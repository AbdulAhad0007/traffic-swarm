import json,statistics
from pathlib import Path
def aggregate(root):
 rows=[]
 # Legacy layout: runs/<scenario>/seed-*/ ; generated networks: runs/<network>/<scenario>/seed-*/
 files=list(Path(root).glob('experiments/runs/*/seed-*/comparison.json'))+list(Path(root).glob('experiments/runs/*/*/seed-*/comparison.json'))
 for f in files:
  x=json.loads(f.read_text())
  network=(x.get('metadata') or {}).get('network',{}).get('preset')
  key=x['scenario'] if network in (None,'grid3x3_legacy') else f"{network}/{x['scenario']}"
  for metric,v in x['comparison'].items():
   if v.get('change_pct') is not None: rows.append((key,metric,v['change_pct']))
 out={}
 for s,m,c in rows:
  out.setdefault(s,{}).setdefault(m,[]).append(c)
 return {s:{m:{'n':len(v),'mean_change_pct':statistics.mean(v),'stddev':statistics.stdev(v) if len(v)>1 else 0.0} for m,v in ms.items()} for s,ms in out.items()}
if __name__=='__main__': print(json.dumps(aggregate('.'),indent=2))
