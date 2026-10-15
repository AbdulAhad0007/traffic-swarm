"""Controller V2 safety tests with test doubles (no SUMO needed)."""
import math
from pathlib import Path
from simulation.network.network_model import NetworkModel
from simulation.safety.risk_field import SafetyGate
from simulation.safety.signal_audit import SignalAuditor
from simulation.swarm.adaptive_controller import AdaptiveController, apply_green_duration
from simulation.swarm.signal_agent import interpret, MODE_FALLBACK, MODE_NATIVE

ROOT = Path(__file__).resolve().parents[1]
LEGACY_NET = ROOT / "simulation/scenarios/grid3x3/build.net.xml"
SETTINGS = {"decision_interval_s": 5, "min_green_s": 10, "max_green_s": 60, "max_red_s": 120, "min_yellow_s": 3,
            "pedestrian_min_green_s": 15, "observation_ttl_s": 30, "downstream_discount": 0.8,
            "green_wave_cap_s": 45, "max_consecutive_optimizer_failures": 3, "max_risk": 1.0}


class FakeTrafficLight:
    def __init__(self, phase, state):
        self.phase, self.state, self.calls = phase, state, []

    def getPhase(self, tls):
        return self.phase

    def getRedYellowGreenState(self, tls):
        return self.state

    def setPhaseDuration(self, tls, value):
        self.calls.append((tls, value))


def controller(optimizer=None):
    c = AdaptiveController(seed=1, settings=SETTINGS, **({"optimizer": optimizer} if optimizer else {}))
    c.build_agents(NetworkModel.from_net_file(LEGACY_NET))
    return c


# ---------------------------------------------------------------- safety gate
def test_green_plan_bounds_are_measured_from_phase_start():
    g = SafetyGate(min_green=10, max_green=60)
    assert g.validate_green_plan(80, elapsed=30, min_green=10).green_seconds == 60
    assert g.validate_green_plan(80, elapsed=30, min_green=10).reason == "clamped_max_green"
    assert g.validate_green_plan(5, elapsed=2, min_green=10).green_seconds == 10
    assert g.validate_green_plan(5, elapsed=2, min_green=15).green_seconds == 15   # pedestrian minimum
    assert g.validate_green_plan(30, elapsed=12, min_green=10).reason == "validated"


def test_green_plan_rejects_bad_inputs_and_risk_without_using_score():
    g = SafetyGate()
    for bad in (None, math.nan, math.inf, "x"):
        d = g.validate_green_plan(bad, elapsed=5, min_green=10)
        assert not d.allowed and d.fallback and d.reason == "invalid_proposal"
    assert g.validate_green_plan(30, 5, 10, risk=2.0).reason == "risk_limit_exceeded"
    assert g.validate_green_plan(30, 5, 10, risk=-1).reason == "invalid_risk"


def test_fairness_ends_green_when_competing_phase_starves():
    g = SafetyGate(max_red=120)
    d = g.validate_green_plan(60, elapsed=25, min_green=10, competing_red=130, competing_demand=True)
    assert d.allowed and d.reason == "fairness_max_red" and d.green_seconds == 25
    # No waiting traffic on the competing phase: no forced change.
    assert g.validate_green_plan(60, 25, 10, competing_red=130, competing_demand=False).reason == "validated"


# ---------------------------------------------------------------- applying decisions
def test_apply_never_touches_a_yellow_phase():
    tl = FakeTrafficLight(phase=1, state="Gyyyyyrrr")       # J6 yellow, contains 'G'
    ok, why = apply_green_duration(tl, "J6", 0, "GGgGggrrr", 20)
    assert not ok and why == "phase_changed_before_apply" and tl.calls == []


def test_apply_checks_state_and_sets_remaining_time():
    tl = FakeTrafficLight(phase=0, state="rrrrrrrrr")
    assert apply_green_duration(tl, "J6", 0, "GGgGggrrr", 20) == (False, "state_mismatch_before_apply")
    tl = FakeTrafficLight(phase=0, state="GGgGggrrr")
    assert apply_green_duration(tl, "J6", 0, "GGgGggrrr", 20) == (True, "phase_duration_updated")
    assert tl.calls == [("J6", 20.0)]


def test_apply_failure_is_reported_not_raised():
    class Broken(FakeTrafficLight):
        def setPhaseDuration(self, tls, value):
            raise RuntimeError("boom")
    ok, why = apply_green_duration(Broken(0, "GG"), "X", 0, "GG", 5)
    assert not ok and why == "apply_failed:RuntimeError"


# ---------------------------------------------------------------- agents and decision ticks
def test_uncontrollable_junctions_are_registered_not_skipped():
    c = controller()
    assert len(c.agents) == 9
    assert {t for t, a in c.agents.items() if a.mode == MODE_NATIVE} == {"J1", "J3", "J7", "J9"}
    assert all(a.mode_reason == "single_green_phase" for a in c.agents.values() if a.mode == MODE_NATIVE)


def test_programmed_green_is_bounded_on_entry():
    c = controller()
    agent = c.agents["J5"]
    assert agent.on_phase(0, 0.0, max_green=60) is None          # 42 s is inside [10, 60]
    assert agent.on_phase(1, 42.0, 60) is None                    # yellow: nothing set
    assert agent.on_phase(2, 45.0, max_green=30) == 30            # programmed 42 s > max 30 -> bounded
    assert agent.last_green_end[0] == 42.0


def test_decisions_are_only_pending_for_agents_in_green():
    c = controller()
    for tid, agent in c.agents.items():
        agent.on_phase(1 if tid == "J5" else 0, 0.0, 60)          # J5 in yellow
    records = c.decide(12.0, 0, lambda lane: 3, lambda lane: 0.1, [])
    by_tls = {r["intersection"]: r for r in records}
    assert by_tls["J5"]["status"] == "deferred" and by_tls["J5"]["reason"] == "in_transition"
    for tid in ("J2", "J4", "J6", "J8"):
        assert by_tls[tid]["status"] == "pending"
        assert by_tls[tid]["applied_total_s"] >= 10
        assert by_tls[tid]["remaining_set_s"] >= 0
    assert not {"J1", "J3", "J7", "J9"} & set(by_tls)              # native agents are logged at registration


def test_failed_optimizer_keeps_plan_and_eventually_falls_back():
    def broken(*args, **kwargs):
        raise RuntimeError("optimizer down")
    c = controller(broken)
    for agent in c.agents.values():
        agent.on_phase(0, 0.0, 60)
    plan_before = c.agents["J5"].planned_total
    events = []
    for tick in range(3):
        records = c.decide(12.0 + tick * 5, tick, lambda lane: 1, lambda lane: 0.0, events)
        assert all(r["status"] != "pending" for r in records)
        assert all(r["reason"] == "optimizer_error:RuntimeError" for r in records if r["status"] == "rejected")
    assert c.agents["J5"].planned_total == plan_before
    assert c.agents["J5"].mode == MODE_FALLBACK
    assert any(e["event"] == "agent_fallback" for e in events)
    assert c.decide(40.0, 4, lambda lane: 1, lambda lane: 0.0, []) == []   # fallback agents run the program


def test_malformed_optimizer_result_is_rejected():
    for bad in ({"direction": "UP", "green_seconds": 20}, {"direction": "NS", "green_seconds": math.nan}, {}):
        try:
            interpret(bad, 5, 10)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad}")
    assert interpret({"direction": "EW", "green_seconds": 50}, elapsed=4, min_green=10) == ("yield", 10.0)
    assert interpret({"direction": "NS", "green_seconds": 50}, elapsed=4, min_green=10) == ("serve", 50.0)


def test_downstream_congestion_from_fresh_neighbors_only():
    c = controller()
    for agent in c.agents.values():
        agent.on_phase(0, 0.0, 60)
    c.decide(10.0, 0, lambda lane: 2, lambda lane: 0.9, [])         # everyone publishes occupancy 0.9
    records = c.decide(100.0, 1, lambda lane: 2, lambda lane: 0.9, [])
    assert all(r["downstream_saturation"] == 0.9 for r in records if r.get("downstream_saturation") is not None)
    c.blackboard.observations.clear()                                # all neighbor data lost
    c.agents["J5"].current_phase = 0
    rec = {r["intersection"]: r for r in c.decide(105.0, 2, lambda lane: 2, lambda lane: 0.9, [])}
    assert rec["J5"]["status"] == "pending"                          # still decides with missing neighbors


# ---------------------------------------------------------------- independent audit
def test_auditor_flags_missing_and_short_yellow_and_green_bounds():
    a = SignalAuditor({"T": [0, 1]}, min_yellow=3, green_bounds={"T": {0: (10, 60)}})
    a.observe(0, "T", "Gr", 0); a.observe(5, "T", "rr", 1)                      # G -> r without yellow
    assert a.violations["missing_yellow"] == 1
    a.observe(10, "T", "Gr", 0); a.observe(20, "T", "yr", 1); a.observe(21, "T", "rr", 2)
    assert a.violations["short_yellow"] == 1
    a.observe(30, "T", "Gr", 0); a.observe(100, "T", "yr", 1)                  # 70 s green > 60 + 1
    assert a.violations["green_too_long"] == 1
    a.observe(110, "T", "Gr", 0); a.observe(113, "T", "yr", 1)                 # 3 s green < 10 - 1
    assert a.violations["green_too_short"] == 1


def test_auditor_accepts_a_clean_cycle():
    a = SignalAuditor({"T": [0, 1]}, min_yellow=3, green_bounds={"T": {0: (10, 60), 3: (10, 60)}})
    t = 0
    for _ in range(3):
        for state, phase, dur in (("Gr", 0, 30), ("yr", 1, 3), ("rr", 2, 1), ("rG", 3, 30), ("ry", 4, 3), ("rr", 5, 1)):
            a.observe(t, "T", state, phase); t += dur
    assert a.report()["total_violations"] == 0


def test_only_consecutive_optimizer_failures_cause_fallback():
    from optimizer.app.swarm.engine import optimize
    calls = {"n": 0}
    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] in (1, 2, 4, 5):                      # fail, fail, ok, fail, fail
            raise RuntimeError("transient")
        return optimize(*args, **kwargs)
    c = AdaptiveController(seed=1, settings=SETTINGS, optimizer=flaky)
    c.build_agents(NetworkModel.from_net_file(LEGACY_NET))
    c.agents = {"J5": c.agents["J5"]}
    c.agents["J5"].on_phase(0, 0.0, 60)
    for tick in range(5):
        c.decide(11.0 + tick, tick, lambda lane: 1, lambda lane: 0.0, [])
    assert c.agents["J5"].mode != MODE_FALLBACK
