"""Vehicle detection and tracking with Ultralytics YOLO and its ByteTrack.

Optional at runtime: if the package or weights are missing, this reports why and the video keeps flowing.
Ultralytics is AGPL-3.0; see THIRD_PARTY_NOTICES.md. Each camera has its own model object because tracker state lives
in it. One semaphore limits concurrent inference, so extra cameras cost frames rather than overloading the machine.
"""
from __future__ import annotations
import logging
import os
import threading
import time

from camera_service.settings import RUNTIME

log = logging.getLogger("camera.detect")
COCO_VEHICLES = {1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
_inference = threading.Semaphore(int(os.environ.get("TSI_CAMERA_MAX_INFERENCE", "1")))


class DetectorUnavailable(RuntimeError):
    pass


def compute_device() -> str:
    """GPU when one is usable; CPU otherwise. A GPU is never required."""
    override = os.environ.get("TSI_CAMERA_DEVICE")
    if override:
        return override
    try:
        import torch
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except ImportError:
        return "cpu"


class YoloDetector:
    def __init__(self, weights: str | None = None, device: str | None = None, imgsz: int = 640):
        self.weights = weights or os.environ.get("TSI_CAMERA_YOLO_WEIGHTS") or str(RUNTIME / "models" / "yolo11n.pt")
        self.device = device or compute_device()
        self.imgsz = imgsz
        self.model = None
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            if self.model is None:
                try:
                    from ultralytics import YOLO
                except ImportError as err:
                    raise DetectorUnavailable("The ultralytics package is not installed: pip install -r camera_service/requirements.txt") from err
                os.makedirs(os.path.dirname(self.weights) or ".", exist_ok=True)
                try:
                    self.model = YOLO(self.weights)
                except Exception as err:
                    raise DetectorUnavailable(f"Could not load the model {os.path.basename(self.weights)}: {type(err).__name__}") from err
        return self.model

    def info(self) -> dict:
        return {"model": os.path.basename(self.weights), "device": self.device, "loaded": self.model is not None, "tracker": "ByteTrack"}

    def track(self, image, confidence: float = 0.3) -> tuple[list[dict], float]:
        """Returns (objects, inference milliseconds). track_id is None until ByteTrack confirms a track."""
        model = self.load()
        with _inference:
            started = time.perf_counter()
            results = model.track(image, persist=True, tracker="bytetrack.yaml", conf=confidence, classes=list(COCO_VEHICLES), imgsz=self.imgsz, device=self.device, verbose=False)
            elapsed = (time.perf_counter() - started) * 1000
        objects = []
        boxes = results[0].boxes
        if boxes is not None and len(boxes):
            ids = boxes.id.int().tolist() if boxes.id is not None else [None] * len(boxes)
            for tid, cls, conf, box in zip(ids, boxes.cls.int().tolist(), boxes.conf.tolist(), boxes.xyxy.tolist()):
                objects.append({"track_id": tid, "cls": COCO_VEHICLES.get(cls, str(cls)), "conf": round(conf, 3), "box": [round(v, 1) for v in box]})
        return objects, elapsed
