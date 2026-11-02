"""Orchestrates cameras, infrastructure monitors, agents and signal modes. Holds the state the API reads."""
from __future__ import annotations
import copy
import logging
import re
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from camera_service.agents import AgentNetwork, state_message
from camera_service.analytics import TrafficAnalyzer, validate_zones
from camera_service.detect import DetectorUnavailable, YoloDetector, compute_device
from camera_service.events import EventHub, StageTracker, iso, mask
from camera_service.infra import FrigateClient, Go2rtcClient, check_http_url
from camera_service.ingest import RateMeter, StreamWorker
from camera_service.settings import CONFIG_LIMITS, DATA_CLASSES, DEFAULT_CONFIG, RUNTIME, SOURCE_TYPES
from camera_service import signals as sig
from camera_service.store import BatchWriter, open_backend
from camera_service.vault import Vault

log = logging.getLogger("camera.service")
CAMERA_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
INTERSECTION_ID = re.compile(r"^[A-Za-z0-9_.:#-]{1,64}$")
STREAM_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
RTSP_SCHEMES = ("rtsp", "rtsps", "rtmp", "http", "https")
VIDEO_TYPES = (".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v")
SECTION_FLAGS = ("camera-management", "frame-extraction", "yolo-processing", "traffic-analytics", "agent-integration", "signal-optimization", "test-mode")
HISTORY_POINTS = 600


class Conflict(Exception):
    """The request is valid but cannot be carried out in the current state."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean_config(update: dict, base: dict | None = None) -> dict:
    cfg = copy.deepcopy(base or DEFAULT_CONFIG)
    for key, value in (update or {}).items():
        if key in CONFIG_LIMITS:
            lo, hi = CONFIG_LIMITS[key]
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not lo <= value <= hi:
                raise ValueError(f"{key} must be between {lo} and {hi}")
            cfg[key] = int(value) if isinstance(DEFAULT_CONFIG[key], int) else float(value)
        elif key == "detection_enabled":
            cfg[key] = bool(value)
        elif key == "sim_tls":
            cfg[key] = str(value)[:64] if value else None
        elif key == "retention":
            ret = dict(cfg["retention"])
            for k in ret:
                if k in value:
                    if not isinstance(value[k], (int, float)) or isinstance(value[k], bool) or value[k] < 0:
                        raise ValueError(f"retention.{k} must not be negative")
                    ret[k] = value[k]
            cfg["retention"] = ret
        else:
            raise ValueError(f"unknown setting: {key}")
    return cfg


class CameraRuntime:
    """Everything live about one running camera. Thread failures stay inside it."""

    def __init__(self, service: "LiveCameraService", row: dict):
        self.service, self.row = service, row
        self.id = row["id"]
        self.config = row["config"]
        self.data_class = row["data_class"]
        self.analyzer = TrafficAnalyzer(row.get("zones") or {})
        self.detector = service.detector_factory()
        self.processed = 0
        self.detector_error = None
        self.detection_paused = False
        self.latency_ms = None
        self.inference_ms = None
        self.rate_processed = RateMeter()
        self.latest = None        # latest detection result
        self.analytics = None
        self.history: deque = deque(maxlen=HISTORY_POINTS)
        self.frame_log: deque = deque(maxlen=40)
        self.stop_flag = threading.Event()
        self.last_state = 0.0
        self.last_persist = 0.0
        self.last_flow: dict = {}
        self.last_snapshot = 0.0
        self.worker = StreamWorker(self.id, lambda: service.resolve_source(self.row), self.config, on_event=self._on_stream, is_file=row["source_type"] == "file",
                                   capture_factory=service.capture_factory, extraction_on=lambda: service.flag("frame-extraction"))
        self.processor = threading.Thread(target=self._process_loop, name=f"lcm-process-{self.id}", daemon=True)

    def start(self) -> None:
        self.worker.start()
        self.processor.start()

    def stop(self) -> None:
        self.stop_flag.set()
        self.worker.stop()

    def join(self, timeout: float = 3.0) -> None:
        self.worker.join(timeout)
        self.processor.join(timeout)

    def _flow(self, source: str, target: str) -> None:
        """A packet on the page. Sampled from real work, at most twice a second for each link of each camera."""
        now = time.time()
        if now - self.last_flow.get(source, 0) >= 0.5:
            self.last_flow[source] = now
            self.service.hub.publish("flow", f"{source} to {target}", stage=source, to_stage=target, camera_id=self.id, data_class=self.data_class)

    def _on_stream(self, event: str, message) -> None:
        s = self.service
        direct = self.row["source_type"] != "go2rtc"
        if event == "frame":
            s.tracker.work("camera")
            if direct:
                self._flow("camera", "decode")
            else:
                s.tracker.work("go2rtc")
                s.tracker.work("restream")
                self._flow("camera", "go2rtc")
                self._flow("go2rtc", "restream")
                self._flow("restream", "decode")
            s.tracker.work("decode")
            self._flow("decode", "extract")
        elif event == "extracted":
            s.tracker.work("extract")
            self._flow("extract", "yolo")
        elif event == "error":
            s.tracker.error("decode", f"{self.id}: {message}")
            if not direct:
                s.tracker.error("restream", f"{self.id}: {message}")
            s.hub.publish("log", f"{self.id}: {message}", level="error", stage="decode", camera_id=self.id, data_class=self.data_class)
        elif event in ("connected", "disconnected", "stopped", "connecting"):
            s.hub.publish("log", f"{self.id}: {message}", level="warn" if event == "disconnected" else "info", stage="camera", camera_id=self.id, data_class=self.data_class)
            s.tracker.log("camera", f"{self.id}: {message}")
            if event in ("connected", "stopped", "disconnected"):
                s.persist_status(self.id, self.worker.state)

    def _process_loop(self) -> None:
        s = self.service
        while not self.stop_flag.is_set():
            frame = self.worker.frames.take_newest(0.5)
            if frame is None:
                continue
            started = time.time()
            status = "skipped"
            try:
                if s.flag("yolo-processing") and self.config["detection_enabled"]:
                    self._detect(frame)
                    status = "processed"
                else:
                    self.detection_paused = True
            except DetectorUnavailable as err:
                status = "detector_unavailable"
                self._detector_failed(str(err))
                self.stop_flag.wait(5.0)
            except Exception as err:      # one bad frame must not end the camera
                status = "error"
                self._detector_failed(f"{type(err).__name__}: {err}")
            finished = time.time()
            self.latency_ms = round((finished - frame.received_ts) * 1000, 1)
            self.frame_log.append({"frame_number": frame.number, "source_ts_ms": frame.source_ts_ms, "received": iso(frame.received_ts), "processing_ms": round((finished - started) * 1000, 1), "status": status})
            self._retain(frame)
            if finished - self.last_persist >= 1.0:
                self.last_persist = finished
                s.writer.add("lcm_frame_metadata", {"camera_id": self.id, "frame_number": frame.number, "source_timestamp_ms": frame.source_ts_ms, "received_timestamp": iso(frame.received_ts),
                                                    "width": frame.width, "height": frame.height, "processing_status": status, "processing_ms": round((finished - started) * 1000, 1)})
                if self.latest and self.latest["frame_number"] == frame.number:
                    for o in self.latest["objects"]:
                        s.writer.add("lcm_vehicle_detections", {"camera_id": self.id, "frame_number": frame.number, "tracking_id": o["track_id"], "vehicle_class": o["cls"], "confidence": o["conf"],
                                                                "bounding_box": o["box"], "timestamp": iso(frame.received_ts)})

    def _detector_failed(self, message: str) -> None:
        s = self.service
        if self.detector_error != message:
            s.hub.publish("log", f"{self.id}: detection unavailable, video continues. {message}", level="error", stage="yolo", camera_id=self.id, data_class=self.data_class)
        self.detector_error = message
        self.latest = None
        s.tracker.error("yolo", f"{self.id}: {message}")

    def _detect(self, frame) -> None:
        s = self.service
        objects, inference_ms = self.detector.track(frame.image, self.config["confidence"])
        self.detector_error = None
        self.detection_paused = False
        self.inference_ms = inference_ms
        self.processed += 1
        self.rate_processed.mark()
        s.tracker.work("yolo", inference_ms)
        self._flow("yolo", "tracking")
        tracked = [o for o in objects if o["track_id"] is not None]
        s.tracker.work("tracking")
        self.latest = {"frame_number": frame.number, "received": iso(frame.received_ts), "source_ts_ms": frame.source_ts_ms, "width": frame.width, "height": frame.height,
                       "inference_ms": round(inference_ms, 1), "objects": objects, "data_class": self.data_class}
        if not s.flag("traffic-analytics"):
            return
        self._flow("tracking", "analytics")
        started = time.perf_counter()
        self.analyzer.observe(frame.received_ts, frame.width, frame.height, tracked)
        if frame.received_ts - self.last_state < self.config["state_interval_s"]:
            return
        self.last_state = frame.received_ts
        snap = self.analyzer.snapshot(frame.received_ts)
        s.tracker.work("analytics", (time.perf_counter() - started) * 1000)
        self.analytics = {**snap, "timestamp": iso(frame.received_ts), "intersection_id": self.row["intersection_id"], "camera_id": self.id, "data_class": self.data_class}
        self.history.append({"t": iso(frame.received_ts), "vehicles": snap["vehicle_count"], "moving": snap["moving"], "stopped": snap["stopped"], "queue": snap["queue_vehicles"], "queue_m": snap["queue_length_m"],
                             "occupancy": snap["lane_occupancy"], "congestion": snap["congestion_level"], "approaches": {k: {"queue": v["queue_vehicles"], "occupancy": v["occupancy"], "vehicles": v["vehicles"]} for k, v in snap["approaches"].items()}})
        s.writer.add("lcm_traffic_analytics", {"intersection_id": self.row["intersection_id"], "camera_id": self.id, "vehicle_count": snap["vehicle_count"], "queue_length_m": snap["queue_length_m"],
                                               "queue_vehicles": snap["queue_vehicles"], "average_speed_mps": snap["average_speed_mps"], "occupancy": snap["lane_occupancy"], "congestion_level": snap["congestion_level"],
                                               "quality": snap["quality"], "data_class": self.data_class, "details": {"approaches": snap["approaches"], "by_class": snap["by_class"], "turning": snap["turning"]}, "timestamp": iso(frame.received_ts)})
        s.on_traffic_state(self, snap, frame.received_ts)

    def _retain(self, frame) -> None:
        """Frames are memory-only by default. Saving snapshots is opt-in per camera, and they expire."""
        ret = self.config["retention"]
        every = ret.get("snapshot_every_s") or 0
        if not every or time.time() - self.last_snapshot < every:
            return
        self.last_snapshot = time.time()
        try:
            import cv2
            folder = RUNTIME / "snapshots" / self.id
            folder.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(folder / f"{int(time.time() * 1000)}.jpg"), frame.image)
            limit = time.time() - float(ret.get("snapshot_max_age_s") or 0)
            for old in folder.glob("*.jpg"):
                if old.stat().st_mtime < limit:
                    old.unlink(missing_ok=True)
        except Exception as err:
            log.warning("Snapshot failed for %s: %s", self.id, err)


class LiveCameraService:
    def __init__(self, runtime_dir: Path = RUNTIME, detector_factory=YoloDetector, capture_factory=None, sumo_factory=sig.SumoBridge, backend=None, flags_client=None):
        self.runtime_dir = Path(runtime_dir)
        self.hub, self.tracker = EventHub(5000), StageTracker()
        if backend is not None:
            self.backend, self.db_note, self.flags_client = backend, None, flags_client
        else:
            self.backend, self.db_note, self.flags_client = open_backend(self.runtime_dir / "camera.sqlite3")
        self.writer = BatchWriter(self.backend)
        self.vault = Vault(self.runtime_dir / "credentials.enc")
        self.detector_factory = detector_factory
        if capture_factory is None:
            from camera_service.ingest import open_capture
            capture_factory = open_capture
        self.capture_factory = capture_factory
        self.sumo_factory = sumo_factory
        self.network = AgentNetwork(self.hub, self.tracker)
        self.shadow = sig.ShadowController()
        self.real_gate = sig.RealControllerGate()
        self.bridge = None
        self.bridge_error = None
        self.lock = threading.RLock()
        self.rows: dict[str, dict] = {}
        self.runtimes: dict[str, CameraRuntime] = {}
        self.flags = {"module": self.flags_client is None, **{f: self.flags_client is None for f in SECTION_FLAGS}}
        self.flags_error = None
        self.infra = {"frigate": {"state": "NOT_CONFIGURED", "detail": "Frigate has not been configured."}, "go2rtc": {"state": "NOT_CONFIGURED", "detail": "go2rtc has not been configured.", "streams": {}}}
        self.infra_log: dict[str, deque] = {"frigate": deque(maxlen=50), "go2rtc": deque(maxlen=50)}
        self.clients: dict = {"frigate": None, "go2rtc": None}
        self.settings: dict = {}
        self.signal_mode = sig.MODE_SHADOW
        self.decisions: deque = deque(maxlen=200)
        self.stop_flag = threading.Event()
        self.threads: list = []
        self.resources: dict = {}
        self.started_at = time.time()

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        (self.runtime_dir / "media").mkdir(exist_ok=True)
        for row in self.backend.select("lcm_settings"):
            self.settings[row["key"]] = row["value"]
        self.signal_mode = (self.settings.get("signal_mode") or {}).get("mode", sig.MODE_SHADOW)
        if self.signal_mode not in (sig.MODE_SHADOW, sig.MODE_SIMULATION):
            self.signal_mode = sig.MODE_SHADOW
        for row in self.backend.select("lcm_cameras", order="created_at.asc"):
            row["config"] = clean_config({k: v for k, v in (row.get("config") or {}).items() if k in DEFAULT_CONFIG or k == "sim_tls"})
            self.rows[row["id"]] = row
        for row in self.backend.select("lcm_signal_decisions", order="id.desc", limit=100)[::-1]:
            self.decisions.append(row)
        self._rebuild_clients()
        self._update_topology()
        if self.signal_mode == sig.MODE_SIMULATION:
            threading.Thread(target=self._start_bridge, daemon=True).start()
        self._read_flags()
        self._spawn("flags", self._flags_loop)
        self._spawn("infra", self._infra_loop)
        self._spawn("watch", self._watch_loop)
        self._spawn("retention", self._retention_loop)
        self.reconcile()
        self.hub.publish("log", f"Camera service started. Database: {self.backend.name}.", stage=None)

    def _spawn(self, name, target) -> None:
        t = threading.Thread(target=target, name=f"lcm-{name}", daemon=True)
        t.start()
        self.threads.append(t)

    def shutdown(self) -> None:
        self.stop_flag.set()
        with self.lock:
            runtimes = list(self.runtimes.values())
            self.runtimes.clear()
        for rt in runtimes:
            rt.stop()
        for rt in runtimes:
            rt.join()
        if self.bridge:
            self.bridge.stop()
        for client in self.clients.values():
            if client:
                client.close()
        self.writer.close()

    # ------------------------------------------------------------------ flags
    def flag(self, name: str) -> bool:
        return bool(self.flags.get("module")) and bool(self.flags.get(name))

    def _read_flags(self) -> None:
        if self.flags_client is None:
            return
        try:
            modules, sections = self.flags_client.read_flags()
            row = modules[0] if modules else None
            module_on = row["is_enabled"] is True if row else True      # same rule as the website: no row yet counts as on
            saved = {s["slug"]: s["is_enabled"] is True for s in sections if row and s["module_id"] == row["id"]}
            self.flags = {"module": module_on, **{f: saved.get(f, True) for f in SECTION_FLAGS}}
            self.flags_error = None
        except Exception as err:
            # Last known state is kept. Before any successful read everything stays off: no processing on unknown authority.
            self.flags_error = f"{type(err).__name__}"

    def _flags_loop(self) -> None:
        while not self.stop_flag.wait(5.0):
            before = dict(self.flags)
            self._read_flags()
            if before != self.flags:
                self.hub.publish("log", "Admin module settings changed.")
                self.reconcile()

    def reconcile(self) -> None:
        """Bring running workers in line with module state and each camera's enabled flag. Configuration is never deleted."""
        with self.lock:
            for cid, row in self.rows.items():
                want = self.flags.get("module") and row["enabled"] and self._source_allowed(row)
                rt = self.runtimes.get(cid)
                if want and rt is None:
                    self.runtimes[cid] = CameraRuntime(self, row)
                    self.runtimes[cid].start()
                elif not want and rt is not None:
                    rt.stop()
                    del self.runtimes[cid]
                    self.persist_status(cid, "STOPPED")

    def _source_allowed(self, row: dict) -> bool:
        return row["data_class"] == "LIVE" or self.flag("test-mode")

    # ------------------------------------------------------------------ settings and infrastructure
    def _save_setting(self, key: str, value: dict) -> None:
        self.settings[key] = value
        self.backend.upsert("lcm_settings", {"key": key, "value": value, "updated_at": _now_iso()})

    def _rebuild_clients(self) -> None:
        for name, client in self.clients.items():
            if client:
                client.close()
            self.clients[name] = None
        f = self.settings.get("frigate") or {}
        if f.get("url"):
            try:
                self.clients["frigate"] = FrigateClient(f["url"], self.vault.get("frigate.token"), self.vault.get("frigate.username"), self.vault.get("frigate.password"), f.get("verify_tls", True))
            except ValueError as err:
                self.infra["frigate"] = {"state": "ERROR", "detail": str(err)}
        g = self.settings.get("go2rtc") or {}
        if g.get("url"):
            try:
                self.clients["go2rtc"] = Go2rtcClient(g["url"], self.vault.get("go2rtc.username"), self.vault.get("go2rtc.password"), g.get("rtsp_url"))
            except ValueError as err:
                self.infra["go2rtc"] = {"state": "ERROR", "detail": str(err), "streams": {}}

    def configure_infra(self, name: str, body: dict) -> dict:
        """Save an address and, if given, credentials. Empty credential fields leave the saved ones alone; clear=true removes them."""
        if name not in self.clients:
            raise ValueError("unknown service")
        url = check_http_url(body.get("url", ""))
        value = {"url": url}
        fields = {"frigate": ("token", "username", "password"), "go2rtc": ("username", "password")}[name]
        if name == "frigate":
            value["verify_tls"] = bool(body.get("verify_tls", True))
        else:
            rtsp = (body.get("rtsp_url") or "").strip()
            if rtsp:
                parsed = urlparse(rtsp)
                if parsed.scheme not in ("rtsp", "rtsps") or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError("The restream base looks like rtsp://host:8554, without credentials.")
                value["rtsp_url"] = rtsp.rstrip("/")
        secrets = {f: body[f] for f in fields if body.get(f)}
        if body.get("clear_credentials"):
            secrets = {f: None for f in fields}
        for f, v in secrets.items():
            self.vault.set(f"{name}.{f}", v)
        self._save_setting(name, value)
        self._rebuild_clients()
        self.check_infra(name, log_result=True)
        self.hub.publish("log", f"{name} configuration saved.", stage=name)
        return self.infra_view(name)

    def check_infra(self, name: str, log_result: bool = False) -> dict:
        client = self.clients.get(name)
        if client is None:
            if self.infra[name].get("state") != "ERROR":
                self.infra[name] = {"state": "NOT_CONFIGURED", "detail": f"{name} has not been configured.", "streams": {}}
            self.tracker.condition(name, None, "Not configured")
            return self.infra[name]
        previous = self.infra[name].get("state")
        try:
            result = client.status()
        except Exception as err:
            result = {"state": "ERROR", "detail": f"{type(err).__name__}", "checked_at": iso(), "streams": {}}
        self.infra[name] = result
        state = result["state"]
        if state == "CONNECTED":
            self.tracker.condition(name, None, f"Version {result.get('version') or 'unknown'}")
            self.tracker.touch(name)
        elif state == "ERROR":
            self.tracker.condition(name, "ERROR", result.get("detail"))
        else:
            self.tracker.condition(name, "DISCONNECTED", result.get("detail"))
        if state != previous or log_result:
            line = {"ts": iso(), "state": state, "detail": mask(result.get("detail") or f"Version {result.get('version') or 'unknown'}")}
            self.infra_log[name].append(line)
            self.tracker.log(name, f"{state}: {line['detail']}")
            self.hub.publish("log", f"{name}: {state}. {line['detail']}", stage=name, level="info" if state == "CONNECTED" else "warn")
        return result

    def infra_view(self, name: str) -> dict:
        saved = self.settings.get(name) or {}
        fields = {"frigate": ("token", "username", "password"), "go2rtc": ("username", "password")}[name]
        return {**self.infra[name], "configured": bool(saved.get("url")), "url": saved.get("url"), "rtsp_url": saved.get("rtsp_url"), "verify_tls": saved.get("verify_tls", True),
                "credentials": {f: self.vault.has(f"{name}.{f}") for f in fields}, "vault_writable": self.vault.writable, "log": list(self.infra_log[name])}

    def test_infra(self, name: str, body: dict | None = None) -> dict:
        """Check an address without saving it, with the saved credentials unless new ones are given."""
        body = body or {}
        if not body.get("url"):
            return self.check_infra(name, log_result=True)
        if name == "frigate":
            client = FrigateClient(body["url"], body.get("token") or self.vault.get("frigate.token"), body.get("username") or self.vault.get("frigate.username"),
                                   body.get("password") or self.vault.get("frigate.password"), bool(body.get("verify_tls", True)))
        else:
            client = Go2rtcClient(body["url"], body.get("username") or self.vault.get("go2rtc.username"), body.get("password") or self.vault.get("go2rtc.password"), body.get("rtsp_url"))
        try:
            return client.status()
        finally:
            client.close()

    def _infra_loop(self) -> None:
        while True:
            for name in self.clients:
                self.check_infra(name)
            self._apply_stream_labels()
            if self.stop_flag.wait(5.0):
                return

    def _apply_stream_labels(self) -> None:
        """A go2rtc stream fed from a file is a replay, whatever it was registered as."""
        streams = self.infra["go2rtc"].get("streams") or {}
        with self.lock:
            for row in self.rows.values():
                if row["source_type"] == "go2rtc" and (streams.get(row["stream_reference"]) or {}).get("looks_like_file") and row["data_class"] != "REPLAY":
                    self.update_camera(row["id"], {"data_class": "REPLAY"})
                    self.hub.publish("log", f"{row['id']}: go2rtc reads this stream from a file, so it is labelled REPLAY.", level="warn", stage="go2rtc", camera_id=row["id"])

    # ------------------------------------------------------------------ cameras
    def resolve_source(self, row: dict):
        kind, ref = row["source_type"], row["stream_reference"]
        if kind == "go2rtc":
            client = self.clients["go2rtc"]
            if client is None:
                raise ConnectionError("go2rtc is not configured.")
            url = client.restream_url(ref)
            user, password = self.vault.get("go2rtc.rtsp_username"), self.vault.get("go2rtc.rtsp_password")
            if user and password:
                parsed = urlparse(url)
                url = parsed._replace(netloc=f"{user}:{password}@{parsed.netloc}").geturl()
            return url
        if kind == "rtsp":
            url = self.vault.get(f"camera.{row['id']}.url") or self.settings.get(f"url:{row['id']}", {}).get("url")
            if not url:
                raise ConnectionError("The stream address is missing.")
            return url
        if kind in ("webcam", "usb"):
            return int(ref)
        if kind == "file":
            return str(self._media_path(ref))
        raise ConnectionError(f"Unknown source type {kind}")

    def _media_path(self, name: str) -> Path:
        media = (self.runtime_dir / "media").resolve()
        path = (media / name).resolve()
        if path.parent != media or path.suffix.lower() not in VIDEO_TYPES:
            raise ValueError("A replay source must be an uploaded video.")
        if not path.is_file():
            raise ValueError("That video has not been uploaded.")
        return path

    def _prepare_source(self, cid: str, kind: str, body: dict) -> tuple[str, str]:
        """Check a source, keep any secret part of it out of the database, and return (stream_reference, data_class)."""
        requested = body.get("data_class") or "TEST"
        if requested not in DATA_CLASSES:
            raise ValueError("data_class must be LIVE, TEST or REPLAY")
        source = body.get("source")
        if kind == "go2rtc":
            if not isinstance(source, str) or not STREAM_NAME.match(source):
                raise ValueError("Choose a go2rtc stream name.")
            # A file-backed stream is a replay from its first frame, whatever it was registered as.
            from_file = (self.infra["go2rtc"].get("streams") or {}).get(source, {}).get("looks_like_file")
            return source, "REPLAY" if from_file else requested
        if kind == "rtsp":
            if not isinstance(source, str):
                raise ValueError("Enter a stream address.")
            parsed = urlparse(source.strip())
            if parsed.scheme not in RTSP_SCHEMES or not parsed.hostname:
                raise ValueError("Use an rtsp://, rtsps://, rtmp://, http:// or https:// address.")
            if parsed.username or parsed.password or parsed.query:
                self.vault.set(f"camera.{cid}.url", source.strip())
                return mask(source.strip()).split("?")[0], requested
            self._save_setting(f"url:{cid}", {"url": source.strip()})
            return source.strip(), requested
        if kind in ("webcam", "usb"):
            if not isinstance(source, int) or isinstance(source, bool) or not 0 <= source <= 16:
                raise ValueError("Enter a device number between 0 and 16.")
            return str(source), "TEST"
        if kind == "file":
            return self._media_path(str(source)).name, "REPLAY"
        raise ValueError("Unknown source type")

    def add_camera(self, body: dict) -> dict:
        if not self.flag("camera-management"):
            raise Conflict("Camera management is turned off in the admin panel.")
        cid = str(body.get("id") or f"CAM_{uuid.uuid4().hex[:6].upper()}")
        if not CAMERA_ID.match(cid):
            raise ValueError("A camera ID uses letters, numbers, - and _.")
        kind = body.get("source_type")
        if kind not in SOURCE_TYPES:
            raise ValueError(f"source_type must be one of {', '.join(SOURCE_TYPES)}")
        intersection = str(body.get("intersection_id") or "")
        if not INTERSECTION_ID.match(intersection):
            raise ValueError("Enter an intersection ID.")
        with self.lock:
            if cid in self.rows:
                raise Conflict("A camera with that ID already exists.")
        reference, data_class = self._prepare_source(cid, kind, body)
        if data_class != "LIVE" and not self.flag("test-mode"):
            raise Conflict("Test sources are turned off in the admin panel.")
        now = _now_iso()
        row = {"id": cid, "camera_name": str(body.get("camera_name") or cid)[:80], "location": str(body.get("location") or "")[:120], "intersection_id": intersection,
               "source_type": kind, "stream_reference": reference, "data_class": data_class, "enabled": bool(body.get("enabled", True)), "status": "STOPPED",
               "config": clean_config(body.get("config")), "zones": validate_zones(body.get("zones") or {}), "created_at": now, "updated_at": now}
        self.backend.upsert("lcm_cameras", row)
        with self.lock:
            self.rows[cid] = row
        self._update_topology()
        self.hub.publish("log", f"{cid} registered as {data_class} source at {intersection}.", camera_id=cid, data_class=data_class)
        self.reconcile()
        return self.camera_view(cid, admin=True)

    def update_camera(self, cid: str, body: dict) -> dict:
        with self.lock:
            row = self._row(cid)
            restart = False
            for key in ("camera_name", "location"):
                if key in body:
                    row[key] = str(body[key])[:120]
            if "intersection_id" in body:
                if not INTERSECTION_ID.match(str(body["intersection_id"])):
                    raise ValueError("Enter an intersection ID.")
                row["intersection_id"] = str(body["intersection_id"])
            if "enabled" in body:
                row["enabled"] = bool(body["enabled"])
            if "config" in body:
                row["config"] = clean_config(body["config"], row["config"])
                restart = True
            if "zones" in body:
                row["zones"] = validate_zones(body["zones"])
                restart = True
            if "data_class" in body:
                wanted = body["data_class"]
                if wanted not in DATA_CLASSES:
                    raise ValueError("data_class must be LIVE, TEST or REPLAY")
                if row["source_type"] in ("webcam", "usb") and wanted != "TEST":
                    raise ValueError("A webcam or USB camera is always a test source.")
                if row["source_type"] == "file" and wanted != "REPLAY":
                    raise ValueError("An uploaded video is always a replay.")
                row["data_class"] = wanted
                restart = True
            if "source" in body:
                row["stream_reference"], row["data_class"] = self._prepare_source(cid, row["source_type"], {"source": body["source"], "data_class": row["data_class"]})
                restart = True
            row["updated_at"] = _now_iso()
            self.backend.upsert("lcm_cameras", row)
            if restart and cid in self.runtimes:
                self.runtimes.pop(cid).stop()
        self._update_topology()
        self.reconcile()
        return self.camera_view(cid, admin=True)

    def delete_camera(self, cid: str) -> None:
        with self.lock:
            self._row(cid)
            rt = self.runtimes.pop(cid, None)
            if rt:
                rt.stop()
            del self.rows[cid]
            self.backend.delete("lcm_cameras", "id", cid)
            self.backend.delete("lcm_settings", "key", f"url:{cid}")
            self.settings.pop(f"url:{cid}", None)
        if self.vault.writable:
            self.vault.set(f"camera.{cid}.url", None)
        self._update_topology()

    def _row(self, cid: str) -> dict:
        row = self.rows.get(cid)
        if row is None:
            raise KeyError(cid)
        return row

    def persist_status(self, cid: str, status: str) -> None:
        row = self.rows.get(cid)
        if row and row.get("status") != status:
            row["status"] = status
            try:
                self.backend.upsert("lcm_cameras", {**row, "updated_at": _now_iso()})
            except Exception as err:
                log.warning("Could not save status of %s: %s", cid, err)

    def reconnect(self, cid: str) -> dict:
        with self.lock:
            self._row(cid)
            rt = self.runtimes.get(cid)
        if rt is None:
            raise Conflict("This camera is not running.")
        rt.worker.reconnect()
        self.hub.publish("log", f"{cid}: reconnect requested.", camera_id=cid)
        return self.camera_view(cid, admin=True)

    def test_connection(self, cid: str) -> dict:
        """Open the source on its own, read one frame, and close it. Works while the camera is stopped."""
        row = self._row(cid)
        started = time.perf_counter()
        cap = None
        try:
            cap = self.capture_factory(self.resolve_source(row))
            if cap is None or not cap.isOpened():
                return {"ok": False, "detail": "The source did not open."}
            ok, image = cap.read()
            if not ok or image is None:
                return {"ok": False, "detail": "The source opened but delivered no frame."}
            return {"ok": True, "width": int(image.shape[1]), "height": int(image.shape[0]), "elapsed_ms": round((time.perf_counter() - started) * 1000)}
        except Exception as err:
            return {"ok": False, "detail": mask(f"{type(err).__name__}: {err}")}
        finally:
            if cap is not None:
                cap.release()

    def camera_view(self, cid: str, admin: bool = False) -> dict:
        row = self._row(cid)
        rt = self.runtimes.get(cid)
        now = time.time()
        w = rt.worker if rt else None
        frigate = ((self.infra["frigate"].get("cameras") or {}).get(row.get("frigate_name") or row["stream_reference"])
                   or (self.infra["frigate"].get("cameras") or {}).get(cid))
        stream = (self.infra["go2rtc"].get("streams") or {}).get(row["stream_reference"]) if row["source_type"] == "go2rtc" else None
        latest = rt.latest if rt else None
        protocol = {"go2rtc": "RTSP (go2rtc restream)", "rtsp": urlparse(row["stream_reference"]).scheme.upper(), "webcam": "Local device", "usb": "Local device", "file": "Video file"}[row["source_type"]]
        out = {
            "id": cid, "camera_name": row["camera_name"], "location": row["location"], "intersection_id": row["intersection_id"], "source_type": row["source_type"],
            "data_class": row["data_class"], "enabled": row["enabled"], "protocol": protocol, "status": w.state if w else "STOPPED", "detail": w.detail if w else None,
            "fps": w.rate_received.rate(now) if w else 0.0, "source_fps": w.source_fps if w else None, "processing_fps": rt.rate_processed.rate(now) if rt else 0.0,
            "width": w.width if w else None, "height": w.height if w else None, "last_frame": iso(w.last_frame_ts) if w and w.last_frame_ts else None,
            "last_frame_age_s": round(now - w.last_frame_ts, 2) if w and w.last_frame_ts else None, "latency_ms": rt.latency_ms if rt else None, "inference_ms": rt.inference_ms if rt else None,
            "detection_status": self._detection_status(row, rt), "vehicle_count": len(latest["objects"]) if latest and w and w.state == "CONNECTED" else None,
            "unique_tracks": rt.analyzer.unique_total if rt else 0, "recording": frigate["recording"] if frigate else None,
            "frames": {"received": w.received if w else 0, "extracted": w.extracted if w else 0, "processed": rt.processed if rt else 0, "dropped": w.frames.dropped if w else 0, "reconnects": w.attempts - 1 if w and w.attempts else 0},
            "next_retry_in_s": round(w.next_retry_at - now, 1) if w and w.next_retry_at else None,
            "config": row["config"], "zones": row["zones"],
        }
        if admin:
            out.update({"connection": row["stream_reference"], "sim_tls": self.tls_for(row["intersection_id"]), "pipeline": self._camera_stages(row, rt, frigate, stream), "frigate": frigate, "stream": stream,
                        "errors": [{"at": iso(e["at"]), "message": mask(e["message"])} for e in list(w.errors)[-15:]] if w else [], "attempts": w.attempts if w else 0,
                        "detector": rt.detector.info() if rt and hasattr(rt.detector, "info") else None})
        return out

    @staticmethod
    def _detection_status(row, rt) -> str:
        if rt is None:
            return "STOPPED"
        if rt.detector_error:
            return "UNAVAILABLE"
        if not row["config"]["detection_enabled"] or rt.detection_paused:
            return "OFF"
        if rt.worker.state != "CONNECTED":
            return "WAITING"
        return "RUNNING" if rt.processed else "STARTING"

    def _camera_stages(self, row, rt, frigate, stream) -> list[dict]:
        w = rt.worker if rt else None
        connected = bool(w and w.state == "CONNECTED")
        go = row["source_type"] == "go2rtc"
        frigate_state = self.infra["frigate"].get("state")
        return [
            {"key": "camera", "status": "RUNNING" if connected else ("CONNECTING" if w and w.state == "CONNECTING" else ("DISCONNECTED" if w and w.state == "RECONNECTING" else "IDLE")), "note": row["data_class"]},
            {"key": "frigate", "status": ("RUNNING" if frigate and frigate.get("connected") else "DEGRADED") if frigate else ("DISCONNECTED" if frigate_state not in ("NOT_CONFIGURED", "CONNECTED") else "IDLE"),
             "note": "Managed by Frigate" if frigate else "Not managed by Frigate"},
            {"key": "go2rtc", "status": ("RUNNING" if stream else "DISCONNECTED") if go else "IDLE", "note": (f"{stream['producers']} source, {stream['consumers']} readers" if stream else "Stream not found") if go else "Direct source; go2rtc not used"},
            {"key": "restream", "status": ("RUNNING" if connected else "DISCONNECTED") if go else "IDLE", "note": None if go else "Direct source; no restream"},
            {"key": "extract", "status": "RUNNING" if connected and self.flag("frame-extraction") else "IDLE", "note": None if self.flag("frame-extraction") else "Turned off by admin"},
            {"key": "yolo", "status": self._yolo_status(row, rt), "note": rt.detector_error if rt else None},
        ]

    def _yolo_status(self, row, rt) -> str:
        if rt is None:
            return "IDLE"
        if rt.detector_error:
            return "ERROR"
        return "RUNNING" if rt.processed and not rt.detection_paused and rt.worker.state == "CONNECTED" else "IDLE"

    # ------------------------------------------------------------------ agents and signals
    def _update_topology(self) -> None:
        with self.lock:
            ids = sorted({r["intersection_id"] for r in self.rows.values()})
        self.network.set_topology([{"id": j} for j in ids])

    def tls_for(self, intersection_id: str) -> str | None:
        """SUMO junction for an intersection: the camera's sim_tls setting, otherwise assigned in order."""
        tls = sorted(self.bridge.phase_maps) if self.bridge and self.bridge.phase_maps else []
        with self.lock:
            for row in self.rows.values():
                if row["intersection_id"] == intersection_id and row["config"].get("sim_tls"):
                    return row["config"]["sim_tls"]
            ids = sorted({r["intersection_id"] for r in self.rows.values()})
        if not tls or intersection_id not in ids:
            return None
        return tls[ids.index(intersection_id) % len(tls)]

    def on_traffic_state(self, rt: CameraRuntime, snap: dict, ts: float) -> None:
        if not self.flag("agent-integration"):
            return
        j = rt.row["intersection_id"]
        message = state_message(rt.id, j, ts, snap, {"LIVE": "LIVE_CAMERA", "TEST": "TEST_SOURCE", "REPLAY": "REPLAY"}[rt.data_class])
        self.network.receive_state(message, snap["approaches"], rt.data_class)
        if self.flag("signal-optimization") and self.network.due(j):
            self.decide(j)

    def _context(self, j: str):
        if self.signal_mode == sig.MODE_SIMULATION:
            tls = self.tls_for(j)
            if not (self.bridge and self.bridge.running and tls in self.bridge.phase_maps):
                return None, None
            return self.bridge.context(tls), tls
        return self.shadow.context(j), None

    def decide(self, j: str) -> dict | None:
        ctx, tls = self._context(j)
        if ctx is None:
            self.tracker.condition("signal", "DISCONNECTED", "The simulation is not running.")
            return None
        self.tracker.condition("signal", None, f"{self.signal_mode} mode")
        proposal = self.network.propose(j, ctx)
        if proposal is None:
            return None
        started = time.perf_counter()
        validation = sig.validate_plan(proposal["axis"], proposal["green_s"], ctx, time.time() - proposal["state_timestamp"])
        self.tracker.work("safety", (time.perf_counter() - started) * 1000)
        mode = self.signal_mode
        outcome = {"applied": False, "note": "Rejected by the safety validator; nothing was applied."}
        if validation.status != "REJECTED":
            if mode == sig.MODE_SIMULATION:
                outcome = self.bridge.apply(tls, validation)
                outcome["state_after"] = self.bridge.state(tls)
            else:
                outcome = self.shadow.apply(j, validation)
            self.tracker.work("signal")
        self.network.record_decision(j, proposal, validation, outcome)
        decision = {"intersection_id": j, "camera_id": proposal["camera_id"], "proposed_phase": f"{proposal['axis']} {proposal['green_s']:.0f}s",
                    "approved_phase": f"{validation.approved_axis} {validation.approved_green_s:.0f}s" if validation.approved_axis else None,
                    "decision_reason": proposal["reason"], "source": proposal["data_class"], "mode": mode, "validation_status": validation.status,
                    "details": {"reasons": validation.reasons, "action": validation.action, "outcome": outcome, "central_verdict": proposal["central_verdict"], "demand": proposal["demand"], "algorithm": proposal["algorithm"],
                                "current_axis": ctx.current_axis, "elapsed_s": round(ctx.elapsed_s, 1), "in_clearance": ctx.in_clearance, "emergency": proposal["emergency"]},
                    "timestamp": iso()}
        self.decisions.append(decision)
        self.writer.add("lcm_signal_decisions", decision)
        self.hub.publish("signal", f"{j}: {validation.status} {proposal['axis']} ({mode.lower()})", stage="safety", to_stage="signal" if validation.status != "REJECTED" else None,
                         camera_id=proposal["camera_id"], data_class=proposal["data_class"], level="info" if validation.status != "REJECTED" else "warn", data={"decision": decision})
        return decision

    def _start_bridge(self) -> None:
        try:
            bridge = self.sumo_factory()
            bridge.start()
            self.bridge, self.bridge_error = bridge, None
            self.tracker.condition("signal", None, "SIMULATION mode")
            self.hub.publish("log", f"SUMO started under TraCI with {len(bridge.phase_maps)} controllable junctions.", stage="signal")
        except Exception as err:
            self.bridge_error = f"{type(err).__name__}: {err}"
            self.tracker.error("signal", self.bridge_error)
            self.hub.publish("log", f"SUMO could not start: {self.bridge_error}", level="error", stage="signal")

    def set_mode(self, mode: str, background: bool = True) -> dict:
        if mode not in sig.MODES:
            raise ValueError("Unknown signal mode.")
        if mode == sig.MODE_REAL:
            self.hub.publish("log", "Refused a request for real controller mode.", level="warn", stage="signal")
            raise PermissionError(self.real_gate.REFUSAL)
        if mode == sig.MODE_SIMULATION and not (self.bridge and self.bridge.running):
            if background:
                threading.Thread(target=self._start_bridge, daemon=True).start()
            else:
                self._start_bridge()
        if mode == sig.MODE_SHADOW and self.bridge:
            self.bridge.stop()
            self.bridge = None
        self.signal_mode = mode
        self._save_setting("signal_mode", {"mode": mode})
        self.hub.publish("log", f"Signal mode set to {mode}.", stage="signal")
        return self.signal_view()

    def signal_view(self) -> dict:
        junctions = []
        for agent in self.network.snapshot()["agents"]:
            j = agent["id"]
            current = None
            tls = None
            if self.signal_mode == sig.MODE_SIMULATION and self.bridge and self.bridge.running:
                tls = self.tls_for(j)
                current = self.bridge.state(tls) if tls in self.bridge.phase_maps else None
            elif self.signal_mode == sig.MODE_SHADOW:
                current = self.shadow.describe(j)
            junctions.append({"intersection_id": j, "tls": tls, "current": current, "proposal": agent["proposal"], "decision": agent["decision"]})
        return {"mode": self.signal_mode, "junctions": junctions, "real_controller": {"configured": False, "available": False, "detail": self.real_gate.REFUSAL},
                "simulation": {**self.bridge.status()} if self.bridge else {"running": False, "error": self.bridge_error}, "enabled": self.flag("signal-optimization")}

    # ------------------------------------------------------------------ monitors
    def _watch_loop(self) -> None:
        try:
            import psutil
        except ImportError:
            psutil = None
        if psutil:
            psutil.cpu_percent(None)
        while not self.stop_flag.wait(2.0):
            self.network.watchdog()
            if psutil:
                mem = psutil.virtual_memory()
                self.resources = {"cpu_percent": psutil.cpu_percent(None), "ram_percent": mem.percent, "ram_used_gb": round(mem.used / 2**30, 1), "process_mb": round(psutil.Process().memory_info().rss / 2**20)}
            self.resources["device"] = compute_device()
            for key in ("yolo", "tracking"):
                self._reflect_processing(key)
            self.tracker.condition("agent", None, None if self.flag("agent-integration") else "Turned off by admin")
            self.tracker.condition("coordination", None, None if self.flag("agent-integration") else "Turned off by admin")

    def _reflect_processing(self, key: str) -> None:
        note = None if self.flag("yolo-processing") else "Turned off by admin"
        self.tracker.condition(key, None, note)

    def _retention_loop(self) -> None:
        while not self.stop_flag.wait(3600.0):
            days = max((r["config"]["retention"].get("metadata_days") or 7 for r in self.rows.values()), default=7)
            cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            for table, column in (("lcm_frame_metadata", "received_timestamp"), ("lcm_vehicle_detections", "timestamp"), ("lcm_traffic_analytics", "timestamp")):
                try:
                    self.backend.delete_older(table, column, cutoff)
                except Exception as err:
                    log.warning("Retention cleanup failed for %s: %s", table, err)

    # ------------------------------------------------------------------ views
    def overview(self, admin: bool = False) -> dict:
        with self.lock:
            ids = list(self.rows)
        cameras = [self.camera_view(c, admin) for c in ids]
        connected = [c for c in cameras if c["status"] == "CONNECTED"]
        return {
            "status": {"total": len(cameras), "connected": len(connected), "offline": sum(1 for c in cameras if c["enabled"] and c["status"] != "CONNECTED"), "active_streams": len(self.runtimes),
                       "processing_fps": round(sum(c["processing_fps"] for c in cameras), 1), "vehicles_detected": sum(c["unique_tracks"] for c in cameras),
                       "active_intersections": len({c["intersection_id"] for c in connected})},
            "cameras": cameras, "stages": self.tracker.snapshot(), "flags": self.flags, "flags_error": self.flags_error,
            "services": {"frigate": self._service_summary("frigate"), "go2rtc": self._service_summary("go2rtc")},
            "resources": self.resources,
            "database": {"backend": self.backend.name, "note": self.db_note if admin else None, "dropped_rows": self.writer.dropped, "write_failures": self.writer.failures},
            "signal_mode": self.signal_mode, "seq": self.hub.seq, "server_time": iso(),
        }

    def _service_summary(self, name: str) -> dict:
        info = self.infra[name]
        return {"state": info.get("state"), "version": info.get("version"), "detail": info.get("detail"), "streams": sorted(info.get("streams") or {}) if name == "go2rtc" else None,
                "cameras": sorted(info.get("cameras") or {}) if name == "frigate" else None}

    def topology(self, admin: bool = False) -> dict:
        streams = self.infra["go2rtc"].get("streams") or {}
        links = []
        assigned = set()
        with self.lock:
            rows = list(self.rows.values())
        for row in rows:
            rt = self.runtimes.get(row["id"])
            w = rt.worker if rt else None
            stream = streams.get(row["stream_reference"]) if row["source_type"] == "go2rtc" else None
            if stream:
                assigned.add(row["stream_reference"])
            links.append({"camera_id": row["id"], "camera_name": row["camera_name"], "source_type": row["source_type"], "data_class": row["data_class"],
                          "stream": row["stream_reference"] if row["source_type"] == "go2rtc" else None, "stream_state": stream["state"] if stream else ("MISSING" if row["source_type"] == "go2rtc" else "DIRECT"),
                          "ingest_state": w.state if w else "STOPPED", "fps": w.rate_received.rate() if w else 0.0})
        def public(s):
            return s if admin else {k: s[k] for k in ("name", "state", "producers", "consumers")}
        return {"links": links, "streams": [public(s) for s in streams.values()], "unassigned": sorted(set(streams) - assigned), "go2rtc_state": self.infra["go2rtc"].get("state")}
