"""OSM import, mixed demand, real road closure (skipped automatically when SUMO is not installed)."""
from collections import Counter
from pathlib import Path
import xml.etree.ElementTree as ET
import pytest

ROOT = Path(__file__).resolve().parents[1]
SAMPLE_OSM = ROOT / "simulation/scenarios/osm/bengaluru_mg_road/map.osm"
SAMPLE_SHA = "cc6cd752852942d4c7c521fc8793fc10c9c646eb0eb29dde6f097c0eb9fd1a02"
pytestmark = pytest.mark.sumo


@pytest.fixture(scope="module")
def osm_info(tmp_path_factory):
    from simulation.network.build_network import ensure_network
    return ensure_network("osm_bengaluru_mg_road", root=tmp_path_factory.mktemp("osm"), osm_file=SAMPLE_OSM)


def test_osm_sample_converts_validates_and_loads(osm_info):
    meta, model = osm_info["meta"], osm_info["model"]
    assert meta["errors"] == []                                   # includes "SUMO could load the net"
    assert meta["source"]["osm_sha256"] == SAMPLE_SHA             # provenance recorded
    assert meta["source"]["license_note"].startswith("OpenStreetMap data")
    assert meta["tls_count"] > 0 and sum(meta["phase_map_status"].values()) == meta["tls_count"]
    if "1.27.1" in (meta["netconvert_version"] or ""):
        assert meta["tls_count"] == 20                            # value verified for SUMO 1.27.1
    degrees = {int(k) for k in meta["degree_histogram"]}
    assert degrees - {4}                                          # irregular: not a 4-neighbor grid
    assert meta["junctions"] > meta["tls_count"] and meta["roads"] > 50
    entries, exits = model.fringe_edges()
    assert entries and exits


def test_missing_osm_falls_back_to_grid(tmp_path):
    from simulation.network.build_network import ensure_network
    info = ensure_network("osm_user", root=tmp_path)
    assert info["meta"]["fallback_from"] == "osm_user" and info["meta"]["preset"] == "grid5x5_india"
    info = ensure_network("osm_user", root=tmp_path, osm_file=tmp_path / "nope.osm")
    assert "not found" in info["meta"]["fallback_reason"]


def test_osm_mixed_demand_is_seeded_routable_and_mixed(osm_info, tmp_path):
    from simulation.network.scenario_builder import build_scenario
    a = build_scenario(osm_info, "normal", tmp_path / "a", demand_seed=5)
    b = build_scenario(osm_info, "normal", tmp_path / "b", demand_seed=5)
    c = build_scenario(osm_info, "normal", tmp_path / "c", demand_seed=6)
    read = lambda d: (d / "trips.xml").read_bytes()
    assert read(tmp_path / "a") == read(tmp_path / "b")           # same seed -> identical demand
    assert read(tmp_path / "a") != read(tmp_path / "c")
    check = a["meta"]["route_check"]
    assert check["dropped"] == 0 and check["errors"] == 0
    counts = Counter(v.get("type") for v in ET.parse(a["routes"]).getroot().iter("vehicle"))
    total = sum(counts.values())
    for vt, share in a["meta"]["mix_shares"].items():
        assert abs(counts[vt] / total - share) < 0.08, (vt, counts[vt], total)
    expected = osm_info["preset"]["demand"]["vehicles_per_hour"] * 900 / 3600
    assert 0.8 * expected < total < 1.2 * expected


def test_rush_hour_and_surge_change_demand_over_time(osm_info, tmp_path):
    from simulation.network.scenario_builder import build_scenario
    def per_window(scenario):
        built = build_scenario(osm_info, scenario, tmp_path / scenario, demand_seed=3)
        departs = [float(v.get("depart")) for v in ET.parse(built["routes"]).getroot().iter("vehicle")]
        return [sum(1 for d in departs if lo <= d < hi) for lo, hi in ((0, 297), (297, 450), (450, 900))]
    normal, surge = per_window("normal"), per_window("sudden-congestion")
    assert surge[1] > 1.8 * normal[1]                            # 2.5x surge window
    assert abs(surge[0] - normal[0]) <= 0.35 * max(normal[0], 1)


def test_grid_normal_demand_is_unchanged_from_phase1(tmp_path):
    from simulation.network.build_network import ensure_network
    from simulation.network.scenario_builder import build_scenario
    from experiments.tools.scenario_generator import generate
    info = ensure_network("grid3x3", root=tmp_path)
    built = build_scenario(info, "normal", tmp_path / "run")
    old = generate(info["routes"], tmp_path / "phase1.rou.xml", "normal")
    flows = lambda p: [dict(f.attrib) for f in ET.parse(p).getroot().findall("flow")]
    assert flows(built["routes"]) == flows(old)


def test_road_closure_is_real_and_respected(tmp_path):
    from experiments.tools.run_experiment import run
    from experiments.tools.validate_run_artifacts import validate
    result = run("road-closure", 42, tmp_path, max_time=900, network="grid3x3")
    closure = result["metadata"]["scenario_definition"]["closure"]
    assert closure["mechanism"] == "SUMO rerouter closingReroute" and closure["planned_use"] > 0
    add = ET.parse(tmp_path / "experiments/runs/grid3x3/road-closure/seed-42/closure.add.xml").getroot()
    assert add.find(".//closingReroute").get("id") == closure["edge"]
    for label in ("baseline", "swarm"):
        check = result[label]["closure_check"]
        assert check["vehicles_entered_before_closure"] > 0       # the road carried traffic before...
        assert check["vehicles_entered_during_closure"] == 0       # ...and none after it was closed
    validate(tmp_path / "experiments/runs/grid3x3/road-closure/seed-42")


def test_osm_experiment_smoke(tmp_path):
    from experiments.tools.run_experiment import run
    from experiments.tools.validate_run_artifacts import validate
    result = run("normal", 42, tmp_path, max_time=600, network="osm_bengaluru_mg_road", osm_file=SAMPLE_OSM)
    s, b = result["swarm"], result["baseline"]
    assert s["tls_total"] == result["metadata"]["network"]["tls_count"]
    assert s["active_tls_without_decisions"] == []
    assert s["safety_audit"]["total_violations"] == 0 and b["safety_audit"]["total_violations"] == 0
    assert set(s["per_vtype"]) <= {"car_in", "motorcycle_in", "auto_rickshaw", "bus_in"}
    assert "simulation_failures" in s and "average_time_loss_s" in s
    validate(tmp_path / "experiments/runs/osm_bengaluru_mg_road/normal/seed-42")
