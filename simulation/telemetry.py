from __future__ import annotations
from dataclasses import dataclass
from collections import defaultdict

@dataclass
class VehicleRecord:
    departed_at: float
    waiting_s: float = 0.0
    stop_count: int = 0
    arrived_at: float | None = None
    was_stopped: bool = False

class TelemetryCollector:
    """Pure TraCI-independent KPI accumulator; safe to unit test without SUMO."""
    def __init__(self):
        self.records: dict[str, VehicleRecord] = {}
        self.arrivals = 0
        self.total_fuel_mg = 0.0
        self.total_co2_mg = 0.0
        self.max_queue = 0
        self.queue_sum = 0.0
        self.queue_samples = 0
        self.total_waiting_s = 0.0

    def observe_vehicle(self, vehicle_id: str, sim_time: float, waiting_s: float, speed: float,
                        fuel_mg: float, co2_mg: float, stopped_threshold: float = 0.1) -> None:
        rec = self.records.get(vehicle_id)
        if rec is None:
            rec = self.records[vehicle_id] = VehicleRecord(sim_time)
        # SUMO waiting time is cumulative, so retain the latest value per vehicle.
        rec.waiting_s = max(rec.waiting_s, float(waiting_s))
        if speed < stopped_threshold:
            # Count a stop only on a transition into a stopped state.
            if not rec.was_stopped:
                rec.stop_count += 1
            rec.was_stopped = True
        else:
            rec.was_stopped = False
        self.total_fuel_mg += max(0.0, float(fuel_mg))
        self.total_co2_mg += max(0.0, float(co2_mg))

    def observe_queue(self, queue: int) -> None:
        q = max(0, int(queue))
        self.max_queue = max(self.max_queue, q)
        self.queue_sum += q
        self.queue_samples += 1

    def vehicle_arrived(self, vehicle_id: str, sim_time: float) -> None:
        if vehicle_id in self.records and self.records[vehicle_id].arrived_at is None:
            self.records[vehicle_id].arrived_at = float(sim_time)
            self.arrivals += 1

    def summary(self, simulation_end: float) -> dict:
        n = len(self.records)
        total_wait = sum(r.waiting_s for r in self.records.values())
        travel_times = [r.arrived_at-r.departed_at for r in self.records.values() if r.arrived_at is not None]
        stops = sum(r.stop_count for r in self.records.values())
        arrived_count = len(travel_times)
        return {
            "vehicles_observed": n,
            "vehicles_arrived": self.arrivals,
            "throughput": self.arrivals,
            "average_delay_s": total_wait / n if n else 0.0,
            "total_waiting_time_s": total_wait,
            "max_queue": self.max_queue,
            "average_queue": self.queue_sum / self.queue_samples if self.queue_samples else 0.0,
            "average_travel_time_s": sum(travel_times) / arrived_count if arrived_count else 0.0,
            "average_stops": stops / n if n else 0.0,
            "fuel_mg": self.total_fuel_mg,
            "co2_mg": self.total_co2_mg,
        }
