"""Advanced features without SUMO: emergency priority logic, heatmap levels, prediction, lab validation."""
import json
from pathlib import Path
import pytest
from simulation.network.network_model import NetworkModel
from simulation.network.phase_map import build_all
from simulation.emergency.priority import EmergencyPriority
from simulation.live.congestion import classify, load_live_config, network_layout, tls_incoming_lanes
from simulation.prediction.models import LinearTrend, MovingAverage, Persistence, RidgeAR, make_predictor
from simulation.prediction.dataset import check_split, make_samples
from simulation.prediction.online import OnlinePredictor

ROOT = Path(__file__).resolve().parents[1]
LEGACY_NET = ROOT / "simulation/scenarios/grid3x3/build.net.xml"
SETTINGS = {"decision_interval_s": 5, "min_green_s": 10, "max_green_s": 60, "max_red_s": 120, "min_yellow_s": 3,
            "pedestrian_min_green_s": 15, "observation_ttl_s": 30, "downstream_discount": 0.8,
            "green_wave_cap_s": 45, "max_consecutive_optimizer_failures": 3, "max_risk": 1.0}


# ---------------------------------------------------------------- emergency priority (fake TraCI)
class FakeTL:
    def __init__(self, maps):
        self.maps, self.phase, self.next_switch, self.calls, self.fail = maps, {}, {}, [], False

    def getPhase(self, t): return self.phase[t]
    def getRedYellowGreenState(self, t):
        g = self.maps[t].green_by_index(self.phase[t])
        return g.state if g else "y" * 12
    def getNextSwitch(self, t): return self.next_switch.get(t, 0.0)
    def setPhaseDuration(self, t, v):
        if self.fail:
            raise RuntimeError("traci down")
        self.calls.append((t, round(v, 2)))


class FakeVehicle:
    def __init__(self):
        self.cls, self.next, self.speed = {}, {}, {}
    def getVehicleClass(self, v): return self.cls[v]
    def getRoute(self, v): return ["a", "b", "c"]
    def getNextTLS(self, v): return self.next[v]
    def getSpeed(self, v): return self.speed.get(v, 10.0)


class FakeAPI:
    def __init__(self, maps):
        self.trafficlight, self.vehicle = FakeTL(maps), FakeVehicle()


class FakeSession:
    def __init__(self, api):
        self.api, self.now, self.departed_ids, self.arrived_ids = api, 0.0, [], []
    def phase(self, t): return self.api.trafficlight.phase.get(t)


@pytest.fixture
def j5():
    maps = {t: pm for t, pm in build_all(NetworkModel.from_net_file(LEGACY_NET), SETTINGS).items() if pm.controllable}
    pm = maps["J5"]
    g0, g2 = pm.green_by_index(0), pm.green_by_index(2)
    link0 = min(g0.served_links - g2.served_links)
    link2 = min(g2.served_links - g0.served_links)
    api = FakeAPI(maps)
    return maps, api, link0, link2


def step(prio, s, t, departed=(), arrived=()):
    s.now, s.departed_ids, s.arrived_ids = t, list(departed), list(arrived)
    prio.on_step(s)


def test_priority_extends_target_green_within_max_green(j5):
    maps, api, link0, _ = j5
    prio, s = EmergencyPriority(maps, SETTINGS, enabled=True, api=api), FakeSession(api)
    api.trafficlight.phase["J5"] = 0
    api.vehicle.cls["amb"] = "emergency"
    api.vehicle.next["amb"] = [("J5", link0, 200.0, "G")]
    api.vehicle.speed["amb"] = 2.0                      # slow: ETA = 200 / 3 (min ETA speed) = 67 s
    api.trafficlight.next_switch["J5"] = 5.0
    step(prio, s, 0.0, departed=["amb"])                 # phase 0 starts at t=0
    step(prio, s, 1.0)
    assert prio.locked_tls() == {"J5"}
    assert api.trafficlight.calls and api.trafficlight.calls[-1][0] == "J5"
    assert api.trafficlight.calls[-1][1] <= 60 - 1.0      # never beyond max_green from phase start


def test_conflicting_green_ends_only_after_min_green_and_only_once(j5):
    maps, api, _, link2 = j5
    prio, s = EmergencyPriority(maps, SETTINGS, enabled=True, api=api), FakeSession(api)
    api.trafficlight.phase["J5"] = 0
    api.vehicle.cls["amb"] = "emergency"
    api.vehicle.next["amb"] = [("J5", link2, 150.0, "r")]
    step(prio, s, 0.0, departed=["amb"])
    step(prio, s, 5.0)
    assert api.trafficlight.calls == []
    assert prio.active[("amb", "J5")].status == "waiting_min_green"
    min_green = maps["J5"].green_by_index(0).min_green
    step(prio, s, min_green)
    step(prio, s, min_green + 1)
    assert api.trafficlight.calls == [("J5", 0.0)]      # ended once, at/after the minimum green
    api.trafficlight.phase["J5"] = 1                      # yellow: never touched
    step(prio, s, min_green + 2)
    assert api.trafficlight.calls == [("J5", 0.0)]
    assert prio.active[("amb", "J5")].status == "in_clearance"


def test_two_ambulances_with_conflicting_needs_are_arbitrated(j5):
    maps, api, link0, link2 = j5
    prio, s = EmergencyPriority(maps, SETTINGS, enabled=True, api=api), FakeSession(api)
    api.trafficlight.phase["J5"] = 0
    api.vehicle.cls.update(a="emergency", b="emergency")
    api.vehicle.next["a"] = [("J5", link0, 100.0, "G")]
    api.vehicle.next["b"] = [("J5", link2, 120.0, "r")]
    step(prio, s, 0.0, departed=["a"])
    step(prio, s, 1.0, departed=["b"])
    assert prio.active[("a", "J5")].status == "granted"
    assert prio.active[("b", "J5")].status == "waiting_conflict"
    assert all(v != 0.0 for _, v in api.trafficlight.calls)   # the first ambulance's green is not cut


def test_expired_request_is_released_and_not_renewed(j5):
    maps, api, _, link2 = j5
    prio = EmergencyPriority(maps, SETTINGS, enabled=True, api=api, options={"max_request_s": 20})
    s = FakeSession(api)
    api.trafficlight.phase["J5"] = 1                      # stuck in a transition -> cannot be served
    api.vehicle.cls["amb"] = "emergency"
    api.vehicle.next["amb"] = [("J5", link2, 100.0, "r")]
    step(prio, s, 0.0, departed=["amb"])
    step(prio, s, 25.0)
    assert ("amb", "J5") not in prio.active and prio.locked_tls() == set()
    step(prio, s, 26.0)
    assert ("amb", "J5") not in prio.active               # no new request for an expired junction
    assert prio.ambulances["amb"].requests[0].outcome == "expired"


def test_disabled_priority_tracks_but_never_acts(j5):
    maps, api, link0, _ = j5
    prio, s = EmergencyPriority(maps, SETTINGS, enabled=False, api=api), FakeSession(api)
    api.trafficlight.phase["J5"] = 0
    api.vehicle.cls["amb"] = "emergency"
    api.vehicle.next["amb"] = [("J5", link0, 100.0, "G")]
    step(prio, s, 0.0, departed=["amb"])
    step(prio, s, 30.0, arrived=["amb"])
    assert api.trafficlight.calls == [] and prio.locked_tls() == set()
    rep = prio.report()["emergency"]
    assert rep["priority_enabled"] is False and rep["vehicles"][0]["travel_time_s"] == 30.0


def test_traci_failure_disables_priority_at_that_junction(j5):
    maps, api, link0, _ = j5
    prio, s = EmergencyPriority(maps, SETTINGS, enabled=True, api=api), FakeSession(api)
    api.trafficlight.fail = True
    api.trafficlight.phase["J5"] = 0
    api.vehicle.cls["amb"] = "emergency"
    api.vehicle.next["amb"] = [("J5", link0, 200.0, "G")]
    api.vehicle.speed["amb"] = 1.0
    step(prio, s, 0.0, departed=["amb"])
    step(prio, s, 1.0)                                   # apply_green_duration catches the error ...
    assert prio.locked_tls() == {"J5"}                   # ... and reports it as not applied
    assert any(e["event"] == "action" and not e["applied"] for e in prio.events)


def test_non_emergency_vehicles_are_ignored(j5):
    maps, api, link0, _ = j5
    prio, s = EmergencyPriority(maps, SETTINGS, enabled=True, api=api), FakeSession(api)
    api.vehicle.cls["car"] = "passenger"
    step(prio, s, 0.0, departed=["car"])
    assert prio.ambulances == {}


def test_swarm_defers_at_locked_junctions():
    from simulation.swarm.adaptive_controller import AdaptiveController

    class Lock:
        def locked_tls(self): return {"J5"}
    c = AdaptiveController(seed=1, settings=SETTINGS, hooks=[Lock()])
    c.build_agents(NetworkModel.from_net_file(LEGACY_NET))
    for a in c.agents.values():
        a.on_phase(0, 0.0, 60)
    recs = c.decide(12.0, 0, lambda lane: 3, lambda lane: 0.2, [])
    j5 = [r for r in recs if r["intersection"] == "J5"]
    assert j5 and j5[0]["status"] == "deferred" and j5[0]["reason"] == "emergency_priority"
    assert any(r["status"] == "pending" for r in recs if r["intersection"] != "J5")


# ---------------------------------------------------------------- heatmap levels and layout
def test_congestion_levels_use_the_worse_of_occupancy_and_queue():
    cfg = load_live_config()
    assert classify(0, 0.0, 2, cfg) == "free"
    assert classify(4, 0.05, 2, cfg) == "light"           # 2 veh/lane
    assert classify(10, 0.05, 2, cfg) == "heavy"          # 5 veh/lane, although occupancy is low
    assert classify(None, None, 2, cfg) == cfg["no_data_level"]
    assert classify(1, 0.9, 0, cfg) == cfg["no_data_level"]
    assert classify(100, 0.0, 2, cfg) == "severe"
    assert classify(0, 0.3, 2, cfg) == "heavy"


def test_live_config_rejects_unordered_thresholds(tmp_path):
    bad = json.loads((ROOT / "simulation/config/live.json").read_text())
    bad["levels"][1]["max_occupancy"] = 0.01
    p = tmp_path / "live.json"; p.write_text(json.dumps(bad))
    with pytest.raises(ValueError):
        load_live_config(p)


def test_layout_is_derived_from_the_network_not_hardcoded():
    model = NetworkModel.from_net_file(LEGACY_NET)
    lay = network_layout(model)
    assert len(lay["nodes"]) == len(model.tls) and lay["unpositioned"] == []
    assert len(lay["links"]) == model.adjacency_edge_count()
    lanes = tls_incoming_lanes(model)
    assert all(lanes[t] for t in model.tls)


# ---------------------------------------------------------------- prediction
def test_baseline_predictors():
    h = [1, 2, 3, 4]
    assert Persistence().predict(h) == 4
    assert MovingAverage(4).predict(h) == 2.5 and MovingAverage(5).predict(h) is None
    assert LinearTrend(4).predict(h, 1) == pytest.approx(5.0)
    assert LinearTrend(4).predict([4, 3, 2, 1], 3) == 0.0     # never negative


def test_ridge_learns_a_linear_process_and_round_trips():
    xs, ys = [], []
    seq = [float(i % 7) for i in range(400)]
    for i in range(3, len(seq) - 1):
        xs.append(seq[i - 2:i + 1]); ys.append(0.5 * seq[i] + 0.25 * seq[i - 1] + 1.0)
    m = RidgeAR(3, alpha=1e-6).fit(xs, ys, horizon=1)
    assert m.predict([2.0, 4.0, 6.0], 1) == pytest.approx(0.5 * 6 + 0.25 * 4 + 1.0, abs=1e-3)
    m2 = make_predictor(m.to_dict())
    assert m2.predict([2.0, 4.0, 6.0], 1) == pytest.approx(m.predict([2.0, 4.0, 6.0], 1))
    with pytest.raises(ValueError):
        m.predict([1, 2, 3], horizon=2)                    # trained for another horizon


def test_samples_never_use_the_future_and_skip_gaps():
    series = {"J": [(t * 5.0, float(t), 2) for t in range(10)] + [(100.0, 1.0, 2), (105.0, None, 2)]}
    samples = make_samples("run", series, lags=3, horizon=2, step=5.0)
    assert samples and all(s.feature_end_time < s.target_time for s in samples)
    assert all(s.target_time - s.feature_end_time == 10.0 for s in samples)
    assert all(s.target_time <= 45.0 for s in samples)     # nothing across the gap or the missing value


def test_split_by_run_and_seed_is_enforced(tmp_path):
    a = tmp_path / "x/seed-42/baseline"; b = tmp_path / "y/seed-42/swarm"; c = tmp_path / "x/seed-43/baseline"
    with pytest.raises(ValueError):
        check_split([a], [a])
    with pytest.raises(ValueError):
        check_split([a], [b])                              # same seed (same demand) on both sides
    check_split([a], [c])


def test_online_predictor_falls_back_until_proven_reliable():
    p = OnlinePredictor(Persistence(), horizon_steps=1, max_mae=0.5, min_checked=3)
    assert p.predict("J", 0, 0) is None                    # missing -> None (controller uses current state)
    for k, v in enumerate([5, 5, 5, 5]):
        p.update("J", k, {0: v, 2: 1})
    pr = p.predict("J", 4, 0)
    assert pr["reliable"] is True and pr["served"] == 5 and pr["competing"] == 1
    for k, v in enumerate([0, 20, 0, 20], start=4):        # erratic series -> large error -> unreliable
        p.update("J", k, {0: v, 2: 1})
    assert p.predict("J", 8, 0)["reliable"] is False
    assert p.report()["fallback_share"] > 0


def test_unreliable_or_wild_predictions_never_bypass_the_safety_gate():
    from simulation.swarm.adaptive_controller import AdaptiveController

    class Wild:
        def update(self, *a): pass
        def predict(self, tls, now, g): return {"served": 1e6, "competing": 0.0, "reliable": True}
        def report(self): return {}
    s = {**SETTINGS, "use_prediction": True}
    c = AdaptiveController(seed=1, settings=s, predictor=Wild())
    c.build_agents(NetworkModel.from_net_file(LEGACY_NET))
    for a in c.agents.values():
        a.on_phase(0, 0.0, 60)
    recs = c.decide(130.0, 0, lambda lane: 50, lambda lane: 0.2, [])
    pending = [r for r in recs if r.get("status") == "pending"]
    assert pending and all(r["input_source"] == "predicted" for r in pending)
    # competing red 130 s > max_red 120 s with waiting traffic: the gate still ends the green
    assert all(r["reason"] == "fairness_max_red" and r["applied_total_s"] <= 130.0 for r in pending)


# ---------------------------------------------------------------- lab validation
def test_job_spec_validation_rejects_unsafe_values():
    from experiments.lab.jobs import SpecError, validate_spec
    ok = validate_spec({"network": "grid3x3", "scenario": "normal", "seed": 1, "controllers": ["fixed", "actuated", "swarm"]})
    assert ok["controllers"] == ["fixed", "actuated", "swarm"]
    for bad in ({"network": "../../etc/passwd"}, {"network": "osm_user"}, {"scenario": "x; rm -rf /"},
                {"seed": -1}, {"seed": "1"}, {"controllers": ["swarm", "bash"]}, {"kind": "demo", "controllers": ["swarm"]},
                {"ambulances": 99}, {"network": "grid3x3_legacy", "ambulances": 1}, {"realtime_factor": 0},
                {"max_time": 10 ** 9}, {"kind": "shell"}):
        with pytest.raises(SpecError):
            validate_spec({"network": "grid3x3", **bad})


def test_lab_api_rejects_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setenv("TSI_LAB_ROOT", str(tmp_path))
    import importlib
    from fastapi.testclient import TestClient
    import experiments.lab.api as api
    api = importlib.reload(api)
    c = TestClient(api.app)
    assert c.get("/api/lab/runs/comparison", params={"id": "../../secrets"}).status_code == 400
    assert c.get("/api/lab/runs/comparison", params={"id": "a/../../b"}).status_code == 400
    assert c.get("/api/lab/reports/..%2F..%2Fx").status_code in (400, 404)
    assert c.get("/api/lab/jobs/../../x").status_code in (400, 404)
    assert c.get("/api/lab/jobs/zzzzzzzzzzzz").status_code == 404
    assert c.post("/api/lab/jobs", json={"network": "nope"}).status_code == 400
