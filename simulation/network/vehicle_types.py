"""Vehicle types and demand mixes loaded from simulation/config/vehicle_types.json."""
from __future__ import annotations
import json, math
from pathlib import Path
import xml.etree.ElementTree as ET

PROJECT_ROOT = Path(__file__).resolve().parents[2]
VEHICLE_CONFIG = PROJECT_ROOT / "simulation" / "config" / "vehicle_types.json"


def load_vehicle_config(path: str | Path | None = None) -> dict:
    return json.loads(Path(path or VEHICLE_CONFIG).read_text(encoding="utf-8"))


def resolve_mix(name: str, path: str | Path | None = None) -> dict[str, float]:
    """Return {vtype_id: share} for a named mix; validates ids and that shares sum to 1."""
    cfg = load_vehicle_config(path)
    if name not in cfg["mixes"]:
        raise ValueError(f"unknown vehicle mix '{name}'; available: {', '.join(sorted(cfg['mixes']))}")
    shares = {k: float(v) for k, v in cfg["mixes"][name]["shares"].items()}
    unknown = sorted(set(shares) - set(cfg["vtypes"]))
    if unknown:
        raise ValueError(f"mix '{name}' references undefined vehicle types: {unknown}")
    if any(v < 0 or not math.isfinite(v) for v in shares.values()):
        raise ValueError(f"mix '{name}' has a negative or non-finite share")
    total = sum(shares.values())
    if abs(total - 1.0) > 1e-6:
        raise ValueError(f"mix '{name}' shares sum to {total}, expected 1.0")
    return {k: v for k, v in shares.items() if v > 0}


def vtype_attrs(vtype_id: str, path: str | Path | None = None) -> dict[str, str]:
    cfg = load_vehicle_config(path)
    if vtype_id not in cfg["vtypes"]:
        raise ValueError(f"unknown vehicle type '{vtype_id}'")
    return dict(cfg["vtypes"][vtype_id]["attrs"])


def vclass_of(vtype_id: str, path: str | Path | None = None) -> str:
    return vtype_attrs(vtype_id, path).get("vClass", "passenger")


def add_vtypes(root: ET.Element, vtype_ids, path: str | Path | None = None) -> None:
    """Append <vType> elements (in the given order) to a routes root."""
    for vid in vtype_ids:
        attrs = vtype_attrs(vid, path)
        if vid == "car":
            # Keep the exact legacy element (attribute order and no vClass) so Phase-1 route files are unchanged.
            attrs.pop("vClass", None)
            ET.SubElement(root, "vType", {"id": "car", "accel": attrs["accel"], "decel": attrs["decel"], "sigma": attrs["sigma"],
                                          "length": attrs["length"], "minGap": attrs["minGap"], "maxSpeed": attrs["maxSpeed"]})
        else:
            ET.SubElement(root, "vType", {"id": vid, **attrs})
