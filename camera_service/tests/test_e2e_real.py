"""The real pipeline: a video through a real go2rtc binary over RTSP, OpenCV, YOLO, ByteTrack, the agents and SUMO.

Skipped unless these are set, since it needs downloads and takes a few minutes:
  TSI_LCM_E2E_GO2RTC   path to the go2rtc binary
  TSI_LCM_E2E_FFMPEG   path to an ffmpeg binary (imageio_ffmpeg.get_ffmpeg_exe() gives one)
  TSI_LCM_E2E_VIDEO    H.264 video of road traffic; 960 px wide is plenty
It proves the software path, not a roadside camera: the source is a file, so the stream is correctly labelled REPLAY.
"""
import json
import os
import socket
import subprocess
import time
from pathlib import Path

import pytest

from camera_service import signals as sig
from camera_service.service import LiveCameraService
from camera_service.store import SqliteBackend

GO2RTC, FFMPEG, VIDEO = (os.environ.get(f"TSI_LCM_E2E_{n}") for n in ("GO2RTC", "FFMPEG", "VIDEO"))
pytestmark = pytest.mark.skipif(not (GO2RTC and FFMPEG and VIDEO), reason="needs TSI_LCM_E2E_GO2RTC, _FFMPEG and _VIDEO")
ZONES = {"approaches": {"north": {"polygon": [[0.0, 1.0], [0.33, 0.2], [0.46, 0.2], [0.46, 1.0]], "stop_line": [[0.0, 0.98], [0.46, 0.98]]},
                        "east": {"polygon": [[0.46, 0.2], [0.52, 0.2], [1.0, 0.8], [1.0, 1.0], [0.5, 1.0]]}},
         "calibration": {"a": [0.25, 0.95], "b": [0.29, 0.75], "distance_m": 12.0}}
API, RTSP = 19841, 18554


def wait_until(predicate, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return
        time.sleep(0.2)
    pytest.fail(f"Timed out waiting for {what() if callable(what) else what}")


def start_go2rtc(folder: Path) -> subprocess.Popen:
    config = folder / "go2rtc.yaml"
    source = f"exec:{FFMPEG} -hide_banner -re -stream_loop -1 -i {VIDEO} -c copy -an -rtsp_transport tcp -f rtsp {{output}}"
    config.write_text(json.dumps({"api": {"listen": f"127.0.0.1:{API}"}, "rtsp": {"listen": f"127.0.0.1:{RTSP}"}, "webrtc": {"listen": ""}, "log": {"level": "warn"}, "streams": {"road": source}}))
    process = subprocess.Popen([GO2RTC, "-config", str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd=folder)

    def listening():
        with socket.socket() as s:
            return s.connect_ex(("127.0.0.1", API)) == 0
    wait_until(listening, 15, "go2rtc to listen")
    return process


def test_real_video_runs_the_whole_pipeline(tmp_path):
    evidence = {}
    go2rtc = start_go2rtc(tmp_path)
    service = LiveCameraService(runtime_dir=tmp_path, backend=SqliteBackend(tmp_path / "e2e.sqlite3"))
    hardware_calls = []
    service.real_gate.send = lambda *a, **k: hardware_calls.append(a)
    service.start()
    try:
        # Test 3: go2rtc is reachable and lists the stream.
        view = service.configure_infra("go2rtc", {"url": f"http://127.0.0.1:{API}", "rtsp_url": f"rtsp://127.0.0.1:{RTSP}"})
        assert view["state"] == "CONNECTED" and "road" in view["streams"]
        evidence["go2rtc_version"] = view["version"]

        # Tests 4-6: Python receives the restream and extracts identified, timestamped frames.
        service.add_camera({"id": "ROAD", "camera_name": "Road", "source_type": "go2rtc", "source": "road", "intersection_id": "J1", "zones": ZONES})
        service.add_camera({"id": "DEAD", "camera_name": "Dead", "source_type": "go2rtc", "source": "no_such_stream", "intersection_id": "J2"})
        rt = service.runtimes["ROAD"]
        wait_until(lambda: rt.worker.state == "CONNECTED", 40, "the restream")
        wait_until(lambda: rt.processed >= 30, 90, lambda: f"30 processed frames: {service.camera_view('ROAD', admin=True)} detector_error={rt.detector_error} log={list(rt.frame_log)[-3:]}")
        cam = service.camera_view("ROAD", admin=True)
        assert cam["width"] == 960 and cam["fps"] > 5 and cam["frames"]["received"] > cam["frames"]["extracted"] >= cam["frames"]["processed"] > 0
        log = list(rt.frame_log)
        assert [f["frame_number"] for f in log] == sorted(f["frame_number"] for f in log)
        assert all(f["received"] and f["status"] == "processed" for f in log)
        wait_until(lambda: service.infra["go2rtc"]["streams"]["road"]["consumers"] >= 1, 12, "go2rtc to list the reader")
        evidence["frames"] = cam["frames"] | {"fps": cam["fps"], "processing_fps": cam["processing_fps"], "inference_ms": cam["inference_ms"], "latency_ms": cam["latency_ms"]}

        # A stream read from a file must never pass as live.
        wait_until(lambda: service.rows["ROAD"]["data_class"] == "REPLAY", 15, "the REPLAY label")

        # Tests 7-8: real detections, with tracks that survive across frames.
        seen: dict = {}
        end = time.time() + 45
        best = 0
        while time.time() < end and best < 5:
            latest = rt.latest
            if latest:
                for obj in latest["objects"]:
                    if obj["track_id"] is not None:
                        seen.setdefault(obj["track_id"], set()).add(latest["frame_number"])
                best = max((len(v) for v in seen.values()), default=0)
            time.sleep(0.1)
        assert best >= 5, f"no vehicle was tracked across 5 processed frames: {seen}"
        evidence["longest_track_frames"] = best
        evidence["classes"] = sorted({o["cls"] for o in (rt.latest or {}).get("objects", [])})
        assert rt.analyzer.unique_total < rt.processed, "vehicles are counted once, not once per frame"

        # Test 9: metrics from tracks.
        wait_until(lambda: rt.analytics and rt.analytics["vehicle_count"] > 0, 45, "traffic metrics")
        snap = rt.analytics
        assert snap["quality"] == "calibrated_estimate" and {"north", "east"} == set(snap["approaches"])
        evidence["analytics"] = {k: snap[k] for k in ("vehicle_count", "by_class", "unique_tracks", "moving", "stopped", "average_speed_mps", "lane_occupancy", "congestion_level")}

        # Tests 10-12 and 14: state reaches the right agent; shadow mode proposes and validates, and touches nothing.
        agents = {a["id"]: a for a in service.network.snapshot()["agents"]}
        wait_until(lambda: {a["id"]: a for a in service.network.snapshot()["agents"]}["J1"]["state"], 20, "state at J1")
        assert agents["J2"]["state"] is None
        assert service.signal_mode == sig.MODE_SHADOW and service.bridge is None
        wait_until(lambda: any(d["mode"] == "SHADOW" for d in service.decisions), 90, "a shadow decision")
        shadow = next(d for d in service.decisions if d["mode"] == "SHADOW")
        assert shadow["validation_status"] in ("APPROVED", "ADJUSTED", "REJECTED") and shadow["details"]["outcome"]["applied"] is False
        assert hardware_calls == [] and service.bridge is None
        evidence["shadow_decision"] = {k: shadow[k] for k in ("proposed_phase", "approved_phase", "validation_status", "decision_reason")}

        # Test 13: simulation mode applies approved plans through TraCI, and SUMO's own state confirms them.
        service.set_mode(sig.MODE_SIMULATION, background=False)
        assert service.bridge and service.bridge.running, service.bridge_error
        def applied():
            return next((d for d in service.decisions if d["mode"] == "SIMULATION" and d["details"]["outcome"].get("applied")), None)
        wait_until(applied, 150, "a plan applied in SUMO")
        decision = applied()
        outcome = decision["details"]["outcome"]
        assert outcome["state_after"]["source"] == "sumo" and outcome["reason"] == "phase_duration_updated"
        tls = outcome["tls"]
        assert tls in service.bridge.phase_maps
        evidence["sumo_decision"] = {"tls": tls, "approved": decision["approved_phase"], "state_before": outcome["state_before"], "remaining_s": outcome["remaining_s"], "state_after": outcome["state_after"]["state"]}

        # Plans ended and extended greens for a while: the independent auditor saw no clearance or green-length violation.
        target = service.bridge.now + 90
        wait_until(lambda: service.bridge.now >= target, 90, "90 more simulated seconds")
        audit = service.bridge.status()["safety_audit"]
        evidence["sumo_audit"] = audit
        assert audit["total"] == 0, audit

        # Test 15: the dead camera never connected and the other kept running.
        dead = service.camera_view("DEAD", admin=True)
        assert dead["status"] != "CONNECTED" and dead["vehicle_count"] is None and dead["errors"]
        assert service.runtimes["DEAD"].latest is None
        before = rt.worker.received
        time.sleep(1.5)
        assert rt.worker.received > before
        evidence["independent_cameras"] = {"dead_status": dead["status"], "dead_attempts": dead["attempts"]}

        # Interruption and recovery: go2rtc goes away, the reader backs off and reconnects by itself.
        go2rtc.kill()
        go2rtc.wait()
        wait_until(lambda: rt.worker.state != "CONNECTED", 30, "the reader to notice")
        assert service.camera_view("ROAD")["vehicle_count"] is None, "no detections are shown for a stream that is down"
        wait_until(lambda: service.infra["go2rtc"]["state"] == "DISCONNECTED", 12, "the monitor to report go2rtc down")
        go2rtc = start_go2rtc(tmp_path)
        wait_until(lambda: rt.worker.state == "CONNECTED", 90, "automatic reconnection")
        evidence["reconnected_after_attempts"] = rt.worker.attempts

        # Persisted: metadata and decisions, no image data.
        time.sleep(1.5)
        assert service.backend.select("lcm_frame_metadata", limit=1) and service.backend.select("lcm_vehicle_detections", limit=1)
        assert service.backend.select("lcm_traffic_analytics", limit=1) and service.backend.select("lcm_signal_decisions", limit=1)
        assert not list(tmp_path.glob("snapshots/**/*.jpg")), "no frames are saved unless retention asks for it"
        print("\nEVIDENCE " + json.dumps(evidence, default=str))
    finally:
        service.shutdown()
        go2rtc.kill()
