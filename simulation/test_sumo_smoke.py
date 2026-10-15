"""End-to-end SUMO smoke and regression tests (skipped when SUMO is not installed)."""
import json, math, shutil
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "experiments/reference/legacy_3x3_seed42.json"
pytestmark = pytest.mark.sumo


def _legacy_cfg(tmp_path, scenario):
    from experiments.tools.scenario_generator import generate
    base = ROOT / "simulation/scenarios/grid3x3"
    route = generate(base / "routes.rou.xml", tmp_path / f"{scenario}.rou.xml", scenario)
    cfg = tmp_path / f"{scenario}.sumocfg"
    cfg.write_text((base / "sumo.sumocfg").read_text().replace("routes.rou.xml", Path(route).as_posix())
                   .replace("build.net.xml", (base / "build.net.xml").as_posix()))
    return cfg


@pytest.mark.parametrize("scenario", ["normal", "rush-hour", "uneven", "sudden-congestion", "road-closure"])
def test_legacy_baseline_reproduces_pre_phase1_results(tmp_path, scenario):
    """The fixed-time baseline must be unchanged by the refactor (detects measurement regressions)."""
    from simulation.baseline.fixed_time_controller import FixedTimeController
    ref = json.loads(REFERENCE.read_text())
    summary = FixedTimeController(42).run(_legacy_cfg(tmp_path, scenario), tmp_path / "out")
    if ref["sumo_version_verified"] not in (summary["sumo_version"] or "").split():
        pytest.skip(f"reference produced with SUMO {ref['sumo_version_verified']}, running {summary['sumo_version']}")
    for key, expected in ref["scenarios"][scenario]["baseline"].items():
        actual = summary[key]
        assert actual == expected or (isinstance(expected, float) and math.isclose(actual, expected, rel_tol=1e-9)), key
    assert summary["safety_audit"]["total_violations"] == 0


@pytest.mark.parametrize("preset,n", [("grid3x3", 3), ("grid5x5", 5), ("grid9x9", 9)])
def test_grid_experiment_smoke(tmp_path, preset, n):
    from experiments.tools.run_experiment import run
    from experiments.tools.validate_run_artifacts import validate
    result = run("normal", 42, tmp_path, max_time=300, network=preset)
    swarm, baseline, meta = result["swarm"], result["baseline"], result["metadata"]
    assert swarm["tls_total"] == n * n and swarm["tls_modes"] == {"swarm": n * n}
    assert swarm["active_tls_without_decisions"] == []
    assert swarm["safety_audit"]["total_violations"] == 0
    assert baseline["safety_audit"]["total_violations"] == 0
    assert swarm["decision_status_counts"].get("applied", 0) > 0
    assert meta["network"]["tls_count"] == n * n and meta["network"]["adjacency_edges"] == 2 * n * (n - 1)
    assert meta["same_seed"] == 42 and meta["software"]["sumo"]
    validate(tmp_path / f"experiments/runs/{preset}/normal/seed-42")


def test_legacy_swarm_run_is_safe_and_accounts_for_every_junction(tmp_path):
    shutil.copytree(ROOT / "simulation/scenarios/grid3x3", tmp_path / "simulation/scenarios/grid3x3")
    from experiments.tools.run_experiment import run
    result = run("normal", 42, tmp_path, max_time=400)
    swarm = result["swarm"]
    assert swarm["tls_total"] == 9
    assert swarm["tls_native"] == {"J1": "single_green_phase", "J3": "single_green_phase",
                                   "J7": "single_green_phase", "J9": "single_green_phase"}
    assert swarm["safety_audit"]["total_violations"] == 0
    assert (tmp_path / "experiments/runs/normal/seed-42/swarm/swarm_events.jsonl").is_file()


def test_same_seed_gives_identical_swarm_results(tmp_path):
    from simulation.network.build_network import ensure_network
    from simulation.swarm.adaptive_controller import AdaptiveController
    info = ensure_network("grid3x3", root=tmp_path)
    a = AdaptiveController(7, settings=info["preset"]["controller"]).run(info["sumocfg"], tmp_path / "a", max_time=300)
    b = AdaptiveController(7, settings=info["preset"]["controller"]).run(info["sumocfg"], tmp_path / "b", max_time=300)
    for key in ("vehicles_arrived", "average_travel_time_s", "average_queue", "decision_count", "decision_status_counts"):
        assert a[key] == b[key], key
