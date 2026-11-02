"""Event log and pipeline stage status. A stage only moves when real work reports to it."""
from __future__ import annotations
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone

CREDENTIAL = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@")
SECRET_PARAM = re.compile(r"(?i)\b(password|passwd|pwd|token|apikey|api_key|authorization|bearer)([=:\s]+)[^\s&,;\"']+")


def mask(text) -> str:
    """Remove credentials from anything that may reach a log, an API response or the browser."""
    return SECRET_PARAM.sub(r"\1\2***", CREDENTIAL.sub(r"\1***@", str(text)))


def iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, timezone.utc).isoformat(timespec="milliseconds")


class EventHub:
    """Bounded ring of events with a sequence number; readers poll or wait for what they have not seen."""

    def __init__(self, capacity: int = 3000):
        self.events: deque = deque(maxlen=capacity)
        self.seq = 0
        self.cond = threading.Condition()

    def publish(self, kind: str, message: str = "", *, level: str = "info", stage: str | None = None, to_stage: str | None = None,
                camera_id: str | None = None, data_class: str | None = None, data: dict | None = None) -> dict:
        with self.cond:
            self.seq += 1
            event = {"seq": self.seq, "ts": iso(), "kind": kind, "level": level, "message": mask(message), "stage": stage,
                     "to_stage": to_stage, "camera_id": camera_id, "data_class": data_class, "data": data or {}}
            self.events.append(event)
            self.cond.notify_all()
        return event

    def since(self, after: int = 0, limit: int = 500, kinds: set | None = None) -> list[dict]:
        with self.cond:
            items = [e for e in self.events if e["seq"] > after and (not kinds or e["kind"] in kinds)]
        return items[-limit:]

    def wait(self, after: int, timeout: float) -> bool:
        with self.cond:
            return self.cond.wait_for(lambda: self.seq > after, timeout)


# Order is the order on the page.
STAGES = [
    ("camera", "CCTV Camera"), ("frigate", "Frigate NVR"), ("go2rtc", "go2rtc"), ("restream", "RTSP Restream"),
    ("decode", "FFmpeg / OpenCV"), ("extract", "Frame Extraction"), ("yolo", "YOLO Detection"), ("tracking", "Vehicle Tracking"),
    ("analytics", "Traffic Analytics"), ("agent", "Intersection Agent"), ("coordination", "Multi-Agent Coordination"),
    ("safety", "Safety Validator"), ("signal", "Signal Optimization"),
]
ACTIVE_WINDOW_S = 6.0
ERROR_WINDOW_S = 20.0
STATUSES = ("RUNNING", "IDLE", "CONNECTING", "DEGRADED", "DISCONNECTED", "ERROR")


class StageTracker:
    def __init__(self):
        self.lock = threading.Lock()
        self.stages = {key: self._blank(name) for key, name in STAGES}

    @staticmethod
    def _blank(name: str) -> dict:
        return {"name": name, "count": 0, "errors": 0, "last_activity": None, "last_error_at": None, "last_error": None,
                "latency_ms": None, "condition": None, "note": None, "logs": deque(maxlen=30)}

    def work(self, stage: str, latency_ms: float | None = None, count: int = 1) -> None:
        with self.lock:
            s = self.stages[stage]
            s["count"] += count
            s["last_activity"] = time.time()
            if latency_ms is not None:
                s["latency_ms"] = latency_ms if s["latency_ms"] is None else 0.8 * s["latency_ms"] + 0.2 * latency_ms

    def touch(self, stage: str) -> None:
        """The stage answered a health check. It is alive, but no item passed through it."""
        with self.lock:
            self.stages[stage]["last_activity"] = time.time()

    def error(self, stage: str, message: str) -> None:
        with self.lock:
            s = self.stages[stage]
            s["errors"] += 1
            s["last_error_at"] = time.time()
            s["last_error"] = mask(message)
            s["logs"].append({"ts": iso(), "level": "error", "message": mask(message)})

    def log(self, stage: str, message: str) -> None:
        with self.lock:
            self.stages[stage]["logs"].append({"ts": iso(), "level": "info", "message": mask(message)})

    def condition(self, stage: str, condition: str | None, note: str | None = None) -> None:
        """A monitored fact about a stage: CONNECTING, DISCONNECTED, DEGRADED or ERROR, or None when there is none."""
        with self.lock:
            self.stages[stage]["condition"], self.stages[stage]["note"] = condition, note

    @staticmethod
    def status_of(s: dict, now: float) -> str:
        active = s["last_activity"] is not None and now - s["last_activity"] <= ACTIVE_WINDOW_S
        recent_error = s["last_error_at"] is not None and now - s["last_error_at"] <= ERROR_WINDOW_S
        if s["condition"]:
            return "DEGRADED" if active and s["condition"] != "CONNECTING" else s["condition"]
        if active:
            return "DEGRADED" if recent_error else "RUNNING"
        return "ERROR" if recent_error else "IDLE"

    def snapshot(self) -> list[dict]:
        now = time.time()
        with self.lock:
            return [{"key": key, "name": s["name"], "status": self.status_of(s, now), "count": s["count"], "errors": s["errors"],
                     "last_activity": iso(s["last_activity"]) if s["last_activity"] else None,
                     "latency_ms": None if s["latency_ms"] is None else round(s["latency_ms"], 1),
                     "last_error": s["last_error"], "note": s["note"], "logs": list(s["logs"])[-15:]}
                    for key, s in self.stages.items()]
