"""Job manager for live / side-by-side simulations: validated specs, isolated processes, safe stop.

A job lives in <root>/experiments/lab/jobs/<job_id>/:
  job.json      spec + state (status, parts, pids, ports, timestamps, errors)   - written only here
  run/          prepared scenario (route, cfg) shared by every part, and one output dir per part
  STOP          created to request cancellation (workers poll it every simulation step)
  <part>.log    stdout/stderr of each worker process
  events.jsonl  structured job log

Kinds:
  experiment  one worker runs the listed controllers one after another (run_experiment.run)
  demo        before/after: scenario prepared once, then one worker PER controller started in
              parallel - separate processes, TraCI ports, output directories and logs. The two
              simulations progress independently (their simulated times are reported separately);
              an optional realtime_factor paces both to the same simulated-seconds-per-second rate.

Workers receive only `--job-dir <dir> --part <name>`; every user-controlled value is validated
here against fixed allow-lists and never reaches a shell. Stop: STOP file -> graceful TraCI close
-> after `grace_s` the whole process tree is killed.
"""
from __future__ import annotations
import json, logging, os, re, signal, socket, subprocess, sys, threading, time, uuid
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
log = logging.getLogger("tsi.lab")

JOB_ID = re.compile(r"^[0-9a-f]{12}$")
PART = re.compile(r"^[a-z_]{1,32}$")
TERMINAL = {"completed", "failed", "cancelled"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class SpecError(ValueError):
    pass


def validate_spec(raw: dict) -> dict:
    """Return a normalised spec or raise SpecError. Only allow-listed values are accepted."""
    from experiments.tools.run_experiment import SCENARIOS, VARIANTS
    from simulation.network.presets import preset_names, resolve_preset
    if not isinstance(raw, dict):
        raise SpecError("spec must be an object")
    kind = raw.get("kind", "experiment")
    if kind not in ("experiment", "demo"):
        raise SpecError("kind must be 'experiment' or 'demo'")
    network = raw.get("network", "grid3x3")
    if network not in preset_names():
        raise SpecError(f"unknown network preset '{network}'")
    preset = resolve_preset(network)
    if preset["type"] == "osm" and not preset.get("osm_file"):
        raise SpecError("OSM presets without a committed extract (e.g. osm_user) can only be run from the CLI")
    scenario = raw.get("scenario", "normal")
    if scenario not in SCENARIOS:
        raise SpecError(f"unknown scenario '{scenario}'")
    seed = raw.get("seed", 42)
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 1_000_000:
        raise SpecError("seed must be an integer in [0, 1000000]")
    controllers = raw.get("controllers") or (["fixed", "swarm"])
    if not isinstance(controllers, list) or not 1 <= len(controllers) <= 8 or any(c not in VARIANTS for c in controllers):
        raise SpecError(f"controllers must be 1-8 of {sorted(VARIANTS)}")
    controllers = list(dict.fromkeys(controllers))
    if kind == "demo" and len(controllers) != 2:
        raise SpecError("a demo compares exactly two controllers (before, after)")
    ambulances = raw.get("ambulances", 0) or 0
    if not isinstance(ambulances, int) or not 0 <= ambulances <= 10:
        raise SpecError("ambulances must be an integer in [0, 10]")
    if ambulances and preset["type"] == "legacy":
        raise SpecError("ambulance scenarios need a generated or OSM network")
    max_time = raw.get("max_time", 3600)
    if not isinstance(max_time, (int, float)) or not 60 <= max_time <= 7200:
        raise SpecError("max_time must be in [60, 7200] simulated seconds")
    rf = raw.get("realtime_factor")
    if rf is not None and (not isinstance(rf, (int, float)) or not 1 <= rf <= 500):
        raise SpecError("realtime_factor must be null or in [1, 500] simulated seconds per wall second")
    return {"kind": kind, "network": network, "scenario": scenario, "seed": seed, "controllers": controllers,
            "ambulances": ambulances, "max_time": float(max_time), "realtime_factor": rf}


class JobManager:
    def __init__(self, root: Path = PROJECT_ROOT, max_running: int = 2, grace_s: float = 10.0, python: str | None = None):
        self.root = Path(root).resolve()
        self.jobs_dir = self.root / "experiments" / "lab" / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.max_running = int(max_running)
        self.grace_s = float(grace_s)
        self.python = python or sys.executable
        self.procs: dict[str, dict[str, subprocess.Popen]] = {}
        self.lock = threading.RLock()
        self._recover()

    # ------------------------------------------------------------------ persistence
    def job_dir(self, job_id: str) -> Path:
        if not JOB_ID.match(job_id or ""):
            raise KeyError("invalid job id")
        d = (self.jobs_dir / job_id).resolve()
        if d.parent != self.jobs_dir.resolve() or not (d / "job.json").is_file():
            raise KeyError("job not found")
        return d

    def read(self, job_id: str) -> dict:
        return json.loads((self.job_dir(job_id) / "job.json").read_text(encoding="utf-8"))

    def _write(self, d: Path, job: dict) -> None:
        tmp = d / "job.json.tmp"
        tmp.write_text(json.dumps(job, indent=2), encoding="utf-8")
        os.replace(tmp, d / "job.json")

    def _event(self, d: Path, event: str, **fields) -> None:
        rec = {"time": _now(), "event": event, **fields}
        with (d / "events.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        log.info(json.dumps({"job": d.name, **rec}))

    def _recover(self) -> None:
        """Jobs left 'running' by a previous service process cannot be monitored: mark them failed."""
        for jf in self.jobs_dir.glob("*/job.json"):
            try:
                job = json.loads(jf.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            if job.get("status") not in TERMINAL:
                for part in job.get("parts", {}).values():
                    self._kill_pid(part.get("pid"))
                job.update(status="failed", error="service restarted while the job was running", finished=_now())
                self._write(jf.parent, job)

    def list(self, limit: int = 50) -> list[dict]:
        jobs = []
        for jf in self.jobs_dir.glob("*/job.json"):
            try:
                jobs.append(json.loads(jf.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
        jobs.sort(key=lambda j: j.get("created", ""), reverse=True)
        return jobs[:max(1, min(int(limit), 500))]

    def running_count(self) -> int:
        return sum(1 for j in self.list(500) if j.get("status") not in TERMINAL)

    # ------------------------------------------------------------------ lifecycle
    def submit(self, raw: dict) -> dict:
        spec = validate_spec(raw)
        with self.lock:
            if self.running_count() >= self.max_running:
                raise SpecError(f"{self.max_running} jobs are already running; stop one first")
            job_id = uuid.uuid4().hex[:12]
            d = self.jobs_dir / job_id
            d.mkdir(parents=True)
            parts = ["all"] if spec["kind"] == "experiment" else list(spec["controllers"])
            job = {"id": job_id, "spec": spec, "root": str(self.root), "status": "queued", "created": _now(), "started": None, "finished": None,
                   "error": None, "parts": {p: {"status": "pending", "pid": None, "port": None} for p in parts},
                   "synchronization": "single process" if spec["kind"] == "experiment" else
                   ("independent processes, paced to the same simulated-time rate" if spec["realtime_factor"]
                    else "independent processes, not synchronized")}
            self._write(d, job)
            self._event(d, "submitted", spec=spec)
        threading.Thread(target=self._drive, args=(job_id,), daemon=True).start()
        return job

    def _spawn(self, d: Path, part: str, port: int | None) -> subprocess.Popen:
        assert PART.match(part)
        cmd = [self.python, "-m", "experiments.lab.worker", "--job-dir", str(d), "--part", part]
        if port is not None:
            cmd += ["--port", str(int(port))]
        kwargs = {"cwd": str(PROJECT_ROOT), "stdout": (d / f"{part}.log").open("w", encoding="utf-8"),
                  "stderr": subprocess.STDOUT, "env": {**os.environ, "PYTHONUNBUFFERED": "1"}}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        return subprocess.Popen(cmd, **kwargs)

    def _update(self, job_id: str, fn) -> dict:
        with self.lock:
            d = self.job_dir(job_id)
            job = self.read(job_id)
            fn(job)
            self._write(d, job)
            return job

    def _drive(self, job_id: str) -> None:
        d = self.job_dir(job_id)
        try:
            job = self.read(job_id)
            self._update(job_id, lambda j: j.update(status="preparing", started=_now()))
            if job["spec"]["kind"] == "demo":
                # Prepare the shared scenario once so both parts get byte-identical inputs.
                prep = self._spawn(d, "prepare", None)
                self.procs.setdefault(job_id, {})["prepare"] = prep
                if prep.wait() != 0:
                    raise RuntimeError("scenario preparation failed (see prepare.log)")
            if (d / "STOP").exists():
                raise InterruptedError
            started = {}
            for part in job["parts"]:
                port = free_port()
                p = self._spawn(d, part, port)
                started[part] = p
                self.procs.setdefault(job_id, {})[part] = p
                self._update(job_id, lambda j, part=part, p=p, port=port: j["parts"][part].update(
                    status="running", pid=p.pid, port=port, started=_now()))
                self._event(d, "part_started", part=part, pid=p.pid, port=port)
            self._update(job_id, lambda j: j.update(status="running"))
            for part, p in started.items():
                code = p.wait()
                result = d / f"{part}.result.json"
                status = "completed" if code == 0 and result.is_file() else ("cancelled" if (d / "STOP").exists() else "failed")
                self._update(job_id, lambda j, part=part, code=code, status=status: j["parts"][part].update(
                    status=status, exit_code=code, finished=_now()))
                self._event(d, "part_finished", part=part, exit_code=code, status=status)
            job = self.read(job_id)
            states = {p["status"] for p in job["parts"].values()}
            final = "completed" if states == {"completed"} else ("cancelled" if "cancelled" in states else "failed")
            self._update(job_id, lambda j: j.update(status=final, finished=_now(),
                                                    error=None if final == "completed" else j.get("error") or f"parts: {sorted(states)}"))
        except InterruptedError:
            self._update(job_id, lambda j: j.update(status="cancelled", finished=_now()))
        except Exception as exc:
            self._event(d, "job_error", error=str(exc))
            self._update(job_id, lambda j: j.update(status="failed", error=str(exc), finished=_now()))
        finally:
            self.procs.pop(job_id, None)

    def stop(self, job_id: str) -> dict:
        d = self.job_dir(job_id)
        job = self.read(job_id)
        if job["status"] in TERMINAL:
            return job
        (d / "STOP").write_text(_now(), encoding="utf-8")
        self._event(d, "stop_requested")
        deadline = time.monotonic() + self.grace_s
        procs = dict(self.procs.get(job_id, {}))
        for p in procs.values():
            try:
                p.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                self._kill_pid(p.pid)
                self._event(d, "killed_after_grace", pid=p.pid)
        for part in job.get("parts", {}).values():       # processes not owned by this manager instance
            if part.get("pid") and not any(p.pid == part["pid"] for p in procs.values()):
                self._kill_pid(part["pid"])
        return self.read(job_id)

    def stop_all(self) -> list[str]:
        stopped = []
        for job in self.list(500):
            if job.get("status") not in TERMINAL:
                self.stop(job["id"])
                stopped.append(job["id"])
        return stopped

    @staticmethod
    def _kill_pid(pid) -> None:
        """Kill a worker and everything it started (SUMO)."""
        if not pid:
            return
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(int(pid))], capture_output=True, check=False)
            else:
                os.killpg(os.getpgid(int(pid)), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
