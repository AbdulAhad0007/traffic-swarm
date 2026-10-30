"""Real-world areas for the lab: OpenStreetMap extracts that SUMO jobs can simulate.

An area is a small bounding box downloaded once from the public Overpass API (same query as
simulation/network/fetch_osm_extract.py) into simulation/scenarios/osm/user/<id>/map.osm. Jobs on
the `osm_user` preset then import it with netconvert, so the traffic lights SUMO controls are the
ones mapped in OSM and the dashboard can place them at their real coordinates.
"""
from __future__ import annotations
import hashlib, json, re, threading, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

from simulation.network.fetch_osm_extract import OVERPASS_URL, bbox_area_km2, build_query

MAX_AREA_KM2 = 4.0          # keeps netconvert + SUMO runs to minutes
ID_RE = re.compile(r"^[a-z0-9-]{1,40}-[0-9a-f]{8}$")
# z. and lz4. are the machines behind the overpass-api.de balancer, which answers 502 while one of them is fine
MIRRORS = [OVERPASS_URL, "https://z.overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://lz4.overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
ROUNDS = 3                  # busy public servers fail in bursts; wait and try every mirror again


class AreaError(ValueError):
    pass


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "area"


def parse_bbox(raw) -> tuple[float, float, float, float]:
    try:
        s, w, n, e = (float(raw[k]) for k in ("south", "west", "north", "east"))
    except (TypeError, KeyError, ValueError):
        raise AreaError("bbox must be an object with numeric south, west, north, east")
    if not (-90 <= s < n <= 90 and -180 <= w < e <= 180):
        raise AreaError("bbox must satisfy south < north and west < east")
    area = bbox_area_km2(s, w, n, e)
    if area > MAX_AREA_KM2:
        raise AreaError(f"area is {area:.1f} km^2; the lab simulates at most {MAX_AREA_KM2:.0f} km^2 per area")
    return round(s, 6), round(w, 6), round(n, 6), round(e, 6)


def _signal_count(osm_file: Path) -> int:
    from simulation.network.osm_import import osm_summary
    return osm_summary(osm_file)["traffic_signal_nodes"]


class AreaStore:
    def __init__(self, root: Path):
        self.dir = Path(root) / "simulation" / "scenarios" / "osm" / "user"
        self.lock = threading.RLock()

    def _meta_path(self, area_id: str) -> Path:
        return self.dir / area_id / "area.json"

    def get(self, area_id: str) -> dict | None:
        if not isinstance(area_id, str) or not ID_RE.match(area_id):
            return None
        p = self._meta_path(area_id)
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None

    def osm_file(self, area_id: str) -> Path:
        meta = self.get(area_id)
        if not meta:
            raise AreaError(f"unknown OSM area '{area_id}'")
        if meta["status"] != "ready":
            raise AreaError(f"OSM area '{area_id}' is {meta['status']}, not ready yet")
        return self.dir / area_id / "map.osm"

    def list(self) -> list[dict]:
        if not self.dir.is_dir():
            return []
        out = [self.get(p.name) for p in self.dir.iterdir() if p.is_dir()]
        return sorted([a for a in out if a], key=lambda a: a["created_utc"], reverse=True)

    def _write(self, meta: dict) -> None:
        p = self._meta_path(meta["id"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def create(self, name: str, bbox_raw) -> dict:
        bbox = parse_bbox(bbox_raw)
        name = (str(name or "").strip() or "OSM area")[:80]
        area_id = f"{_slug(name)}-{hashlib.sha1(json.dumps(bbox).encode()).hexdigest()[:8]}"
        with self.lock:
            existing = self.get(area_id)
            if existing and existing["status"] in ("ready", "downloading"):
                return existing
            meta = {"id": area_id, "name": name, "bbox_swne": list(bbox), "area_km2": round(bbox_area_km2(*bbox), 2),
                    "status": "downloading", "created_utc": datetime.now(timezone.utc).isoformat(),
                    "license": "(c) OpenStreetMap contributors, ODbL 1.0"}
            self._write(meta)
        threading.Thread(target=self._download, args=(meta,), daemon=True).start()
        return meta

    def _download(self, meta: dict) -> None:
        out = self.dir / meta["id"] / "map.osm"
        data = urllib.parse.urlencode({"data": build_query(*meta["bbox_swne"])}).encode()
        errors = []
        for url in [u for r in range(ROUNDS) for u in MIRRORS]:
            if errors and url == MIRRORS[0]:
                time.sleep(10)
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "traffic-swarm-intelligence/1.3 (lab)"})
                with urllib.request.urlopen(req, timeout=300) as resp:
                    body = resp.read()
                if b"<osm" not in body[:500]:
                    raise RuntimeError("answer is not OSM XML")
                out.write_bytes(body)
                signals = _signal_count(out)
                with self.lock:
                    self._write({**meta, "status": "ready", "osm_bytes": len(body), "traffic_signal_nodes": signals,
                                 "downloaded_utc": datetime.now(timezone.utc).isoformat(), "source": url})
                return
            except Exception as exc:  # network errors, HTTP 429/504, bad payload: try the next mirror
                errors.append(f"{urllib.parse.urlparse(url).netloc}: {exc}")
        with self.lock:
            self._write({**meta, "status": "failed", "error": "; ".join(errors)[:500]})
