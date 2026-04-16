const fileInput = document.getElementById('fileInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const tableWrap = document.getElementById('tableWrap');
const loading = document.getElementById('loading');
const errorBox = document.getElementById('error');
const predictionsDiv = document.getElementById('predictions');

let uploadedFile = null;

fileInput.addEventListener('change', (e) => {
  errorBox.textContent = '';
  const f = e.target.files[0];
  if (!f) return;
  if (!f.name.toLowerCase().endsWith('.csv')) {
    errorBox.textContent = 'Please upload a .csv file';
    return;
  }
  uploadedFile = f;
  // Show preview (first 10 rows)
  const reader = new FileReader();
  reader.onload = (ev) => {
    const text = ev.target.result;
    const rows = text.split(/\r?\n/).filter(r=>r.trim()).slice(0, 11);
    if (rows.length === 0) {
      tableWrap.innerHTML = '<div class="error">Empty CSV</div>';
      return;
    }
    const headers = rows[0].split(',');
    let html = '<table><thead><tr>' + headers.map(h=>`<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    for (let i=1;i<rows.length;i++){
      const cols = rows[i].split(',');
      html += '<tr>' + cols.map(c=>`<td>${c}</td>`).join('') + '</tr>';
    }
    html += '</tbody></table>';
    tableWrap.innerHTML = html;
  };
  reader.readAsText(f);
});

// Re-render when smoothing controls change (if results are present)
document.addEventListener('DOMContentLoaded', ()=>{
  const smoothToggle = document.getElementById('smoothingToggle');
  const smoothWindow = document.getElementById('smoothingWindow');
  if (smoothToggle) smoothToggle.addEventListener('change', ()=>{ if (window.lastData) renderResults(window.lastData); });
  if (smoothWindow) smoothWindow.addEventListener('change', ()=>{ if (window.lastData) renderResults(window.lastData); });
});

analyzeBtn.addEventListener('click', async () => {
  errorBox.textContent = '';
  if (!uploadedFile) {
    errorBox.textContent = 'Please select a CSV file first.';
    return;
  }
  loading.classList.remove('hidden');
  const fd = new FormData();
  fd.append('file', uploadedFile);
  try {
    const res = await fetch('/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      // read body once, then try to parse JSON from text
      let msg = `Upload failed (status ${res.status})`;
      try {
        const txt = await res.text();
        try {
          const errJson = JSON.parse(txt);
          msg = errJson.error || JSON.stringify(errJson) || txt || msg;
        } catch (e) {
          msg = txt || msg;
        }
      } catch (e) {
        console.error('Failed to read error body', e);
      }
      console.error('Upload error response:', res.status, msg);
      throw new Error(msg);
    }
    const data = await res.json();
    renderResults(data);
  } catch (err) {
    console.error('Upload exception', err);
    errorBox.textContent = err.message || 'Unexpected error';
  } finally {
    loading.classList.add('hidden');
  }
});

let lineChart, barChart;

const MAX_POINTS = 60;

// Compact toggle handling
document.addEventListener('DOMContentLoaded', ()=>{
  const compact = document.getElementById('compactToggle');
  if (compact){
    compact.addEventListener('change', (e)=>{
      if (e.target.checked) {
        document.body.classList.add('compact');
        // hide heavy panels
        document.getElementById('preview').style.display = 'none';
        document.getElementById('report').style.display = 'none';
      } else {
        document.body.classList.remove('compact');
        document.getElementById('preview').style.display = '';
        document.getElementById('report').style.display = '';
      }
      if (window.lastData) renderResults(window.lastData);
    });
    // initialize compact state
    if (compact.checked){ document.body.classList.add('compact'); document.getElementById('preview').style.display='none'; document.getElementById('report').style.display='none'; }
  }
});

function sampleArray(arr, maxLen){
  if (!arr || arr.length <= maxLen) return arr.slice();
  const step = Math.ceil(arr.length / maxLen);
  return arr.filter((_, i) => i % step === 0);
}

function renderResults(data){
  // keep last data for re-render triggers
  window.lastData = data;
  // Show processed data preview
  if (data.processed_data && data.processed_data.length){
    const rows = data.processed_data;
    const headers = Object.keys(rows[0]);
    let html = '<table><thead><tr>' + headers.map(h=>`<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    rows.forEach(r=>{
      html += '<tr>' + headers.map(h=>`<td>${r[h] ?? ''}</td>`).join('') + '</tr>';
    });
    html += '</tbody></table>';
    tableWrap.innerHTML = html;
  }

  const metrics = data.metrics || Object.keys(data.summary || {});
    if (metrics.length === 0) return;
    const tsCol = data.timestamp_col;
    const rows = data.processed_data || [];
    const labels = rows.map(r=>r[tsCol]);

    // Create per-metric clean line charts (traffic, aqi, energy if present)
    const mapping = {traffic: 'lineTraffic', aqi: 'lineAQI', energy: 'lineEnergy'};
    metrics.forEach(m=>{
      const lc = m.toLowerCase();
      const canvasId = mapping[lc] || null;
      if (!canvasId) return; // skip unknown metrics for dedicated charts
      // robust numeric parsing (handles '1,234', '120 cars', etc.)
      function parseNumber(v){
        if (v == null) return NaN;
        if (typeof v === 'number') return v;
        const s = String(v).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);
        return s ? Number(s[0]) : NaN;
      }
      const rawVals = rows.map(r=>{ const v = parseNumber(r[m]); return isNaN(v)?null:v; });
      const nonNullCount = rawVals.reduce((s,v)=>s + (v!=null?1:0), 0);
      const preds = (data.predictions && data.predictions[m]) ? data.predictions[m].map(p=>{ const n = Number(p); return isNaN(n)?null:n; }).filter(x=>x!=null) : [];
      if (nonNullCount === 0 && preds.length === 0) {
        // render placeholder message or small chart using mean if available
        const mean = data.summary && data.summary[m] && data.summary[m].mean ? Number(data.summary[m].mean) : null;
        renderMetricPlaceholder(canvasId, m, mean);
        return;
      }
      const smooth = document.getElementById('smoothingToggle')?.checked;
      const windowSize = parseInt(document.getElementById('smoothingWindow')?.value || '7', 10);
      let valsForChart = rawVals.slice();
      if (smooth){
        valsForChart = movingAverage(valsForChart, windowSize);
      }
      const sampledLabels = sampleArray(labels, MAX_POINTS);
      const sampledVals = sampleArray(valsForChart, MAX_POINTS);
      // if no historical numeric data but predictions exist, draw preds as tiny chart
      if (nonNullCount === 0 && preds.length>0){
        // show predictions only
        renderMetricLine(m, canvasId, preds.map((_,i)=>`t+${i+1}`), preds);
      } else {
        renderMetricLine(m, canvasId, sampledLabels, sampledVals, preds);
      }
    });

    // Bar chart - compare means of metrics (neat formatting)
    const barCtx = document.getElementById('barChart').getContext('2d');
    if (barChart) barChart.destroy();
    const barLabels = metrics.map(m=>m);
    const barVals = metrics.map(m=>Number((data.summary?.[m]?.mean || 0)));
    barChart = new Chart(barCtx, {
      type: 'bar',
      data: {labels:barLabels, datasets:[{label:'Mean', data:barVals, backgroundColor:barLabels.map((_,i)=>['#6ad1ff','#ffd36a','#9be36a'][i%3])}]},
      options: {responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true,ticks:{precision:0}}}}
    });

  // (Old aggregated charts removed to avoid rendering missing canvases)
  // Ensure bar chart exists before drawing (already drawn above)
  try{
    const barCanvas = document.getElementById('barChart');
    if (barCanvas && barChart){
      // barChart already created above
    }
  }catch(e){console.warn('skip legacy charts', e)}

  // Predictions
  predictionsDiv.innerHTML = '';
  for (const m of metrics){
    const preds = (data.predictions && data.predictions[m]) || [];
    const trendObj = (data.trends && data.trends[m]) || {};
    const trend = trendObj.trend || 'unknown';
    // If no predictions available, create a deterministic fallback based on mean or slope
    let displayPreds = preds.slice();
    if ((!displayPreds || displayPreds.length === 0)){
      const mean = data.summary && data.summary[m] && Number(data.summary[m].mean);
      const slope = trendObj.slope || 0;
      if (!Number.isFinite(mean) || mean === 0){
        // tiny synthetic baseline
        displayPreds = [1,1,1,1,1].map((v,i)=> (i+1) * 1.0);
      } else {
        // project mean with slope (small deterministic increments)
        displayPreds = Array.from({length:5}, (_,i)=> mean + (i+1) * (slope || mean * 0.02));
      }
    }
    const box = document.createElement('div');
    box.className = 'pred-box';
    box.innerHTML = `<strong>${m}</strong> — Trend: <em>${trend}</em><div class="pred-list">Predictions: ${displayPreds.map(p=>typeof p === 'number' ? p.toFixed(2) : p).join(', ')}</div>`;
    // If metric has no dedicated chart canvas, add a small sparkline to the prediction box
    const mapping = {traffic: 'lineTraffic', aqi: 'lineAQI', energy: 'lineEnergy'};
    const lc = m.toLowerCase();
    if (!mapping[lc]){
      const c = document.createElement('canvas');
      c.width = 200; c.height = 40; c.style.marginTop = '6px';
      box.appendChild(c);
      // draw sparkline: try historical values, else use displayPreds
      const hist = (data.processed_data || []).map(r=>{ const v = r[m]; return (v==null||v==='')?null: Number(String(v).replace(/,/g,'').match(/-?\d+(?:\.\d+)?/)?RegExp.lastMatch: NaN); }).filter(x=>x!=null && !Number.isNaN(x));
      const sparkData = hist.length>2 ? sampleArray(hist, 20) : displayPreds.slice();
      try{ new Chart(c.getContext('2d'), {type:'line', data:{labels:sparkData.map((_,i)=>i), datasets:[{data:sparkData, borderColor:'#7b6bff', backgroundColor:'rgba(123,107,255,0.06)', pointRadius:0, tension:0.3}]}, options:{responsive:false, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{display:false}}}}); }catch(e){console.warn('sparkline failed', e)}
    }
    predictionsDiv.appendChild(box);
  }

  // Summary cards
  const summaryGrid = document.getElementById('summaryGrid');
  summaryGrid.innerHTML = '';
  for (const m of metrics){
    const s = data.summary[m] || {};
    const t = data.trends[m] || {};
    const card = document.createElement('div');
    card.className = 'card-stat';
    card.innerHTML = `<h5>${m}</h5><div class="val">${(s.mean||0).toFixed? (s.mean||0).toFixed(2) : s.mean}</div><div class="meta">min: ${s.min ?? '-'} max: ${s.max ?? '-'} count: ${s.count ?? '-'}</div><div class="trend">Trend: <strong>${t.trend ?? '-'}</strong></div>`;
    summaryGrid.appendChild(card);
  }

  // Render smaller report charts (mirrors main charts)
  try{
    const repLineCtx = document.getElementById('reportLine');
    const repBarCtx = document.getElementById('reportBar');
    if (repLineCtx){
      const repMetric = metrics.includes('traffic') ? 'traffic' : metrics[0];
      const repLabels = sampleArray(rows.map(r=>r[tsCol]), MAX_POINTS);
      const repVals = sampleArray(rows.map(r=>{ const v=r[repMetric]; return v==null||v===''?NaN:Number(v)}).map(v=>isNaN(v)?null:v), MAX_POINTS);
      const ctx = repLineCtx.getContext('2d');
      if (window.reportLine) window.reportLine.destroy();
      window.reportLine = new Chart(ctx, {type:'line', data:{labels:repLabels, datasets:[{label:repMetric, data:repVals, borderColor:'#3c82ff', backgroundColor:'rgba(60,130,255,0.06)', tension:0.3, pointRadius:0}]}, options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}}});
    }
    if (repBarCtx){
      const ctx2 = repBarCtx.getContext('2d');
      if (window.reportBar) window.reportBar.destroy();
      window.reportBar = new Chart(ctx2, {type:'bar', data:{labels:metrics.map(m=>m), datasets:[{label:'Mean', data:metrics.map(m=>Number((data.summary?.[m]?.mean || 0))), backgroundColor:metrics.map((_,i)=>['#6ad1ff','#ffd36a','#9be36a'][i%3])}]}, options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}}});
    }
  }catch(e){console.warn('report charts failed', e)}

  // Export / Print handlers
  document.getElementById('exportBtn').onclick = exportCharts;
  document.getElementById('printBtn').onclick = printReport;
}

function renderMetricPlaceholder(canvasId, metric, mean){
  try{
    const el = document.getElementById(canvasId);
    if (!el) return;
    // clear any existing chart
    if (metricCharts[canvasId]) { metricCharts[canvasId].destroy(); metricCharts[canvasId]=null; }
    const ctx = el.getContext('2d');
    // if mean provided, draw a tiny flat line
    if (mean != null){
      const labels = ['','','','',''];
      const data = [mean, mean, mean, mean, mean];
      metricCharts[canvasId] = new Chart(ctx, {type:'line', data:{labels, datasets:[{data, borderColor:'#888', backgroundColor:'rgba(136,136,136,0.06)', pointRadius:0}]}, options:{responsive:true, maintainAspectRatio:true, aspectRatio:2.2, plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{display:true}}}});
    } else {
      // draw a simple grey background and text
      ctx.clearRect(0,0,el.width, el.height);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0,0,el.width,el.height);
      ctx.fillStyle = '#cfcfcf';
      ctx.font = '12px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('No numeric data for ' + metric, el.width/2, el.height/2);
    }
  }catch(e){console.warn('renderMetricPlaceholder', e)}
}

function renderMetricLine(metric, canvasId, labels, data, preds){
  try{
    const el = document.getElementById(canvasId);
    if (!el) return;
    const ctx = el.getContext('2d');
    if (metricCharts[canvasId]) metricCharts[canvasId].destroy();
    const compact = document.body.classList.contains('compact');

    const predCount = (Array.isArray(preds) ? preds.length : 0);
    // Build combined labels so predictions appear after historical labels
    const combinedLabels = labels ? labels.slice() : [];
    for (let i=0;i<predCount;i++){ combinedLabels.push(`t+${i+1}`); }

    // Prepare main dataset (pad with nulls for prediction slots)
    const mainData = (Array.isArray(data) ? data.slice() : []).slice();
    while (mainData.length < combinedLabels.length) mainData.push(null);

    // Prepare prediction dataset (nulls for historical slots, then preds)
    const predData = new Array((labels && labels.length) || 0).fill(null).concat(preds || []);

    const datasets = [];
    // only add historical dataset if it contains any non-null numeric points
    const hasHistorical = mainData.some(v=>v != null && !Number.isNaN(v));
    if (hasHistorical){
      datasets.push({ label: metric, data: mainData, borderColor: '#2b6cff', backgroundColor: 'rgba(43,108,255,0.06)', tension: 0.22, pointRadius:0, borderWidth:1.5 });
    }
    if (predCount>0){
      datasets.push({ label: metric + ' (prediction)', data: predData, borderColor: '#ff6b6b', backgroundColor: 'rgba(255,107,107,0.02)', borderDash:[6,4], tension:0.22, pointRadius:2, borderWidth:1 });
    }

    metricCharts[canvasId] = new Chart(ctx, {
      type: 'line',
      data: { labels: combinedLabels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 2.2,
        layout: { padding: { left: 6, right: 6, top: 6, bottom: 6 } },
        plugins: { legend: { display: false }, tooltip: {mode:'index',intersect:false} },
        elements: { line: { tension: 0.22 } },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: compact?3:5, font: {size: compact?10:12} }, grid: { display:false }, display: true },
          y: { beginAtZero: true, ticks: { precision: 0, font: {size: compact?10:12} }, grid: { color: 'rgba(255,255,255,0.04)' }, display: true }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });
  }catch(e){console.warn('renderMetricLine error', e)}
}

function movingAverage(arr, windowSize){
  const out = [];
  const w = Math.max(1, parseInt(windowSize,10)||1);
  for (let i=0;i<arr.length;i++){
    let sum=0, count=0;
    for (let j=i-Math.floor(w/2); j<=i+Math.floor(w/2); j++){
      if (j>=0 && j<arr.length && arr[j] != null){ sum += arr[j]; count++; }
    }
    out.push(count? (sum/count) : null);
  }
  return out;
}

function exportCharts(){
  try{
    const imgs = [];
    if (lineChart) imgs.push(lineChart.toBase64Image());
    if (barChart) imgs.push(barChart.toBase64Image());
    const w = window.open('');
    let html = `<html><head><title>Analysis Export</title><style>body{font-family:Arial;padding:20px}</style></head><body>`;
    html += `<h2>Analysis Charts</h2>`;
    imgs.forEach(i=>{html += `<div style="margin-bottom:16px"><img src="${i}" style="max-width:100%"></div>`});
    html += `</body></html>`;
    w.document.write(html);
    w.document.close();
  }catch(e){alert('Export failed: '+e.message)}
}

function printReport(){
  const w = window.open('');
  const summaryHtml = document.getElementById('summaryGrid').innerHTML;
  const lineImg = lineChart ? lineChart.toBase64Image() : '';
  const barImg = barChart ? barChart.toBase64Image() : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Print Report</title><style>body{font-family:Arial;padding:20px}.card-stat{border:1px solid #ddd;padding:8px;border-radius:6px;margin:6px;display:inline-block}</style></head><body><h1>Smart City Analysis Report</h1><div>${summaryHtml}</div><h2>Trend</h2><img src="${lineImg}" style="max-width:100%"><h2>Comparison</h2><img src="${barImg}" style="max-width:100%"></body></html>`;
  w.document.write(html);
  w.document.close();
  w.print();
}
