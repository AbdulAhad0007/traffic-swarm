from pathlib import Path
import xml.etree.ElementTree as ET
SCENARIOS={'normal':1.0,'rush-hour':1.8,'uneven':1.35,'sudden-congestion':1.55,'road-closure':1.25}
def generate(base_route,out,scenario):
    if scenario not in SCENARIOS: raise ValueError(f'unknown scenario: {scenario}')
    root=ET.parse(base_route).getroot(); factor=SCENARIOS[scenario]
    for flow in root.findall('flow'):
        flow.set('vehsPerHour',str(round(float(flow.get('vehsPerHour'))*factor)))
    if scenario=='uneven':
        for f in root.findall('flow')[:4]: f.set('vehsPerHour',str(round(float(f.get('vehsPerHour'))*1.8)))
    if scenario=='sudden-congestion':
        for f in root.findall('flow')[:2]: f.set('vehsPerHour',str(round(float(f.get('vehsPerHour'))*2.5)))
    ET.ElementTree(root).write(out,encoding='utf-8',xml_declaration=True)
    return out
