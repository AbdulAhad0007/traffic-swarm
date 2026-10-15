"""SUMO's built-in actuated (gap-based) signal control as a third comparator.

For every traffic light whose program the swarm controller may control (same phase-map rules,
see simulation/network/phase_map.py), an `actuated` tlLogic is written that keeps the network's
own phase sequence, states, yellow, all-red and pedestrian-clearance durations unchanged, and only
makes the green phases variable within [min_green, max_green] - the same bounds the swarm's
safety gate uses. SUMO then extends each green while its automatically placed induction loops
report gaps shorter than `max-gap`, and ends it otherwise.

Traffic lights the swarm leaves on their native program (single green phase / invalid program)
also keep their native program here, so all three controllers act on the same set of junctions.

Detectors: SUMO creates one induction loop per incoming lane of each actuated TLS at
`detector-gap` seconds (at max speed) upstream of the stop line. The fixed-time and swarm
controllers use no detectors (the swarm reads halting counts and occupancy through TraCI), so
the actuated controller has a different (more realistic) sensing model. See docs/RESEARCH_METHODOLOGY.md (section 3).
"""
from __future__ import annotations
import xml.etree.ElementTree as ET
from pathlib import Path
from simulation.baseline.fixed_time_controller import FixedTimeController
from simulation.network.phase_map import build_all

PROGRAM_ID = "tsi_actuated"
# SUMO documented defaults (https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html#actuated_traffic_lights),
# written explicitly so the configuration is recorded with every run.
DEFAULT_PARAMS = {"max-gap": 3.0, "detector-gap": 2.0, "passing-time": 1.9, "show-detectors": "false"}


def actuated_programs(model, settings: dict, params: dict | None = None) -> tuple[ET.Element, dict, dict]:
    """Build the <additional> element with actuated programs. Returns (root, phase_maps, config)."""
    params = {**DEFAULT_PARAMS, **(params or {})}
    max_green = float(settings["max_green_s"])
    root = ET.Element("additional")
    phase_maps, converted, native = {}, {}, {}
    for tid, pm in sorted(build_all(model, settings).items()):
        if not pm.controllable:
            native[tid] = pm.status
            continue
        tl = model.tls[tid]
        logic = ET.SubElement(root, "tlLogic", {"id": tid, "type": "actuated", "programID": PROGRAM_ID, "offset": "0"})
        for key, value in params.items():
            ET.SubElement(logic, "param", {"key": key, "value": str(value)})
        greens = {g.index: g for g in pm.greens}
        for i, phase in enumerate(tl.phases):
            attrs = {"duration": f"{phase.duration:g}", "state": phase.state}
            g = greens.get(i)
            if g is not None:
                lo, hi = g.min_green, max(max_green, g.min_green)
                attrs.update(duration=f"{min(max(phase.duration, lo), hi):g}", minDur=f"{lo:g}", maxDur=f"{hi:g}")
            ET.SubElement(logic, "phase", attrs)
        phase_maps[tid] = pm
        converted[tid] = {"greens": [{"index": g.index, "minDur": g.min_green, "maxDur": max(max_green, g.min_green)}
                                     for g in pm.greens]}
    ET.indent(root)
    config = {"program_id": PROGRAM_ID, "parameters": params, "actuated_tls": len(converted),
              "native_tls": native, "green_bounds_source": "controller min_green_s / pedestrian_min_green_s / max_green_s"}
    return root, phase_maps, config


def cfg_with_additional(sumocfg, extra: Path, out_cfg: Path) -> Path:
    tree = ET.parse(sumocfg)
    cfg_root = tree.getroot()
    inp = cfg_root.find("input")
    base = Path(sumocfg).parent
    # Absolute paths: the new cfg lives in another directory.
    for node in list(inp):
        value = node.get("value")
        if value is not None and node.tag in ("net-file", "route-files", "additional-files"):
            parts = [p if Path(p).is_absolute() else (base / p).resolve().as_posix() for p in value.split(",") if p]
            node.set("value", ",".join(parts))
    add = inp.find("additional-files")
    if add is None:
        add = ET.SubElement(inp, "additional-files", value="")
    # Programs must be loaded after the net (they are additional files) and are the last loaded -> active.
    values = [v for v in add.get("value", "").split(",") if v] + [extra.resolve().as_posix()]
    add.set("value", ",".join(values))
    tree.write(out_cfg, encoding="utf-8", xml_declaration=True)
    return out_cfg


class ActuatedController(FixedTimeController):
    controller_name = "actuated"
    file_prefix = "actuated"

    def __init__(self, seed=42, gui=None, settings=None, hooks=None, port=None, params=None):
        super().__init__(seed, gui=gui, settings=settings, hooks=hooks, port=port)
        self.params = params
        self._expected: list[str] = []

    def prepare(self, sumocfg, out: Path, model):
        root, phase_maps, config = actuated_programs(model, self.settings, self.params)
        add = out / "actuated.add.xml"
        ET.ElementTree(root).write(add, encoding="utf-8", xml_declaration=True)
        cfg = cfg_with_additional(sumocfg, add, out / "actuated.sumocfg")
        self._expected = sorted(phase_maps)
        return cfg, phase_maps, {"actuated_config": config}

    def verify(self, session) -> dict:
        import traci
        wrong = {t: traci.trafficlight.getProgram(t) for t in self._expected
                 if traci.trafficlight.getProgram(t) != PROGRAM_ID}
        if wrong:
            raise RuntimeError(f"actuated program not active for {len(wrong)} TLS: {dict(list(wrong.items())[:5])}")
        return {"actuated_program_verified": len(self._expected)}
