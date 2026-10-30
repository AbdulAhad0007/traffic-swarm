"""Geo-referencing of SUMO networks imported from OpenStreetMap.

netconvert projects OSM lon/lat to UTM and shifts the result by `netOffset` (both recorded in the
net's <location> element). Inverting that puts every junction and traffic light back at its real
position on Earth. Synthetic grids carry projParameter="!" and have no real-world location.
"""
from __future__ import annotations
import math
import re

_A = 6378137.0                  # WGS84 semi-major axis
_F = 1 / 298.257223563          # WGS84 flattening
_K0 = 0.9996                    # UTM scale factor
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)


def utm_to_lonlat(easting: float, northing: float, zone: int, south: bool = False) -> tuple[float, float]:
    """Inverse transverse Mercator on WGS84 (Snyder 1987); sub-millimetre at city scale."""
    x = easting - 500000.0
    y = northing - (10000000.0 if south else 0.0)
    m = y / _K0
    mu = m / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
            + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    sin1, cos1, tan1 = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    n1 = _A / math.sqrt(1 - _E2 * sin1 ** 2)
    t1 = tan1 ** 2
    c1 = _EP2 * cos1 ** 2
    r1 = _A * (1 - _E2) / (1 - _E2 * sin1 ** 2) ** 1.5
    d = x / (n1 * _K0)
    lat = phi1 - (n1 * tan1 / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * _EP2) * d ** 4 / 24
                                     + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * _EP2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * _EP2 + 24 * t1 ** 2) * d ** 5 / 120) / cos1
    return math.degrees(lon), math.degrees(lat)


def parse_location(attrs: dict | None) -> dict | None:
    """The usable part of a net's <location> element, or None for networks without a real location."""
    if not attrs:
        return None
    proj = attrs.get("projParameter") or "!"
    m = re.search(r"\+proj=utm\b.*?\+zone=(\d+)", proj)
    if not m:
        return None
    try:
        ox, oy = (float(v) for v in attrs.get("netOffset", "0,0").split(","))
    except ValueError:
        return None
    return {"zone": int(m.group(1)), "south": "+south" in proj, "offset_x": ox, "offset_y": oy, "proj": proj,
            "orig_boundary": attrs.get("origBoundary")}


def xy_to_lonlat(x: float, y: float, location: dict) -> tuple[float, float]:
    """SUMO network coordinates (metres) of a geo-referenced net to (lon, lat)."""
    return utm_to_lonlat(x - location["offset_x"], y - location["offset_y"], location["zone"], location["south"])


_OSM_ID = re.compile(r"\d{5,}")


def osm_node_ids(*names: str) -> list[int]:
    """OSM node ids embedded in netconvert junction / TLS ids (plain ids, GS_<id>, cluster_<id>_<id>...)."""
    seen = []
    for name in names:
        for token in _OSM_ID.findall(name or ""):
            value = int(token)
            if value not in seen:
                seen.append(value)
    return seen
