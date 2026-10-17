import math
from types import SimpleNamespace
import pytest
from simulation.swarm.junction_mesh import (
    LookaheadDemo, JunctionMesh, build_links, grid_topology, fuel_telemetry, idle_liters, mulberry32, hash2,
    CONFIG, FUEL, SWARM, FIXED, AXIS, LEFT, RIGHT,
)


def test_prng_and_hash_are_deterministic_32bit():
    a, b = mulberry32(42), mulberry32(42)
    xs = [a() for _ in range(5)]
    assert xs == [b() for _ in range(5)]
    assert all(0 <= x < 1 for x in xs)
    # Pinned values: frontend/lib/swarmMesh.js must produce the same stream.
    assert round(mulberry32(42)(), 10) == 0.6011037519
    assert hash2(1, 2) == hash2(1, 2) and 0 <= hash2(123456, 7919) <= 0xFFFFFFFF


def test_turns_are_consistent():
    assert LEFT["NORTHBOUND"] == "WESTBOUND" and RIGHT["NORTHBOUND"] == "EASTBOUND"
    assert RIGHT["WESTBOUND"] == "NORTHBOUND" and LEFT["EASTBOUND"] == "NORTHBOUND"


def test_links_are_bidirectional_with_opposite_directions():
    junctions, edges = grid_topology(3)
    links = build_links(junctions, edges)
    assert len(links) == 2 * len(edges) == 24
    opposite = {"NORTHBOUND": "SOUTHBOUND", "SOUTHBOUND": "NORTHBOUND", "EASTBOUND": "WESTBOUND", "WESTBOUND": "EASTBOUND"}
    for l in links[:len(edges)]:
        back = next(x for x in links if x["from"] == l["to"] and x["to"] == l["from"])
        assert back["dir"] == opposite[l["dir"]]
        assert 10 <= l["travel_s"] <= 28


def test_swarm_beats_fixed_timer_on_identical_demand():
    demo = LookaheadDemo(grid=3, seed=42)
    demo.step(600)
    f = demo.fuel()
    totals = {m: demo.meshes[m].totals() for m in (SWARM, FIXED)}
    assert totals[SWARM]["arrived"] == totals[FIXED]["arrived"] > 0          # same vehicles entered both meshes
    assert f["average_delay_reduction_pct"] > 40
    assert f["liters_fuel_saved"] > 0 and f["stops_avoided"] > 0
    assert f["co2_kg_prevented"] == pytest.approx(f["liters_fuel_saved"] * 2.31, abs=1e-3)
    assert f["rupees_saved"] == pytest.approx(f["liters_fuel_saved"] * 96.72, abs=0.01)


def test_run_is_reproducible():
    a, b = LookaheadDemo(grid=5, seed=7), LookaheadDemo(grid=5, seed=7)
    a.step(300); b.step(300)
    assert a.fuel() == b.fuel()
    assert [m["text"] for m in a.messages(limit=500)] == [m["text"] for m in b.messages(limit=500)]


def test_platoon_alerts_are_sent_ahead_of_the_platoon():
    demo = LookaheadDemo(grid=3, seed=42)
    sent = []
    for agent in demo.meshes[SWARM].agents:
        original = agent.send_platoon_alert

        def spy(target_id, count, eta, _orig=original, **kw):
            packet = _orig(target_id, count, eta, **kw)
            sent.append(dict(packet))
            return packet
        agent.send_platoon_alert = spy
    demo.step(300)
    assert sent
    for p in sent:
        assert {"source_junction", "target_junction", "platoon_size", "estimated_arrival_sec",
                "approaching_direction", "target_speed_kmh"} <= set(p)
        # delivered (1 s latency) before the head of the platoon reaches the receiver
        assert p["head_at"] - p["sent_at"] >= CONFIG["comm_latency_s"]
    assert not demo.meshes[FIXED].channel and not demo.meshes[FIXED].messages     # static timers do not talk
    kinds = {m["kind"] for m in demo.messages(limit=500)}
    assert {"platoon", "alert", "clear"} <= kinds


def _one_junction_mesh():
    junctions = [{"id": "A", "name": "A", "lat": 28.0, "lon": 77.0}, {"id": "B", "name": "B", "lat": 28.01, "lon": 77.0}]
    mesh = JunctionMesh(junctions, build_links(junctions, [(0, 1)]), SWARM, dict(CONFIG))
    return mesh, mesh.agents[0]


def test_dead_green_is_released_after_min_green():
    mesh, a = _one_junction_mesh()
    mesh.step([])                                                             # NS green with nothing on it
    mesh.step([(0, "EASTBOUND", 1, False), (0, "EASTBOUND", 2, False)])       # 2 cars wait on EW
    for _ in range(12):
        mesh.step([])
    assert a.last_green["NS"] is not None and a.last_green["NS"] <= 8         # empty green released in 6-8 s
    assert a.axis == "EW" and a.queue("EW") == 0                              # the waiting cars were served


def test_agent_holds_green_for_announced_platoon():
    mesh, a = _one_junction_mesh()
    alert = mesh.new_alert(1, mesh.links[1])
    alert.update(vehicles=6, platoon_size=6, approaching_direction="NORTHBOUND", head_at=8, tail_at=14, sent_at=0)
    a.inbox.append(alert)
    mesh.t = 7
    a.green_start = 0
    a.arms["EASTBOUND"].extend([SimpleNamespace(id=i, heavy=False, dir="EASTBOUND", wait=0, alert=None) for i in range(3)])
    switch, reason = a.decide(7)
    assert (switch, reason) == (False, "platoon_hold")


def test_emergency_corridor_has_zero_signal_delay_under_swarm():
    demo = LookaheadDemo(grid=3, seed=42)
    demo.step(120)
    info = demo.trigger_emergency()
    assert len(info["route"]) >= 3
    demo.step(240)
    em = demo.emergency()
    assert em[SWARM]["done"] and em[SWARM]["delay_s"] == 0
    assert em[FIXED]["delay_s"] > 0
    assert any(m["kind"] == "emergency" for m in demo.messages(limit=500))


def test_fuel_formula():
    assert idle_liters(3600, 0) == pytest.approx(FUEL["car_idle_lph"])
    assert idle_liters(0, 3600) == pytest.approx(FUEL["heavy_idle_lph"])
    base = {"passages": 10, "stops": 10, "idle_s": 400, "stopped_idle_s": 400, "car_idle_s": 3600, "heavy_idle_s": 0}
    swarm = {"passages": 10, "stops": 5, "idle_s": 100, "stopped_idle_s": 100, "car_idle_s": 0, "heavy_idle_s": 0}
    f = fuel_telemetry(base, swarm)
    assert f["liters_fuel_saved"] == pytest.approx(0.6)
    assert f["average_delay_reduction_pct"] == 75.0 and f["stops_avoided"] == 5


def test_all_grids_run_and_report_state():
    for n in (3, 5, 9):
        demo = LookaheadDemo(grid=n)
        demo.step(60)
        s = demo.state(FIXED)
        assert len(s["junctions"]) == n * n and s["mode"] == FIXED
        assert all(j["static_green_s"] == 30 for j in s["junctions"])


def test_lab_api_mesh_endpoints(tmp_path, monkeypatch):
    pytest.importorskip("httpx")
    monkeypatch.setenv("TSI_LAB_ROOT", str(tmp_path))
    from fastapi.testclient import TestClient
    import importlib
    import experiments.lab.api as api
    api = importlib.reload(api)
    c = TestClient(api.app)
    assert c.post("/api/lab/swarm/mesh/reset", json={"grid": 3, "seed": 1}).status_code == 200
    assert c.post("/api/lab/swarm/mesh/reset", json={"grid": 4}).status_code == 400
    s = c.post("/api/lab/swarm/mesh/step", json={"seconds": 120}).json()
    assert s["t"] == 120 and len(s["junctions"]) == 9
    assert c.get("/api/lab/swarm/mesh/state", params={"mode": "fixed"}).json()["mode"] == "fixed"
    assert c.get("/api/lab/swarm/mesh/state", params={"mode": "x"}).status_code == 400
    assert c.get("/api/lab/swarm/mesh/messages").json()["messages"]
    assert "liters_fuel_saved" in c.get("/api/lab/swarm/mesh/fuel").json()
    assert c.post("/api/lab/swarm/mesh/emergency").json()["route"]
    assert c.post("/api/lab/swarm/mesh/emergency").status_code == 409


def test_green_wave_send_platoon_alert_uses_neighbour_channel(tmp_path):
    from simulation.coordination.green_wave import GreenWave
    green = SimpleNamespace(index=0)
    ctl = SimpleNamespace(agents={"B": SimpleNamespace(phase_map=SimpleNamespace(greens=[green]))}, hooks=[])
    gw = GreenWave(ctl, SimpleNamespace(tls={}), {"max_green_s": 45}, seed=1)
    call = gw.send_platoon_alert("A", "B", 30, 18.0, now=100.0)
    assert call.receiver == "B" and call.target_phase == 0 and call.eta_head == 118.0
    assert gw.channels[("A", "B")]["sent"] == 1 and gw.channels[("A", "B")]["vehicles"] == 30
    assert gw.inflight == [call] and "30 veh to B" in gw.messages[0]["text"]
    out = gw.finish(tmp_path)["green_wave"]
    assert out["channels"]["A->B"]["sent"] == 1
    assert (tmp_path / "swarm_messages.jsonl").read_text().strip()
