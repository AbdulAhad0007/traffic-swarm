from pathlib import Path
import xml.etree.ElementTree as ET

SCENARIOS = ("normal", "rush-hour", "uneven", "sudden-congestion", "road-closure")
BASE = Path("simulation/scenarios/grid3x3")

def validate():
    base = ET.parse(BASE / "routes.rou.xml").getroot()
    flows = base.findall("flow")
    if not flows: raise AssertionError("base route file contains no flows")
    for name in SCENARIOS:
        # Generate and parse a temporary route in the run directory so validation
        # exercises the exact scenario generator used by experiments.
        from scenario_generator import generate
        out = Path("experiments/.scenario-validation") / f"{name}.rou.xml"
        out.parent.mkdir(parents=True, exist_ok=True)
        generate(BASE / "routes.rou.xml", out, name)
        root = ET.parse(out).getroot()
        if len(root.findall("flow")) != len(flows): raise AssertionError(name)
        print("OK", name)
    import shutil
    shutil.rmtree("experiments/.scenario-validation", ignore_errors=True)

if __name__ == "__main__": validate()
