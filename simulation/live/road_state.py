"""Road-level traffic state for the Command Center: six congestion levels, storage and spillback.

Separate from the four junction levels in congestion.py, which prediction training also uses.
Vehicle count, halting, occupancy, speed and waiting time are measured by SUMO. Capacity is an ESTIMATE:
lane metres divided by a typical vehicle length plus gap. The thresholds are display conventions in
simulation/config/live.json (`road_state`), not a level-of-service standard.
"""
from __future__ import annotations

LEVELS = ("free", "normal", "busy", "heavy", "severe", "blocked")
DEFAULTS = {"vehicle_spacing_m": 7.5, "occupancy": [0.10, 0.20, 0.35, 0.55], "red_queue_cap_used": 0.5, "blocked_used": 0.85,
            "blocked_speed_mps": 1.0, "spillback_on_used": 0.85, "spillback_off_used": 0.70, "sample_interval_s": 5}


def estimated_capacity(length_m: float, lanes: int, spacing_m: float) -> int:
    return max(1, int(float(length_m) * max(1, int(lanes)) / float(spacing_m)))


def classify_road(count: int, occupancy: float, speed: float, used: float, at_red: bool, growth: int, downstream_used: float, cfg: dict = DEFAULTS) -> str:
    """A queue waiting at a red light is normal operation, so on its own it is held at 'busy' unless it is long or growing."""
    if count <= 0:
        return "free"
    if used >= cfg["blocked_used"] and speed < cfg["blocked_speed_mps"] and (not at_red or downstream_used >= cfg["blocked_used"]):
        return "blocked"
    index = sum(1 for bound in cfg["occupancy"] if occupancy > bound)
    if at_red and used < cfg["red_queue_cap_used"] and growth <= 0:
        index = min(index, 2)
    return LEVELS[index]


class SpillbackTracker:
    """Reports when a road becomes nearly full and when it recovers, with hysteresis so a boundary value cannot flicker."""
    def __init__(self, on: float, off: float):
        self.on, self.off = on, off
        self.active: set = set()

    def observe(self, road: str, used: float) -> str | None:
        if road not in self.active and used >= self.on:
            self.active.add(road)
            return "spillback_warning"
        if road in self.active and used < self.off:
            self.active.remove(road)
            return "spillback_cleared"
        return None


class RoadMonitor:
    """Builds one column-oriented sample of every road. `edges` is the network3d edge list."""
    def __init__(self, model, edges: list, cfg: dict | None = None):
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.edges = edges
        self.capacity = [estimated_capacity(e["length"], e.get("drive_lanes", e["lanes"]), self.cfg["vehicle_spacing_m"]) for e in edges]
        self.spillback = SpillbackTracker(self.cfg["spillback_on_used"], self.cfg["spillback_off_used"])
        self.events: list[dict] = []
        index = {e["id"]: i for i, e in enumerate(edges)}
        self.approach: list[list] = [[] for _ in edges]     # (tls, link index) controlling the end of this road
        self.upstream: list[str | None] = [None] * len(edges)
        self.next_roads: list[set] = [set() for _ in edges]
        for tid, tl in model.tls.items():
            for link_index, links in tl.links.items():
                for link in links:
                    if link.pedestrian:
                        continue
                    a = index.get(link.from_edge)
                    b = index.get(link.to_lane.rsplit("_", 1)[0]) if link.to_lane else None
                    if a is not None:
                        self.approach[a].append((tid, link_index))
                    if b is not None:
                        self.upstream[b] = tid
                    if a is not None and b is not None:
                        self.next_roads[a].add(b)
        self.previous = [0] * len(edges)

    def _at_red(self, i: int, tl_values: dict, state_key) -> bool:
        if not self.approach[i]:
            return False
        for tid, link in self.approach[i]:
            state = tl_values.get(tid, {}).get(state_key, "")
            if link < len(state) and state[link] in "GgyYu":
                return False
        return True

    def sample(self, now: float, measured: list, entered: list, left: list, tl_values: dict, state_key) -> dict:
        """measured[i] = (count, halting, occupancy, mean speed, waiting s)."""
        used = [m[0] / cap for m, cap in zip(measured, self.capacity)]
        out = {"t": now, "n": [], "q": [], "o": [], "v": [], "w": [], "u": [], "g": [], "l": [], "in": list(entered), "out": list(left)}
        for i, (count, halting, occupancy, speed, waiting) in enumerate(measured):
            growth = count - self.previous[i]
            self.previous[i] = count
            downstream = max((used[j] for j in self.next_roads[i]), default=0.0)
            level = classify_road(count, occupancy, speed, used[i], self._at_red(i, tl_values, state_key), growth, downstream, self.cfg)
            out["n"].append(count)
            out["q"].append(halting)
            out["o"].append(round(occupancy, 3))
            out["v"].append(round(speed, 1))
            out["w"].append(round(waiting))
            out["u"].append(round(used[i], 3))
            out["g"].append(growth)
            out["l"].append(LEVELS.index(level))
            change = self.spillback.observe(self.edges[i]["id"], used[i])
            if change:
                self.events.append({"t": now, "kind": change, "road": self.edges[i]["id"], "edge": i, "vehicles": count,
                                    "estimated_capacity": self.capacity[i], "used": round(used[i], 3), "upstream": self.upstream[i]})
        return out
