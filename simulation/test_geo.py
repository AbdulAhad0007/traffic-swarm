"""Geo-referencing of OSM networks and real-world lab areas."""
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from simulation.network.geo import parse_location, utm_to_lonlat, xy_to_lonlat, osm_node_ids
from experiments.lab.osm_areas import AreaError, AreaStore, parse_bbox
from experiments.lab.jobs import SpecError, validate_spec

ROOT = Path(__file__).resolve().parents[1]
BLR_NET = ROOT / "simulation" / "scenarios" / "generated" / "osm_bengaluru_mg_road" / "build.net.xml"
BLR_OSM = ROOT / "simulation" / "scenarios" / "osm" / "bengaluru_mg_road" / "map.osm"


def _metres(a, b):
    return math.hypot((a[0] - b[0]) * 111320 * math.cos(math.radians(a[1])), (a[1] - b[1]) * 110570)


def test_utm_inverse_known_points():
    # Zone 43N central meridian (75 E) on the equator, and a published Bengaluru fix
    assert utm_to_lonlat(500000.0, 0.0, 43) == pytest.approx((75.0, 0.0), abs=1e-9)
    lon, lat = utm_to_lonlat(782039.12, 1434951.12, 43)
    assert _metres((lon, lat), (77.599697, 12.967255)) < 1.0
    # Southern hemisphere: the projection mirrors the northern one once the 10 000 km false northing is removed
    lon_n, lat_n = utm_to_lonlat(334369.0, 3747920.0, 56)
    lon_s, lat_s = utm_to_lonlat(334369.0, 10000000.0 - 3747920.0, 56, south=True)
    assert (lon_s, lat_s) == pytest.approx((lon_n, -lat_n), abs=1e-9)


def test_location_without_projection_is_not_geo():
    assert parse_location({"netOffset": "0.00,0.00", "projParameter": "!"}) is None
    assert parse_location(None) is None


def test_osm_node_ids_from_netconvert_names():
    assert osm_node_ids("10123663932") == [10123663932]
    assert osm_node_ids("GS_248455485") == [248455485]
    assert osm_node_ids("cluster_10001371115_10001402819_#2more", "10001371115") == [10001371115, 10001402819]
    assert osm_node_ids("J0_0") == []


@pytest.mark.skipif(not (BLR_NET.is_file() and BLR_OSM.is_file()), reason="Bengaluru OSM network not built")
def test_osm_network_junctions_land_on_their_osm_nodes():
    root = ET.parse(BLR_NET).getroot()
    loc = parse_location(root.find("location").attrib)
    nodes = {n.get("id"): (float(n.get("lon")), float(n.get("lat"))) for n in ET.parse(BLR_OSM).getroot().findall("node")}
    errors = [_metres(xy_to_lonlat(float(j.get("x")), float(j.get("y")), loc), nodes[j.get("id")])
              for j in root.findall("junction") if j.get("id") in nodes]
    assert len(errors) > 20
    assert max(errors) < 0.5


@pytest.mark.skipif(not BLR_NET.is_file(), reason="Bengaluru OSM network not built")
def test_layout_of_osm_network_is_geo_referenced():
    from simulation.network.network_model import NetworkModel
    from simulation.live.congestion import network_layout
    layout = network_layout(NetworkModel.from_net_file(BLR_NET))
    assert layout["geo"]["source"] == "openstreetmap"
    for n in layout["nodes"]:
        assert 12.96 < n["lat"] < 12.99 and 77.59 < n["lon"] < 77.62
        assert n["osm_nodes"], n["id"]


def test_grid_layout_has_no_geo():
    from simulation.network.network_model import NetworkModel
    from simulation.live.congestion import network_layout
    net = ROOT / "simulation" / "scenarios" / "generated" / "grid3x3" / "build.net.xml"
    if not net.is_file():
        pytest.skip("grid3x3 not built")
    layout = network_layout(NetworkModel.from_net_file(net))
    assert layout["geo"] is None and "lat" not in layout["nodes"][0]


def test_area_bbox_validation():
    assert parse_bbox({"south": 12.97, "west": 77.60, "north": 12.98, "east": 77.61})
    with pytest.raises(AreaError):
        parse_bbox({"south": 12.98, "west": 77.60, "north": 12.97, "east": 77.61})
    with pytest.raises(AreaError):
        parse_bbox({"south": 12.0, "west": 77.0, "north": 12.5, "east": 77.5})  # far above the 4 km^2 cap
    with pytest.raises(AreaError):
        parse_bbox("12,77,13,78")


def test_area_ids_are_validated(tmp_path):
    store = AreaStore(tmp_path)
    assert store.get("../../etc") is None
    with pytest.raises(AreaError):
        store.osm_file("missing-0123abcd")


def test_spec_osm_area_rules(tmp_path):
    with pytest.raises(SpecError):
        validate_spec({"network": "osm_user", "scenario": "normal"}, tmp_path)
    with pytest.raises(SpecError):
        validate_spec({"network": "grid3x3", "osm_area": "x-0123abcd"}, tmp_path)
    with pytest.raises(SpecError, match="unknown OSM area"):
        validate_spec({"network": "osm_user", "osm_area": "nope-0123abcd"}, tmp_path)
    area = tmp_path / "simulation" / "scenarios" / "osm" / "user" / "mg-road-0123abcd"
    area.mkdir(parents=True)
    (area / "area.json").write_text('{"id": "mg-road-0123abcd", "status": "ready", "created_utc": "x"}', encoding="utf-8")
    (area / "map.osm").write_text("<osm/>", encoding="utf-8")
    spec = validate_spec({"network": "osm_user", "osm_area": "mg-road-0123abcd", "scenario": "normal"}, tmp_path)
    assert spec["osm_area"] == "mg-road-0123abcd"
