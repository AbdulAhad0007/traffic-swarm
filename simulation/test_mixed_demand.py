"""Vehicle types, scenario profiles, SUMO output parsing and closure checks (no SUMO needed)."""
import json
from pathlib import Path
import pytest
from simulation.metrics import parse_tripinfo, parse_statistics
from simulation.network.network_model import NetworkModel
from simulation.network.presets import resolve_preset
from simulation.network.scenario_builder import scenario_profile, _windows
from simulation.network.vehicle_types import resolve_mix, vtype_attrs, load_vehicle_config
from simulation.runtime import ClosureMonitor

ROOT = Path(__file__).resolve().parents[1]


def test_india_mix_is_valid_and_documented():
    mix = resolve_mix("india_urban_assumed")
    assert set(mix) == {"motorcycle_in", "car_in", "auto_rickshaw", "bus_in"}
    assert abs(sum(mix.values()) - 1) < 1e-9
    cfg = load_vehicle_config()
    assert "ASSUMED" in cfg["mixes"]["india_urban_assumed"]["note"]          # not presented as observed data
    for vt in mix:
        assert cfg["vtypes"][vt]["source"]                                    # every type cites its source


def test_vehicle_parameters_match_cited_sources():
    auto = vtype_attrs("auto_rickshaw")
    assert (auto["length"], auto["width"], auto["maxSpeed"], auto["guiShape"]) == ("2.635", "1.3", "18.06", "rickshaw")
    moto = vtype_attrs("motorcycle_in")
    assert (moto["vClass"], moto["length"], moto["width"]) == ("motorcycle", "2.0", "0.72")
    bus = vtype_attrs("bus_in")
    assert (bus["vClass"], bus["length"], bus["accel"], bus["decel"]) == ("bus", "12", "1.2", "4")
    assert vtype_attrs("car")["length"] == "5"                                # legacy type unchanged


def test_bad_mixes_are_rejected(tmp_path):
    cfg = load_vehicle_config()
    cfg["mixes"]["bad_sum"] = {"shares": {"car_in": 0.5, "bus_in": 0.4}}
    cfg["mixes"]["bad_type"] = {"shares": {"tuk_tuk": 1.0}}
    cfg["mixes"]["negative"] = {"shares": {"car_in": 1.5, "bus_in": -0.5}}
    path = tmp_path / "vt.json"
    path.write_text(json.dumps(cfg))
    for name in ("bad_sum", "bad_type", "negative", "missing"):
        with pytest.raises(ValueError):
            resolve_mix(name, path)


def test_scenario_profiles_are_time_varying_and_validated():
    preset = resolve_preset("osm_bengaluru_mg_road")
    rush = _windows(preset["demand"], scenario_profile(preset, "rush-hour"))
    assert [m for _, _, m in rush] == [1.2, 2.0, 1.4]
    surge = _windows(preset["demand"], scenario_profile(preset, "sudden-congestion"))
    assert max(m for _, _, m in surge) == 2.5 and surge[0][2] == 1.0          # surge is time-bounded
    assert scenario_profile(preset, "road-closure")["closure"]["edge"] == "auto"
    assert scenario_profile(preset, "uneven")["side_weights"]["N"] > 1
    with pytest.raises(ValueError):
        scenario_profile(preset, "does-not-exist")
    bad = dict(preset, scenarios={"x": {"segments": [[0.5, 0.2, 1.0]]}})
    with pytest.raises(ValueError):
        scenario_profile(bad, "x")


def test_osm_presets_fall_back_to_a_grid():
    for name in ("osm_bengaluru_mg_road", "osm_user"):
        assert resolve_preset(name)["fallback_preset"] == "grid5x5_india"
    assert resolve_preset("osm_user")["osm_file"] is None


def test_closure_monitor_counts_only_new_entries_while_closed():
    m = ClosureMonitor({"edge": "e", "begin_s": 10, "end_s": 20})
    m.observe(5, ["a"])            # used before the closure
    m.observe(10, ["a", "b"])      # closure starts: a and b are already on the edge, allowed to leave
    m.observe(11, ["b"])
    m.observe(12, ["b", "c"])      # c enters during the closure -> violation
    r = m.report()
    assert r["vehicles_entered_before_closure"] == 1
    assert r["vehicles_on_edge_when_closed"] == 2
    assert r["vehicles_entered_during_closure"] == 1 and r["examples"] == [{"vehicle": "c", "time": 12}]


def test_tripinfo_and_statistics_parsing(tmp_path):
    (tmp_path / "tripinfo.xml").write_text("""<tripinfos>
      <tripinfo id="v1" vType="car_in" arrival="50" duration="40" timeLoss="10" waitingCount="2" waitingTime="6" rerouteNo="1"/>
      <tripinfo id="v2" vType="bus_in" arrival="80" duration="60" timeLoss="30" waitingCount="1" waitingTime="9" rerouteNo="0"/>
      <tripinfo id="v3" vType="car_in" arrival="-1" duration="-1" timeLoss="0" waitingCount="0" waitingTime="0"/>
      <personinfo id="p1"><walk arrival="100" duration="90" timeLoss="5"/></personinfo>
    </tripinfos>""")
    t = parse_tripinfo(tmp_path / "tripinfo.xml")
    assert t["n"] == 2 and t["average_time_loss_s"] == 20 and t["unfinished_in_tripinfo"] == 1
    assert t["rerouted_vehicles"] == 1 and t["per_vtype"]["bus_in"]["average_time_loss_s"] == 30
    assert t["persons_arrived"] == 1 and t["person_average_time_loss_s"] == 5
    (tmp_path / "statistics.xml").write_text("""<statistics>
      <vehicles loaded="3" inserted="3" running="0" waiting="0"/>
      <teleports total="2" jam="1" yield="1" wrongLane="0"/>
      <safety collisions="0" emergencyStops="1"/>
      <persons loaded="1"/></statistics>""")
    s = parse_statistics(tmp_path / "statistics.xml")
    assert (s["vehicles_loaded"], s["teleports"], s["collisions"], s["emergency_stops"]) == (3, 2, 0, 1)


def test_routable_core_respects_connections_on_legacy_net():
    model = NetworkModel.from_net_file(ROOT / "simulation/scenarios/grid3x3/build.net.xml")
    core = model.routable_edges("passenger")
    assert core and core <= set(model.normal_edges())
    # Every edge of the core can reach every other edge through real connections.
    start = next(iter(core))
    seen, stack = {start}, [start]
    while stack:
        for n in model.successors.get(stack.pop(), ()):
            if n in core and n not in seen:
                seen.add(n); stack.append(n)
    assert seen == core
