#!/usr/bin/env python3
"""Validate a completed experiment artifact without recomputing or inventing KPIs."""
from __future__ import annotations
import argparse, json
from pathlib import Path
import sys
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
from experiments.tools.kpi_engine import METRICS, CORE_METRICS

REQUIRED_SUMMARY_KEYS = {"seed", "controller", "vehicles_observed", "vehicles_arrived", "throughput"}
BASELINE_LABELS = {"baseline", "fixed-time"}

def read_json(path: Path) -> dict:
    if not path.is_file():
        raise ValueError(f"missing file: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {path}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"JSON object required: {path}")
    return data

def validate_controllers(run_dir: Path, comparison: dict) -> None:
    """Multi-controller runs (fixed / actuated / swarm variants): every controller is checked."""
    from experiments.tools.run_experiment import VARIANTS
    summaries = comparison["controllers"]
    seeds = {s.get("seed") for s in summaries.values()}
    if len(seeds) != 1:
        raise ValueError(f"controllers ran with different seeds: {seeds}")
    meta = comparison.get("metadata") or {}
    closure = (meta.get("scenario_definition") or {}).get("closure")
    tls = (meta.get("network") or {}).get("tls_count")
    for name, s in summaries.items():
        if name not in VARIANTS:
            raise ValueError(f"unknown controller variant {name}")
        if not isinstance(s, dict) or not REQUIRED_SUMMARY_KEYS <= s.keys():
            raise ValueError(f"incomplete {name} summary")
        for key in METRICS:
            v = s.get(key)
            if v is not None and (not isinstance(v, (int, float)) or v < 0):
                raise ValueError(f"invalid KPI {name}.{key}={v!r}")
        audit = s.get("safety_audit") or {}
        if audit.get("total_violations", 0) != 0:
            raise ValueError(f"{name} signal safety audit reported violations: {audit.get('by_kind')}")
        if closure:
            check = s.get("closure_check")
            if check is None or check["vehicles_entered_during_closure"] != 0:
                raise ValueError(f"{name}: closure not monitored or violated")
        if VARIANTS[name][0] == "swarm":
            if s.get("active_tls_without_decisions"):
                raise ValueError(f"{name}: controlled intersections without decisions")
            if tls is not None and s.get("tls_total") != tls:
                raise ValueError(f"{name} did not register every intersection")
        if VARIANTS[name][0] == "actuated" and not s.get("actuated_program_verified") and s.get("actuated_config", {}).get("actuated_tls"):
            raise ValueError("actuated programs were not verified as active")
        sub = run_dir / VARIANTS[name][1]
        for f in ("tripinfo.xml", "tls_timeseries.csv"):
            if not (sub / f).is_file():
                raise ValueError(f"missing run artifact: {sub / f}")


def validate(run_dir: Path) -> None:
    comparison = read_json(run_dir / "comparison.json")
    if "controllers" in comparison:
        validate_controllers(run_dir, comparison)
        if "baseline" not in comparison:      # runs without the fixed+swarm pair have no legacy section
            return
    # The fixed-time runner labels its summary "baseline" (older docs called it "fixed-time").
    if comparison.get("baseline", {}).get("controller") not in BASELINE_LABELS:
        raise ValueError("baseline artifact must identify controller=baseline (fixed-time)")
    if comparison.get("swarm", {}).get("controller") != "swarm":
        raise ValueError("swarm artifact must identify controller=swarm")
    for label in ("baseline", "swarm"):
        summary = comparison.get(label)
        if not isinstance(summary, dict) or not REQUIRED_SUMMARY_KEYS <= summary.keys():
            raise ValueError(f"incomplete {label} summary")
        for key in METRICS:
            if key in summary and summary[key] is not None:
                if not isinstance(summary[key], (int, float)):
                    raise ValueError(f"non-numeric KPI {label}.{key}")
                if summary[key] < 0:
                    raise ValueError(f"negative KPI {label}.{key}")
    comp = comparison.get("comparison")
    if not isinstance(comp, dict):
        raise ValueError("comparison section missing")
    for key in CORE_METRICS:
        if key not in comp:
            raise ValueError(f"comparison metric missing: {key}")
    # Phase 1 artifacts (absent in legacy runs): any signal-safety violation fails the gate,
    # and the two controllers must have seen the same seed and network.
    for label in ("baseline", "swarm"):
        audit = comparison[label].get("safety_audit")
        if audit is not None and audit.get("total_violations", 0) != 0:
            raise ValueError(f"{label} signal safety audit reported violations: {audit.get('by_kind')}")
    if comparison["baseline"].get("seed") != comparison["swarm"].get("seed"):
        raise ValueError("baseline and swarm seeds differ")
    if comparison["swarm"].get("active_tls_without_decisions"):
        raise ValueError(f"controlled intersections without any decision: {comparison['swarm']['active_tls_without_decisions']}")
    meta = comparison.get("metadata") or {}
    closure = (meta.get("scenario_definition") or {}).get("closure")
    if closure:
        # A configured closure must really keep vehicles off the road while it is active.
        for label in ("baseline", "swarm"):
            check = comparison[label].get("closure_check")
            if check is None:
                raise ValueError(f"{label}: closure configured but not monitored")
            if check["vehicles_entered_during_closure"] != 0:
                raise ValueError(f"{label}: {check['vehicles_entered_during_closure']} vehicles entered closed edge {check['edge']}")
    if "network" in meta and meta["network"].get("tls_count") != comparison["swarm"].get("tls_total", meta["network"].get("tls_count")):
        raise ValueError("swarm controller did not register every intersection of the network")
    for name in ("baseline_timeseries.csv", "swarm_timeseries.csv", "swarm_decisions.csv"):
        if not (run_dir / "baseline" / name).is_file() and not (run_dir / "swarm" / name).is_file():
            # Decisions only exist for swarm; this branch is intentionally strict for all expected artifacts.
            raise ValueError(f"missing run artifact: {name}")

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("run_dir", type=Path)
    args = p.parse_args()
    validate(args.run_dir)
    print(f"OK: completed run artifacts validated at {args.run_dir}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
