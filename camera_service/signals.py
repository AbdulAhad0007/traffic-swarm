"""Signal plans: the safety validator and the three control modes.

Nothing reaches a signal without passing validate_plan, and the validator knows nothing about how a plan was made.
Physical signal control does not exist in this code: real-controller mode can only be refused until a certified
adapter is written and configured, and no such adapter ships with the project.
"""
from __future__ import annotations
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field

from camera_service.settings import ROOT, SIGNAL_LIMITS

log = logging.getLogger("camera.signals")
MODE_SIMULATION, MODE_SHADOW, MODE_REAL = "SIMULATION", "SHADOW", "REAL_CONTROLLER"
MODES = (MODE_SIMULATION, MODE_SHADOW, MODE_REAL)
AXES = ("NS", "EW")


@dataclass
class PlanContext:
    """What the validator needs to know about the signal right now."""
    current_axis: str | None
    in_clearance: bool
    elapsed_s: float
    yellow_s: float
    all_red_s: float
    min_green_s: float = SIGNAL_LIMITS["min_green_s"]
    max_green_s: float = SIGNAL_LIMITS["max_green_s"]
    pedestrian_green: bool = False


@dataclass
class Validation:
    status: str                      # APPROVED, ADJUSTED or REJECTED
    approved_axis: str | None
    approved_green_s: float | None
    action: str                      # extend, end_green, hold or none
    reasons: list = field(default_factory=list)


def validate_plan(axis, green_s, ctx: PlanContext, state_age_s: float, limits: dict = SIGNAL_LIMITS) -> Validation:
    """Hard rules. A plan may be fitted to its limits or refused; it can never skip clearance."""
    def refuse(reason, action="none"):
        return Validation("REJECTED", None, None, action, [reason])

    if axis not in AXES:
        return refuse(f"unknown phase group {axis!r}")
    if not isinstance(green_s, (int, float)) or isinstance(green_s, bool) or green_s != green_s or green_s <= 0:
        return refuse("green duration is not a positive number")
    if state_age_s > limits["max_state_age_s"]:
        return refuse(f"traffic state is {state_age_s:.1f}s old, over the {limits['max_state_age_s']:.0f}s limit")
    if ctx.yellow_s < limits["min_yellow_s"]:
        return refuse(f"programmed yellow {ctx.yellow_s:.1f}s is below the {limits['min_yellow_s']:.0f}s minimum")
    if ctx.all_red_s < limits["min_all_red_s"]:
        return refuse(f"programmed all-red {ctx.all_red_s:.1f}s is below the {limits['min_all_red_s']:.0f}s minimum")
    if ctx.in_clearance:
        return refuse("signal is in yellow or all-red; clearance always runs to its end")
    if ctx.current_axis is None:
        return refuse("current signal phase is unknown")

    floor = max(limits["min_green_s"], ctx.min_green_s)
    if ctx.pedestrian_green:
        floor = max(floor, limits["pedestrian_min_green_s"])
    ceiling = min(limits["max_green_s"], ctx.max_green_s)
    reasons, adjusted = [], False
    total = float(green_s)
    if total < floor:
        total, adjusted = floor, True
        reasons.append(f"raised to the {floor:.0f}s minimum green")
    if total > ceiling:
        total, adjusted = ceiling, True
        reasons.append(f"cut to the {ceiling:.0f}s maximum green")

    if axis == ctx.current_axis:
        total = min(max(total, ctx.elapsed_s), ceiling)
        reasons.append(f"keep {axis} green to {total:.0f}s")
        return Validation("ADJUSTED" if adjusted else "APPROVED", axis, round(total, 1), "extend", reasons)
    if ctx.elapsed_s + 1e-9 < floor:
        return refuse(f"{ctx.current_axis} green has run {ctx.elapsed_s:.0f}s of its {floor:.0f}s minimum; change deferred", "hold")
    reasons.append(f"end {ctx.current_axis} green; {ctx.yellow_s:.0f}s yellow and {ctx.all_red_s:.0f}s all-red run before {axis}")
    return Validation("ADJUSTED" if adjusted else "APPROVED", axis, round(total, 1), "end_green", reasons)


class ShadowController:
    """A virtual signal, driven only by approved plans. It holds no connection to anything outside this process."""
    YELLOW, ALL_RED = SIGNAL_LIMITS["min_yellow_s"], SIGNAL_LIMITS["min_all_red_s"]

    def __init__(self, clock=time.time):
        self.clock = clock
        self.states: dict[str, dict] = {}

    def _state(self, key: str) -> dict:
        now = self.clock()
        s = self.states.setdefault(key, {"axis": "NS", "since": now, "next": None, "clear_until": None})
        if s["clear_until"] is not None and now >= s["clear_until"]:
            s.update(axis=s["next"], since=s["clear_until"], next=None, clear_until=None)
        return s

    def context(self, key: str) -> PlanContext:
        s = self._state(key)
        return PlanContext(s["axis"], s["clear_until"] is not None, self.clock() - s["since"], self.YELLOW, self.ALL_RED)

    def apply(self, key: str, validation: Validation) -> dict:
        s = self._state(key)
        if validation.action == "end_green":
            s.update(next=validation.approved_axis, clear_until=self.clock() + self.YELLOW + self.ALL_RED)
        return {"applied": False, "virtual": True, "state": self.describe(key), "note": "Recommendation only. No signal was changed."}

    def describe(self, key: str) -> dict:
        s = self._state(key)
        return {"axis": s["axis"], "elapsed_s": round(self.clock() - s["since"], 1), "in_clearance": s["clear_until"] is not None, "next_axis": s["next"], "source": "virtual"}


class RealControllerGate:
    """Always refuses. Adding real control means writing a certified adapter here, with its own review."""
    REFUSAL = ("Real controller mode is unavailable: no authorized, certified traffic controller interface is configured. "
               "This project contains no code that sends commands to signal hardware.")
    configured = False

    def send(self, *_a, **_k):
        raise PermissionError(self.REFUSAL)


def _prepare_sumo_environment() -> None:
    try:
        import sumo
        os.environ.setdefault("SUMO_HOME", str(sumo.SUMO_HOME))
        bin_dir = os.path.join(str(sumo.SUMO_HOME), "bin")
        if bin_dir not in os.environ.get("PATH", ""):
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    except ImportError:
        pass
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))


class SumoBridge:
    """Runs the existing grid scenario under TraCI and applies approved plans to it. SIMULATION ONLY."""

    def __init__(self, network: str = "grid3x3", scenario: str = "rush-hour", seed: int = 42, step_s: float = 0.2):
        # A generated network: its signals have all-red clearance. The legacy hand-written grid has none, so the validator refuses every plan for it.
        self.network, self.scenario = network, scenario
        self.sumocfg = None
        self.seed, self.step_s = seed, step_s
        self.lock = threading.RLock()
        self.running = False
        self.thread = None
        self.conn = None
        self.phase_maps: dict = {}
        self.phase_since: dict = {}
        self.auditor = None
        self.settings: dict = {}
        self.error = None
        self.now = 0.0
        self.applied = 0

    def _args(self) -> list[str]:
        return ["-c", self.sumocfg, "--seed", str(self.seed), "--no-step-log", "true", "--no-warnings", "true"]

    def start(self, background: bool = True) -> None:
        with self.lock:
            if self.running:
                return
            _prepare_sumo_environment()
            import traci
            from simulation.network.grid_generator import find_sumo_binary
            from simulation.network.network_model import NetworkModel
            from simulation.network.phase_map import build_all
            from simulation.network.presets import resolve_preset
            from simulation.runtime import net_file_from_cfg
            from simulation.safety.signal_audit import build_auditor
            from experiments.tools.run_experiment import prepare
            from camera_service.settings import RUNTIME
            self.sumocfg = str(prepare(self.scenario, self.seed, ROOT, network=self.network, run_dir=RUNTIME / "sumo" / self.network)[1])
            self.settings = dict(resolve_preset(self.network)["controller"])
            model = NetworkModel.from_net_file(net_file_from_cfg(self.sumocfg))
            self.phase_maps = {t: pm for t, pm in build_all(model, self.settings).items() if pm.controllable}
            self.auditor = build_auditor(model, self.settings, self.phase_maps)
            binary = find_sumo_binary("sumo")
            if binary is None:
                raise RuntimeError("SUMO is not installed.")
            label = f"lcm-{id(self)}"
            traci.start([binary, *self._args()], label=label)
            self.conn = traci.getConnection(label)
            self.running, self.error, self.applied, self.now = True, None, 0, 0.0
            self.phase_since = {}
            self.advance()
            if background:
                self.thread = threading.Thread(target=self._loop, name="lcm-sumo", daemon=True)
                self.thread.start()

    def _loop(self) -> None:
        try:
            while self.running:
                self.advance()
                time.sleep(self.step_s)
        except Exception as err:
            if self.running:
                self.error = f"{type(err).__name__}: {err}"
                log.warning("SUMO bridge stopped: %s", self.error)
            self.running = False

    def advance(self) -> None:
        with self.lock:
            if self.conn is None:
                return
            self.conn.simulationStep()
            self.now = self.conn.simulation.getTime()
            if self.conn.simulation.getMinExpectedNumber() <= 0:
                self.conn.load(self._args())      # the scenario's traffic ended: run it again
                self.phase_since.clear()
                self.auditor.last_state.clear()
                self.auditor.phase_since.clear()
                self.auditor.yellow_since.clear()
                return
            for tls in self.phase_maps:
                phase = self.conn.trafficlight.getPhase(tls)
                self.auditor.observe(self.now, tls, self.conn.trafficlight.getRedYellowGreenState(tls), phase)
                if self.phase_since.get(tls, (None,))[0] != phase:
                    self.phase_since[tls] = (phase, self.now)

    def stop(self) -> None:
        self.running = False
        thread, self.thread = self.thread, None
        if thread and thread is not threading.current_thread():
            thread.join(timeout=3)
        with self.lock:
            if self.conn:
                try:
                    self.conn.close()
                except Exception:
                    pass
            self.conn = None

    def context(self, tls: str) -> PlanContext:
        with self.lock:
            pm = self.phase_maps[tls]
            phase = self.conn.trafficlight.getPhase(tls)
            green = pm.green_by_index(phase)
            if green is None:
                any_green = pm.greens[0]
                return PlanContext(None, True, 0.0, any_green.yellow_s, any_green.all_red_s)
            since = self.phase_since.get(tls, (phase, self.now))[1]
            return PlanContext(green.axis if green.axis in AXES else None, False, self.now - since, green.yellow_s, green.all_red_s,
                               green.min_green, float(self.settings["max_green_s"]), green.serves_pedestrians)

    def apply(self, tls: str, validation: Validation) -> dict:
        """Change only the remaining time of the current green, so the signal program's own clearance always runs."""
        from simulation.swarm.adaptive_controller import apply_green_duration
        with self.lock:
            api = self.conn.trafficlight
            phase, before = api.getPhase(tls), api.getRedYellowGreenState(tls)
            ctx = self.context(tls)
            if validation.action == "extend":
                remaining = max(0.0, validation.approved_green_s - ctx.elapsed_s)
            elif validation.action == "end_green":
                remaining = 0.0
            else:
                return {"applied": False, "reason": "nothing to apply", "tls": tls}
            ok, reason = apply_green_duration(api, tls, phase, before, remaining)
            self.applied += int(ok)
            return {"applied": ok, "reason": reason, "tls": tls, "phase": phase, "state_before": before, "remaining_s": round(remaining, 1), "sim_time": self.now}

    def state(self, tls: str) -> dict:
        with self.lock:
            api = self.conn.trafficlight
            phase = api.getPhase(tls)
            green = self.phase_maps[tls].green_by_index(phase)
            return {"tls": tls, "phase": phase, "state": api.getRedYellowGreenState(tls), "axis": green.axis if green else None,
                    "in_clearance": green is None, "sim_time": self.now, "source": "sumo"}

    def status(self) -> dict:
        report = self.auditor.report() if self.auditor else None
        return {"running": self.running, "error": self.error, "sim_time": self.now, "applied": self.applied, "tls": sorted(self.phase_maps),
                "safety_audit": None if not report else {"violations": report["by_kind"], "total": report["total_violations"]}}
