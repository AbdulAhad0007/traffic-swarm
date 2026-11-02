"""Regional coordinators and a central supervisor for the `swarm_hierarchical` controller - SIMULATION ONLY.

Local agents still propose their own green times. Each region watches the exit lanes of its junctions and
reports when a road leaving the region's junctions is nearly full. While a region is escalated, the central
supervisor reviews its agents' proposals: an extension that would keep feeding a saturated road, while
other traffic is waiting, is cut back to end the green as soon as the minimum allows. The safety gate still has the final say on
every plan, and the supervisor can only ever shorten a green.

This changes signal timing, so it is its own controller variant with its own results: `swarm` never builds it.
Whether it helps is an experimental question answered by comparing the two variants.
"""
from __future__ import annotations
import math

# A completely full lane reads about 0.67 occupancy, because the gaps between stopped vehicles do not count.
DEFAULTS = {"exit_saturated_occupancy": 0.50, "exit_clear_occupancy": 0.30, "junctions_per_region_side": 3}


def partition_regions(nodes: list[dict], per_side: int = DEFAULTS["junctions_per_region_side"]) -> dict[str, list[str]]:
    """Split positioned junctions into a square grid of regions of about per_side x per_side junctions."""
    placed = [n for n in nodes if n.get("x") is not None]
    if not placed:
        return {"R1": [n["id"] for n in nodes]} if nodes else {}
    side = max(1, round(math.sqrt(len(placed)) / per_side))
    xs, ys = [n["x"] for n in placed], [n["y"] for n in placed]
    span_x, span_y = (max(xs) - min(xs)) or 1.0, (max(ys) - min(ys)) or 1.0
    cells: dict[tuple, list[str]] = {}
    for n in placed:
        cell = (min(side - 1, int((n["y"] - min(ys)) / span_y * side)), min(side - 1, int((n["x"] - min(xs)) / span_x * side)))
        cells.setdefault(cell, []).append(n["id"])
    return {f"R{i + 1}": sorted(cells[cell]) for i, cell in enumerate(sorted(cells))}


def review_extension(total: float, elapsed: float, min_green: float, exit_occupancy: float, competing: float, cfg: dict = DEFAULTS) -> tuple[str, float]:
    """Central rule, TraCI-free. Returns (verdict, approved total). Shorter or unchanged greens are never blocked."""
    earliest = max(elapsed, min_green)
    if total <= earliest:
        return "approved", total
    if exit_occupancy >= cfg["exit_saturated_occupancy"] and competing > 0:
        return "cut_back", earliest
    return "approved", total


class HierarchicalSupervisor:
    def __init__(self, model, agents: dict, nodes: list[dict], options: dict | None = None):
        self.cfg = {**DEFAULTS, **(options or {})}
        self.regions = partition_regions(nodes, self.cfg["junctions_per_region_side"])
        self.region_of = {t: r for r, members in self.regions.items() for t in members}
        self.exits: dict[str, dict[int, list[str]]] = {}
        for tid, agent in agents.items():
            by_green = {}
            for green in agent.phase_map.greens:
                lanes = {l.to_lane for i in green.served_links for l in model.tls[tid].links.get(i, []) if not l.pedestrian and l.to_lane}
                by_green[green.index] = sorted(lanes)
            self.exits[tid] = by_green
        self.escalated: dict[str, dict] = {}
        self.reported: set = set()
        self.counts = {"reviews": 0, "approved": 0, "cut_back": 0, "escalations": 0}

    def _peak(self, tid: str, phase: int, occupancy) -> float:
        return max((occupancy(l) for l in self.exits.get(tid, {}).get(phase, [])), default=0.0)

    def tick(self, now: float, occupancy, events: list) -> None:
        """Regions check their junctions' exit lanes; a change of state is reported upward."""
        for region, members in self.regions.items():
            worst, peak = None, 0.0
            for tid in members:
                for phase in self.exits.get(tid, {}):
                    value = self._peak(tid, phase, occupancy)
                    if value > peak:
                        worst, peak = tid, value
            if region not in self.escalated and peak >= self.cfg["exit_saturated_occupancy"]:
                self.escalated[region] = {"since": now}
                self.counts["escalations"] += 1
                events.append({"event": "regional_report", "time": now, "from": worst, "to": region, "peak_exit_occupancy": round(peak, 3),
                               "text": f"{worst} reports a road ahead at {peak:.0%} occupancy."})
                events.append({"event": "regional_escalation", "time": now, "from": region, "to": "CENTRAL", "region": region, "junctions": members,
                               "peak_exit_occupancy": round(peak, 3), "text": f"{region} asks for network-level review: downstream road nearly full."})
            elif region in self.escalated and peak < self.cfg["exit_clear_occupancy"]:
                del self.escalated[region]
                events.append({"event": "regional_clear", "time": now, "from": region, "to": "CENTRAL", "region": region,
                               "peak_exit_occupancy": round(peak, 3), "text": f"{region} has recovered; review ended."})

    def review(self, rec: dict, green, now: float, total: float, elapsed: float, competing: float, occupancy, events: list) -> float:
        tid = rec["intersection"]
        region = self.region_of.get(tid)
        if region not in self.escalated:
            return total
        peak = self._peak(tid, green.index, occupancy)
        verdict, approved = review_extension(total, elapsed, green.min_green, peak, competing, self.cfg)
        self.counts["reviews"] += 1
        self.counts[verdict] += 1
        rec["supervisor"] = verdict
        # Repeated approvals of the same green say nothing new; every cut-back is reported.
        key = (tid, green.index, round(now - elapsed))
        if verdict == "cut_back" or key not in self.reported:
            self.reported.add(key)
            why = (f"Road ahead is {peak:.0%} full and {competing:.0f} vehicles wait on other approaches: end this green at {approved:.0f}s instead of {total:.0f}s."
                   if verdict == "cut_back" else f"Road ahead is {peak:.0%} full, within limits: green of {approved:.0f}s approved.")
            events.append({"event": "central_decision", "time": now, "from": "CENTRAL", "to": tid, "region": region, "verdict": verdict,
                           "proposed_total_s": round(total, 2), "approved_total_s": round(approved, 2), "peak_exit_occupancy": round(peak, 3), "text": why})
        return approved

    def report(self) -> dict:
        return {"hierarchy": {**self.counts, "regions": self.regions, "options": self.cfg}}
