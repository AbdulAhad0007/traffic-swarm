"""Deterministic demand for generated grids.

Every row and column carries straight-through flows in both directions, so every intersection
has conflicting movements. Each entry also gets one turning flow to a perpendicular exit chosen
with a fixed demand seed (independent of the simulation seed), so baseline and swarm runs always
see the identical route file.
"""
from __future__ import annotations
import random
from pathlib import Path
import xml.etree.ElementTree as ET
from simulation.network.grid_generator import junction_id, edge_id

# Same vehicle type as the legacy 3x3 scenario so KPIs stay comparable.
CAR_VTYPE = dict(id="car", accel="2.6", decel="4.5", sigma="0.5", length="5", minGap="2.5", maxSpeed="13.9")


def grid_flows(rows: int, cols: int, demand: dict) -> list[dict]:
    last_r, last_c = rows - 1, cols - 1
    entries = ([("N", c, edge_id(f"N{c}", junction_id(0, c))) for c in range(cols)]
               + [("S", c, edge_id(f"S{c}", junction_id(last_r, c))) for c in range(cols)]
               + [("W", r, edge_id(f"W{r}", junction_id(r, 0))) for r in range(rows)]
               + [("E", r, edge_id(f"E{r}", junction_id(r, last_c))) for r in range(rows)])
    exits = {"N": [edge_id(junction_id(0, c), f"N{c}") for c in range(cols)],
             "S": [edge_id(junction_id(last_r, c), f"S{c}") for c in range(cols)],
             "W": [edge_id(junction_id(r, 0), f"W{r}") for r in range(rows)],
             "E": [edge_id(junction_id(r, last_c), f"E{r}") for r in range(rows)]}
    opposite = {"N": "S", "S": "N", "W": "E", "E": "W"}
    perpendicular = {"N": ("W", "E"), "S": ("W", "E"), "W": ("N", "S"), "E": ("N", "S")}
    rng = random.Random(int(demand.get("demand_seed", 7)))
    straight = float(demand["straight_veh_per_hour"])
    turn = float(demand.get("turn_veh_per_hour", 0))
    flows = []
    for side, pos, src in entries:
        flows.append({"from": src, "to": exits[opposite[side]][pos], "vph": straight})
    if turn > 0:
        for side, pos, src in entries:
            target_side = rng.choice(perpendicular[side])
            flows.append({"from": src, "to": rng.choice(exits[target_side]), "vph": turn})
    return flows


def write_routes(flows: list[dict], out: Path, begin: float, end: float) -> Path:
    root = ET.Element("routes")
    ET.SubElement(root, "vType", CAR_VTYPE)
    for i, f in enumerate(flows):
        ET.SubElement(root, "flow", {"id": f"f{i:03d}", "type": "car", "from": f["from"], "to": f["to"],
                                     "begin": f"{begin:g}", "end": f"{end:g}", "vehsPerHour": f"{f['vph']:g}"})
    ET.indent(root)
    ET.ElementTree(root).write(out, encoding="utf-8", xml_declaration=True)
    return out


def write_sumocfg(out: Path, end: float, time_to_teleport: float) -> Path:
    # Same layout as the legacy config; run_experiment rewrites the two file names per run.
    out.write_text('<configuration><input><net-file value="build.net.xml"/><route-files value="routes.rou.xml"/></input>'
                   f'<time><begin value="0"/><end value="{end:g}"/></time>'
                   f'<processing><time-to-teleport value="{time_to_teleport:g}"/></processing></configuration>\n',
                   encoding="utf-8")
    return out
