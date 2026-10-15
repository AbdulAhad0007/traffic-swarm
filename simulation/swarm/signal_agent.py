"""Per-intersection agent state and decision logic (TraCI-free, unit-testable).

Each agent observes only its own approach lanes, publishes one observation to the blackboard and
reads only its direct neighbors. Decisions are made for the *current green phase* of the real
signal program:

  serve -> keep the current green for the optimizer's proposed total green
  yield -> end the current green as soon as its minimum allows

The optimizer's two-axis encoding is reused as "current phase (NS slot) vs competing phases
(EW slot)", so the existing PSO+ACO engine is unchanged. Clearance transitions (yellow, all-red,
pedestrian clearance) are never touched: the agent only changes the remaining duration of a
green phase, and SUMO then runs the programmed transition.
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field
from simulation.network.phase_map import PhaseMap, GreenPhase

MODE_SWARM = "swarm"            # agent controls green durations
MODE_NATIVE = "native"          # program not controllable (single green / invalid): SUMO program runs as-is
MODE_FALLBACK = "fallback"      # agent stopped after repeated failures: SUMO program runs as-is


@dataclass
class Observation:
    tls: str
    phase_index: int
    elapsed: float
    served_queue: float
    competing_queue: float
    competing_red: float          # longest red time among competing greens that have waiting traffic
    competing_demand: bool
    occupancy: float              # mean occupancy of this junction's incoming vehicle lanes [0, 1]


@dataclass
class SignalAgent:
    tls_id: str
    phase_map: PhaseMap
    neighbors: list
    mode: str = MODE_SWARM
    mode_reason: str = ""
    current_phase: int = -1
    phase_start: float = 0.0
    planned_total: float | None = None       # planned length of the current green (from its start)
    last_green_end: dict = field(default_factory=dict)
    consecutive_failures: int = 0
    counts: dict = field(default_factory=lambda: {"proposed": 0, "applied": 0, "rejected": 0, "deferred": 0})

    def __post_init__(self):
        if self.mode == MODE_SWARM and not self.phase_map.controllable:
            self.mode = MODE_NATIVE
            self.mode_reason = self.phase_map.status if not self.phase_map.issues else "invalid_program:" + ";".join(self.phase_map.issues)

    @property
    def active(self) -> bool:
        return self.mode == MODE_SWARM

    def current_green(self) -> GreenPhase | None:
        return self.phase_map.green_by_index(self.current_phase)

    def on_phase(self, phase_index: int, now: float, max_green: float) -> float | None:
        """Track phase changes. On entering a green phase, returns the remaining duration to set
        if the programmed duration violates [min_green, max_green]; otherwise None."""
        if phase_index == self.current_phase:
            return None
        previous = self.phase_map.green_by_index(self.current_phase)
        if previous is not None:
            self.last_green_end[previous.index] = now
        self.current_phase, self.phase_start, self.planned_total = phase_index, now, None
        green = self.current_green()
        if green is None or not self.active:
            return None
        bounded = min(max(green.duration, green.min_green), max(max_green, green.min_green))
        self.planned_total = bounded
        return bounded if bounded != green.duration else None

    def observe(self, now: float, halting, occupancy) -> Observation | None:
        """Build the local observation from per-lane values (callables lane -> value)."""
        green = self.current_green()
        all_lanes = sorted({lane for g in self.phase_map.greens for lane in g.served_lanes})
        occ = sum(occupancy(l) for l in all_lanes) / len(all_lanes) if all_lanes else 0.0
        if green is None:
            return Observation(self.tls_id, self.current_phase, now - self.phase_start, 0.0, 0.0, 0.0, False, occ)
        served_lanes = set(green.served_lanes)
        served = float(sum(halting(l) for l in served_lanes))
        competing, red, demand = 0.0, 0.0, False
        for other in self.phase_map.greens:
            if other.index == green.index:
                continue
            q = float(sum(halting(l) for l in other.served_lanes if l not in served_lanes))
            competing = max(competing, q)
            if q > 0:
                demand = True
                red = max(red, now - self.last_green_end.get(other.index, 0.0))
        return Observation(self.tls_id, self.current_phase, now - self.phase_start, served, competing, red, demand, occ)

    def record_failure(self, limit: int) -> bool:
        """Count a consecutive optimizer/apply failure; switch to fallback mode at the limit."""
        self.consecutive_failures += 1
        if self.consecutive_failures >= limit and self.mode == MODE_SWARM:
            self.mode, self.mode_reason = MODE_FALLBACK, f"{self.consecutive_failures}_consecutive_failures"
            return True
        return False


def downstream_saturation(green: GreenPhase, neighbor_obs: dict) -> tuple[float, int]:
    """Highest published occupancy among fresh downstream neighbors; and how many were unavailable."""
    values, missing = [], 0
    for n in green.downstream_tls:
        obs = neighbor_obs.get(n)
        if obs is None:
            missing += 1
        else:
            values.append(float(obs.occupancy))
    return (max(values) if values else 0.0), missing


def interpret(result: dict, elapsed: float, min_green: float) -> tuple[str, float]:
    """Map an optimizer result to (action, proposed total green). Raises ValueError if malformed."""
    direction = result.get("direction")
    green = result.get("green_seconds")
    if direction not in ("NS", "EW") or not isinstance(green, (int, float)) or not math.isfinite(green):
        raise ValueError(f"malformed optimizer result: direction={direction!r} green={green!r}")
    if direction == "NS":
        return "serve", float(green)
    return "yield", max(float(min_green), float(elapsed))
