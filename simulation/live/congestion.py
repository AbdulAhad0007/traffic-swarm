"""Congestion levels and network layout for the live heatmap (any network: grid or OSM import).

One definition is used everywhere (live view, replay, prediction classes), loaded from
simulation/config/live.json, so the dashboard legend always matches the computed levels.
"""
from __future__ import annotations
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
LIVE_CONFIG = PROJECT_ROOT / "simulation" / "config" / "live.json"


def load_live_config(path: str | Path | None = None) -> dict:
    cfg = json.loads(Path(path or LIVE_CONFIG).read_text(encoding="utf-8"))
    levels = cfg.get("levels") or []
    if len(levels) < 2:
        raise ValueError("live config needs at least two congestion levels")
    for key in ("max_occupancy", "max_queue_per_lane"):
        bounds = [lv[key] for lv in levels[:-1]]
        if any(b is None for b in bounds) or bounds != sorted(bounds):
            raise ValueError(f"'{key}' thresholds must be increasing and set for every level but the last")
        if levels[-1][key] is not None:
            raise ValueError("the last level must be open-ended (null thresholds)")
    return cfg


def _index(value: float, levels: list, key: str) -> int:
    for i, lv in enumerate(levels[:-1]):
        if value <= lv[key]:
            return i
    return len(levels) - 1


def classify(queue: float | None, occupancy: float | None, lanes: int, cfg: dict) -> str:
    """Congestion level name; `no_data_level` when the junction has no measurable incoming lanes."""
    if lanes <= 0 or queue is None or occupancy is None:
        return cfg.get("no_data_level", "no_data")
    levels = cfg["levels"]
    i = max(_index(float(occupancy), levels, "max_occupancy"), _index(float(queue) / lanes, levels, "max_queue_per_lane"))
    return levels[i]["name"]


def level_names(cfg: dict) -> list[str]:
    return [lv["name"] for lv in cfg["levels"]]


def tls_incoming_lanes(model) -> dict[str, list[str]]:
    """Incoming vehicle lanes of every TLS, from its controlled links (pedestrian links excluded)."""
    out = {}
    for tid, tl in model.tls.items():
        lanes = {l.from_lane for links in tl.links.values() for l in links if not l.pedestrian and l.from_lane}
        out[tid] = sorted(lanes)
    return out


def network_layout(model) -> dict:
    """Junction positions (SUMO network coordinates, metres) and neighbor links for drawing."""
    nodes = []
    for tid in model.tls_ids:
        js = [model.junctions[j] for j in model.tls[tid].junctions if j in model.junctions]
        if not js and tid in model.junctions:
            js = [model.junctions[tid]]
        x = sum(j["x"] for j in js) / len(js) if js else None
        y = sum(j["y"] for j in js) / len(js) if js else None
        nodes.append({"id": tid, "x": None if x is None else round(x, 2), "y": None if y is None else round(y, 2)})
    graph = model.neighbor_graph()
    links = sorted({tuple(sorted((a, b))) for a, ns in graph.items() for b in ns})
    xs = [n["x"] for n in nodes if n["x"] is not None]
    ys = [n["y"] for n in nodes if n["y"] is not None]
    bounds = {"min_x": min(xs), "max_x": max(xs), "min_y": min(ys), "max_y": max(ys)} if xs else None
    return {"nodes": nodes, "links": [list(l) for l in links], "bounds": bounds,
            "unpositioned": [n["id"] for n in nodes if n["x"] is None]}
