"""Turns tracked detections into traffic measurements. Pure Python: no camera, model or network.

Coordinates in `zones` are normalised to the frame (0..1). What a measurement can claim depends on calibration:
without a reference distance the service reports vehicle counts and relative motion, and leaves metres and m/s empty.
With one, values are labelled estimates, since one scale cannot remove camera perspective.
"""
from __future__ import annotations
import math
from collections import deque

APPROACHES = ("north", "south", "east", "west")
AXIS_OF = {"north": "NS", "south": "NS", "east": "EW", "west": "EW"}
# Motion is judged relative to the vehicle's own size, so it works at any zoom: below this many
# vehicle-heights per second the vehicle counts as stopped. It tolerates detector jitter.
STOPPED_HEIGHTS_PER_S = 0.12
TRACK_TTL_S = 3.0
RATE_WINDOW_S = 60.0
CLASSES = ("car", "motorcycle", "bus", "truck", "bicycle")


def point_in_polygon(x: float, y: float, polygon: list) -> bool:
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def polygon_area(polygon: list) -> float:
    n = len(polygon)
    return abs(sum(polygon[i][0] * polygon[(i + 1) % n][1] - polygon[(i + 1) % n][0] * polygon[i][1] for i in range(n))) / 2.0


def _segment_distance(px, py, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / length))
    return math.hypot(px - a[0] - t * dx, py - a[1] - t * dy)


def validate_zones(zones) -> dict:
    """Normalise a zone document from the editor, or raise ValueError."""
    if not isinstance(zones, dict):
        raise ValueError("zones must be an object")

    def point(p, name):
        if not (isinstance(p, (list, tuple)) and len(p) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1 for v in p)):
            raise ValueError(f"{name}: points are [x, y] between 0 and 1")
        return [float(p[0]), float(p[1])]

    def poly(value, name):
        if not isinstance(value, list) or len(value) < 3 or len(value) > 64:
            raise ValueError(f"{name}: a polygon needs 3 to 64 points")
        return [point(p, name) for p in value]

    out = {"approaches": {}, "detection_zones": [], "counting_zones": [], "turning_zones": [], "calibration": None}
    for name, a in (zones.get("approaches") or {}).items():
        if name not in APPROACHES:
            raise ValueError(f"unknown approach: {name}")
        entry = {"polygon": poly(a.get("polygon"), name), "stop_line": None}
        if a.get("stop_line"):
            if not isinstance(a["stop_line"], list) or len(a["stop_line"]) != 2:
                raise ValueError(f"{name}: a stop line has 2 points")
            entry["stop_line"] = [point(p, name) for p in a["stop_line"]]
        out["approaches"][name] = entry
    for group in ("detection_zones", "counting_zones", "turning_zones"):
        for i, z in enumerate(zones.get(group) or []):
            zone = {"name": str(z.get("name") or f"{group[:-6]} {i + 1}")[:40], "polygon": poly(z.get("polygon"), group)}
            if group == "detection_zones" and z.get("role") == "downstream":
                zone["role"] = "downstream"
            out[group].append(zone)
    cal = zones.get("calibration")
    if cal:
        distance = cal.get("distance_m")
        if not (isinstance(distance, (int, float)) and 0 < distance < 1000):
            raise ValueError("calibration: distance_m must be between 0 and 1000")
        out["calibration"] = {"a": point(cal.get("a"), "calibration"), "b": point(cal.get("b"), "calibration"), "distance_m": float(distance)}
    return out


def congestion_level(occupancy: float | None, stopped_share: float, count: int) -> str:
    if not count or occupancy is None:
        return "LOW"
    if occupancy >= 0.7 or (occupancy >= 0.45 and stopped_share >= 0.6):
        return "SEVERE"
    if occupancy >= 0.45 or (occupancy >= 0.25 and stopped_share >= 0.5):
        return "HIGH"
    if occupancy >= 0.2 or stopped_share >= 0.3:
        return "MEDIUM"
    return "LOW"


def spillback_risk(approach: dict, downstream_capacity: float | None) -> str:
    if downstream_capacity is not None and downstream_capacity < 0.2:
        return "HIGH"
    if approach["occupancy"] >= 0.7 and approach["queue_vehicles"] >= 3:
        return "HIGH"
    if approach["occupancy"] >= 0.45 or (downstream_capacity is not None and downstream_capacity < 0.4):
        return "MEDIUM"
    return "LOW"


class TrafficAnalyzer:
    def __init__(self, zones: dict | None = None):
        self.zones = validate_zones(zones or {})
        self.tracks: dict[int, dict] = {}
        self.unique_total = 0
        self.arrivals: dict[str, deque] = {a: deque() for a in self.zones["approaches"]}
        self.departures: dict[str, deque] = {a: deque() for a in self.zones["approaches"]}
        self.counting: dict[str, set] = {z["name"]: set() for z in self.zones["counting_zones"]}
        self.turning: dict[str, int] = {}
        self.size = (1, 1)

    def metres_per_pixel(self) -> float | None:
        cal = self.zones["calibration"]
        if not cal:
            return None
        w, h = self.size
        pixels = math.hypot((cal["a"][0] - cal["b"][0]) * w, (cal["a"][1] - cal["b"][1]) * h)
        return cal["distance_m"] / pixels if pixels > 1 else None

    def observe(self, ts: float, width: int, height: int, objects: list[dict]) -> None:
        """Feed one frame. ts is the frame's timestamp in seconds; objects have track_id, cls, conf and box in pixels."""
        self.size = (width, height)
        for obj in objects:
            tid = obj.get("track_id")
            if tid is None:
                continue
            x1, y1, x2, y2 = obj["box"]
            # The middle of the box's bottom edge is the point closest to the road surface.
            cx, cy = (x1 + x2) / 2, y2
            t = self.tracks.get(tid)
            if t is None:
                t = self.tracks[tid] = {"history": deque(maxlen=40), "first_seen": ts, "stopped_since": None, "approach": None, "entry": None}
                self.unique_total += 1
            t.update(cls=obj["cls"], box=obj["box"], last_seen=ts, pos=(cx / width, cy / height))
            t["history"].append((ts, cx, cy))
            self._motion(t, ts, y2 - y1)
            self._zones(tid, t, ts, cx / width, cy / height)
        for tid in [k for k, t in self.tracks.items() if ts - t["last_seen"] > TRACK_TTL_S]:
            self._leave(self.tracks.pop(tid), ts)

    @staticmethod
    def _motion(t: dict, ts: float, box_height: float) -> None:
        recent = [h for h in t["history"] if ts - h[0] <= 1.5]
        t["speed_px"] = None
        if len(recent) >= 2 and recent[-1][0] - recent[0][0] >= 0.3:
            dt = recent[-1][0] - recent[0][0]
            t["speed_px"] = math.hypot(recent[-1][1] - recent[0][1], recent[-1][2] - recent[0][2]) / dt
            if t["speed_px"] < STOPPED_HEIGHTS_PER_S * max(box_height, 1.0):
                t["stopped_since"] = t["stopped_since"] or recent[0][0]
            else:
                t["stopped_since"] = None

    def _zones(self, tid: int, t: dict, ts: float, nx: float, ny: float) -> None:
        current = next((name for name, a in self.zones["approaches"].items() if point_in_polygon(nx, ny, a["polygon"])), None)
        if current != t["approach"]:
            self._leave(t, ts)
            if current:
                self.arrivals[current].append(ts)
                t["entry"] = t["entry"] or current
            t["approach"] = current
        for z in self.zones["counting_zones"]:
            if point_in_polygon(nx, ny, z["polygon"]):
                self.counting[z["name"]].add(tid)
        if t["entry"] and not t.get("turned"):
            for z in self.zones["turning_zones"]:
                if point_in_polygon(nx, ny, z["polygon"]):
                    key = f'{t["entry"]} -> {z["name"]}'
                    self.turning[key] = self.turning.get(key, 0) + 1
                    t["turned"] = True
                    break

    def _leave(self, t: dict, ts: float) -> None:
        if t["approach"]:
            self.departures[t["approach"]].append(ts)
            t["approach"] = None

    @staticmethod
    def _rate(events: deque, now: float) -> float:
        while events and now - events[0] > RATE_WINDOW_S:
            events.popleft()
        return len(events) * 60.0 / RATE_WINDOW_S

    def _box_share(self, box: list, polygon: list) -> float:
        w, h = self.size
        return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1]) / max(w * h * polygon_area(polygon), 1e-9)

    def snapshot(self, now: float) -> dict:
        """now is on the same clock as observe's ts."""
        scale = self.metres_per_pixel()
        current = [t for t in self.tracks.values() if t["last_seen"] >= now - 1.0]
        by_class = {c: sum(1 for t in current if t["cls"] == c) for c in CLASSES}
        stopped = [t for t in current if t["stopped_since"] is not None]
        speeds = [t["speed_px"] for t in current if t.get("speed_px") is not None]
        approaches = {name: self._approach(name, zone, current, now, scale) for name, zone in self.zones["approaches"].items()}
        downstream = self._downstream(current)
        occupancy = max((a["occupancy"] for a in approaches.values()), default=None)
        lengths = [a["queue_length_m"] for a in approaches.values() if a["queue_length_m"] is not None]
        mean_speed_px = sum(speeds) / len(speeds) if speeds else None
        stopped_share = len(stopped) / len(current) if current else 0.0
        for a in approaches.values():
            a["spillback_risk"] = spillback_risk(a, downstream)
        return {
            "zones_configured": bool(approaches), "calibrated": scale is not None,
            "quality": "calibrated_estimate" if scale is not None else "uncalibrated",
            "vehicle_count": len(current), "by_class": by_class, "unique_tracks": self.unique_total,
            "moving": len(current) - len(stopped), "stopped": len(stopped),
            "queue_vehicles": sum(a["queue_vehicles"] for a in approaches.values()) if approaches else None,
            "queue_length_m": max(lengths) if lengths else None,
            "average_speed_mps": round(mean_speed_px * scale, 2) if scale is not None and mean_speed_px is not None else None,
            "relative_speed_px_s": round(mean_speed_px, 1) if mean_speed_px is not None else None,
            "lane_occupancy": None if occupancy is None else round(occupancy, 3),
            "congestion_level": congestion_level(occupancy, stopped_share, len(current)) if approaches else None,
            "downstream_capacity": downstream, "approaches": approaches, "turning": dict(self.turning),
            "counting": {k: len(v) for k, v in self.counting.items()},
            "max_wait_s": round(max((now - t["stopped_since"] for t in stopped), default=0.0), 1),
        }

    def _approach(self, name: str, zone: dict, current: list, now: float, scale: float | None) -> dict:
        inside = [t for t in current if t.get("approach") == name]
        waiting = [t for t in inside if t["stopped_since"] is not None]
        queue_m = None
        if scale is not None and zone["stop_line"] and waiting:
            w, h = self.size
            a, b = [(p[0] * w, p[1] * h) for p in zone["stop_line"]]
            queue_m = round(max(_segment_distance(t["pos"][0] * w, t["pos"][1] * h, a, b) for t in waiting) * scale, 1)
        waits = [now - t["stopped_since"] for t in waiting]
        speeds = [t["speed_px"] for t in inside if t.get("speed_px") is not None]
        return {
            "axis": AXIS_OF[name], "vehicles": len(inside), "queue_vehicles": len(waiting), "queue_length_m": queue_m,
            "occupancy": round(min(1.0, sum(self._box_share(t["box"], zone["polygon"]) for t in inside)), 3),
            "density_per_area": round(len(inside) / max(polygon_area(zone["polygon"]), 1e-6), 1),
            "arrivals_per_min": round(self._rate(self.arrivals[name], now), 1), "departures_per_min": round(self._rate(self.departures[name], now), 1),
            "mean_wait_s": round(sum(waits) / len(waits), 1) if waits else 0.0, "max_wait_s": round(max(waits), 1) if waits else 0.0,
            "average_speed_mps": round(sum(speeds) / len(speeds) * scale, 2) if scale is not None and speeds else None,
        }

    def _downstream(self, current: list) -> float | None:
        zones = [z for z in self.zones["detection_zones"] if z.get("role") == "downstream"]
        if not zones:
            return None
        worst = 0.0
        for z in zones:
            share = sum(self._box_share(t["box"], z["polygon"]) for t in current if point_in_polygon(*t["pos"], z["polygon"]))
            worst = max(worst, min(1.0, share))
        return round(1.0 - worst, 3)
