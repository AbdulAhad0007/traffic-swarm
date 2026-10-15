"""KPIs from SUMO's own output files (tripinfo + statistics).

These complement the per-step telemetry. `average_time_loss_s` (SUMO timeLoss: time lost compared
with driving at the desired speed) is the delay measure to use; the older `average_delay_s` is
kept unchanged only for comparability with earlier runs.
"""
from __future__ import annotations
import statistics as st
import xml.etree.ElementTree as ET
from pathlib import Path


def _mean(values):
    return round(st.fmean(values), 4) if values else None


def parse_tripinfo(path: Path) -> dict:
    if not Path(path).is_file():
        return {}
    root = ET.parse(path).getroot()
    arrived, unfinished, by_type, rerouted = [], 0, {}, 0
    for t in root.findall("tripinfo"):
        if float(t.get("arrival", -1)) < 0 or t.get("vaporized"):
            unfinished += 1
            continue
        rec = {"duration": float(t.get("duration")), "timeLoss": float(t.get("timeLoss")),
               "waitingCount": float(t.get("waitingCount")), "waitingTime": float(t.get("waitingTime"))}
        arrived.append(rec)
        by_type.setdefault(t.get("vType"), []).append(rec)
        if int(t.get("rerouteNo", 0)) > 0:
            rerouted += 1
    persons = []
    for p in root.findall("personinfo"):
        walks = p.findall("walk")
        if walks and all(float(w.get("arrival", -1)) >= 0 for w in walks):
            persons.append({"duration": sum(float(w.get("duration")) for w in walks),
                            "timeLoss": sum(float(w.get("timeLoss", 0)) for w in walks)})
    summary = lambda recs: {"n": len(recs), "average_trip_duration_s": _mean([r["duration"] for r in recs]),
                            "average_time_loss_s": _mean([r["timeLoss"] for r in recs]),
                            "average_waiting_count": _mean([r["waitingCount"] for r in recs]),
                            "average_waiting_time_s": _mean([r["waitingTime"] for r in recs])}
    out = summary(arrived)
    out.update({"unfinished_in_tripinfo": unfinished, "rerouted_vehicles": rerouted,
                "per_vtype": {k: summary(v) for k, v in sorted(by_type.items())},
                "persons_arrived": len(persons),
                "person_average_duration_s": _mean([p["duration"] for p in persons]),
                "person_average_time_loss_s": _mean([p["timeLoss"] for p in persons])})
    return out


def parse_statistics(path: Path) -> dict:
    if not Path(path).is_file():
        return {}
    root = ET.parse(path).getroot()
    get = lambda tag: root.find(tag).attrib if root.find(tag) is not None else {}
    veh, tel, saf, per = get("vehicles"), get("teleports"), get("safety"), get("persons")
    num = lambda d, k: int(float(d.get(k, 0)))
    return {"vehicles_loaded": num(veh, "loaded"), "vehicles_inserted": num(veh, "inserted"),
            "vehicles_running_at_end": num(veh, "running"), "vehicles_waiting_to_insert_at_end": num(veh, "waiting"),
            "teleports": num(tel, "total"), "teleports_jam": num(tel, "jam"), "teleports_yield": num(tel, "yield"),
            "teleports_wrong_lane": num(tel, "wrongLane"),
            "collisions": num(saf, "collisions"), "emergency_stops": num(saf, "emergencyStops"),
            "persons_loaded": num(per, "loaded")}


def sumo_kpis(output_dir: Path, vehicles_observed: int, vehicles_arrived: int, timed_out: bool) -> dict:
    trip = parse_tripinfo(Path(output_dir) / "tripinfo.xml")
    stats = parse_statistics(Path(output_dir) / "statistics.xml")
    if not trip and not stats:
        return {}
    loaded = stats.get("vehicles_loaded", vehicles_observed)
    out = {"average_time_loss_s": trip.get("average_time_loss_s"),
           "average_trip_duration_s": trip.get("average_trip_duration_s"),
           "average_waiting_count": trip.get("average_waiting_count"),
           "vehicles_with_reroute_events": trip.get("rerouted_vehicles"),
           "teleports": stats.get("teleports"), "collisions": stats.get("collisions"),
           "emergency_stops": stats.get("emergency_stops"),
           "vehicles_loaded": loaded,
           "vehicles_unfinished": max(0, loaded - vehicles_arrived),
           "vehicles_not_inserted": max(0, loaded - stats.get("vehicles_inserted", loaded)),
           "per_vtype": trip.get("per_vtype"),
           "persons": {"loaded": stats.get("persons_loaded"), "arrived": trip.get("persons_arrived"),
                       "average_duration_s": trip.get("person_average_duration_s"),
                       "average_time_loss_s": trip.get("person_average_time_loss_s")},
           "statistics": stats}
    out["simulation_failures"] = {"timed_out": bool(timed_out), "teleports": out["teleports"] or 0,
                                  "collisions": out["collisions"] or 0, "vehicles_unfinished": out["vehicles_unfinished"],
                                  "vehicles_not_inserted": out["vehicles_not_inserted"]}
    return out
