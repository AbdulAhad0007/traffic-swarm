"""3D View recording: file format, retention, and proof that recording does not change a simulation."""
import json
from pathlib import Path
from types import SimpleNamespace
import pytest

ROOT = Path(__file__).resolve().parents[1]


def _session(now, vehicles):
    from simulation.runtime import tc
    return SimpleNamespace(now=now, tl_values={"J1": {tc.TL_CURRENT_PHASE: 1, tc.TL_RED_YELLOW_GREEN_STATE: "GrGr"}}, vehicle_values={
        vid: {tc.VAR_POSITION: (10.04, 20.06), tc.VAR_ANGLE: 89.6, tc.VAR_SPEED: 5.55, tc.VAR_WAITING_TIME: 2.2,
              tc.VAR_TYPE: "car", tc.VAR_ROAD_ID: "E0"} for vid in vehicles})


def _recorder(tmp_path, **kw):
    from simulation.live.frame_recorder import FrameRecorder
    recorder = FrameRecorder(None, tmp_path, **kw)
    recorder.dir.mkdir(parents=True)
    recorder._edges = {"E0": 0}
    return recorder


def test_frames_round_trip_and_resume_after_a_time(tmp_path):
    from simulation.live.frame_recorder import read_frames
    recorder = _recorder(tmp_path)
    for t in range(1, 66):
        recorder.on_step(_session(float(t), ["veh0"]))
    recorder.on_close(None)
    first = read_frames(recorder.live, None, 2)
    assert [f["t"] for f in first["frames"]] == [1.0, 2.0]
    assert first["status"] == "finished" and first["first_t"] == 1.0 and first["last_t"] == 65.0
    frame = first["frames"][0]
    assert frame["ids"] == ["veh0"] and frame["x"] == [10.0] and frame["a"] == [90] and frame["e"] == [0]
    assert frame["tl"] == {"J1": [1, "GrGr"]} and frame["types"] == ["car"]
    assert [f["t"] for f in read_frames(recorder.live, 45.0, 3)["frames"]] == [46.0, 47.0, 48.0]
    assert read_frames(recorder.live, 65.0, 3)["frames"] == []


def test_nothing_recorded_reads_as_none(tmp_path):
    from simulation.live.frame_recorder import read_frames
    assert read_frames(tmp_path, None, 5) is None


def test_a_half_written_line_waits_for_the_next_poll(tmp_path):
    from simulation.live.frame_recorder import read_frames
    recorder = _recorder(tmp_path)
    recorder.on_step(_session(1.0, ["veh0"]))
    recorder._file.write('{"t":2.0,"ids":[')
    recorder._file.flush()
    assert [f["t"] for f in read_frames(recorder.live, None, 5)["frames"]] == [1.0]
    recorder.on_close(None)


def test_oldest_chunks_are_dropped_over_the_size_cap(tmp_path):
    from simulation.live.frame_recorder import read_frames
    recorder = _recorder(tmp_path, max_bytes=20_000)
    for t in range(1, 301):
        recorder.on_step(_session(float(t), ["veh0", "veh1"]))
    recorder.on_close(None)
    assert recorder.bytes <= 20_000
    data = read_frames(recorder.live, None, 120)
    assert data["first_t"] > 1.0 and data["frames"][0]["t"] == data["first_t"] and data["last_t"] == 300.0


def test_a_vehicle_without_position_is_left_out_not_invented(tmp_path):
    from simulation.live.frame_recorder import read_frames
    from simulation.runtime import tc
    recorder = _recorder(tmp_path)
    session = _session(1.0, ["veh0", "veh1"])
    del session.vehicle_values["veh1"][tc.VAR_POSITION]
    recorder.on_step(session)
    recorder.on_close(None)
    assert read_frames(recorder.live, None, 1)["frames"][0]["ids"] == ["veh0"]


@pytest.mark.sumo
def test_recording_on_a_real_run_changes_no_kpi(tmp_path):
    from experiments.tools.run_experiment import prepare, run_variant
    info, cfg, _, _, run_dir = prepare("normal", 42, ROOT, "grid3x3", run_dir=tmp_path / "run")
    settings = info["preset"]["controller"]
    plain = run_variant("fixed", 42, cfg, tmp_path / "plain", settings, max_time=240, live=False)
    recorded = run_variant("fixed", 42, cfg, tmp_path / "recorded", settings, max_time=240, live=True)
    for key in ("average_time_loss_s", "average_travel_time_s", "average_queue", "max_queue", "vehicles_arrived", "fuel_mg", "co2_mg", "teleports"):
        assert recorded[key] == plain[key], key
    live = tmp_path / "recorded" / "baseline" / "live"
    network = json.loads((live / "network3d.json").read_text(encoding="utf-8"))
    assert network["edges"] and network["signals"] and network["signals"][0]["lamps"]
    from simulation.live.frame_recorder import read_frames
    frames = read_frames(live, 100.0, 5)["frames"]
    assert frames and frames[0]["ids"] and len(frames[0]["ids"]) == len(frames[0]["x"]) and frames[0]["tl"]
