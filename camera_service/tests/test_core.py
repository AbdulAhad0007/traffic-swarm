"""Service logic with stand-ins for the camera and model. Real video and SUMO are in test_e2e_real.py."""
import time

import httpx
import numpy as np
import pytest

pytest.importorskip("cv2", reason="needs camera_service/requirements.txt")
pytest.importorskip("cryptography", reason="needs camera_service/requirements.txt")

from camera_service.agents import AgentNetwork, axis_demand
from camera_service.analytics import TrafficAnalyzer, validate_zones
from camera_service.events import EventHub, StageTracker, mask
from camera_service.infra import FrigateClient, Go2rtcClient, check_http_url
from camera_service.ingest import LatestFrames, Frame, StreamWorker, next_backoff, BACKOFF_MAX_S
from camera_service.service import LiveCameraService, clean_config
from camera_service import signals as sig
from camera_service.store import SqliteBackend
from camera_service.vault import Vault, VaultLocked

BOX = [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]
RIGHT = [[0.5, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0]]
ZONES = {"approaches": {"north": {"polygon": BOX}, "east": {"polygon": RIGHT}}}


def frame(n=1):
    return Frame("C", n, None, None, time.time(), 10, 10)


# ---- frame queue
def test_queue_is_bounded_and_counts_every_lost_frame():
    q = LatestFrames(2)
    for i in range(10):
        q.put(frame(i))
    assert len(q.items) == 2 and q.dropped == 8


def test_processing_gets_the_newest_frame_and_discards_stale_ones():
    q = LatestFrames(3)
    for i in range(3):
        q.put(frame(i))
    assert q.take_newest().number == 2
    assert q.dropped == 2 and not q.items


def test_backoff_doubles_and_is_capped():
    assert next_backoff(1) == 2 and next_backoff(BACKOFF_MAX_S) == BACKOFF_MAX_S


# ---- stream worker with a fake capture
class FakeCapture:
    def __init__(self, frames=3, opened=True, delay=0.0):
        self.left, self.opened, self.delay = frames, opened, delay
        self.released = False

    def isOpened(self):
        return self.opened

    def get(self, _):
        return 0.0

    def set(self, *_):
        return True

    def read(self):
        time.sleep(self.delay or 0.001)
        if self.left == 0:
            return False, None
        self.left -= 1
        return True, np.zeros((20, 40, 3), dtype=np.uint8)

    def release(self):
        self.released = True


CONFIG = clean_config({"processing_fps": 30, "preview_fps": 30})


def test_worker_reconnects_after_a_failure_and_stops_cleanly():
    attempts = []

    def factory(_source):
        attempts.append(1)
        return FakeCapture(opened=len(attempts) > 1, frames=5)

    w = StreamWorker("C", lambda: "x", CONFIG, capture_factory=factory)
    w.start()
    deadline = time.time() + 6
    while w.received < 5 and time.time() < deadline:
        time.sleep(0.02)
    w.stop()
    w.join(3)
    assert len(attempts) >= 2 and w.received >= 5
    assert w.state == "STOPPED" and not w.is_alive()
    assert any("did not open" in e["message"] for e in w.errors)


def test_worker_preview_comes_from_received_frames_only():
    w = StreamWorker("C", lambda: "x", CONFIG, capture_factory=lambda _s: FakeCapture(opened=False))
    w.start()
    time.sleep(0.2)
    assert w.wait_preview(-1, 0.05) is None, "a camera that never opened has no frame to show"
    w.stop()
    w.join(3)


# ---- analytics
def vehicle(tid, x, y, cls="car", size=40):
    return {"track_id": tid, "cls": cls, "conf": 0.9, "box": [x - size / 2, y - size, x + size / 2, y]}


def test_same_vehicle_across_frames_counts_once():
    a = TrafficAnalyzer(ZONES)
    for i in range(10):
        a.observe(i * 0.2, 1000, 1000, [vehicle(1, 100 + i * 20, 500)])
    assert a.snapshot(1.8)["unique_tracks"] == 1


def test_stopped_vehicle_is_a_queue_with_a_wait_time_but_a_moving_one_is_not():
    a = TrafficAnalyzer(ZONES)
    for i in range(30):
        t = i * 0.2
        a.observe(t, 1000, 1000, [vehicle(1, 100, 500), vehicle(2, 200 + i * 30 % 250, 300)])
    snap = a.snapshot(5.8)
    north = snap["approaches"]["north"]
    assert north["vehicles"] == 2 and north["queue_vehicles"] == 1 and snap["moving"] == 1 and snap["stopped"] == 1
    assert north["max_wait_s"] > 3


def test_without_calibration_no_physical_units_are_claimed():
    a = TrafficAnalyzer(ZONES)
    for i in range(10):
        a.observe(i * 0.2, 1000, 1000, [vehicle(1, 100 + i * 10, 500)])
    snap = a.snapshot(1.8)
    assert snap["quality"] == "uncalibrated" and snap["average_speed_mps"] is None and snap["queue_length_m"] is None
    assert snap["relative_speed_px_s"] > 0


def test_with_calibration_speed_is_a_labelled_estimate():
    zones = {**ZONES, "calibration": {"a": [0, 0], "b": [0.1, 0], "distance_m": 10}}   # 100 px = 10 m at 1000 px wide
    a = TrafficAnalyzer(zones)
    for i in range(10):
        a.observe(i * 0.2, 1000, 1000, [vehicle(1, 100 + i * 10, 500)])     # 50 px/s = 5 m/s
    snap = a.snapshot(1.8)
    assert snap["quality"] == "calibrated_estimate"
    assert snap["average_speed_mps"] == pytest.approx(5.0, abs=0.01)


def test_queue_length_uses_distance_to_the_stop_line():
    zones = {"approaches": {"north": {"polygon": BOX, "stop_line": [[0, 0.9], [0.5, 0.9]]}}, "calibration": {"a": [0, 0], "b": [0.1, 0], "distance_m": 10}}
    a = TrafficAnalyzer(zones)
    for i in range(10):
        a.observe(i * 0.2, 1000, 1000, [vehicle(1, 200, 400)])      # 500 px from the line
    assert a.snapshot(1.8)["queue_length_m"] == pytest.approx(50.0)


def test_arrivals_departures_and_turning_movements():
    zones = {**ZONES, "turning_zones": [{"name": "left exit", "polygon": RIGHT}]}
    a = TrafficAnalyzer(zones)
    for i in range(20):
        a.observe(i * 0.2, 1000, 1000, [vehicle(1, 100 + i * 50, 500)])    # north into east
    snap = a.snapshot(3.8)
    assert snap["approaches"]["north"]["arrivals_per_min"] == 1 and snap["approaches"]["north"]["departures_per_min"] == 1
    assert snap["turning"] == {"north -> left exit": 1}


def test_downstream_blockage_reduces_capacity_and_raises_spillback():
    zones = {**ZONES, "detection_zones": [{"name": "exit", "role": "downstream", "polygon": [[0.5, 0.4], [0.7, 0.4], [0.7, 0.6], [0.5, 0.6]]}]}
    a = TrafficAnalyzer(zones)
    a.observe(0, 1000, 1000, [vehicle(1, 600, 500, size=190)])
    snap = a.snapshot(0)
    assert snap["downstream_capacity"] < 0.2
    assert snap["approaches"]["north"]["spillback_risk"] == "HIGH"


@pytest.mark.parametrize("bad", [{"approaches": {"up": {"polygon": BOX}}}, {"approaches": {"north": {"polygon": BOX[:2]}}}, {"approaches": {"north": {"polygon": [[0, 0], [2, 0], [1, 1]]}}},
                                 {"calibration": {"a": [0, 0], "b": [1, 1], "distance_m": -1}}, "nope"])
def test_bad_zone_documents_are_refused(bad):
    with pytest.raises(ValueError):
        validate_zones(bad)


# ---- safety validator
def ctx(axis="NS", elapsed=20.0, **kw):
    return sig.PlanContext(axis, kw.pop("in_clearance", False), elapsed, kw.pop("yellow", 3.0), kw.pop("all_red", 1.0), **kw)


def test_plan_for_the_current_green_extends_it():
    v = sig.validate_plan("NS", 30, ctx(), 0.5)
    assert v.status == "APPROVED" and v.action == "extend" and v.approved_green_s == 30


def test_change_of_phase_runs_clearance():
    v = sig.validate_plan("EW", 30, ctx(), 0.5)
    assert v.action == "end_green" and v.approved_axis == "EW" and "yellow" in v.reasons[-1] and "all-red" in v.reasons[-1]


def test_minimum_green_blocks_an_early_change():
    v = sig.validate_plan("EW", 30, ctx(elapsed=4.0), 0.5)
    assert v.status == "REJECTED" and v.action == "hold"


def test_pedestrian_phase_has_a_longer_minimum():
    assert sig.validate_plan("EW", 30, ctx(elapsed=12.0, pedestrian_green=True), 0.5).status == "REJECTED"
    assert sig.validate_plan("EW", 30, ctx(elapsed=16.0, pedestrian_green=True), 0.5).status == "APPROVED"


@pytest.mark.parametrize("green,expected", [(2, 10.0), (500, 60.0)])
def test_durations_are_fitted_to_the_limits(green, expected):
    v = sig.validate_plan("NS", green, ctx(elapsed=5.0), 0.5)
    assert v.status == "ADJUSTED" and v.approved_green_s == expected


@pytest.mark.parametrize("args", [("XX", 30, ctx(), 0.5), ("NS", -1, ctx(), 0.5), ("NS", float("nan"), ctx(), 0.5), ("NS", True, ctx(), 0.5), ("NS", 30, ctx(), 60.0),
                                  ("NS", 30, ctx(in_clearance=True), 0.5), ("NS", 30, ctx(axis=None), 0.5), ("EW", 30, ctx(yellow=1.0), 0.5), ("EW", 30, ctx(all_red=0.0), 0.5)])
def test_unsafe_or_meaningless_plans_are_refused(args):
    assert sig.validate_plan(*args).status == "REJECTED"


def test_shadow_controller_tracks_a_virtual_signal_through_clearance():
    now = [0.0]
    s = sig.ShadowController(clock=lambda: now[0])
    s.context("J")
    now[0] = 20.0
    v = sig.validate_plan("EW", 20, s.context("J"), 0.1)
    assert s.apply("J", v)["applied"] is False
    assert s.context("J").in_clearance
    now[0] = 25.0
    assert s.describe("J")["axis"] == "EW" and not s.context("J").in_clearance


def test_real_controller_always_refuses():
    with pytest.raises(PermissionError):
        sig.RealControllerGate().send("anything")


# ---- agents
def approach(axis, vehicles, queue, wait=10.0):
    return {"axis": axis, "vehicles": vehicles, "queue_vehicles": queue, "mean_wait_s": wait, "arrivals_per_min": 6.0}


def network():
    hub, tracker = EventHub(), StageTracker()
    n = AgentNetwork(hub, tracker)
    n.set_topology([{"id": "J1"}, {"id": "J2"}])
    return n, hub


def state(j="J1", congestion="LOW", downstream=None):
    return {"camera_id": "C", "intersection_id": j, "congestion_level": congestion, "lane_occupancy": 0.4, "downstream_capacity": downstream}


def test_state_reaches_only_the_addressed_agent_and_makes_real_messages():
    n, hub = network()
    n.receive_state(state(), {"north": approach("NS", 5, 3)}, "TEST")
    snap = {a["id"]: a for a in n.snapshot()["agents"]}
    assert snap["J1"]["status"] == "RUNNING" and snap["J2"]["status"] == "IDLE"
    assert {"traffic_state", "heartbeat"} <= {e["data"]["type"] for e in hub.since()}


def test_no_state_means_no_proposal_and_no_message():
    n, hub = network()
    assert n.propose("J1", ctx()) is None
    assert hub.since() == []


def test_empty_junction_gets_no_proposal():
    n, _ = network()
    n.receive_state(state(), {"north": approach("NS", 0, 0)}, "TEST")
    assert n.propose("J1", ctx()) is None


def test_optimizer_serves_the_heavier_direction():
    n, _ = network()
    n.receive_state(state(), {"north": approach("NS", 22, 18, 40), "east": approach("EW", 2, 1, 3)}, "TEST")
    assert n.propose("J1", ctx())["axis"] == "NS"
    n2, _ = network()
    n2.receive_state(state(), {"north": approach("NS", 2, 1, 3), "east": approach("EW", 22, 18, 40)}, "TEST")
    assert n2.propose("J1", ctx(axis="EW"))["axis"] == "EW"


def test_congestion_escalates_and_central_cuts_green_into_a_full_road():
    n, hub = network()
    n.receive_state(state(congestion="SEVERE", downstream=0.2), {"north": approach("NS", 20, 15), "east": approach("EW", 6, 6)}, "TEST")
    assert "R1" in n.escalated
    p = n.propose("J1", ctx(elapsed=12.0))
    types = [e["data"].get("type") for e in hub.since()]
    assert "congestion_alert" in types and "central_decision" in types
    assert p["central_verdict"] == "cut_back" and p["green_s"] == 12.0


def test_silent_agent_is_reported_disconnected():
    n, hub = network()
    n.receive_state(state(), {"north": approach("NS", 5, 3)}, "TEST", now=100.0)
    n.watchdog(now=120.0)
    assert n.snapshot()["agents"][0]["status"] == "DISCONNECTED" or any(a["status"] == "DISCONNECTED" for a in n.snapshot()["agents"])
    assert any(e["data"].get("type") == "agent_disconnected" for e in hub.since())


def test_axis_demand_adds_both_approaches_of_an_axis():
    d = axis_demand({"north": approach("NS", 5, 3), "south": approach("NS", 2, 1), "east": approach("EW", 1, 0)})
    assert d["NS"]["vehicles"] == 7 and d["NS"]["queue"] == 4 and d["EW"]["vehicles"] == 1


# ---- credentials
@pytest.mark.parametrize("raw", ["rtsp://admin:hunter2@10.0.0.5:554/s", "connect rtsp://u:hunter2@h failed", "password=hunter2", "token: hunter2", "Authorization: hunter2"])
def test_mask_removes_secrets(raw):
    assert "hunter2" not in mask(raw)


def test_vault_encrypts_at_rest_and_refuses_without_a_key(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.delenv("TSI_CAMERA_SECRET_KEY", raising=False)
    locked = Vault(tmp_path / "a.enc", key="")
    with pytest.raises(VaultLocked):
        locked.set("x", "hunter2")
    v = Vault(tmp_path / "b.enc", key=Fernet.generate_key().decode())
    v.set("frigate.token", "hunter2")
    assert v.get("frigate.token") == "hunter2"
    assert b"hunter2" not in (tmp_path / "b.enc").read_bytes()


def test_environment_variable_wins_over_the_vault(tmp_path, monkeypatch):
    monkeypatch.setenv("TSI_CAMERA_FRIGATE_TOKEN", "from-env")
    assert Vault(tmp_path / "c.enc", key="").get("frigate.token") == "from-env"


def test_urls_with_embedded_credentials_are_refused():
    with pytest.raises(ValueError):
        check_http_url("http://user:pw@frigate:5000")
    with pytest.raises(ValueError):
        check_http_url("file:///etc/passwd")


# ---- Frigate and go2rtc clients against recorded API shapes. Not a substitute for a real server.
def frigate_transport(auth=None, version="0.16.0"):
    def handler(request: httpx.Request) -> httpx.Response:
        if auth and request.headers.get("authorization") != f"Bearer {auth}" and "frigate_token" not in request.headers.get("cookie", ""):
            if request.url.path == "/api/login":
                return httpx.Response(200, headers={"set-cookie": "frigate_token=abc; Path=/"}, json={})
            return httpx.Response(401, json={})
        if request.url.path == "/api/version":
            return httpx.Response(200, text=version)
        if request.url.path == "/api/config":
            return httpx.Response(200, json={"cameras": {"gate": {"enabled": True, "record": {"enabled": True}, "detect": {"enabled": False},
                                                                  "ffmpeg": {"inputs": [{"path": "rtsp://admin:hunter2@10.0.0.5/s", "roles": ["record"]}]}}},
                                             "go2rtc": {"streams": {"gate": ["rtsp://admin:hunter2@10.0.0.5/s"]}}})
        if request.url.path == "/api/stats":
            return httpx.Response(200, json={"cameras": {"gate": {"camera_fps": 12.0, "process_fps": 5.0, "detection_fps": 0.0, "skipped_fps": 0.0}}})
        if request.url.path == "/api/events":
            return httpx.Response(200, json=[{"id": "1", "camera": "gate", "label": "car", "start_time": 1.0, "end_time": 2.0, "has_clip": True}])
        return httpx.Response(404)
    return httpx.MockTransport(handler)


def test_frigate_status_reads_cameras_and_keeps_credentials_out():
    out = FrigateClient("http://f:5000", transport=frigate_transport()).status()
    assert out["state"] == "CONNECTED" and out["version"] == "0.16.0"
    gate = out["cameras"]["gate"]
    assert gate["recording"] is True and gate["connected"] is True and out["events"][0]["label"] == "car"
    assert "hunter2" not in str(out)


def test_frigate_needing_a_login_is_reported_then_works_with_one():
    assert FrigateClient("http://f:8971", transport=frigate_transport(auth="good")).status()["state"] == "AUTH_REQUIRED"
    assert FrigateClient("http://f:8971", token="good", transport=frigate_transport(auth="good")).status()["state"] == "CONNECTED"
    assert FrigateClient("http://f:8971", username="u", password="p", transport=frigate_transport(auth="good")).status()["state"] == "CONNECTED"


def test_unreachable_services_say_so():
    def down(_):
        raise httpx.ConnectError("no")
    assert FrigateClient("http://f", transport=httpx.MockTransport(down)).status()["state"] == "DISCONNECTED"
    assert Go2rtcClient("http://g", transport=httpx.MockTransport(down)).status()["state"] == "DISCONNECTED"


def test_go2rtc_masks_sources_and_notices_file_streams():
    def handler(request):
        if request.url.path == "/api":
            return httpx.Response(200, json={"version": "1.9.15"})
        return httpx.Response(200, json={"cam": {"producers": [{"url": "rtsp://u:hunter2@cam/1"}], "consumers": [{}]}, "demo": {"producers": [{"url": "ffmpeg:C:/v/road.mp4#video=h264"}]}, "busy": {"producers": [{"source": "exec:ffmpeg -i road.mp4 -f rtsp {output}", "remote_addr": "127.0.0.1:1"}]}})
    out = Go2rtcClient("http://g:1984", transport=httpx.MockTransport(handler)).status()
    assert out["version"] == "1.9.15" and "hunter2" not in str(out)
    assert out["streams"]["cam"]["state"] == "ACTIVE" and out["streams"]["demo"]["looks_like_file"] is True and out["streams"]["busy"]["looks_like_file"] is True


def test_restream_endpoint_is_separate_from_the_source():
    assert Go2rtcClient("http://host:1984").restream_url("gate 1") == "rtsp://host:8554/gate%201"


# ---- the service as a whole, with stand-ins
class NoDetector:
    def track(self, *_):
        raise RuntimeError("no model in this test")

    def info(self):
        return {}


class FixedDetector:
    def __init__(self):
        self.i = 0

    def track(self, *_):
        self.i += 1
        return [{"track_id": 1, "cls": "car", "conf": 0.9, "box": [5, 5, 15, 15]}], 5.0

    def info(self):
        return {}


def make_service(tmp_path, detector=FixedDetector, capture=None, sumo=None):
    s = LiveCameraService(runtime_dir=tmp_path, detector_factory=detector, capture_factory=capture or (lambda _s: FakeCapture(frames=10**6, delay=0.01)),
                          sumo_factory=sumo or sig.SumoBridge, backend=SqliteBackend(tmp_path / "t.sqlite3"))
    s.start()
    return s


def add(s, cid="C1", j="J1", **kw):
    return s.add_camera({"id": cid, "source_type": "webcam", "source": 0, "intersection_id": j, **kw})


def wait_until(predicate, timeout=6.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_one_failing_camera_never_stops_another(tmp_path):
    def capture(source):
        return FakeCapture(frames=10**6, delay=0.01) if source == 0 else FakeCapture(opened=False)
    s = make_service(tmp_path, capture=capture)
    try:
        add(s, "GOOD", source=0)
        add(s, "BAD", j="J2", source=1)
        assert wait_until(lambda: s.camera_view("GOOD")["status"] == "CONNECTED")
        before = s.runtimes["GOOD"].worker.received
        time.sleep(0.5)
        assert s.runtimes["GOOD"].worker.received > before
        assert s.camera_view("BAD")["status"] != "CONNECTED" and s.camera_view("BAD")["vehicle_count"] is None
        assert s.overview()["status"] == {**s.overview()["status"], "total": 2, "connected": 1, "offline": 1}
    finally:
        s.shutdown()


def test_video_continues_when_the_detector_fails(tmp_path):
    s = make_service(tmp_path, detector=NoDetector)
    try:
        add(s)
        assert wait_until(lambda: s.camera_view("C1")["detection_status"] == "UNAVAILABLE")
        rt = s.runtimes["C1"]
        before = rt.worker.received
        time.sleep(0.3)
        assert rt.worker.received > before and rt.latest is None
    finally:
        s.shutdown()


def test_module_off_stops_workers_and_keeps_configuration(tmp_path):
    s = make_service(tmp_path)
    try:
        add(s)
        assert "C1" in s.runtimes
        s.flags["module"] = False
        s.reconcile()
        assert "C1" not in s.runtimes and "C1" in s.rows
        assert s.backend.select("lcm_cameras")[0]["id"] == "C1"
        s.flags["module"] = True
        s.reconcile()
        assert "C1" in s.runtimes
    finally:
        s.shutdown()


def test_flags_stop_each_processing_stage(tmp_path):
    s = make_service(tmp_path)
    try:
        add(s, config={"processing_fps": 30})
        rt = s.runtimes["C1"]
        assert wait_until(lambda: rt.processed > 2)
        s.flags["yolo-processing"] = False
        time.sleep(0.2)
        before = rt.processed
        time.sleep(0.3)
        assert rt.processed == before
        s.flags["yolo-processing"] = True
        s.flags["frame-extraction"] = False
        time.sleep(0.2)
        extracted = rt.worker.extracted
        time.sleep(0.3)
        assert rt.worker.extracted == extracted, "extraction stopped"
        assert rt.worker.received > 0
    finally:
        s.shutdown()


def test_test_mode_off_blocks_and_stops_test_sources(tmp_path):
    s = make_service(tmp_path)
    try:
        add(s)
        s.flags["test-mode"] = False
        s.reconcile()
        assert "C1" not in s.runtimes
        with pytest.raises(Exception, match="Test sources"):
            add(s, "C2", j="J2")
    finally:
        s.shutdown()


def test_webcam_is_always_test_and_upload_always_replay(tmp_path):
    s = make_service(tmp_path)
    try:
        assert add(s, data_class="LIVE")["data_class"] == "TEST"
        (tmp_path / "media" / "road.mp4").write_bytes(b"x")
        assert s.add_camera({"id": "F", "source_type": "file", "source": "road.mp4", "intersection_id": "J2", "data_class": "LIVE", "enabled": False})["data_class"] == "REPLAY"
        with pytest.raises(ValueError):
            s.update_camera("F", {"data_class": "LIVE"})
        with pytest.raises(ValueError):
            s.add_camera({"id": "T", "source_type": "file", "source": "../../secret.mp4", "intersection_id": "J3"})
    finally:
        s.shutdown()


def test_public_view_has_no_connection_details_and_credentials_never_reach_the_database(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.setenv("TSI_CAMERA_SECRET_KEY", Fernet.generate_key().decode())
    s = make_service(tmp_path, capture=lambda _s: FakeCapture(opened=False))
    try:
        s.add_camera({"id": "R", "source_type": "rtsp", "source": "rtsp://admin:hunter2@10.0.0.5:554/s", "intersection_id": "J1", "enabled": False})
        public, admin = s.camera_view("R"), s.camera_view("R", admin=True)
        assert "connection" not in public and "10.0.0.5" not in str(public)
        assert "hunter2" not in str(admin) and admin["connection"].startswith("rtsp://***@")
        assert "hunter2" not in str(s.backend.select("lcm_cameras")) and "hunter2" not in str(s.backend.select("lcm_settings"))
        assert s.resolve_source(s.rows["R"]) == "rtsp://admin:hunter2@10.0.0.5:554/s"
    finally:
        s.shutdown()


def test_rtsp_url_with_password_is_refused_when_it_cannot_be_encrypted(tmp_path, monkeypatch):
    monkeypatch.delenv("TSI_CAMERA_SECRET_KEY", raising=False)
    s = make_service(tmp_path)
    try:
        with pytest.raises(VaultLocked):
            s.add_camera({"id": "R", "source_type": "rtsp", "source": "rtsp://a:b@h/s", "intersection_id": "J1"})
    finally:
        s.shutdown()


def test_replay_label_follows_a_go2rtc_stream_read_from_a_file(tmp_path):
    s = make_service(tmp_path)
    try:
        s.add_camera({"id": "G", "source_type": "go2rtc", "source": "demo", "intersection_id": "J1", "data_class": "LIVE", "enabled": False})
        s.infra["go2rtc"]["streams"] = {"demo": {"name": "demo", "state": "READY", "producers": 1, "consumers": 0, "sources": [], "looks_like_file": True, "bytes_received": 0}}
        s._apply_stream_labels()
        assert s.rows["G"]["data_class"] == "REPLAY"
    finally:
        s.shutdown()


def test_cameras_survive_a_restart(tmp_path):
    s = make_service(tmp_path)
    add(s, zones=ZONES, config={"processing_fps": 2})
    s.shutdown()
    again = make_service(tmp_path)
    try:
        row = again.rows["C1"]
        assert row["config"]["processing_fps"] == 2 and "north" in row["zones"]["approaches"]
    finally:
        again.shutdown()


def test_signal_flag_off_means_no_proposals_and_agent_flag_off_means_no_state(tmp_path):
    s = make_service(tmp_path)
    try:
        add(s, zones=ZONES)
        s.flags["agent-integration"] = False
        time.sleep(1.5)
        assert s.network.snapshot()["agents"][0]["state"] is None
        s.flags["agent-integration"] = True
        s.flags["signal-optimization"] = False
        assert wait_until(lambda: s.network.snapshot()["agents"][0]["state"] is not None)
        time.sleep(0.5)
        assert s.network.snapshot()["counts"]["proposals"] == 0
    finally:
        s.shutdown()


def test_real_controller_request_is_refused_and_mode_is_unchanged(tmp_path):
    s = make_service(tmp_path)
    try:
        with pytest.raises(PermissionError):
            s.set_mode(sig.MODE_REAL)
        assert s.signal_mode == sig.MODE_SHADOW
    finally:
        s.shutdown()
