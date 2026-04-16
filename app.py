from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
import io
import os
import csv
import math
from datetime import datetime, timedelta

try:
    import pandas as pd
except Exception:
    pd = None
try:
    import numpy as _np
except Exception:
    _np = None
try:
    from sklearn.ensemble import RandomForestRegressor
    SKLEARN_AVAILABLE = True
except Exception:
    RandomForestRegressor = None
    SKLEARN_AVAILABLE = False

# Compatibility shim: some Python runtimes may not expose pkgutil.get_loader
import pkgutil
import importlib.util
if not hasattr(pkgutil, 'get_loader'):
    def _get_loader(name):
        try:
            spec = importlib.util.find_spec(name)
            if spec is None:
                return None
            class _Loader:
                def get_filename(self, fullname):
                    return spec.origin
            return _Loader()
        except Exception:
            return None
    pkgutil.get_loader = _get_loader

# Simple path resolution for both local and Vercel
template_dir = 'templates'
static_dir = 'static'

app = Flask(__name__, template_folder=template_dir, static_folder=static_dir, static_url_path='/static')
# Configure CORS explicitly to allow preflight and common headers
CORS(app, resources={r"/*": {"origins": "*"}}, allow_headers='*', methods=['GET', 'POST', 'OPTIONS'])


@app.before_request
def log_request_info():
    try:
        print(f"[request] {request.method} {request.path} from {request.remote_addr}")
        # print headers briefly
        h = {k: v for k, v in request.headers.items() if k.lower() in ('origin','content-type','access-control-request-method')}
        if h:
            print('[request] headers:', h)
    except Exception:
        pass


def detect_numeric_metrics(df, exclude_cols):
    if pd is not None and hasattr(df, 'select_dtypes'):
        try:
            nums = df.select_dtypes(include=['number']).columns.tolist()
        except Exception:
            nums = df.select_dtypes(include=[float, int]).columns.tolist()
        return [c for c in nums if c not in exclude_cols]
    # fallback: df is list of dicts
    cols = set()
    for r in df:
        cols.update(r.keys())
    candidates = [c for c in cols if c not in exclude_cols]
    numerics = []
    for c in candidates:
        ok = True
        for r in df:
            v = r.get(c)
            if v is None or v == '':
                continue
            try:
                float(v)
            except Exception:
                ok = False
                break
        if ok:
            numerics.append(c)
    return numerics


def _median(lst):
    s = sorted(lst)
    n = len(s)
    if n == 0:
        return 0
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


def compute_trend_and_predict(times_numeric, values, n_predict=5):
    if len(values) < 2 or len(times_numeric) < 2:
        return {"trend": "insufficient_data", "predictions": []}

    # Filter out None values to avoid float() conversion errors
    filtered_pairs = [(t, v) for t, v in zip(times_numeric, values) if t is not None and v is not None]
    if len(filtered_pairs) < 2:
        return {"trend": "insufficient_data", "predictions": []}
    
    times_numeric = [t for t, v in filtered_pairs]
    values = [v for t, v in filtered_pairs]
    
    # Ensure lists are same length and all values are numeric
    try:
        x = [float(t) for t in times_numeric]
        y = [float(v) for v in values]
    except (TypeError, ValueError) as e:
        print(f"[error] compute_trend_and_predict conversion error: {e}")
        return {"trend": "error", "predictions": []}

    n = len(x)
    mean_x = sum(x) / n
    mean_y = sum(y) / n
    num = sum((x[i] - mean_x) * (y[i] - mean_y) for i in range(n))
    den = sum((x[i] - mean_x) ** 2 for i in range(n))
    slope = (num / den) if den != 0 else 0.0
    intercept = mean_y - slope * mean_x
    trend = "increasing" if slope > 0 else ("decreasing" if slope < 0 else "stable")

    last = x[-1]
    diffs = [x[i+1] - x[i] for i in range(len(x)-1)]
    delta = _median(diffs) if diffs else 1
    future_times = [last + (i + 1) * delta for i in range(n_predict)]
    # Attempt a stronger model when scikit-learn and numpy are available
    try:
        if SKLEARN_AVAILABLE and _np is not None and len(values) >= 20:
            # build simple lag features from the raw values for iterative forecasting
            arr = _np.array(values, dtype=float)
            lags = 3
            X = []
            y = []
            for i in range(lags, len(arr)):
                X.append(arr[i-lags:i].tolist())
                y.append(float(arr[i]))
            if len(X) >= 5:
                rf = RandomForestRegressor(n_estimators=100, random_state=42)
                rf.fit(X, y)
                preds = []
                last_window = arr[-lags:].tolist()
                for _ in range(n_predict):
                    p = float(rf.predict([last_window])[0])
                    preds.append(p)
                    last_window = last_window[1:] + [p]
                return {"trend": trend, "slope": float(slope), "predictions": preds, "future_times": future_times, "model": "random_forest"}
    except Exception:
        # fallback to simple linear extrapolation
        pass

    preds = [slope * ft + intercept for ft in future_times]

    return {"trend": trend, "slope": float(slope), "predictions": preds, "future_times": future_times, "model": "linear"}


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/<path:path>')
def serve_static(path):
    # Serve static files and spa routes
    if path.startswith('static/'):
        return send_from_directory(static_dir, path.replace('static/', ''))
    # For any other route (SPA), serve index.html
    return render_template('index.html')


@app.route('/upload', methods=['POST', 'OPTIONS', 'GET'])
def upload():
    # Support OPTIONS for CORS preflight and GET for helpful instruction
    if request.method == 'OPTIONS':
        return jsonify({"status": "ok"}), 200
    if request.method == 'GET':
        return jsonify({"message": "POST a CSV file to this endpoint as form-data under key 'file'"}), 200
    
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file part"}), 400
        file = request.files['file']
        print(f"[upload] received file: {file.filename}")
        
        if file.filename == '':
            return jsonify({"error": "No selected file"}), 400
        if not file.filename.lower().endswith('.csv'):
            return jsonify({"error": "Invalid file type; CSV required"}), 400

        data = file.read()

        if pd is not None:
            try:
                df = pd.read_csv(io.BytesIO(data))
                
                if df.empty:
                    return jsonify({"error": "CSV is empty"}), 400

                df.columns = [str(c).strip() for c in df.columns]

                timestamp_col = None
                for c in df.columns:
                    if 'time' in c.lower() or 'date' in c.lower():
                        timestamp_col = c
                        break

                if timestamp_col:
                    df[timestamp_col] = pd.to_datetime(df[timestamp_col], errors='coerce')
                    df = df.sort_values(timestamp_col).reset_index(drop=True)
                else:
                    try:
                        df['timestamp'] = pd.date_range(start=pd.Timestamp.now(), periods=len(df), freq='min')
                    except Exception:
                        start = pd.Timestamp.now().floor('min') if hasattr(pd.Timestamp.now(), 'floor') else pd.Timestamp.now()
                        df['timestamp'] = [start + pd.Timedelta(minutes=i) for i in range(len(df))]
                    timestamp_col = 'timestamp'

                df = df.ffill().bfill()

                location_col = None
                for c in df.columns:
                    if 'loc' in c.lower() or 'city' in c.lower() or 'lat' in c.lower() or 'lon' in c.lower():
                        location_col = c
                        break

                exclude = [timestamp_col]
                if location_col:
                    exclude.append(location_col)
                metrics = detect_numeric_metrics(df, exclude)

                summary = {}
                predictions = {}
                trends = {}

                times_numeric = (df[timestamp_col].astype('int64') // 10 ** 9).astype(float)

                for m in metrics:
                    series = df[m].astype(float).ffill().bfill()
                    summary[m] = {
                        'mean': float(series.mean()),
                        'max': float(series.max()),
                        'min': float(series.min()),
                        'count': int(series.count())
                    }
                    tp = compute_trend_and_predict(times_numeric.tolist(), series.tolist(), n_predict=5)
                    predictions[m] = tp['predictions']
                    trends[m] = {'trend': tp['trend'], 'slope': tp.get('slope', 0.0)}

                processed = df.head(100).copy()
                processed[timestamp_col] = processed[timestamp_col].dt.strftime('%Y-%m-%dT%H:%M:%S')

                response = {
                    'summary': summary,
                    'predictions': predictions,
                    'trends': trends,
                    'processed_data': processed.to_dict(orient='records'),
                    'metrics': metrics,
                    'timestamp_col': timestamp_col,
                    'location_col': location_col
                }
                return jsonify(response)
            except Exception as pandas_err:
                print(f"[error] pandas error: {pandas_err}")
                import traceback
                traceback.print_exc()
                # Fall through to CSV parsing fallback

        # Fallback CSV parsing without pandas
        try:
            text = data.decode('utf-8')
        except Exception:
            try:
                text = data.decode('latin-1')
            except Exception as e:
                return jsonify({"error": f"Failed to decode CSV: {e}"}), 400

        reader = csv.DictReader(io.StringIO(text))
        rows = [r for r in reader]
        if len(rows) == 0:
            return jsonify({"error": "CSV is empty"}), 400

        # Normalize keys
        for r in rows:
            for k in list(r.keys()):
                if k is None:
                    continue
                v = k.strip()
                if v != k:
                    r[v] = r.pop(k)

        # Detect timestamp
        timestamp_col = None
        for k in rows[0].keys():
            if 'time' in k.lower() or 'date' in k.lower():
                timestamp_col = k
                break
        if not timestamp_col:
            base = datetime.now()
            for i, r in enumerate(rows):
                r['timestamp'] = (base.replace(microsecond=0) + timedelta(minutes=i)).isoformat()
            timestamp_col = 'timestamp'

        # parse timestamps to numeric seconds
        times_numeric = []
        for r in rows:
            try:
                dt = datetime.fromisoformat(r.get(timestamp_col))
            except Exception:
                try:
                    dt = datetime.strptime(r.get(timestamp_col), '%Y-%m-%d %H:%M:%S')
                except Exception:
                    dt = None
            if dt is not None:
                times_numeric.append(dt.timestamp())
            else:
                times_numeric.append(None)

        # Fill missing times by linear interpolation-ish
        for i, t in enumerate(times_numeric):
            if t is None:
                left = next((times_numeric[j] for j in range(i-1, -1, -1) if times_numeric[j] is not None), None)
                right = next((times_numeric[j] for j in range(i+1, len(times_numeric)) if times_numeric[j] is not None), None)
                times_numeric[i] = left if right is None else (left if left is not None else right)

        # detect numeric metrics
        exclude = [timestamp_col]
        metrics = detect_numeric_metrics(rows, exclude)

        summary = {}
        predictions = {}
        trends = {}

        for m in metrics:
            vals = []
            for r in rows:
                v = r.get(m)
                try:
                    fv = float(v) if v not in (None, '') else math.nan
                except Exception:
                    fv = math.nan
                vals.append(fv)
            arr = [v for v in vals if not math.isnan(v)]
            if len(arr) == 0:
                continue
            summary[m] = {'mean': float(sum(arr) / len(arr)), 'max': float(max(arr)), 'min': float(min(arr)), 'count': int(len(arr))}
            # Filter out None timestamps to avoid float() conversion errors
            valid_times = [times_numeric[i] for i in range(len(times_numeric)) if times_numeric[i] is not None and not math.isnan(vals[i])]
            valid_vals = [vals[i] if not math.isnan(vals[i]) else 0.0 for i in range(len(vals)) if times_numeric[i] is not None and not math.isnan(vals[i])]
            if len(valid_times) >= 2 and len(valid_vals) >= 2:
                tp = compute_trend_and_predict(valid_times, valid_vals, n_predict=5)
            else:
                tp = {"trend": "insufficient_data", "predictions": []}
            predictions[m] = tp['predictions']
            trends[m] = {'trend': tp['trend'], 'slope': tp.get('slope', 0.0)}

        processed = rows[:100]
        response = {'summary': summary, 'predictions': predictions, 'trends': trends, 'processed_data': processed, 'metrics': metrics, 'timestamp_col': timestamp_col, 'location_col': None}
        return jsonify(response)
    
    except Exception as e:
        print(f"[error] upload exception: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
