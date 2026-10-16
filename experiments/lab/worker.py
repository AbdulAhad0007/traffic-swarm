"""One isolated worker process of a lab job (started only by experiments.lab.jobs.JobManager).

    python -m experiments.lab.worker --job-dir <dir> --part <prepare|all|<controller variant>> [--port N]

The spec is read from <dir>/job.json (already validated by the manager). Results go to
<dir>/<part>.result.json; a cancelled or failed part writes <dir>/<part>.error.json.
"""
from __future__ import annotations
import argparse, json, logging, sys, traceback
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from experiments.lab.jobs import PART, validate_spec
from experiments.tools.run_experiment import prepare, run, run_variant
from simulation.live.recorder import RunCancelled


def main() -> int:
    try:
        import sumo, os
        if hasattr(sumo, "SUMO_HOME"):
            os.environ.setdefault("SUMO_HOME", str(sumo.SUMO_HOME))
            tools = os.path.join(str(sumo.SUMO_HOME), "tools")
            bin_dir = os.path.join(str(sumo.SUMO_HOME), "bin")
            if tools not in sys.path:
                sys.path.append(tools)
            if bin_dir not in os.environ.get("PATH", ""):
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    except ImportError:
        pass
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--job-dir", type=Path, required=True)
    p.add_argument("--part", required=True)
    p.add_argument("--port", type=int, default=None)
    a = p.parse_args()
    if not PART.match(a.part):
        p.error("invalid part")
    d = a.job_dir.resolve()
    job = json.loads((d / "job.json").read_text(encoding="utf-8"))
    spec = validate_spec(job["spec"])
    root = Path(job.get("root") or PROJECT_ROOT)
    if d.parent != (root / "experiments" / "lab" / "jobs").resolve():
        p.error("job directory is not inside the job root")
    stop = d / "STOP"
    run_dir = d / "run"
    try:
        if a.part == "prepare":
            info, cfg, route, meta, _ = prepare(spec["scenario"], spec["seed"], root, spec["network"],
                                                ambulances=spec["ambulances"] or None, run_dir=run_dir)
            out = {"sumocfg": str(cfg), "routes": str(route), "scenario_definition": meta,
                   "controller_settings": info["preset"]["controller"], "network": info["meta"].get("preset")}
        elif a.part == "all":
            out = run(spec["scenario"], spec["seed"], root, max_time=spec["max_time"], network=spec["network"],
                      controllers=spec["controllers"], ambulances=spec["ambulances"] or None, run_dir=run_dir,
                      live=True, stop_file=stop, realtime_factor=spec["realtime_factor"])
        else:
            if a.part not in spec["controllers"]:
                p.error("part is not one of the job's controllers")
            prep = json.loads((d / "prepare.result.json").read_text(encoding="utf-8"))
            meta = prep["scenario_definition"] or {}
            out = run_variant(a.part, spec["seed"], prep["sumocfg"], run_dir, prep["controller_settings"],
                              max_time=spec["max_time"], has_ambulances=bool(meta.get("ambulances")), live=True,
                              run_info={"scenario": spec["scenario"], "seed": spec["seed"], "network": spec["network"],
                                        "job": d.name, "port": a.port},
                              stop_file=stop, realtime_factor=spec["realtime_factor"], port=a.port)
        (d / f"{a.part}.result.json").write_text(json.dumps(out, indent=2, default=str), encoding="utf-8")
        return 0
    except RunCancelled as exc:
        (d / f"{a.part}.error.json").write_text(json.dumps({"status": "cancelled", "detail": str(exc)}), encoding="utf-8")
        return 3
    except Exception as exc:
        (d / f"{a.part}.error.json").write_text(json.dumps({"status": "failed", "error": f"{type(exc).__name__}: {exc}",
                                                             "traceback": traceback.format_exc()[-4000:]}), encoding="utf-8")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

