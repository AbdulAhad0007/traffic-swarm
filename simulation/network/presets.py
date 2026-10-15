"""Load network presets and controller settings from simulation/config/networks.json."""
from __future__ import annotations
import copy, hashlib, json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = PROJECT_ROOT / "simulation" / "config" / "networks.json"
LEGACY_PRESET = "grid3x3_legacy"


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def load_config(path: str | Path | None = None) -> dict:
    data = json.loads(Path(path or DEFAULT_CONFIG).read_text(encoding="utf-8"))
    if not isinstance(data.get("presets"), dict) or not data["presets"]:
        raise ValueError("network config must define at least one preset")
    return data


def preset_names(path: str | Path | None = None) -> list[str]:
    return sorted(load_config(path)["presets"])


def resolve_preset(name: str, path: str | Path | None = None) -> dict:
    """Return the fully merged preset (defaults + preset overrides + controller settings)."""
    cfg = load_config(path)
    if name not in cfg["presets"]:
        raise ValueError(f"unknown network preset '{name}'; available: {', '.join(sorted(cfg['presets']))}")
    preset = _merge(cfg.get("defaults", {}), cfg["presets"][name])
    preset["controller"] = _merge(cfg.get("controller", {}), preset.get("controller", {}))
    preset["scenarios"] = _merge({k: v for k, v in cfg.get("scenarios", {}).items() if not k.startswith("_")},
                                 preset.get("scenarios", {}))
    preset["name"] = name
    kind = preset.get("type")
    if kind == "grid":
        for key in ("rows", "cols"):
            value = preset.get(key)
            if not isinstance(value, int) or not 1 <= value <= 30:
                raise ValueError(f"preset '{name}': {key} must be an integer in [1, 30]")
        if preset["rows"] * preset["cols"] < 2:
            raise ValueError(f"preset '{name}': a grid needs at least two intersections")
    elif kind == "osm":
        if preset.get("osm_file") is not None and not isinstance(preset["osm_file"], str):
            raise ValueError(f"preset '{name}': osm_file must be a path string or null")
        fallback = preset.get("fallback_preset")
        if fallback is not None and fallback not in cfg["presets"]:
            raise ValueError(f"preset '{name}': fallback_preset '{fallback}' is not defined")
    elif kind != "legacy":
        raise ValueError(f"preset '{name}': unsupported type '{kind}'")
    return preset


def config_hash(preset: dict) -> str:
    """Stable hash of everything that determines the generated network and demand."""
    relevant = {k: preset.get(k) for k in ("type", "rows", "cols", "grid", "tls", "demand", "simulation", "directory",
                                           "osm", "osm_file", "osm_sha256")}
    return hashlib.sha256(json.dumps(relevant, sort_keys=True).encode("utf-8")).hexdigest()[:16]
