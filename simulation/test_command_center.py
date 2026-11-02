"""Road levels, spillback, regions, the supervisor's rule and the event journal. No SUMO needed."""
import json
from types import SimpleNamespace
from simulation.coordination.hierarchy import partition_regions, review_extension
from simulation.live.event_journal import JournalHook, read_events
from simulation.live.road_state import SpillbackTracker, classify_road, estimated_capacity


def test_capacity_is_lane_metres_over_spacing():
    assert estimated_capacity(150, 2, 7.5) == 40
    assert estimated_capacity(1, 1, 7.5) == 1


def test_a_short_queue_at_red_is_not_congestion():
    assert classify_road(count=8, occupancy=0.6, speed=0.0, used=0.4, at_red=True, growth=0, downstream_used=0.0) == "busy"


def test_the_same_queue_growing_at_red_is_congestion():
    assert classify_road(count=8, occupancy=0.6, speed=0.0, used=0.4, at_red=True, growth=3, downstream_used=0.0) == "severe"


def test_a_full_stopped_road_on_green_is_blocked():
    assert classify_road(count=20, occupancy=0.9, speed=0.2, used=0.95, at_red=False, growth=0, downstream_used=0.2) == "blocked"


def test_a_full_road_at_red_is_blocked_only_if_the_road_ahead_is_full():
    assert classify_road(count=20, occupancy=0.9, speed=0.2, used=0.95, at_red=True, growth=0, downstream_used=0.2) == "severe"
    assert classify_road(count=20, occupancy=0.9, speed=0.2, used=0.95, at_red=True, growth=0, downstream_used=0.9) == "blocked"


def test_an_empty_road_is_free():
    assert classify_road(count=0, occupancy=0.0, speed=0.0, used=0.0, at_red=True, growth=0, downstream_used=0.9) == "free"


def test_spillback_does_not_flicker_at_the_threshold():
    t = SpillbackTracker(0.85, 0.70)
    assert t.observe("e", 0.84) is None
    assert t.observe("e", 0.86) == "spillback_warning"
    assert t.observe("e", 0.84) is None
    assert t.observe("e", 0.86) is None
    assert t.observe("e", 0.60) == "spillback_cleared"


def _grid(n):
    return [{"id": f"J{r}_{c}", "x": c * 100.0, "y": r * 100.0} for r in range(n) for c in range(n)]


def test_regions_cover_every_junction_once():
    for n, expected in ((3, 1), (5, 4), (7, 4), (9, 9)):
        regions = partition_regions(_grid(n))
        assert len(regions) == expected, n
        members = [t for group in regions.values() for t in group]
        assert sorted(members) == sorted(node["id"] for node in _grid(n))


def test_supervisor_cuts_an_extension_into_a_full_road_when_others_wait():
    assert review_extension(40, 12, 10, exit_occupancy=0.7, competing=5) == ("cut_back", 12)


def test_supervisor_respects_minimum_green():
    assert review_extension(40, 4, 10, exit_occupancy=0.7, competing=5) == ("cut_back", 10)


def test_supervisor_approves_when_nobody_else_waits_or_the_road_has_room():
    assert review_extension(40, 12, 10, exit_occupancy=0.7, competing=0) == ("approved", 40)
    assert review_extension(40, 12, 10, exit_occupancy=0.3, competing=5) == ("approved", 40)


def test_supervisor_never_lengthens_a_green():
    for total in (5, 12, 40):
        assert review_extension(total, 12, 10, 0.9, 5)[1] <= total


def test_journal_streams_entries_once_with_increasing_ids(tmp_path):
    hook = JournalHook(tmp_path, "sim")
    controller = SimpleNamespace(live_events=[], green_wave=SimpleNamespace(messages=[]))
    hook.bind(controller)
    session = SimpleNamespace(now=1.0, hooks=[hook])
    hook.on_start(session)
    controller.live_events.append({"event": "proposed", "time": 1.0, "intersection": "A"})
    controller.live_events.append({"event": "applied", "time": 1.0, "intersection": "A", "status": "applied", "score": 9})
    controller.green_wave.messages.append({"time": 1.0, "from": "A", "to": "B", "kind": "platoon_alert", "text": "hi"})
    hook.on_step(session)
    first = read_events(tmp_path / "live")
    assert [e["kind"] for e in first] == ["applied", "platoon_alert"]
    assert "score" not in first[0]["payload"]
    hook.on_step(session)
    assert [e["id"] for e in read_events(tmp_path / "live")] == [1, 2]
    assert [e["id"] for e in read_events(tmp_path / "live", after=1)] == [2]
    hook.on_close(session)
    assert json.loads((tmp_path / "live" / "events.jsonl").read_text().splitlines()[0])["sim"] == "sim"


def test_run_without_journal_is_reported_as_such(tmp_path):
    assert read_events(tmp_path) is None


def test_pause_holds_the_recorder_until_resumed_and_speed_changes_the_pace(tmp_path):
    import json, threading, time
    from simulation.live.recorder import LiveRecorder
    rec = LiveRecorder.__new__(LiveRecorder)
    rec.stop_file = tmp_path / "STOP"
    rec.control_file = tmp_path / "control.json"
    rec.realtime_factor = 1.0
    rec.paused = False
    rec._control_read_at = 0.0
    rec._pace_anchor = None
    rec.control_file.write_text(json.dumps({"paused": True, "speed": 10}))
    thread = threading.Thread(target=rec._pace, args=(5.0,), daemon=True)
    thread.start()
    time.sleep(0.4)
    assert thread.is_alive(), "a paused simulation must not advance"
    rec.control_file.write_text(json.dumps({"paused": False, "speed": 10}))
    thread.join(2)
    assert not thread.is_alive()
    assert rec.realtime_factor == 10.0


def test_a_stop_request_ends_a_pause(tmp_path):
    import json, threading
    from simulation.live.recorder import LiveRecorder
    rec = LiveRecorder.__new__(LiveRecorder)
    rec.stop_file = tmp_path / "STOP"
    rec.control_file = tmp_path / "control.json"
    rec.realtime_factor = None
    rec.paused = False
    rec._control_read_at = 0.0
    rec._pace_anchor = None
    rec.control_file.write_text(json.dumps({"paused": True}))
    thread = threading.Thread(target=rec._pace, args=(1.0,), daemon=True)
    thread.start()
    rec.stop_file.write_text("stop")
    thread.join(2)
    assert not thread.is_alive()


def test_demo_city_preset_has_every_vehicle_class_and_two_lanes():
    from simulation.network.presets import resolve_preset
    preset = resolve_preset("demo_city")
    assert preset["grid"]["lanes"] == 2 and preset["rows"] * preset["cols"] == 12
    assert preset["demand"]["vehicle_mix"] == "demo_mixed"
