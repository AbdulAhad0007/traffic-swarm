"""Derive controllable green phases and clearance transitions from a real SUMO signal program.

No phase index is ever assumed to mean a direction. Each phase is classified from its state
string, and each green phase is described by the movements (link indices / incoming lanes)
it actually serves. The approach axis ("NS", "EW" or "MIXED") is computed from geometry and is
informational only.

Phase kinds:
  green      - serves at least one movement and is not a reduction of the previous phase
  yellow     - contains 'y'/'Y' (or 'u' red-yellow): a clearance transition
  all_red    - no movement has right of way
  clearance  - keeps a strict subset of the previous phase's greens (e.g. pedestrian clearance)
Only green phases are ever extended or shortened by the controller; transitions always run
with their programmed durations.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from simulation.network.network_model import NetworkModel, TrafficLight

GREEN_CHARS = "Gg"
YELLOW_CHARS = "yYu"
OFF_CHARS = "oO"


@dataclass(frozen=True)
class GreenPhase:
    index: int
    duration: float
    state: str
    served_links: frozenset
    served_lanes: tuple            # incoming vehicle lanes with right of way in this phase
    axis: str                      # "NS", "EW" or "MIXED" (informational)
    serves_pedestrians: bool
    min_green: float               # effective minimum (pedestrian minimum applied when needed)
    downstream_tls: tuple          # TLS reached by the served vehicle movements
    transition: tuple              # phase indices from the end of this green to the next green
    yellow_s: float
    all_red_s: float
    clearance_s: float


@dataclass
class PhaseMap:
    tls_id: str
    kinds: list                    # kind per phase index
    greens: list                   # GreenPhase in program order
    issues: list = field(default_factory=list)

    @property
    def controllable(self) -> bool:
        return not self.issues and len(self.greens) >= 2

    @property
    def status(self) -> str:
        if self.issues:
            return "invalid_program"
        if len(self.greens) < 2:
            return "single_green_phase"
        return "controllable"

    def green_by_index(self, phase_index: int) -> GreenPhase | None:
        for g in self.greens:
            if g.index == phase_index:
                return g
        return None

    def is_green(self, phase_index: int) -> bool:
        return 0 <= phase_index < len(self.kinds) and self.kinds[phase_index] == "green"


def classify_phases(states: list[str]) -> list[str]:
    kinds = []
    n = len(states)
    for i, state in enumerate(states):
        if any(ch in YELLOW_CHARS for ch in state):
            kinds.append("yellow")
            continue
        greens = {k for k, ch in enumerate(state) if ch in GREEN_CHARS}
        if not greens:
            kinds.append("all_red")
            continue
        prev = states[(i - 1) % n]
        prev_greens = {k for k, ch in enumerate(prev) if ch in GREEN_CHARS}
        kinds.append("clearance" if n > 1 and greens < prev_greens else "green")
    return kinds


def validate_program(states: list[str], durations: list[float], vehicle_links: set, link_count: int,
                     min_yellow: float) -> list[str]:
    """Return a list of safety problems in a program. Empty list = safe to control."""
    issues = []
    if not states:
        return ["empty_program"]
    for i, s in enumerate(states):
        if len(s) != link_count:
            issues.append(f"phase_{i}_state_length_{len(s)}_expected_{link_count}")
        if any(ch in OFF_CHARS for ch in s):
            issues.append(f"phase_{i}_contains_off_signal")
    if issues:
        return issues
    n = len(states)
    for i in range(n):
        cur, nxt = states[i], states[(i + 1) % n]
        for k in vehicle_links:
            if cur[k] in GREEN_CHARS and nxt[k] in "rs":
                issues.append(f"missing_yellow_link_{k}_phase_{i}_to_{(i + 1) % n}")
    # Every yellow run that ends in red must last at least min_yellow seconds.
    for k in vehicle_links:
        for start in range(n):
            if states[start][k] not in "yY" or states[(start - 1) % n][k] in "yY":
                continue
            total, j = 0.0, start
            while states[j % n][k] in "yY" and j - start < n:
                total += durations[j % n]
                j += 1
            if states[j % n][k] in "rs" and total + 1e-9 < min_yellow:
                issues.append(f"yellow_too_short_link_{k}_phase_{start}_{total:g}s")
    return issues


def _axis(sides: set) -> str:
    if not sides:
        return "MIXED"
    if sides <= {"N", "S"}:
        return "NS"
    if sides <= {"E", "W"}:
        return "EW"
    return "MIXED"


def build_phase_map(model: NetworkModel, tls_id: str, settings: dict) -> PhaseMap:
    tl: TrafficLight = model.tls[tls_id]
    states = [p.state for p in tl.phases]
    durations = [p.duration for p in tl.phases]
    vehicle_links = {i for i, ls in tl.links.items() if any(not l.pedestrian for l in ls)}
    ped_links = {i for i, ls in tl.links.items() if all(l.pedestrian for l in ls)}
    kinds = classify_phases(states)
    issues = validate_program(states, durations, vehicle_links, tl.link_count, float(settings.get("min_yellow_s", 3)))
    greens = []
    if not issues:
        n = len(states)
        green_indices = [i for i, k in enumerate(kinds) if k == "green"]
        for i in green_indices:
            state = states[i]
            served = frozenset(k for k, ch in enumerate(state) if ch in GREEN_CHARS)
            lanes, straight_sides, all_sides, downstream = [], set(), set(), set()
            for k in sorted(served & vehicle_links):
                for link in tl.links[k]:
                    if link.pedestrian:
                        continue
                    if link.from_lane not in lanes:
                        lanes.append(link.from_lane)
                    if link.approach:
                        all_sides.add(link.approach)
                        if link.direction == "s":
                            straight_sides.add(link.approach)
                downstream.update(model.downstream_tls(tls_id, k))
            transition, j = [], (i + 1) % n
            while kinds[j] != "green" and len(transition) < n:
                transition.append(j)
                j = (j + 1) % n
            ped = bool(served & ped_links)
            min_green = float(settings.get("min_green_s", 10))
            if ped:
                min_green = max(min_green, float(settings.get("pedestrian_min_green_s", min_green)))
            greens.append(GreenPhase(
                index=i, duration=durations[i], state=state, served_links=served, served_lanes=tuple(lanes),
                axis=_axis(straight_sides or all_sides), serves_pedestrians=ped, min_green=min_green,
                downstream_tls=tuple(sorted(downstream)), transition=tuple(transition),
                yellow_s=sum(durations[t] for t in transition if kinds[t] == "yellow"),
                all_red_s=sum(durations[t] for t in transition if kinds[t] == "all_red"),
                clearance_s=sum(durations[t] for t in transition if kinds[t] == "clearance")))
    return PhaseMap(tls_id, kinds, greens, issues)


def build_all(model: NetworkModel, settings: dict) -> dict[str, PhaseMap]:
    return {t: build_phase_map(model, t, settings) for t in model.tls_ids}
