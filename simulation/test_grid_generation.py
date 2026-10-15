"""Grid generation, configuration and topology tests.

Pure-Python tests always run. Tests marked `sumo` build real networks with netconvert and are
skipped automatically when SUMO is not installed (see simulation/conftest.py).
"""
import json
import pytest
from simulation.network.grid_generator import build_layout, junction_id
from simulation.network.demand import grid_flows
from simulation.network.presets import resolve_preset, preset_names, config_hash


@pytest.mark.parametrize("n", [3, 5, 9])
def test_layout_counts_and_deterministic_ids(n):
    layout = build_layout(n, n, 150, 120)
    assert layout.tls_ids == [junction_id(r, c) for r in range(n) for c in range(n)]
    assert len(layout.tls_ids) == n * n
    assert layout.expected_adjacency_edges() == 2 * n * (n - 1)
    internal = [e for e in layout.edges if e[1].startswith("J") and e[2].startswith("J")]
    assert len(internal) == 2 * layout.expected_adjacency_edges()          # both directions
    assert len(layout.nodes) == n * n + 4 * n                               # + fringe nodes
    assert build_layout(n, n, 150, 120) == layout


def test_non_square_grid_is_supported():
    layout = build_layout(2, 4, 100, 100)
    assert len(layout.tls_ids) == 8 and layout.expected_adjacency_edges() == 2 * 3 + 4 * 1


@pytest.mark.parametrize("n", [3, 5, 9])
def test_demand_has_conflicting_movements_and_is_deterministic(n):
    demand = {"straight_veh_per_hour": 240, "turn_veh_per_hour": 60, "demand_seed": 7}
    flows = grid_flows(n, n, demand)
    assert flows == grid_flows(n, n, demand)
    assert len(flows) == 2 * 4 * n                                          # straight + one turn per entry
    starts = {f["from"].split("__")[0][0] for f in flows}
    assert starts == {"N", "S", "W", "E"}                                   # both axes loaded everywhere


def test_presets_are_config_driven():
    names = preset_names()
    assert {"grid3x3_legacy", "grid3x3", "grid5x5", "grid9x9"} <= set(names)
    p = resolve_preset("grid9x9")
    assert (p["rows"], p["cols"]) == (9, 9)
    assert p["controller"]["min_green_s"] <= p["controller"]["max_green_s"]
    assert config_hash(p) == config_hash(resolve_preset("grid9x9"))
    assert config_hash(p) != config_hash(resolve_preset("grid5x5"))


def test_custom_preset_without_code_changes(tmp_path):
    from simulation.network.presets import load_config, DEFAULT_CONFIG
    data = load_config(DEFAULT_CONFIG)
    data["presets"]["grid4x6"] = {"type": "grid", "rows": 4, "cols": 6, "grid": {"lanes": 2}}
    path = tmp_path / "networks.json"
    path.write_text(json.dumps(data))
    p = resolve_preset("grid4x6", path)
    assert (p["rows"], p["cols"], p["grid"]["lanes"], p["grid"]["block_length_m"]) == (4, 6, 2, 150)
    data["presets"]["bad"] = {"type": "grid", "rows": 0, "cols": 3}
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        resolve_preset("bad", path)
    with pytest.raises(ValueError):
        resolve_preset("does-not-exist", path)


# ------------------------------------------------------------------ with netconvert
@pytest.mark.sumo
@pytest.mark.parametrize("preset,n", [("grid3x3", 3), ("grid5x5", 5), ("grid9x9", 9)])
def test_generated_grid_validates(tmp_path, preset, n):
    from simulation.network.build_network import ensure_network
    info = ensure_network(preset, root=tmp_path)
    meta, model = info["meta"], info["model"]
    assert meta["tls_count"] == n * n
    assert meta["adjacency_edges"] == 2 * n * (n - 1)
    assert meta["components"] == 1
    assert meta["phase_map_status"] == {"controllable": n * n}
    expected_degrees = {"2": 4, "3": 4 * (n - 2), "4": (n - 2) ** 2}
    assert meta["degree_histogram"] == {k: v for k, v in expected_degrees.items() if v}
    # Not every junction has four neighbors, and none is assumed to.
    assert len(model.neighbors(junction_id(0, 0))) == 2
    # Rebuilding gives the identical network (deterministic generation).
    again = ensure_network(preset, root=tmp_path, force=True)
    assert again["meta"]["net_sha256"] == meta["net_sha256"]


def test_legacy_network_still_validates():
    # Uses the committed legacy net file; no netconvert needed.
    from simulation.network.build_network import ensure_network
    meta = ensure_network("grid3x3_legacy")["meta"]
    assert meta["tls_count"] == 9 and meta["adjacency_edges"] == 12
    assert meta["phase_map_status"] == {"controllable": 5, "single_green_phase": 4}
