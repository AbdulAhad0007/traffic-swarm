"""KPI recomputation from raw artifacts (no SUMO needed: small synthetic files)."""
import json
from experiments.tools.analyze_evaluation import raw_metrics, read_attempts

TRIPS = """<tripinfos>
  <tripinfo id="a" depart="10" departDelay="2" arrival="110" duration="100" timeLoss="20" waitingCount="1" vType="car"/>
  <tripinfo id="b" depart="20" departDelay="0" arrival="-1" duration="80" timeLoss="50" waitingCount="3" vType="car"/>
  <tripinfo id="c" depart="-1" departDelay="0" arrival="-1" duration="-1" timeLoss="0" waitingCount="0" vType="car"/>
  <tripinfo id="amb" depart="5" departDelay="0" arrival="65" duration="60" timeLoss="4" waitingCount="0" vType="ambulance"/>
</tripinfos>"""
STATS = '<statistics><vehicles loaded="4" inserted="3" running="1" waiting="1"/><teleports total="2"/></statistics>'


def _run(tmp_path):
    (tmp_path / "tripinfo.xml").write_text(TRIPS)
    (tmp_path / "statistics.xml").write_text(STATS)
    rows = ["time,total_halting"] + [f"{t},{q}" for t, q in [(1, 0), (2, 4), (3, 2), (4, 10)]]
    (tmp_path / "baseline_timeseries.csv").write_text("\n".join(rows) + "\n")
    (tmp_path / "baseline_summary.json").write_text(json.dumps({"vehicles_observed": 3, "fuel_mg": 6000, "co2_mg": 9000}))
    return tmp_path


def test_denominators_and_windows(tmp_path):
    m = raw_metrics(_run(tmp_path), "fixed", demand_window=(1, 3))
    assert m["arrived_vehicles"] == 1                       # 'a' only; ambulance excluded
    assert m["mean_delay_s"] == 20                          # arrived vehicles only
    assert m["mean_total_delay_all_s"] == ((20 + 2) + 50) / 2   # all departed regular vehicles, incl. unfinished 'b'
    assert m["vehicles_not_departed"] == 1
    assert m["arrived_share"] == 1 / 3
    assert m["ambulance_travel_time_s"] == 60
    assert m["mean_queue_veh"] == (4 + 2) / 2                # window (1, 3]
    assert m["max_queue_veh"] == 10                          # whole run
    assert m["halted_vehicle_hours"] == (0 + 4 + 2 + 10) / 3600
    assert m["fuel_g_per_vehicle"] == 2.0 and m["teleports"] == 2


def test_attempts_mark_latest(tmp_path):
    lines = [{"cell": "x", "status": "failed", "traceback": "t"}, {"cell": "y", "status": "completed"},
             {"cell": "x", "status": "completed"}]
    (tmp_path / "ledger.jsonl").write_text("\n".join(json.dumps(l) for l in lines))
    att = read_attempts(tmp_path)
    assert [a["is_latest_attempt"] for a in att] == [False, True, True]
    assert all("traceback" not in a for a in att)
