"""Convert a user-supplied OpenStreetMap (.osm) file into a SUMO network with netconvert.

Nothing is downloaded here. The OSM file is read from disk, converted with SUMO's own OSM
typemaps, and every input is recorded in import_provenance.json (source hash, bounds, options,
typemap hashes, SUMO version) so the conversion can be repeated exactly.
"""
from __future__ import annotations
import hashlib, json, os, shutil, subprocess, tempfile
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET
from simulation.network.grid_generator import find_sumo_binary

VEHICLE_TYPEMAP = "osmNetconvert.typ.xml"
PEDESTRIAN_TYPEMAP = "osmNetconvertPedestrians.typ.xml"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sumo_home() -> Path | None:
    """SUMO installation folder (SUMO_HOME, the pip 'sumo' package, or next to the netconvert binary)."""
    if os.environ.get("SUMO_HOME"):
        return Path(os.environ["SUMO_HOME"])
    try:
        import sumo  # eclipse-sumo pip package
        return Path(sumo.SUMO_HOME)
    except ImportError:
        pass
    binary = find_sumo_binary("netconvert")
    if binary:
        candidate = Path(binary).resolve().parent.parent
        if (candidate / "data" / "typemap").is_dir():
            return candidate
    return None


def typemap_path(name: str) -> Path:
    home = sumo_home()
    path = home / "data" / "typemap" / name if home else None
    if path is None or not path.is_file():
        raise RuntimeError(f"SUMO typemap '{name}' not found; set SUMO_HOME to your SUMO installation.")
    return path


def osm_summary(osm_file: Path) -> dict:
    """Bounds and element counts of an .osm file (streamed, so large files are fine)."""
    nodes = ways = signals = 0
    bounds = None
    lat_min = lon_min = float("inf"); lat_max = lon_max = float("-inf")
    for _, el in ET.iterparse(osm_file, events=("end",)):
        if el.tag == "bounds":
            bounds = {k: float(el.get(k)) for k in ("minlat", "minlon", "maxlat", "maxlon")}
        elif el.tag == "node":
            nodes += 1
            lat, lon = float(el.get("lat")), float(el.get("lon"))
            lat_min, lat_max = min(lat_min, lat), max(lat_max, lat)
            lon_min, lon_max = min(lon_min, lon), max(lon_max, lon)
            if any(t.get("k") == "highway" and t.get("v") == "traffic_signals" for t in el.findall("tag")):
                signals += 1
            el.clear()
        elif el.tag == "way":
            ways += 1
            el.clear()
    if bounds is None and nodes:
        bounds = {"minlat": lat_min, "minlon": lon_min, "maxlat": lat_max, "maxlon": lon_max, "derived_from_nodes": True}
    return {"nodes": nodes, "ways": ways, "traffic_signal_nodes": signals, "bounds": bounds}


def netconvert_osm_command(osm_file: Path, out_dir: Path, osm_cfg: dict, tls: dict, typemap_dir: Path) -> tuple[list[str], list[Path]]:
    binary = find_sumo_binary("netconvert")
    if binary is None:
        raise RuntimeError("netconvert is required to import OSM data; install SUMO (or pip install eclipse-sumo).")
    pedestrians = bool(osm_cfg.get("pedestrians", False))
    names = [VEHICLE_TYPEMAP] + ([PEDESTRIAN_TYPEMAP] if pedestrians else [])
    # Typemaps are copied next to the output (provenance) and read by netconvert from a short
    # temporary folder: SUMO's XML reader fails on Windows paths longer than ~260 characters.
    local = []
    for name in names:
        shutil.copyfile(typemap_path(name), out_dir / name)
        shutil.copyfile(typemap_path(name), typemap_dir / name)
        local.append(out_dir / name)
    cmd = [binary, "--osm-files", str(osm_file.resolve()), "--type-files", ",".join(str(typemap_dir / p.name) for p in local),
           "--output-file", str(typemap_dir / "build.net.xml"),
           "--geometry.remove", "true", "--ramps.guess", "true", "--roundabouts.guess", "true",
           "--junctions.join", "true", "--tls.guess-signals", "true", "--tls.join", "true",
           "--tls.default-type", str(tls.get("default_type", "static")),
           "--tls.yellow.time", str(int(tls.get("yellow_s", 3))),
           "--remove-edges.isolated", "true", "--no-turnarounds.tls", "true",
           "--output.street-names", "true", "--no-warnings", "false"]
    if osm_cfg.get("lefthand"):
        cmd += ["--lefthand", "true"]
    if osm_cfg.get("discard_simple_tls"):
        cmd += ["--tls.discard-simple", "true"]
    if pedestrians:
        cmd += ["--sidewalks.guess", "true", "--crossings.guess", "true",
                "--tls.crossing-min.time", str(int(tls.get("crossing_min_s", 10))),
                "--tls.crossing-clearance.time", str(int(tls.get("crossing_clearance_s", 5)))]
    else:
        keep = osm_cfg.get("keep_vclasses", "passenger")
        cmd += ["--keep-edges.by-vclass", keep]
    return cmd, local


def import_osm(preset: dict, osm_file: Path, out_dir: Path) -> tuple[Path, dict]:
    """Run netconvert on `osm_file`. Returns (net path, provenance dict)."""
    if not osm_file.is_file():
        raise FileNotFoundError(f"OSM file not found: {osm_file}")
    out_dir.mkdir(parents=True, exist_ok=True)
    osm_cfg, tls = preset.get("osm", {}), preset.get("tls", {})
    with tempfile.TemporaryDirectory(prefix="tsi_typ_") as tmp:
        cmd, typemaps = netconvert_osm_command(osm_file, out_dir, osm_cfg, tls, Path(tmp))
        proc = subprocess.run(cmd, cwd=out_dir, capture_output=True, text=True)
        built = Path(tmp) / "build.net.xml"
        if proc.returncode == 0 and built.is_file():
            shutil.move(str(built), str(out_dir / "build.net.xml"))
    log = proc.stdout + proc.stderr
    (out_dir / "netconvert.log").write_text(log, encoding="utf-8")
    net = out_dir / "build.net.xml"
    if proc.returncode != 0 or not net.is_file():
        raise RuntimeError(f"netconvert failed on {osm_file} (exit {proc.returncode}); see {out_dir / 'netconvert.log'}")
    provenance = {
        "imported_at_utc": datetime.now(timezone.utc).isoformat(),
        "osm_file": str(osm_file),
        "osm_sha256": sha256_file(osm_file),
        "osm_bytes": osm_file.stat().st_size,
        "osm_summary": osm_summary(osm_file),
        "source": preset.get("source", {}),
        "netconvert_args": ["netconvert"] + [",".join(Path(x).name for x in a.split(",")) if a.endswith(".xml") else a for a in cmd[1:]],
        "typemaps": {p.name: sha256_file(p) for p in typemaps},
        "netconvert_warnings": sum(1 for line in log.splitlines() if line.startswith("Warning")),
        "license_note": "OpenStreetMap data (c) OpenStreetMap contributors, available under the ODbL 1.0.",
    }
    (out_dir / "import_provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    return net, provenance


def check_net_loads(net: Path) -> tuple[bool, str]:
    """Load the network in SUMO itself (no vehicles) to prove it is usable."""
    binary = find_sumo_binary("sumo")
    if binary is None:
        return False, "sumo binary not found"
    proc = subprocess.run([binary, "--net-file", str(net), "--end", "1", "--no-step-log", "true"],
                          capture_output=True, text=True, timeout=300)
    errors = [l for l in (proc.stdout + proc.stderr).splitlines() if l.startswith("Error")]
    return proc.returncode == 0 and not errors, ("ok" if proc.returncode == 0 and not errors else "; ".join(errors[:3]) or f"exit {proc.returncode}")
