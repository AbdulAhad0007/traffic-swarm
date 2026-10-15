from __future__ import annotations

CORE_METRICS = (
    "average_delay_s", "max_queue", "average_queue", "average_travel_time_s",
    "average_stops", "fuel_mg", "co2_mg", "throughput", "vehicles_arrived"
)
# From SUMO tripinfo/statistics (absent in runs made before this phase).
SUMO_METRICS = (
    "average_time_loss_s", "average_trip_duration_s", "average_waiting_count",
    "teleports", "collisions", "emergency_stops", "vehicles_unfinished", "vehicles_not_inserted"
)
METRICS = CORE_METRICS + SUMO_METRICS
LOWER_IS_BETTER = set(METRICS) - {"throughput", "vehicles_arrived"}

def percent_change(baseline, swarm):
    if baseline is None or swarm is None or baseline == 0:
        return None
    try:
        b, s = float(baseline), float(swarm)
    except (TypeError, ValueError):
        return None
    if not (b == b and s == s):  # NaN guard
        return None
    return (s - b) / b * 100.0

def improvement_pct(baseline, swarm, metric):
    change = percent_change(baseline, swarm)
    if change is None:
        return None
    return -change if metric in LOWER_IS_BETTER else change

def compare(baseline, swarm):
    out = {}
    for metric in METRICS:
        b, s = baseline.get(metric), swarm.get(metric)
        out[metric] = {
            "baseline": b, "swarm": s,
            "change_pct": percent_change(b, s),
            "improvement_pct": improvement_pct(b, s, metric),
        }
    return out

def build_comparison(scenario, seed, baseline, swarm):
    return {"scenario": scenario, "seed": seed, "baseline": baseline,
            "swarm": swarm, "comparison": compare(baseline, swarm)}
