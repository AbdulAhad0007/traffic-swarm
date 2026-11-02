"""Per-second vehicle and signal frames from a running simulation, for the 3D View.

FrameRecorder is a SumoSession hook. It only reads what TraCI reports and never changes the
simulation. Files in <out>/live/:

  network3d.json       road geometry and signal positions (written once)
  frames/cNNNNNN.jsonl one JSON frame per line, CHUNK_FRAMES frames per file
  frames.json          manifest: first and last recorded time, status

Each frame is column-oriented. Oldest chunks are removed once `max_bytes` is exceeded.
"""
from __future__ import annotations
import json, os
from pathlib import Path
from simulation.live.network_geometry import build_network3d
from simulation.live.congestion import load_live_config
from simulation.live.recorder import write_json_atomic
from simulation.live.road_state import RoadMonitor
from simulation.runtime import tc, traci

CHUNK_FRAMES = 30
DEFAULT_MAX_BYTES = 200 * 1024 * 1024


def frames_enabled() -> bool:
    return os.environ.get("TSI_LAB_CAPTURE_FRAMES", "1").strip().lower() not in {"0", "false", "no"}


def read_frames(live_dir: Path, after: float | None, limit: int) -> dict | None:
    """Frames newer than `after` (oldest first) plus the manifest, or None if nothing was recorded."""
    live_dir = Path(live_dir)
    try:
        manifest = json.loads((live_dir / "frames.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    frames = []
    chunks = sorted((live_dir / "frames").glob("c*.jsonl"))
    first_needed = 0
    if after is not None:
        for i, path in enumerate(chunks):
            if float(path.stem.split("_")[1]) <= after:
                first_needed = i
    for path in chunks[first_needed:]:
        with path.open(encoding="utf-8") as f:
            for line in f:
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    break        # the writer is partway through this line; it arrives on the next poll
                if after is None or frame["t"] > after:
                    frames.append(frame)
                    if len(frames) >= limit:
                        return {**manifest, "frames": frames}
    return {**manifest, "frames": frames}


class FrameRecorder:
    def __init__(self, model, out_dir, interval_s: float = 1.0, live_recorder=None, max_bytes: int = DEFAULT_MAX_BYTES):
        self.model = model
        self.live = Path(out_dir) / "live"
        self.dir = self.live / "frames"
        self.interval = float(interval_s)
        self.live_recorder = live_recorder
        self.max_bytes = int(max_bytes)
        self.next_frame = 0.0
        self.count = 0
        self.first_t = None
        self.last_t = None
        self.bytes = 0
        self.chunks: list[tuple[Path, int]] = []
        self._file = None
        self._junction_sample = None
        self._types: dict[str, int] = {}
        self._edges: dict[str, int] = {}
        self.road_monitor = None
        self._vehicle_edge: dict[str, int] = {}
        self._next_road = 0.0

    # ------------------------------------------------------------------ hook API
    def on_start(self, session) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        network = build_network3d(self.model)
        self._edges = {e["id"]: i for i, e in enumerate(network["edges"])}
        self._edge_list = network["edges"]
        self._entered = [0] * len(self._edge_list)
        self._left = [0] * len(self._edge_list)
        self.road_monitor = RoadMonitor(self.model, self._edge_list, load_live_config().get("road_state"))
        self._road_interval = float(self.road_monitor.cfg["sample_interval_s"])
        for edge in self._edges:
            traci.edge.subscribe(edge, [tc.LAST_STEP_VEHICLE_NUMBER, tc.LAST_STEP_MEAN_SPEED, tc.VAR_WAITING_TIME])
        write_json_atomic(self.live / "network3d.json", network)
        session.extra_vehicle_vars = [tc.VAR_POSITION, tc.VAR_ANGLE, tc.VAR_TYPE]
        self._write_manifest("running")

    def on_step(self, session) -> None:
        now = session.now
        if now + 1e-9 < self.next_frame:
            return
        self.next_frame = now + self.interval
        self._write_frame(session)

    def on_close(self, session) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None
        self._write_manifest("finished")

    def report(self) -> dict:
        return {"frame_recorder": {"frames": self.count, "bytes_kept": self.bytes, "interval_s": self.interval}}

    # ------------------------------------------------------------------ internals
    def _write_frame(self, session) -> None:
        ids, xs, ys, angles, speeds, waits, types, edges = [], [], [], [], [], [], [], []
        for vid, v in session.vehicle_values.items():
            position = v.get(tc.VAR_POSITION)
            if position is None:
                continue         # subscribed before this recorder's variables applied
            ids.append(vid)
            xs.append(round(position[0], 1))
            ys.append(round(position[1], 1))
            angles.append(round(v[tc.VAR_ANGLE]))
            speeds.append(round(v[tc.VAR_SPEED], 1))
            waits.append(round(v[tc.VAR_WAITING_TIME]))
            types.append(self._types.setdefault(v[tc.VAR_TYPE], len(self._types)))
            edge = self._edges.get(v[tc.VAR_ROAD_ID], -1)
            edges.append(edge)
            before = self._vehicle_edge.get(vid, -1)
            if edge != before and self.road_monitor is not None:
                if before >= 0:
                    self._left[before] += 1
                if edge >= 0:
                    self._entered[edge] += 1
                self._vehicle_edge[vid] = edge
        if self.road_monitor is not None:
            for vid in session.arrived_ids:
                self._vehicle_edge.pop(vid, None)
        frame = {"t": session.now, "ids": ids, "x": xs, "y": ys, "a": angles, "s": speeds, "w": waits, "ty": types, "e": edges,
                 "types": list(self._types),
                 "tl": {tls: [int(v[tc.TL_CURRENT_PHASE]), v[tc.TL_RED_YELLOW_GREEN_STATE]] for tls, v in session.tl_values.items()}}
        if self.road_monitor is not None:
            for tls, state in frame["tl"].items():
                state.append(round(traci.trafficlight.getNextSwitch(tls) - session.now, 1))
        if self.road_monitor is not None and session.now + 1e-9 >= self._next_road:
            self._next_road = session.now + self._road_interval
            frame["r"] = self._sample_roads(session)
        snapshot = self.live_recorder.last_snapshot if self.live_recorder else None
        if snapshot and snapshot["sim_time_s"] != self._junction_sample:
            self._junction_sample = snapshot["sim_time_s"]
            frame["j"] = {"t": snapshot["sim_time_s"],
                          "v": {tid: [j["queue"], j["occupancy"], j["level"]] for tid, j in snapshot["junctions"].items()}}
        self._append(frame)

    def _sample_roads(self, session) -> dict:
        values = traci.edge.getAllSubscriptionResults()
        measured = []
        for edge in self._edge_list:
            v = values.get(edge["id"], {})
            lanes = edge["lane_ids"]
            measured.append((int(v.get(tc.LAST_STEP_VEHICLE_NUMBER, 0)), sum(session.halting(l) for l in lanes),
                             sum(session.occupancy(l) for l in lanes) / max(1, len(lanes)),
                             float(v.get(tc.LAST_STEP_MEAN_SPEED, 0.0)), float(v.get(tc.VAR_WAITING_TIME, 0.0))))
        sample = self.road_monitor.sample(session.now, measured, self._entered, self._left, session.tl_values, tc.TL_RED_YELLOW_GREEN_STATE)
        self._entered = [0] * len(self._edge_list)
        self._left = [0] * len(self._edge_list)
        return sample

    def _append(self, frame: dict) -> None:
        if self.count % CHUNK_FRAMES == 0:
            if self._file is not None:
                self._file.close()
            path = self.dir / f"c{self.count // CHUNK_FRAMES:06d}_{frame['t']}.jsonl"
            self._file = path.open("w", encoding="utf-8")
            self.chunks.append((path, 0))
            self._write_manifest("running", pending_t=frame["t"])
        line = json.dumps(frame, separators=(",", ":")) + "\n"
        self._file.write(line)
        self._file.flush()
        size = len(line)
        self.bytes += size
        path, used = self.chunks[-1]
        self.chunks[-1] = (path, used + size)
        self.count += 1
        self.first_t = frame["t"] if self.first_t is None else self.first_t
        self.last_t = frame["t"]
        if self.count % 5 == 0:
            self._write_manifest("running")
        while self.bytes > self.max_bytes and len(self.chunks) > 1:
            oldest, used = self.chunks.pop(0)
            try:
                oldest.unlink()
            except OSError:
                self.chunks.insert(0, (oldest, used))    # a reader holds it on Windows; retry next frame
                break
            self.bytes -= used
            self.first_t = float(self.chunks[0][0].stem.split("_")[1])

    def _write_manifest(self, status: str, pending_t: float | None = None) -> None:
        try:
            write_json_atomic(self.live / "frames.json", {
                "status": status, "interval_s": self.interval, "first_t": self.first_t if self.first_t is not None else pending_t,
                "last_t": self.last_t if self.last_t is not None else pending_t, "frames_recorded": self.count})
        except OSError:
            pass      # a reader holding the file on Windows must not break the simulation
