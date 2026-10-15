# Sample OSM extract: Bengaluru, MG Road area

`map.osm` is a small road-only extract of central Bengaluru (MG Road / Brigade Road area). It is used as the sample for the OSM import workflow.

| Item | Value |
|---|---|
| Bounding box (S, W, N, E) | 12.9700, 77.6030, 12.9780, 77.6130 (about 0.89 km × 1.08 km) |
| Retrieved | 2026-10-13, one manual request to the public Overpass API (`osm_base` 2026-10-12T19:41:49Z) |
| Size | 438,670 bytes; 616 ways; 2,733 nodes; 21 nodes tagged `highway=traffic_signals` (plus signalised pedestrian-crossing tags) |
| sha256 | `cc6cd752852942d4c7c521fc8793fc10c9c646eb0eb29dde6f097c0eb9fd1a02` |
| License | © OpenStreetMap contributors, Open Database License (ODbL) 1.0: https://www.openstreetmap.org/copyright |

Query used (Overpass QL, road and footway types only):

```
[out:xml][timeout:60];
(way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|trunk_link|primary_link|secondary_link|tertiary_link|footway|pedestrian)$"](12.9700,77.6030,12.9780,77.6130););
(._;>;);
out body;
```

Re-create it with `python -m simulation.network.fetch_osm_extract --bbox 12.9700,77.6030,12.9780,77.6130 --out map.osm`. OSM changes over time, so the hash will differ.

## Caveats

- OSM signal tags, lane counts and turn restrictions are crowd-sourced and may be incomplete or outdated.
- Signal timings are **not** in OSM. netconvert generates default programs, so they do not represent the real signal plans at this location.
- The project does not control, and must not be used to modify, any real traffic infrastructure.
