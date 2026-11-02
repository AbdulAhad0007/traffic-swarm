"""Road geometry and signal positions of a SUMO network, for the 3D View.

Coordinates stay in SUMO network metres. `transform` maps them to metres east/north of `anchor`
so the browser never needs a map projection. Synthetic grids have no real location: `geo` is null
and the anchor only gives the renderer somewhere to put them.
"""
from __future__ import annotations
import math
import xml.etree.ElementTree as ET
from simulation.live.congestion import network_layout
from simulation.network.geo import xy_to_lonlat

_METRES_PER_DEG_LAT = 111_320.0


def _points(shape: str | None) -> list[list[float]]:
    out = []
    for pair in (shape or "").split():
        x, y = pair.split(",")[:2]
        out.append([round(float(x), 2), round(float(y), 2)])
    return out


def _local_frame(center: tuple[float, float], location: dict | None) -> tuple[dict, dict]:
    """Anchor (lon, lat) and the 2x2 matrix from network metres to metres east/north of it."""
    cx, cy = center
    if not location:
        return {"lon": 0.0, "lat": 0.0}, {"cx": cx, "cy": cy, "ee": 1.0, "en": 0.0, "ne": 0.0, "nn": 1.0}
    lon0, lat0 = xy_to_lonlat(cx, cy, location)
    per_lon = _METRES_PER_DEG_LAT * math.cos(math.radians(lat0))
    span = 500.0
    lon_x, lat_x = xy_to_lonlat(cx + span, cy, location)
    lon_y, lat_y = xy_to_lonlat(cx, cy + span, location)
    return {"lon": lon0, "lat": lat0}, {
        "cx": cx, "cy": cy,
        "ee": (lon_x - lon0) * per_lon / span, "en": (lon_y - lon0) * per_lon / span,
        "ne": (lat_x - lat0) * _METRES_PER_DEG_LAT / span, "nn": (lat_y - lat0) * _METRES_PER_DEG_LAT / span,
    }


def build_network3d(model) -> dict:
    root = ET.parse(model.path).getroot()
    lane_shapes, edges = {}, []
    for e in root.findall("edge"):
        lanes = e.findall("lane")
        for lane in lanes:
            lane_shapes[lane.get("id")] = _points(lane.get("shape"))
        if e.get("function") or not lanes:
            continue
        middle = lanes[len(lanes) // 2]
        drive = [lane for lane in lanes if lane.get("allow") != "pedestrian"]
        edges.append({"id": e.get("id"), "name": e.get("name"), "lanes": len(lanes), "drive_lanes": len(drive),
                      "lane_ids": [lane.get("id") for lane in drive], "speed": round(float(middle.get("speed", 0)), 1),
                      "length": round(float(middle.get("length", 0)), 1), "shape": _points(middle.get("shape")),
                      "lane_shapes": [_points(lane.get("shape")) for lane in drive]})

    xs = [p[0] for edge in edges for p in edge["shape"]]
    ys = [p[1] for edge in edges for p in edge["shape"]]
    bounds = {"min_x": min(xs), "max_x": max(xs), "min_y": min(ys), "max_y": max(ys)} if xs else None
    center = ((bounds["min_x"] + bounds["max_x"]) / 2, (bounds["min_y"] + bounds["max_y"]) / 2) if bounds else (0.0, 0.0)
    location = getattr(model, "location", None)
    anchor, transform = _local_frame(center, location)

    layout = network_layout(model)
    signals = []
    for node in layout["nodes"]:
        tl = model.tls[node["id"]]
        by_lane: dict[str, list[int]] = {}
        for index, links in tl.links.items():
            for link in links:
                if link.from_lane and not link.pedestrian:
                    by_lane.setdefault(link.from_lane, []).append(index)
        lamps = [{"at": lane_shapes[lane][-1], "links": sorted(set(indexes))}
                 for lane, indexes in sorted(by_lane.items()) if lane_shapes.get(lane)]
        signals.append({"id": node["id"], "x": node["x"], "y": node["y"], "streets": node.get("streets", []), "lamps": lamps})

    from simulation.coordination.hierarchy import partition_regions
    return {"version": 2, "geo": layout["geo"], "anchor": anchor, "transform": transform, "bounds": bounds,
            "edges": edges, "signals": signals, "links": layout["links"], "regions": partition_regions(layout["nodes"])}
