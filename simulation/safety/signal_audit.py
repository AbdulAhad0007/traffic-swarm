"""Independent per-step audit of the signal states SUMO actually displayed.

It does not trust controller logs. For every TLS and every vehicle link it checks:
  - missing_yellow:  a link went from green (G/g) straight to red/stop without yellow
  - short_yellow:    a yellow interval that ended in red lasted less than min_yellow
For TLS listed in `green_bounds` it also checks the length of each completed green phase:
  - green_too_long:  longer than max_green (+ one step tolerance)
  - green_too_short: shorter than that phase's minimum green (- one step tolerance)
Pedestrian links may go green -> red directly (no yellow for pedestrian signals).
"""
from __future__ import annotations


class SignalAuditor:
    def __init__(self, vehicle_links: dict, min_yellow: float, step: float = 1.0,
                 green_bounds: dict | None = None, max_violations_logged: int = 200, exempt: dict | None = None):
        self.vehicle_links = {t: sorted(v) for t, v in vehicle_links.items()}
        self.min_yellow = float(min_yellow)
        self.step = float(step)
        self.green_bounds = green_bounds or {}      # tls -> {phase_index: (min_green, max_green)}
        self.last_state: dict[str, str] = {}
        self.yellow_since: dict[tuple[str, int], float] = {}
        self.phase_since: dict[str, tuple[int, float]] = {}
        self.violations: dict[str, int] = {"missing_yellow": 0, "short_yellow": 0, "green_too_long": 0, "green_too_short": 0}
        self.examples: list[dict] = []
        # TLS whose (imported) program already failed validation: never controlled by the swarm,
        # so their violations come from SUMO's own program and are reported separately.
        self.exempt = dict(exempt or {})
        self.native_program_violations: dict[str, int] = {}
        self.max_logged = max_violations_logged
        self.steps = 0

    def _violate(self, kind: str, **detail) -> None:
        if detail.get("tls") in self.exempt:
            self.native_program_violations[kind] = self.native_program_violations.get(kind, 0) + 1
            return
        self.violations[kind] += 1
        if len(self.examples) < self.max_logged:
            self.examples.append({"kind": kind, **detail})

    def observe(self, now: float, tls_id: str, state: str, phase_index: int | None = None) -> None:
        prev = self.last_state.get(tls_id)
        if prev is not None and prev != state:
            for k in self.vehicle_links.get(tls_id, []):
                if k >= len(state) or k >= len(prev):
                    continue
                a, b = prev[k], state[k]
                if a in "Gg" and b in "rs":
                    self._violate("missing_yellow", time=now, tls=tls_id, link=k, prev=prev, state=state)
                if b in "yY" and a not in "yY":
                    self.yellow_since[(tls_id, k)] = now
                if a in "yY" and b in "rs":
                    started = self.yellow_since.pop((tls_id, k), None)
                    if started is not None and now - started + 1e-9 < self.min_yellow:
                        self._violate("short_yellow", time=now, tls=tls_id, link=k, duration=now - started)
        self.last_state[tls_id] = state
        if phase_index is not None and tls_id in self.green_bounds:
            since = self.phase_since.get(tls_id)
            if since is None:
                self.phase_since[tls_id] = (phase_index, now)
            elif since[0] != phase_index:
                old, start = since
                bounds = self.green_bounds[tls_id].get(old)
                # The very first phase (started before observation began) is not judged.
                if bounds is not None and start > 0:
                    length = now - start
                    lo, hi = bounds
                    if length > hi + self.step + 1e-9:
                        self._violate("green_too_long", time=now, tls=tls_id, phase=old, length=length, max=hi)
                    if length < lo - self.step - 1e-9:
                        self._violate("green_too_short", time=now, tls=tls_id, phase=old, length=length, min=lo)
                self.phase_since[tls_id] = (phase_index, now)

    def report(self) -> dict:
        return {"total_violations": sum(self.violations.values()), "by_kind": dict(self.violations),
                "examples": self.examples[:20], "tls_audited": len(self.vehicle_links),
                "exempt_tls": self.exempt, "native_program_violations": self.native_program_violations}


def build_auditor(model, settings: dict, phase_maps: dict | None = None, max_green: float | None = None) -> SignalAuditor:
    """Auditor for every TLS in `model`; green-length bounds only for the given (controlled) phase maps."""
    from simulation.network.phase_map import build_all
    vehicle_links = {t: [i for i, ls in tl.links.items() if any(not l.pedestrian for l in ls)] for t, tl in model.tls.items()}
    exempt = {t: pm.issues for t, pm in build_all(model, settings).items() if pm.issues}
    bounds = {}
    for tid, pm in (phase_maps or {}).items():
        upper = float(max_green if max_green is not None else settings["max_green_s"])
        bounds[tid] = {g.index: (g.min_green, max(upper, g.min_green)) for g in pm.greens}
    return SignalAuditor(vehicle_links, float(settings.get("min_yellow_s", 3)), green_bounds=bounds, exempt=exempt)
