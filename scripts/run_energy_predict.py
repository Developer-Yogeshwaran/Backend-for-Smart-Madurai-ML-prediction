import csv
import math
from datetime import datetime
from pathlib import Path
import sys
sys.path.insert(0, str(Path('.').resolve()))
from app import compute_trend_and_predict

csv_path = Path('household_power_consumption_sample.csv')
if not csv_path.exists():
    print('sample CSV not found:', csv_path)
    sys.exit(1)

times = []
energy = []
with open(csv_path, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for r in reader:
        dt = None
        for k in r.keys():
            if 'date' in k.lower() or 'time' in k.lower() or 'datetime' in k.lower():
                try:
                    dt = datetime.fromisoformat(r[k])
                    break
                except Exception:
                    try:
                        dt = datetime.strptime(r[k], '%d/%m/%Y %H:%M:%S')
                        break
                    except Exception:
                        pass
        if dt is None:
            continue
        times.append(dt.timestamp())
        v = r.get('Global_active_power') or r.get('Global_active_power ' ) or r.get('Global_active_power\n')
        if v is None:
            # try third column
            keys = list(r.keys())
            if len(keys) >= 3:
                v = r[keys[2]]
        try:
            fv = float(v) if v not in (None, '') else math.nan
        except Exception:
            fv = math.nan
        energy.append(fv)

# filter out NaNs paired with times
paired = [(t,v) for t,v in zip(times, energy) if not math.isnan(v) and v is not None]
if len(paired) < 2:
    print('insufficient numeric energy data')
    sys.exit(1)

times_num = [p[0] for p in paired]
vals = [p[1] for p in paired]
res = compute_trend_and_predict(times_num, vals, n_predict=5)
print('trend:', res.get('trend'))
print('slope:', res.get('slope'))
print('predictions:')
for p in res.get('predictions',[]):
    print('  ', p)
