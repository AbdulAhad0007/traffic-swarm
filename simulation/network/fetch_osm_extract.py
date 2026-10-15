#!/usr/bin/env python3
"""Download a SMALL road extract from the free Overpass API (manual use only).

The import pipeline never calls this; it only reads local .osm files. This helper exists so a
small extract can be obtained reproducibly. The area is capped (default 4 km^2) to avoid large
downloads and to respect the public Overpass service.

  python -m simulation.network.fetch_osm_extract --bbox 12.9700,77.6030,12.9780,77.6130 --out map.osm
"""
from __future__ import annotations
import argparse, math, sys, urllib.parse, urllib.request
from pathlib import Path

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
HIGHWAYS = ("trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|"
            "trunk_link|primary_link|secondary_link|tertiary_link|footway|pedestrian")


def bbox_area_km2(south: float, west: float, north: float, east: float) -> float:
    lat_km = (north - south) * 111.32
    lon_km = (east - west) * 111.32 * math.cos(math.radians((north + south) / 2))
    return abs(lat_km * lon_km)


def build_query(south: float, west: float, north: float, east: float) -> str:
    return (f'[out:xml][timeout:60];(way["highway"~"^({HIGHWAYS})$"]({south},{west},{north},{east}););'
            "(._;>;);out body;")


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    parts = [float(x) for x in text.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be 'south,west,north,east'")
    s, w, n, e = parts
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise ValueError("bbox must satisfy south < north and west < east")
    return s, w, n, e


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bbox", required=True, help="south,west,north,east in degrees")
    p.add_argument("--out", required=True)
    p.add_argument("--max-area-km2", type=float, default=4.0)
    args = p.parse_args()
    bbox = parse_bbox(args.bbox)
    area = bbox_area_km2(*bbox)
    if area > args.max_area_km2:
        print(f"Refusing: bbox is {area:.2f} km^2 > --max-area-km2 {args.max_area_km2}. Use a smaller area "
              "or a regional extract from a mirror (e.g. Geofabrik) cut with osmium.", file=sys.stderr)
        return 2
    data = urllib.parse.urlencode({"data": build_query(*bbox)}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data, headers={"User-Agent": "traffic-swarm-intelligence/1.2 (student project)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        Path(args.out).write_bytes(resp.read())
    print(f"Saved {args.out} ({area:.2f} km^2). Data (c) OpenStreetMap contributors, ODbL 1.0.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
