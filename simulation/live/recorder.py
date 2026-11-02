"""Live per-junction state for the heatmap, replay, prediction training and safe cancellation.

LiveRecorder is a SumoSession hook. Every `sample_interval_s` of simulated time it records, for
every traffic light, the halting vehicles and mean occupancy of its incoming vehicle lanes, the
congestion level and the current phase:

  <out>/tls_timeseries.csv   one row per (time, tls)  - historical record (replay, prediction data)
  <out>/live/layout.json     junction positions + neighbor links (written once)
  <out>/live/state.json      latest snapshot, replaced atomically (live view)

Cancellation: if the file named by `stop_file` exists, the next step raises RunCancelled; the
controller's try/finally then closes TraCI, which terminates SUMO. The job manager uses this
before falling back to killing the process tree.
"""
from __future__ import annotations
import csv, json, os, time
from datetime import datetime, timezone
from pathlib import Path
from simulation.live.congestion import classify, load_live_config, network_layout, tls_incoming_lanes

TIMESERIES_FIELDS = ["time", "tls", "queue", "occupancy", "lanes", "level", "phase"]


class RunCancelled(RuntimeError):
    pass


def write_json_atomic(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)          # readers never see a half-written file


CONTROL_POLL_S = 0.1
MAX_PAUSE_S = 1800.0
MAX_CATCH_UP_S = 2.0


class LiveRecorder:
    def __init__(self, model, out_dir, run_info: dict | None = None, config: dict | None = None,
                 stop_file: str | Path | None = None, realtime_factor: float | None = None):
        self.model = model
        self.out = Path(out_dir)
        self.cfg = config or load_live_config()
        self.sample_interval = float(self.cfg.get("sample_interval_s", 5))
        self.state_interval = float(self.cfg.get("state_interval_s", self.sample_interval))
        self.run_info = dict(run_info or {})
        self.stop_file = Path(stop_file) if stop_file else None
        self.realtime_factor = float(realtime_factor) if realtime_factor else None   # simulated s per wall s
        # Written by the Lab API, next to the stop file: {"paused": bool, "speed": simulated s per wall s}.
        self.control_file = self.stop_file.parent / "control.json" if self.stop_file else None
        self.paused = False
        self._control_read_at = 0.0
        self._pace_anchor = None
        self.lanes = tls_incoming_lanes(model)
        self.next_sample = 0.0
        self.next_state = 0.0
        self.samples = 0
        self.no_data_samples = 0
        self._csv = None
        self._writer = None
        self._wall0 = None
        self.last_snapshot: dict | None = None
        self.vehicles_arrived = 0

    # ------------------------------------------------------------------ hook API
    def on_start(self, session) -> None:
        (self.out / "live").mkdir(parents=True, exist_ok=True)
        write_json_atomic(self.out / "live" / "layout.json", {**network_layout(self.model), "levels": self.cfg["levels"],
                                                               "no_data_level": self.cfg.get("no_data_level", "no_data")})
        self._csv = (self.out / "tls_timeseries.csv").open("w", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(self._csv, fieldnames=TIMESERIES_FIELDS)
        self._writer.writeheader()
        self._wall0 = time.perf_counter()
        self._write_state(session, "running")

    def on_step(self, session) -> None:
        if self.stop_file is not None and self.stop_file.exists():
            self._write_state(session, "cancelling")
            raise RunCancelled(f"stop requested via {self.stop_file}")
        self.vehicles_arrived += len(session.arrived_ids)
        now = session.now
        if now + 1e-9 >= self.next_sample:
            self.snapshot(session)
            self.next_sample = now + self.sample_interval
        if now + 1e-9 >= self.next_state:
            self._write_state(session, "running")
            self.next_state = now + self.state_interval
        self._pace(now)

    def _read_control(self, wall: float) -> None:
        if self.control_file is None or wall - self._control_read_at < CONTROL_POLL_S:
            return
        self._control_read_at = wall
        try:
            control = json.loads(self.control_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return              # no control yet, or the API is replacing the file on Windows: keep the last values
        self.paused = bool(control.get("paused"))
        speed = control.get("speed")
        if speed and float(speed) != self.realtime_factor:
            self.realtime_factor = float(speed)
            self._pace_anchor = None

    def _pace(self, now: float) -> None:
        """Holds the simulation while paused, and keeps it at the chosen simulated-seconds-per-second rate."""
        self._read_control(time.perf_counter())
        if self.paused:
            # SUMO waits for the next TraCI step. Abandoned pauses end, so a closed browser cannot hold a job slot forever.
            until = time.perf_counter() + MAX_PAUSE_S
            while self.paused and time.perf_counter() < until and not (self.stop_file and self.stop_file.exists()):
                time.sleep(CONTROL_POLL_S)
                self._read_control(time.perf_counter())
            self.paused = False
            self._pace_anchor = None
        if not self.realtime_factor:
            return
        wall = time.perf_counter()
        if self._pace_anchor is None:
            self._pace_anchor = (wall, now)
        lag = (now - self._pace_anchor[1]) / self.realtime_factor - (wall - self._pace_anchor[0])
        if lag > 0:
            time.sleep(min(lag, 1.0))
        elif lag < -MAX_CATCH_UP_S:
            self._pace_anchor = (wall, now)      # fell behind: carry on at the chosen rate instead of racing to catch up

    def on_close(self, session) -> None:
        if self._csv is not None:
            self._csv.close()
            self._csv = None
        status = "cancelled" if self.stop_file is not None and self.stop_file.exists() else "finished"
        self._write_state(session, status)

    def report(self) -> dict:
        return {"live_recorder": {"samples": self.samples, "no_data_samples": self.no_data_samples,
                                  "sample_interval_s": self.sample_interval, "tls": len(self.lanes)}}

    # ------------------------------------------------------------------ internals
    def snapshot(self, session) -> dict:
        junctions = {}
        for tid, lanes in self.lanes.items():
            present = [l for l in lanes if l in session.lane_values]
            if lanes and present:
                queue = float(sum(session.halting(l) for l in present))
                occ = sum(session.occupancy(l) for l in present) / len(present)
            else:
                queue, occ = None, None
                self.no_data_samples += 1
            level = classify(queue, occ, len(present), self.cfg)
            phase = session.phase(tid)
            junctions[tid] = {"queue": queue, "occupancy": None if occ is None else round(occ, 4),
                              "lanes": len(present), "level": level, "phase": phase}
            if self._writer is not None:
                self._writer.writerow({"time": session.now, "tls": tid, "queue": "" if queue is None else queue,
                                       "occupancy": "" if occ is None else round(occ, 4), "lanes": len(present),
                                       "level": level, "phase": "" if phase is None else phase})
        self.samples += 1
        self.last_snapshot = {"sim_time_s": session.now, "junctions": junctions}
        return self.last_snapshot

    def _write_state(self, session, status: str) -> None:
        snap = self.last_snapshot or {"sim_time_s": session.now, "junctions": {}}
        state = {"source": "live_simulation", "status": status, **self.run_info,
                 "sim_time_s": session.now, "sample_time_s": snap["sim_time_s"],
                 "wall_elapsed_s": None if self._wall0 is None else round(time.perf_counter() - self._wall0, 2),
                 "updated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "vehicles_arrived": self.vehicles_arrived, "junctions": snap["junctions"]}
        try:
            write_json_atomic(self.out / "live" / "state.json", state)
        except OSError:
            pass      # a reader holding the file on Windows must not break the simulation
