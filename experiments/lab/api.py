"""Lab API: live simulations, side-by-side demos, replay, saved runs and reports.

    uvicorn experiments.lab.api:app --port 8090        (from the project root)

Environment: TSI_LAB_ROOT (project root used for networks, runs and jobs; default: this repo),
TSI_LAB_MAX_RUNNING (default 2), TSI_WEB_ALLOWED_ORIGINS (comma list; default http://localhost:5173).
No endpoint accepts a filesystem path or a command-line argument from the client: jobs take only
allow-listed values (see jobs.validate_spec), saved runs are addressed by a validated relative id
that must resolve inside experiments/runs, and reports by a validated name.
"""
from __future__ import annotations
import csv, json, logging, os, re, threading
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from experiments.lab.jobs import JobManager, SpecError, PROJECT_ROOT

logging.basicConfig(level=logging.INFO, format="%(message)s")
ROOT = Path(os.environ.get("TSI_LAB_ROOT", PROJECT_ROOT)).resolve()
manager = JobManager(ROOT, max_running=int(os.environ.get("TSI_LAB_MAX_RUNNING", "2")))
RUN_ID = re.compile(r"^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){0,4}$")
NAME = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")

try:
    import sumo, sys
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

app = FastAPI(title="Traffic Swarm Intelligence Lab", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in os.environ.get(
    "TSI_WEB_ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()],
    allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


def _json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
    except (json.JSONDecodeError, OSError):
        return None


def part_dirs(job: dict, d: Path) -> dict[str, Path]:
    from experiments.tools.run_experiment import VARIANTS
    return {c: d / "run" / VARIANTS[c][1] for c in job["spec"]["controllers"]}


def replay_frames(out_dir: Path, max_frames: int = 2000) -> dict:
    """Historical per-junction series from tls_timeseries.csv as compact frames for scrubbing."""
    path = out_dir / "tls_timeseries.csv"
    if not path.is_file():
        raise HTTPException(404, "no recorded time series for this run")
    times, tls, cells = [], [], {}
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            t = float(row["time"])
            if not times or times[-1] != t:
                times.append(t)
            if row["tls"] not in cells:
                tls.append(row["tls"]); cells[row["tls"]] = {}
            cells[row["tls"]][t] = (None if row["queue"] == "" else float(row["queue"]), row["level"],
                                    None if row["occupancy"] == "" else float(row["occupancy"]))
    stride = max(1, len(times) // max_frames)
    times = times[::stride]
    get = lambda t, i: cells[t].get(i, (None, "no_data", None))
    return {"source": "historical_replay", "times": times, "tls": tls,
            "queue": [[get(j, t)[0] for j in tls] for t in times],
            "level": [[get(j, t)[1] for j in tls] for t in times],
            "occupancy": [[get(j, t)[2] for j in tls] for t in times], "stride": stride}


@app.get("/api/lab/health")
def health():
    return {"status": "UP", "service": "lab", "running_jobs": manager.running_count()}


@app.get("/api/lab/options")
def options():
    from experiments.tools.run_experiment import SCENARIOS, VARIANTS
    from simulation.network.presets import preset_names, resolve_preset
    from simulation.live.congestion import load_live_config
    presets = []
    for n in preset_names():
        p = resolve_preset(n)
        presets.append({"name": n, "type": p["type"], "rows": p.get("rows"), "cols": p.get("cols"),
                        "runnable_from_ui": not (p["type"] == "osm" and not p.get("osm_file")), "note": p.get("note")})
    return {"presets": presets, "scenarios": list(SCENARIOS),
            "controllers": {k: {"kind": v[0], "emergency_priority": v[2], "overrides": v[3]} for k, v in VARIANTS.items()},
            "live": load_live_config()}


@app.post("/api/lab/jobs", status_code=201)
def submit(spec: dict):
    try:
        return manager.submit(spec)
    except SpecError as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/lab/jobs")
def jobs(limit: int = Query(20, ge=1, le=200)):
    return manager.list(limit)


def _job(job_id: str) -> tuple[dict, Path]:
    try:
        return manager.read(job_id), manager.job_dir(job_id)
    except (KeyError, FileNotFoundError):
        raise HTTPException(404, "job not found")


@app.get("/api/lab/jobs/{job_id}")
def job(job_id: str):
    j, d = _job(job_id)
    j["errors"] = {p: _json(d / f"{p}.error.json") for p in list(j["parts"]) + ["prepare"] if (d / f"{p}.error.json").is_file()}
    return j


@app.get("/api/lab/jobs/{job_id}/live")
def live(job_id: str):
    """Latest live state of every part. Each part reports its own simulated time; a demo's parts
    are independent processes, so `time_gap_s` shows how far apart they are."""
    j, d = _job(job_id)
    parts, layout = {}, None
    for c, out in part_dirs(j, d).items():
        state = _json(out / "live" / "state.json")
        parts[c] = {"state": state, "emergency": _json(out / "live" / "emergency.json")}
        layout = layout or _json(out / "live" / "layout.json")
    times = [p["state"]["sim_time_s"] for p in parts.values() if p["state"]]
    return {"job": j["id"], "status": j["status"], "kind": j["spec"]["kind"], "synchronization": j.get("synchronization"),
            "time_gap_s": (max(times) - min(times)) if len(times) > 1 else None, "layout": layout, "parts": parts}


@app.post("/api/lab/jobs/{job_id}/stop")
def stop(job_id: str):
    _job(job_id)
    return manager.stop(job_id)


@app.post("/api/lab/stop-all")
def stop_all():
    return {"stopped": manager.stop_all()}


@app.get("/api/lab/jobs/{job_id}/replay")
def job_replay(job_id: str, controller: str):
    j, d = _job(job_id)
    dirs = part_dirs(j, d)
    if controller not in dirs:
        raise HTTPException(400, "controller is not part of this job")
    return {**replay_frames(dirs[controller]), "layout": _json(dirs[controller] / "live" / "layout.json")}


@app.get("/api/lab/jobs/{job_id}/result")
def job_result(job_id: str):
    j, d = _job(job_id)
    if j["spec"]["kind"] == "experiment":
        data = _json(d / "run" / "comparison.json")
        if data is None:
            raise HTTPException(404, "no result yet")
        return data
    from experiments.tools.kpi_engine import compare
    summaries = {c: _json(d / f"{c}.result.json") for c in j["spec"]["controllers"]}
    if any(v is None for v in summaries.values()):
        raise HTTPException(404, "not every part has finished")
    a, b = j["spec"]["controllers"]
    prep = _json(d / "prepare.result.json") or {}
    return {"scenario": j["spec"]["scenario"], "seed": j["spec"]["seed"], "reference_controller": a,
            "controllers": summaries, "comparisons": {b: compare(summaries[a], summaries[b])},
            "metadata": {"scenario_definition": prep.get("scenario_definition"), "network": prep.get("network"),
                         "controller_settings": prep.get("controller_settings"),
                         "synchronization": j.get("synchronization")}}


@app.get("/api/lab/jobs/{job_id}/calls")
def job_calls(job_id: str, limit: int = Query(100, ge=1, le=1000)):
    j, d = _job(job_id)
    dirs = part_dirs(j, d)
    for c, path in dirs.items():
        calls_file = path / "swarm_calls.jsonl"
        if calls_file.is_file():
            records = []
            with calls_file.open(encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        records.append(json.loads(line))
            from simulation.coordination.green_wave import summarize_calls
            return {"summary": summarize_calls(records), "calls": records[-limit:]}
    summary_file = d / "run" / "swarm" / "swarm_summary.json"
    if summary_file.is_file():
        s = _json(summary_file)
        if s and "green_wave" in s:
            return {"summary": s["green_wave"], "calls": []}
    return {"summary": None, "calls": []}


@app.get("/api/lab/jobs/{job_id}/messages")
def job_messages(job_id: str, limit: int = Query(200, ge=1, le=2000)):
    """Inter-agent message log (platoon alerts and responses) written by the SUMO green wave."""
    j, d = _job(job_id)
    for path in part_dirs(j, d).values():
        f = path / "swarm_messages.jsonl"
        if f.is_file():
            with f.open(encoding="utf-8") as fp:
                lines = [json.loads(line) for line in fp if line.strip()]
            return {"messages": lines[-limit:], "total": len(lines)}
    return {"messages": [], "total": 0}


# ---------------------------------------------------------------------- lookahead junction mesh (TraCI-free)
# One shared in-memory demo: swarm agents and a static 30 s timer stepped on identical demand.
_mesh_lock = threading.Lock()
_mesh = {"demo": None}
MESH_GRIDS = (3, 5, 9)


def _mesh_demo():
    from simulation.swarm.junction_mesh import LookaheadDemo
    if _mesh["demo"] is None:
        _mesh["demo"] = LookaheadDemo(grid=3)
    return _mesh["demo"]


def _mesh_mode(mode: str) -> str:
    if mode not in ("swarm", "fixed"):
        raise HTTPException(400, "mode must be 'swarm' or 'fixed'")
    return mode


@app.post("/api/lab/swarm/mesh/reset")
def mesh_reset(body: dict | None = None):
    from simulation.swarm.junction_mesh import LookaheadDemo
    body = body or {}
    grid, seed = body.get("grid", 3), body.get("seed", 42)
    if grid not in MESH_GRIDS or not isinstance(seed, int) or not 0 <= seed < 2 ** 31:
        raise HTTPException(400, f"grid must be one of {MESH_GRIDS}; seed an int in [0, 2^31)")
    with _mesh_lock:
        _mesh["demo"] = LookaheadDemo(grid=grid, seed=seed)
        return {"grid": grid, "seed": seed, "t": 0}


@app.post("/api/lab/swarm/mesh/step")
def mesh_step(body: dict | None = None, mode: str = "swarm"):
    seconds = (body or {}).get("seconds", 1)
    if not isinstance(seconds, int) or not 1 <= seconds <= 3600:
        raise HTTPException(400, "seconds must be an int in [1, 3600]")
    with _mesh_lock:
        demo = _mesh_demo()
        demo.step(seconds)
        return demo.state(_mesh_mode(mode))


@app.get("/api/lab/swarm/mesh/state")
def mesh_state(mode: str = "swarm"):
    with _mesh_lock:
        return _mesh_demo().state(_mesh_mode(mode))


@app.get("/api/lab/swarm/mesh/messages")
def mesh_messages(since: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
    with _mesh_lock:
        demo = _mesh_demo()
        return {"t": demo.t, "messages": demo.messages(since, limit)}


@app.get("/api/lab/swarm/mesh/fuel")
def mesh_fuel():
    with _mesh_lock:
        demo = _mesh_demo()
        return {"t": demo.t, **demo.fuel()}


@app.post("/api/lab/swarm/mesh/emergency")
def mesh_emergency():
    with _mesh_lock:
        demo = _mesh_demo()
        if demo.emergency() and not all(demo.emergency()[m]["done"] for m in ("swarm", "fixed")):
            raise HTTPException(409, "an ambulance corridor is already active")
        try:
            return demo.trigger_emergency()
        except ValueError as exc:
            raise HTTPException(400, str(exc))


# ---------------------------------------------------------------------- saved runs and reports
def _run_dir(run_id: str) -> Path:
    runs = (ROOT / "experiments" / "runs").resolve()
    if not RUN_ID.match(run_id) or ".." in run_id.split("/"):
        raise HTTPException(400, "invalid run id")
    d = (runs / run_id).resolve()
    if runs not in d.parents or not (d / "comparison.json").is_file():
        raise HTTPException(404, "run not found")
    return d


@app.get("/api/lab/runs")
def runs(limit: int = Query(200, ge=1, le=2000)):
    base = ROOT / "experiments" / "runs"
    out = []
    for f in sorted(base.glob("**/comparison.json"))[:limit]:
        rel = f.parent.relative_to(base).as_posix()
        if RUN_ID.match(rel):
            out.append({"id": rel, "controllers": sorted(p.name for p in f.parent.iterdir()
                                                          if p.is_dir() and (p / "tls_timeseries.csv").is_file())})
    return out


@app.get("/api/lab/runs/comparison")
def run_comparison(id: str):
    return _json(_run_dir(id) / "comparison.json")


@app.get("/api/lab/runs/replay")
def run_replay(id: str, controller: str):
    if not NAME.match(controller):
        raise HTTPException(400, "invalid controller directory")
    d = _run_dir(id) / controller
    return {**replay_frames(d), "layout": _json(d / "live" / "layout.json")}


@app.get("/api/lab/runs/calls")
def run_calls(id: str, limit: int = Query(100, ge=1, le=1000)):
    d = _run_dir(id)
    for cand in [d / "swarm", d]:
        f = cand / "swarm_calls.jsonl"
        if f.is_file():
            records = []
            with f.open(encoding="utf-8") as fp:
                for line in fp:
                    if line.strip():
                        records.append(json.loads(line))
            from simulation.coordination.green_wave import summarize_calls
            return {"summary": summarize_calls(records), "calls": records[-limit:]}
    summary_file = d / "swarm" / "swarm_summary.json"
    if summary_file.is_file():
        s = _json(summary_file)
        if s and "green_wave" in s:
            return {"summary": s["green_wave"], "calls": []}
    return {"summary": None, "calls": []}


@app.get("/api/lab/reports")
def reports():
    base = ROOT / "experiments" / "reports"
    return sorted(p.name for p in base.iterdir() if p.is_dir() and (p / "summary.json").is_file()) if base.is_dir() else []


@app.get("/api/lab/reports/{name}")
def report(name: str):
    if not NAME.match(name):
        raise HTTPException(400, "invalid report name")
    data = _json(ROOT / "experiments" / "reports" / name / "summary.json")
    if data is None:
        raise HTTPException(404, "report not found")
    return data

