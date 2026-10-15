#!/usr/bin/env python3
"""Build (if needed) and validate the network for a preset.

  python -m simulation.network.build_network --preset grid9x9
  python -m simulation.network.build_network --preset osm_bengaluru_mg_road
  python -m simulation.network.build_network --preset osm_user --osm-file path/to/area.osm
  python -m simulation.network.build_network --preset grid3x3_legacy   # validates the original net

Generated grids are written to simulation/scenarios/generated/<preset>/ and reused while the
preset's configuration hash is unchanged.
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from simulation.network.presets import resolve_preset, config_hash
from simulation.network.grid_generator import build_grid, build_layout, find_sumo_binary
from simulation.network.network_model import NetworkModel, net_content_hash
from simulation.network.phase_map import build_all
from simulation.network.demand import grid_flows, write_routes, write_sumocfg
from simulation.network.osm_import import import_osm, check_net_loads, sha256_file

GENERATED_DIR = Path("simulation/scenarios/generated")


class NetworkValidationError(RuntimeError):
    pass


def tool_version(name: str) -> str | None:
    binary = find_sumo_binary(name)
    if not binary:
        return None
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=30).stdout
        return out.splitlines()[0].strip() if out else None
    except (OSError, subprocess.SubprocessError):
        return None


def validate_network(model: NetworkModel, preset: dict) -> dict:
    """Check the built network against the preset. Raises NetworkValidationError on failure."""
    phase_maps = build_all(model, preset["controller"])
    status = {t: pm.status for t, pm in phase_maps.items()}
    errors = []
    warnings = []
    invalid = {t: pm.issues for t, pm in phase_maps.items() if pm.issues}
    if invalid and preset["type"] != "osm":
        errors.append(f"unsafe or unsupported signal programs: {invalid}")
    elif invalid:
        # Imported programs come from netconvert's guesses; unsafe ones are excluded from swarm
        # control (they keep their SUMO program) and reported, never silently dropped.
        warnings.append(f"{len(invalid)} imported TLS programs failed validation and run as native: {sorted(invalid)}")
    if preset["type"] == "osm":
        if not model.tls:
            errors.append("the imported network has no traffic lights (check the OSM extract and tls options)")
        ok, why = check_net_loads(model.path)
        if not ok:
            errors.append(f"SUMO could not load the network: {why}")
        entries, exits = model.fringe_edges()
        if not entries or not exits:
            errors.append("no boundary roads found for demand generation")
        if model.connected_components() > 1:
            warnings.append(f"TLS neighbor graph has {model.connected_components()} components "
                            f"(neighbor search limit {model.neighbor_max_distance:g} m)")
    if preset["type"] == "grid":
        rows, cols = preset["rows"], preset["cols"]
        layout = build_layout(rows, cols, 1.0, 1.0)
        expected_ids = sorted(layout.tls_ids)
        if model.tls_ids != expected_ids:
            missing = sorted(set(expected_ids) - set(model.tls_ids))
            extra = sorted(set(model.tls_ids) - set(expected_ids))
            errors.append(f"TLS ids differ from grid: missing={missing} extra={extra}")
        if model.adjacency_edge_count() != layout.expected_adjacency_edges():
            errors.append(f"adjacency edges {model.adjacency_edge_count()} != expected {layout.expected_adjacency_edges()}")
        not_controllable = sorted(t for t, s in status.items() if s != "controllable")
        if not_controllable:
            errors.append(f"generated grid TLS not controllable: {not_controllable}")
        if model.connected_components() != 1:
            errors.append(f"TLS graph has {model.connected_components()} components")
    report = {
        "tls_count": len(model.tls),
        "adjacency_edges": model.adjacency_edge_count(),
        "degree_histogram": {str(k): v for k, v in model.degree_histogram().items()},
        "components": model.connected_components(),
        "phase_map_status": {s: sum(1 for v in status.values() if v == s) for s in sorted(set(status.values()))},
        "tls_status": status,
        "net_sha256": net_content_hash(model.path),
        "junctions": sum(1 for j in model.junctions.values() if j["type"] != "internal"),
        "roads": len(model.normal_edges()),
        "tls_issues": invalid,
        "warnings": warnings,
        "errors": errors,
    }
    if errors:
        raise NetworkValidationError("; ".join(errors))
    return report


def ensure_network(preset_name: str, root: Path = PROJECT_ROOT, config_path: str | Path | None = None,
                   force: bool = False, osm_file: str | Path | None = None) -> dict:
    """Return {'dir', 'net', 'routes', 'sumocfg', 'preset', 'meta', 'model'} for a validated network.

    For an OSM preset without an available .osm file, falls back to the preset's
    `fallback_preset` (recorded as meta['fallback_from']) instead of failing.
    """
    preset = resolve_preset(preset_name, config_path)
    model_kwargs = {"neighbor_max_distance": float(preset.get("neighbor_max_distance_m", 600))}
    if preset["type"] == "legacy":
        base = root / preset["directory"]
        net = base / "build.net.xml"
        if not net.exists():
            netconvert = find_sumo_binary("netconvert")
            if not netconvert:
                raise RuntimeError("netconvert is required to build the SUMO network. Install SUMO and add it to PATH.")
            subprocess.run([netconvert, "--node-files", str(base / "grid.nod.xml"), "--edge-files", str(base / "grid.edg.xml"),
                            "--output-file", str(net)], check=True)
        model = NetworkModel.from_net_file(net, **model_kwargs)
        meta = {"preset": preset_name, "type": "legacy", **validate_network(model, preset)}
        return {"dir": base, "net": net, "routes": base / "routes.rou.xml", "sumocfg": base / "sumo.sumocfg",
                "preset": preset, "meta": meta, "model": model}

    if preset["type"] == "osm":
        source = osm_file if osm_file is not None else preset.get("osm_file")
        source_path = None if source is None else (Path(source) if Path(source).is_absolute() else root / source)
        if source_path is None or not source_path.is_file():
            fallback = preset.get("fallback_preset")
            reason = "no OSM file configured" if source_path is None else f"OSM file not found: {source_path}"
            if not fallback:
                raise FileNotFoundError(f"preset '{preset_name}': {reason} and no fallback_preset is set")
            info = ensure_network(fallback, root, config_path, force)
            info["meta"] = {**info["meta"], "fallback_from": preset_name, "fallback_reason": reason}
            return info
        preset["osm_file"] = str(source_path)
        preset["osm_sha256"] = sha256_file(source_path)

    out = root / GENERATED_DIR / preset_name
    longest = out / "osmNetconvertPedestrians.typ.xml"
    if os.name == "nt" and len(str(longest.resolve())) > 250:
        raise NetworkValidationError(f"output path is too long for SUMO on Windows ({len(str(longest.resolve()))} > 250 "
                                     f"characters): {out}. Use a shorter --root.")
    meta_path = out / "network_meta.json"
    digest = config_hash(preset)
    net, routes, cfg = out / "build.net.xml", out / "routes.rou.xml", out / "sumo.sumocfg"
    reuse = False
    needed = [meta_path, net] + ([routes, cfg] if preset["type"] == "grid" else [])
    if not force and all(p.is_file() for p in needed):
        try:
            reuse = json.loads(meta_path.read_text(encoding="utf-8")).get("config_hash") == digest
        except json.JSONDecodeError:
            reuse = False
    provenance = None
    if not reuse:
        if preset["type"] == "grid":
            build_grid(preset, out)
            demand, sim = preset["demand"], preset["simulation"]
            write_routes(grid_flows(preset["rows"], preset["cols"], demand), routes, float(demand["begin_s"]), float(demand["end_s"]))
            write_sumocfg(cfg, float(sim["end_s"]), float(sim["time_to_teleport_s"]))
        else:
            _, provenance = import_osm(preset, Path(preset["osm_file"]), out)
    elif (out / "import_provenance.json").is_file():
        provenance = json.loads((out / "import_provenance.json").read_text(encoding="utf-8"))
    model = NetworkModel.from_net_file(net, **model_kwargs)
    meta = {"preset": preset_name, "type": preset["type"], "rows": preset.get("rows"), "cols": preset.get("cols"),
            "config_hash": digest, "netconvert_version": tool_version("netconvert"), **validate_network(model, preset)}
    if provenance:
        meta["source"] = {k: provenance.get(k) for k in ("osm_file", "osm_sha256", "osm_bytes", "osm_summary", "source",
                                                         "license_note", "netconvert_args", "typemaps", "netconvert_warnings")}
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return {"dir": out, "net": net, "routes": routes if preset["type"] == "grid" else None,
            "sumocfg": cfg if preset["type"] == "grid" else None, "preset": preset, "meta": meta, "model": model}


def main() -> int:
    p = argparse.ArgumentParser(description="Build and validate a network preset.")
    p.add_argument("--preset", required=True)
    p.add_argument("--config", default=None, help="Path to networks.json (default: simulation/config/networks.json)")
    p.add_argument("--root", default=str(PROJECT_ROOT))
    p.add_argument("--force", action="store_true", help="Rebuild even if the cached network matches the config.")
    p.add_argument("--osm-file", default=None, help="Use this .osm file for an OSM preset (e.g. osm_user)")
    args = p.parse_args()
    try:
        info = ensure_network(args.preset, Path(args.root).resolve(), args.config, args.force, args.osm_file)
    except NetworkValidationError as exc:
        print(f"INVALID: {exc}")
        return 1
    meta = dict(info["meta"]); meta.pop("tls_status", None)
    if "source" in meta:
        meta["source"] = {k: v for k, v in meta["source"].items() if k != "netconvert_args"}
    print(json.dumps({"network_dir": str(info["dir"]), **meta}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
