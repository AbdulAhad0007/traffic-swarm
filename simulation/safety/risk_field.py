"""Hard safety constraints for signal decisions.

The gate never looks at the optimizer score: it only sees the proposed timing, the measured
phase state and configured limits. Safety rejection always overrides optimization.

Note: this module validates a *supplied* risk value; it does not compute a risk field.
"""
from __future__ import annotations
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class SafetyDecision:
    allowed: bool
    green_seconds: float | None
    reason: str
    fallback: bool = False


class SafetyGate:
    """Hard constraint layer: safety rejection always overrides optimization."""
    def __init__(self, min_green=10, max_green=60, max_risk=1.0, max_continuous_green=90.0, max_red=120.0):
        self.min_green, self.max_green, self.max_risk = min_green, max_green, max_risk
        self.max_continuous_green = max_continuous_green
        self.max_red = max_red

    def validate(self, direction, green, risk, current_phase=None, continuous_green=0.0):
        """Legacy two-direction check (kept for the FastAPI/demo path and existing tests)."""
        if direction not in ("NS", "EW"):
            return SafetyDecision(False, float(self.min_green), "invalid_direction", True)
        if risk is None or risk < 0:
            return SafetyDecision(False, float(self.min_green), "invalid_risk", True)
        if risk > self.max_risk:
            return SafetyDecision(False, float(self.min_green), "risk_limit_exceeded", True)
        if not self.min_green <= green <= self.max_green:
            return SafetyDecision(False, float(self.min_green), "green_out_of_bounds", True)
        if continuous_green >= self.max_continuous_green:
            return SafetyDecision(False, float(self.min_green), "fairness_cap_reached", True)
        return SafetyDecision(True, float(green), "validated", False)

    def validate_green_plan(self, proposed_total, elapsed, min_green, risk=0.0,
                            competing_red=0.0, competing_demand=False) -> SafetyDecision:
        """Validate the total length of the *current* green phase, measured from its start.

        Returns the total green the controller may apply. A rejected decision (allowed=False)
        means: keep the existing plan unchanged (safe operating mode).
        - min_green is the effective minimum for this phase (pedestrian minimum included)
        - max_green is measured from phase start, never from "now"
        - if a competing phase with waiting traffic has been red for >= max_red, the current
          green must end as soon as its minimum allows (anti-starvation)
        """
        try:
            proposed = float(proposed_total)
            elapsed = float(elapsed)
            min_green = float(min_green)
        except (TypeError, ValueError):
            return SafetyDecision(False, None, "invalid_proposal", True)
        if not (math.isfinite(proposed) and math.isfinite(elapsed) and math.isfinite(min_green)):
            return SafetyDecision(False, None, "invalid_proposal", True)
        if risk is None or not math.isfinite(float(risk)) or risk < 0:
            return SafetyDecision(False, None, "invalid_risk", True)
        if risk > self.max_risk:
            return SafetyDecision(False, None, "risk_limit_exceeded", True)
        upper = max(float(self.max_green), min_green)
        if competing_demand and competing_red >= self.max_red:
            return SafetyDecision(True, max(min_green, min(elapsed, upper)), "fairness_max_red")
        if proposed < min_green:
            return SafetyDecision(True, min_green, "clamped_min_green")
        if proposed > upper:
            return SafetyDecision(True, upper, "clamped_max_green")
        return SafetyDecision(True, proposed, "validated")
