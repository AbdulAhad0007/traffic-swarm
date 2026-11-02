"""Paths and defaults. Secrets never live here: see vault.py."""
from __future__ import annotations
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = Path(os.environ.get("TSI_CAMERA_RUNTIME", Path(__file__).resolve().parent / "runtime")).resolve()

# Initial prototype values, overridable per camera.
DEFAULT_CONFIG = {
    "processing_fps": 5.0,        # frames per second sent to detection
    "preview_fps": 10.0,          # frames per second encoded for the browser
    "max_queue": 2,               # bounded: the oldest frame is dropped when processing falls behind
    "max_width": 960,             # frames are downscaled to this width; 0 keeps the source size
    "jpeg_quality": 70,
    "detection_enabled": True,
    "confidence": 0.3,
    "state_interval_s": 1.0,      # how often traffic state is computed and sent to the agent
    "retention": {"snapshot_every_s": 0, "snapshot_max_age_s": 3600, "metadata_days": 7},
}
CONFIG_LIMITS = {
    "processing_fps": (0.2, 30.0), "preview_fps": (1.0, 30.0), "max_queue": (1, 16), "max_width": (0, 3840),
    "jpeg_quality": (20, 95), "confidence": (0.05, 0.95), "state_interval_s": (0.5, 10.0),
}

SOURCE_TYPES = ("go2rtc", "rtsp", "webcam", "usb", "file")
# LIVE is only ever an administrator's explicit statement about a real roadside camera.
DATA_CLASSES = ("LIVE", "TEST", "REPLAY")

# Safety limits for signal plans; same values as the simulation's controller presets.
SIGNAL_LIMITS = {
    "min_green_s": 10.0, "max_green_s": 60.0, "min_yellow_s": 3.0, "min_all_red_s": 1.0,
    "pedestrian_min_green_s": 15.0, "max_state_age_s": 5.0,
}
DECISION_INTERVAL_S = 5.0
AGENT_TIMEOUT_S = 10.0
