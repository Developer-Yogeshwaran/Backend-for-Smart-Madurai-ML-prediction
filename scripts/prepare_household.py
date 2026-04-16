import urllib.request
import zipfile
import io
import sys
from pathlib import Path

url = 'https://archive.ics.uci.edu/ml/machine-learning-databases/00235/household_power_consumption.zip'
zip_path = Path('household_power_consumption.zip')
csv_out = Path('household_power_consumption_sample.csv')

print('downloading', url)
urllib.request.urlretrieve(url, zip_path)
print('downloaded', zip_path)

with zipfile.ZipFile(zip_path) as z:
    name = [n for n in z.namelist() if n.endswith('.txt')][0]
    print('found', name)
    with z.open(name) as f:
        text = f.read().decode('latin-1')

lines = text.splitlines()
print('total rows in source (including header):', len(lines))

# write a sampled CSV (first 3000 rows) combining Date+Time -> datetime
max_rows = 3000
with open(csv_out, 'w', encoding='utf-8') as out:
    hdr = lines[0].split(';')
    newhdr = ['datetime'] + hdr[2:]
    out.write(','.join(newhdr) + '\n')
    for line in lines[1:max_rows]:
        parts = line.split(';')
        if len(parts) < 3:
            continue
        date = parts[0]
        time = parts[1]
        rest = [p.replace('?', '') for p in parts[2:]]
        dt = date + ' ' + time
        out.write(dt + ',' + ','.join(rest) + '\n')

print('wrote', csv_out)
