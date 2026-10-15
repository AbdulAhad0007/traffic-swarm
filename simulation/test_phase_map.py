"""Regression tests for phase mapping and clearance handling (no SUMO needed)."""
from pathlib import Path
from simulation.network.network_model import NetworkModel
from simulation.network.phase_map import build_all, classify_phases, validate_program

ROOT = Path(__file__).resolve().parents[1]
LEGACY_NET = ROOT / "simulation/scenarios/grid3x3/build.net.xml"
SETTINGS = {"min_green_s": 10, "min_yellow_s": 3, "pedestrian_min_green_s": 15}


def legacy_maps():
    return build_all(NetworkModel.from_net_file(LEGACY_NET), SETTINGS)


def test_legacy_phase_zero_is_not_assumed_to_be_north_south():
    maps = legacy_maps()
    # J2 and J8 serve East-West in phase 0; the old code assumed phase 0 == NS.
    assert maps["J2"].green_by_index(0).axis == "EW"
    assert maps["J8"].green_by_index(0).axis == "EW"
    assert maps["J5"].green_by_index(0).axis == "NS"
    assert maps["J5"].green_by_index(2).axis == "EW"


def test_legacy_yellow_phases_with_a_carried_green_are_transitions():
    maps = legacy_maps()
    # J6 phase 1 is "Gyyyyyrrr": it contains 'G' but is a yellow clearance phase.
    assert maps["J6"].kinds == ["green", "yellow", "green", "yellow"]
    assert not maps["J6"].is_green(1) and not maps["J6"].is_green(3)
    for pm in maps.values():
        for g in pm.greens:
            assert all(pm.kinds[t] != "green" for t in g.transition)


def test_legacy_served_lanes_come_from_the_program_not_from_lane_order():
    maps = legacy_maps()
    assert set(maps["J2"].green_by_index(0).served_lanes) == {"J3J2_0", "J1J2_0"}   # east + west
    assert set(maps["J5"].green_by_index(2).served_lanes) == {"J6J5_0", "J4J5_0"}


def test_legacy_status_and_neighbor_graph_match_original_topology():
    model = NetworkModel.from_net_file(LEGACY_NET)
    maps = build_all(model, SETTINGS)
    assert {t for t, pm in maps.items() if pm.status == "single_green_phase"} == {"J1", "J3", "J7", "J9"}
    assert {t for t, pm in maps.items() if pm.controllable} == {"J2", "J4", "J5", "J6", "J8"}
    original = {"J1": ["J2", "J4"], "J2": ["J1", "J3", "J5"], "J3": ["J2", "J6"], "J4": ["J1", "J5", "J7"],
                "J5": ["J2", "J4", "J6", "J8"], "J6": ["J3", "J5", "J9"], "J7": ["J4", "J8"],
                "J8": ["J5", "J7", "J9"], "J9": ["J6", "J8"]}
    assert {t: model.neighbors(t) for t in model.tls_ids} == original
    assert model.adjacency_edge_count() == 12


def test_classify_all_red_and_pedestrian_clearance():
    states = ["gGgrrrgGgrrrrGrG", "gGgrrrgGgrrrrrrr", "yyyrrryyyrrrrrrr", "rrrrrrrrrrrrrrrr",
              "rrrgGgrrrgGgGrGr", "rrrgGgrrrgGgrrrr", "rrryyyrrryyyrrrr", "rrrrrrrrrrrrrrrr"]
    assert classify_phases(states) == ["green", "clearance", "yellow", "all_red",
                                       "green", "clearance", "yellow", "all_red"]


def test_validate_detects_missing_yellow():
    issues = validate_program(["GGrr", "rrGG"], [30, 30], {0, 1, 2, 3}, 4, 3)
    assert any(i.startswith("missing_yellow") for i in issues)


def test_validate_detects_short_yellow():
    issues = validate_program(["GGrr", "yyrr", "rrGG", "rryy"], [30, 2, 30, 3], {0, 1, 2, 3}, 4, 3)
    assert any(i.startswith("yellow_too_short") for i in issues)
    assert validate_program(["GGrr", "yyrr", "rrGG", "rryy"], [30, 3, 30, 3], {0, 1, 2, 3}, 4, 3) == []


def test_pedestrian_links_may_end_without_yellow_but_vehicle_links_may_not():
    # link 2 is a pedestrian crossing: G -> r directly is allowed for it.
    assert validate_program(["GGG", "GGr", "yyr", "rrr"], [20, 5, 3, 1], {0, 1}, 3, 3) == []
    assert validate_program(["GGG", "GGr", "yyr", "rrr"], [20, 5, 3, 1], {0, 1, 2}, 3, 3) != []


def test_validate_rejects_off_signals_and_bad_lengths():
    assert validate_program(["GGo", "yyr"], [30, 3], {0, 1, 2}, 3, 3)
    assert validate_program(["GG", "yy"], [30, 3], {0, 1, 2}, 3, 3)
