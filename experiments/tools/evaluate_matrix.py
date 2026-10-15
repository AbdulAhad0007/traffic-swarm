#!/usr/bin/env python3
"""Staged, resumable, cancellable execution of the evaluation matrix.

    python -m experiments.tools.evaluate_matrix status  [--config ...]
    python -m experiments.tools.evaluate_matrix run     --stage core [--networks grid3x3] [--scenarios ...]
                                                         [--seeds 42 43] [--workers 6] [--retry-failed] [--rerun]
    (stop: create experiments/evaluation/<name>/STOP - running cells end cleanly and are recorded as cancelled)

Layout: experiments/evaluation/<name>/runs/<stage>/<network>/<scenario>/seed-<n>/  (one cell = one
prepared scenario, every controller of the stage) and ledger.jsonl - one line per attempt with
status completed / failed / cancelled, error, wall time and code version. A cell is 'completed'
only if its comparison.json exists and passes validate_run_artifacts. Completed cells are skipped
on resume. --rerun runs the selected cells again even if completed (e.g. after a fix to a code path
they use). Before any attempt, an existing run directory is MOVED (never deleted) to
experiments/evaluation/<name>/superseded/<UTC stamp>/<cell>/, and the ledger line records where.
"""
from __future__ import annotations
import argparse, json, os, shutil, sys, time, traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
DEFAULT_CONFIG = PROJECT_ROOT / "experiments" / "config" / "evaluation_matrix.json"


def load_matrix(path=None) -> dict:
    cfg = json.loads(Path(path or DEFAULT_CONFIG).read_text(encoding="utf-8"))
    from experiments.tools.run_experiment import SCENARIOS, VARIANTS
    from simulation.network.presets import preset_names
    names = set(preset_names())
    for sname, st in cfg["stages"].items():
        bad = [n for n in st["networks"] if n not in names] + [s for s in st["scenarios"] if s not in SCENARIOS] + \
              [c for c in st["controllers"] if c not in VARIANTS]
        if bad:
            raise ValueError(f"stage {sname}: unknown entries {bad}")
        for a, b in st.get("comparisons", []):
            if a not in st["controllers"] or b not in st["controllers"]:
                raise ValueError(f"stage {sname}: comparison {a} vs {b} uses a controller not in the stage")
    return cfg


def eval_dir(cfg, root=PROJECT_ROOT) -> Path:
    return Path(root) / "experiments" / "evaluation" / cfg["name"]


def cells(cfg, stage=None, networks=None, scenarios=None, seeds=None):
    for sname, st in cfg["stages"].items():
        if stage and sname != stage:
            continue
        for n in st["networks"]:
            if networks and n not in networks:
                continue
            for sc in st["scenarios"]:
                if scenarios and sc not in scenarios:
                    continue
                for seed in cfg["seeds"]:
                    if seeds and seed not in seeds:
                        continue
                    yield {"stage": sname, "network": n, "scenario": sc, "seed": seed,
                           "controllers": st["controllers"], "ambulances": st.get("ambulances")}


def cell_id(c) -> str:
    return f"{c['stage']}/{c['network']}/{c['scenario']}/seed-{c['seed']}"


def read_ledger(base: Path) -> dict:
    """Latest attempt per cell."""
    latest = {}
    path = base / "ledger.jsonl"
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                latest[rec["cell"]] = rec
    return latest


def _run_cell(cell: dict, base: str, max_time: float, vary_demand: bool) -> dict:
    """Executed in a worker process."""
    from experiments.tools.run_experiment import run
    from experiments.tools.validate_run_artifacts import validate
    from simulation.live.recorder import RunCancelled
    base = Path(base)
    run_dir = base / "runs" / cell_id(cell)
    t0 = time.perf_counter()
    from simulation.version import TSI_VERSION
    rec = {"cell": cell_id(cell), **cell, "run_dir": str(run_dir), "pid": os.getpid(), "tsi_version": TSI_VERSION}
    if run_dir.exists() and any(run_dir.iterdir()):
        dest = base / "superseded" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") / cell_id(cell)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(run_dir), str(dest))
        rec["previous_attempt_moved_to"] = str(dest)
    try:
        result = run(cell["scenario"], cell["seed"], PROJECT_ROOT, max_time=max_time, network=cell["network"],
                     controllers=cell["controllers"], ambulances=cell.get("ambulances"),
                     demand_seed=cell["seed"] if vary_demand else None, run_dir=run_dir, stop_file=base / "STOP")
        validate(run_dir)
        rec.update(status="completed", timed_out={k: v.get("timed_out") for k, v in result["controllers"].items()})
    except RunCancelled as exc:
        rec.update(status="cancelled", error=str(exc))
    except Exception as exc:
        rec.update(status="failed", error=f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc()[-3000:])
    rec.update(wall_s=round(time.perf_counter() - t0, 1), finished_utc=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    return rec


def status(cfg, base: Path) -> dict:
    ledger = read_ledger(base)
    out = {}
    for c in cells(cfg):
        key = (c["stage"], c["network"])
        s = out.setdefault(f"{key[0]}/{key[1]}", {"planned": 0, "completed": 0, "failed": 0, "cancelled": 0, "not_run": 0})
        s["planned"] += 1
        st = ledger.get(cell_id(c), {}).get("status", "not_run")
        s[st if st in s else "not_run"] += 1
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("command", choices=["status", "run"])
    p.add_argument("--config", default=None)
    p.add_argument("--stage", default=None)
    p.add_argument("--networks", nargs="+", default=None)
    p.add_argument("--scenarios", nargs="+", default=None)
    p.add_argument("--seeds", nargs="+", type=int, default=None)
    p.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    p.add_argument("--retry-failed", action="store_true")
    p.add_argument("--rerun", action="store_true", help="run the selected cells again even if completed (old artifacts are moved to superseded/)")
    a = p.parse_args()
    cfg = load_matrix(a.config)
    base = eval_dir(cfg)
    base.mkdir(parents=True, exist_ok=True)
    if a.command == "status":
        print(json.dumps(status(cfg, base), indent=2))
        return 0
    if a.stage and a.stage not in cfg["stages"]:
        p.error(f"unknown stage; available: {', '.join(cfg['stages'])}")
    if not 1 <= a.workers <= 32:
        p.error("--workers must be in [1, 32]")
    (base / "matrix_config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    ledger = read_ledger(base)
    todo = [c for c in cells(cfg, a.stage, a.networks, a.scenarios, a.seeds)
            if a.rerun or (ledger.get(cell_id(c), {}).get("status") != "completed"
                           and (a.retry_failed or ledger.get(cell_id(c), {}).get("status") != "failed"))]
    if (base / "STOP").exists():
        (base / "STOP").unlink()
    # Build every network once in this process: workers then only read the cached files (no build race).
    from simulation.network.build_network import ensure_network
    for n in sorted({c["network"] for c in todo}):
        ensure_network(n, PROJECT_ROOT)
    print(f"{len(todo)} cells to run with {a.workers} workers -> {base}", flush=True)
    done = 0
    with ProcessPoolExecutor(max_workers=a.workers) as pool, (base / "ledger.jsonl").open("a", encoding="utf-8") as led:
        futures = {pool.submit(_run_cell, c, str(base), float(cfg["max_time_s"]), bool(cfg.get("vary_demand"))): c for c in todo}
        try:
            for f in as_completed(futures):
                rec = f.result()
                led.write(json.dumps(rec) + "\n"); led.flush()
                done += 1
                print(f"[{done}/{len(todo)}] {rec['cell']}: {rec['status']} ({rec['wall_s']} s){' - ' + rec['error'] if rec.get('error') else ''}", flush=True)
        except KeyboardInterrupt:
            (base / "STOP").write_text("keyboard interrupt", encoding="utf-8")
            pool.shutdown(cancel_futures=True)
            raise
    print(json.dumps(status(cfg, base), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
