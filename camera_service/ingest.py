"""One independent reader thread per camera. A camera failing affects only its own thread.

Video decoding is OpenCV's FFmpeg backend. Real-time rule: always work on the newest frame. The queue is bounded
and overwrites, so falling behind costs dropped frames, counted, instead of growing memory or latency.
"""
from __future__ import annotations
import logging
import os
import random
import threading
import time
from collections import deque
from dataclasses import dataclass

log = logging.getLogger("camera.ingest")
# TCP survives the packet loss of real camera networks far better than RTSP's default UDP. stimeout is in microseconds.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|stimeout;5000000")

BACKOFF_START_S, BACKOFF_MAX_S = 1.0, 30.0


@dataclass
class Frame:
    camera_id: str
    number: int
    image: object
    source_ts_ms: float | None
    received_ts: float
    width: int
    height: int


class LatestFrames:
    """Bounded frame queue. Readers take the newest frame and everything older is stale, so it is discarded."""

    def __init__(self, maxlen: int = 2):
        self.items: deque = deque(maxlen=maxlen)
        self.cond = threading.Condition()
        self.dropped = 0

    def put(self, frame: Frame) -> None:
        with self.cond:
            if len(self.items) == self.items.maxlen:
                self.dropped += 1
            self.items.append(frame)
            self.cond.notify_all()

    def take_newest(self, timeout: float = 0.5) -> Frame | None:
        with self.cond:
            if not self.items and not self.cond.wait(timeout):
                return None
            if not self.items:
                return None
            newest = self.items.pop()
            self.dropped += len(self.items)
            self.items.clear()
            return newest


def next_backoff(current: float) -> float:
    return min(BACKOFF_MAX_S, current * 2)


def open_capture(source, opts: dict | None = None):
    """Default capture factory. source is a device index (int) or a URL/path (str)."""
    import cv2
    if isinstance(source, int):
        backend = cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY
        return cv2.VideoCapture(source, backend)
    params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000]
    return cv2.VideoCapture(source, cv2.CAP_FFMPEG, params)


class StreamWorker(threading.Thread):
    def __init__(self, camera_id: str, resolve_source, config: dict, on_event=None, is_file: bool = False, capture_factory=open_capture, extraction_on=lambda: True):
        super().__init__(name=f"lcm-ingest-{camera_id}", daemon=True)
        self.camera_id, self.resolve_source, self.config, self.is_file = camera_id, resolve_source, config, is_file
        self.capture_factory, self.extraction_on = capture_factory, extraction_on
        self.on_event = on_event or (lambda *a, **k: None)
        self.frames = LatestFrames(int(config.get("max_queue", 2)))
        self.stop_flag = threading.Event()
        self.reconnect_flag = threading.Event()
        self.state = "CONNECTING"
        self.detail = None
        self.attempts = 0
        self.reconnects = 0
        self.received = 0
        self.extracted = 0
        self.width = self.height = None
        self.source_fps = None
        self.connected_at = None
        self.last_frame_ts = None
        self.last_source_ts_ms = None
        self.next_retry_at = None
        self.errors: deque = deque(maxlen=30)
        self.preview: tuple | None = None        # (number, jpeg bytes, received_ts, source_ts_ms, width, height)
        self.preview_cond = threading.Condition()
        self.rate_received = RateMeter()

    # --- control ---
    def stop(self) -> None:
        self.stop_flag.set()
        self.reconnect_flag.set()

    def reconnect(self) -> None:
        self.reconnects += 1
        self.reconnect_flag.set()

    def _fail(self, message: str) -> None:
        self.detail = message
        self.errors.append({"at": time.time(), "message": message})
        self.on_event("error", message)

    def _wait_backoff(self, seconds: float) -> None:
        wait = seconds * random.uniform(0.85, 1.15)
        self.next_retry_at = time.time() + wait
        self.reconnect_flag.wait(wait)
        self.next_retry_at = None
        self.reconnect_flag.clear()

    # --- main loop ---
    def run(self) -> None:
        backoff = BACKOFF_START_S
        while not self.stop_flag.is_set():
            self.state = "CONNECTING"
            self.attempts += 1
            cap = None
            try:
                source = self.resolve_source()
                self.on_event("connecting", f"Connecting (attempt {self.attempts})")
                cap = self.capture_factory(source)
                if cap is None or not cap.isOpened():
                    raise ConnectionError("The source did not open.")
                served = self._read_loop(cap)
                if served:
                    backoff = BACKOFF_START_S
            except Exception as err:
                self._fail(f"{type(err).__name__}: {err}")
            finally:
                if cap is not None:
                    try:
                        cap.release()
                    except Exception:
                        pass
            if self.stop_flag.is_set():
                break
            self.state = "RECONNECTING"
            self.connected_at = None
            self.on_event("disconnected", f"Retrying in about {backoff:.0f}s")
            self._wait_backoff(backoff)
            backoff = next_backoff(backoff)
        self.state = "STOPPED"
        self.connected_at = None
        self.on_event("stopped", "Stream reader stopped")

    def _read_loop(self, cap) -> bool:
        import cv2
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        self.source_fps = round(fps, 2) if 0 < fps < 240 else None
        frame_period = 1.0 / self.source_fps if self.is_file and self.source_fps else 0.0
        served = False
        last_sample = last_preview = 0.0
        next_due = time.perf_counter()
        while not self.stop_flag.is_set() and not self.reconnect_flag.is_set():
            ok, image = cap.read()
            if not ok or image is None:
                if self.is_file and served:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)      # replay source: loop it
                    continue
                self._fail("The stream stopped delivering frames.")
                return served
            now = time.time()
            if not served:
                served = True
                self.state = "CONNECTED"
                self.detail = None
                self.connected_at = now
                self.on_event("connected", "Receiving frames")
            self.received += 1
            self.rate_received.mark(now)
            self.last_frame_ts = now
            pos = cap.get(cv2.CAP_PROP_POS_MSEC)
            self.last_source_ts_ms = pos if pos and pos > 0 else None
            image = self._fit(image, cv2)
            self.height, self.width = image.shape[:2]
            self.on_event("frame", None)

            cfg = self.config
            if now - last_preview >= 1.0 / float(cfg["preview_fps"]):
                last_preview = now
                self._publish_preview(image, now, cv2)
            if self.extraction_on() and now - last_sample >= 1.0 / float(cfg["processing_fps"]):
                last_sample = now
                self.extracted += 1
                self.frames.put(Frame(self.camera_id, self.received, image, self.last_source_ts_ms, now, self.width, self.height))
                self.on_event("extracted", None)
            if frame_period:
                next_due += frame_period
                delay = next_due - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
                else:
                    next_due = time.perf_counter()
        return served

    def _fit(self, image, cv2):
        limit = int(self.config.get("max_width") or 0)
        h, w = image.shape[:2]
        if limit and w > limit:
            image = cv2.resize(image, (limit, round(h * limit / w)), interpolation=cv2.INTER_AREA)
        return image

    def _publish_preview(self, image, now: float, cv2) -> None:
        ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, int(self.config["jpeg_quality"])])
        if not ok:
            return
        h, w = image.shape[:2]
        with self.preview_cond:
            self.preview = (self.received, jpeg.tobytes(), now, self.last_source_ts_ms, w, h)
            self.preview_cond.notify_all()

    def wait_preview(self, after: int, timeout: float) -> tuple | None:
        """Long poll for a frame newer than `after`, so the browser gets each frame once, with no MJPEG connection held open."""
        with self.preview_cond:
            self.preview_cond.wait_for(lambda: self.preview is not None and self.preview[0] > after, timeout)
            return self.preview if self.preview is not None and self.preview[0] > after else None


class RateMeter:
    """Events per second over the last few seconds."""
    def __init__(self, window: float = 5.0):
        self.window = window
        self.times: deque = deque()
        self.lock = threading.Lock()

    def mark(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self.lock:
            self.times.append(now)
            while self.times and now - self.times[0] > self.window:
                self.times.popleft()

    def rate(self, now: float | None = None) -> float:
        now = time.time() if now is None else now
        with self.lock:
            while self.times and now - self.times[0] > self.window:
                self.times.popleft()
            if len(self.times) < 2:
                return 0.0
            return round(len(self.times) / max(now - self.times[0], 0.2), 2)
