"""SUMO-backed tests for the advanced features (skipped automatically when SUMO is not installed)."""
import csv, json, time
from pathlib import Path
import pytest

pytestmark = pytest.mark.sumo


@pytest.fixture(scope="module")
def grid(tmp_path_factory):
    from simulation.network.build_network import ensure_network
    root = tmp_path_factory.mktemp("feat")
    return root, ensure_network("grid3x3", root)


def test_actuated_controller_runs_sumo_actuated_programs_safely(grid):
    from experiments.tools.run_experiment import run
    root, _ = grid
    r = run("normal", 42, root, max_time=900, network="grid3x3", controllers=["fixed", "actuated"],
            run_dir=root / "act")
    act = r["controllers"]["actuated"]
    assert act["actuated_program_verified"] == 9            # TraCI confirmed the actuated program on every TLS
    assert act["actuated_config"]["parameters"]["max-gap"] == 3.0
    assert act["safety_audit"]["total_violations"] == 0     # incl. min/max green bounds
    assert r["metadata"]["scenario_route_sha256"]           # one route file for both
    add = (root / "act/actuated/actuated.add.xml").read_text()
    assert 'type="actuated"' in add and "minDur" in add


def test_emergency_priority_is_safe_and_acts(grid):
    from experiments.tools.run_experiment import run
    root, _ = grid
    r = run("normal", 42, root, max_time=1200, network="grid3x3", controllers=["swarm", "swarm_priority"],
            ambulances=2, run_dir=root / "amb")
    for v in ("swarm", "swarm_priority"):
        s = r["controllers"][v]
        assert s["safety_audit"]["total_violations"] == 0
        assert s["emergency"]["ambulances"] == 2 and s["emergency"]["ambulances_arrived"] == 2
    on = r["controllers"]["swarm_priority"]["emergency"]
    assert on["priority_enabled"] and sum(on["actions"].values()) > 0
    assert r["controllers"]["swarm"]["emergency"]["actions"] == {}            # tracking only
    assert r["controllers"]["swarm_priority"]["decision_reason_counts"].get("deferred:emergency_priority", 0) > 0
    assert (root / "amb/swarm_priority/emergency_events.jsonl").is_file()


def test_occupancy_is_a_fraction(grid):
    import traci
    from simulation.network.scenario_builder import build_scenario
    from simulation.runtime import SumoSession
    from simulation.telemetry import TelemetryCollector
    root, info = grid
    b = build_scenario(info, "rush-hour", root / "occ")
    s = SumoSession(b["sumocfg"], 1)
    s.start()
    try:
        for _ in range(400):
            s.step(TelemetryCollector())
        lanes = [l for l in traci.lane.getIDList() if not l.startswith(":") and traci.lane.getLastStepVehicleNumber(l)]
        lane = max(lanes, key=traci.lane.getLastStepVehicleNumber)
        manual = sum(traci.vehicle.getLength(v) for v in traci.lane.getLastStepVehicleIDs(lane)) / traci.lane.getLength(lane)
        assert s.occupancy(lane) == pytest.approx(traci.lane.getLastStepOccupancy(lane), rel=1e-9)
        # Units: a fraction close to (vehicle length on the lane / lane length) - not a percentage.
        assert 0 < s.occupancy(lane) <= 1 and abs(s.occupancy(lane) - manual) < 0.05
    finally:
        s.close()


def test_live_recorder_writes_state_and_stop_file_cancels(grid):
    from experiments.tools.run_experiment import prepare, run_variant
    from simulation.live.recorder import RunCancelled
    root, info = grid
    _, cfg, _, _, run_dir = prepare("normal", 42, root, "grid3x3", run_dir=root / "live")
    run_variant("fixed", 42, cfg, run_dir, info["preset"]["controller"], max_time=300)
    out = run_dir / "baseline"
    state = json.loads((out / "live/state.json").read_text())
    assert state["status"] == "finished" and state["source"] == "live_simulation" and len(state["junctions"]) == 9
    layout = json.loads((out / "live/layout.json").read_text())
    assert len(layout["nodes"]) == 9 and len(layout["links"]) == 12
    rows = list(csv.DictReader((out / "tls_timeseries.csv").open()))
    assert len(rows) % 9 == 0 and len(rows) >= 9 * 50
    stop = root / "STOP"
    stop.write_text("now")
    with pytest.raises(RunCancelled):
        run_variant("swarm", 42, cfg, run_dir, info["preset"]["controller"], max_time=300, stop_file=stop)
    assert json.loads((run_dir / "swarm/live/state.json").read_text())["status"] == "cancelled"


def test_demo_job_runs_isolated_processes(tmp_path):
    from experiments.lab.jobs import JobManager
    m = JobManager(tmp_path, grace_s=5)
    job = m.submit({"kind": "demo", "network": "grid3x3", "scenario": "normal", "seed": 7,
                    "controllers": ["fixed", "swarm"], "max_time": 300})
    deadline = time.time() + 240
    while time.time() < deadline and m.read(job["id"])["status"] not in ("completed", "failed", "cancelled"):
        time.sleep(1)
    j = m.read(job["id"])
    assert j["status"] == "completed", j
    ports = [p["port"] for p in j["parts"].values()]
    assert len(set(ports)) == 2 and all(ports)
    d = m.job_dir(job["id"])
    assert (d / "run/baseline/tripinfo.xml").is_file() and (d / "run/swarm/tripinfo.xml").is_file()
