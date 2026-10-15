"""Shared SUMO/TraCI session used by every controller so all controllers are measured identically.

Measurements use TraCI subscriptions (one bulk response per step) instead of several calls per
vehicle per step, which is what makes 9x9 networks practical. KPI definitions are unchanged from
the original per-vehicle polling loop.
"""
from __future__ import annotations
import os
import xml.etree.ElementTree as ET
from pathlib import Path
try:
    import traci
    import traci.constants as tc
except ImportError:
    traci = None
    tc = None
from simulation.network.grid_generator import find_sumo_binary
from simulation.telemetry import TelemetryCollector

CLOSED_EDGE_TRAVEL_TIME_S = 1e7   # per-vehicle weight that makes the router avoid a closed edge


def net_file_from_cfg(sumocfg) -> Path:
    cfg = Path(sumocfg)
    node = ET.parse(cfg).getroot().find("./input/net-file")
    if node is None:
        raise ValueError(f"no <net-file> in {cfg}")
    net = Path(node.get("value"))
    return net if net.is_absolute() else (cfg.parent / net)


def closure_from_cfg(sumocfg) -> dict | None:
    """Read a rerouter closingReroute (written by the scenario builder) from the cfg's additional files."""
    cfg = Path(sumocfg)
    node = ET.parse(cfg).getroot().find("./input/additional-files")
    if node is None:
        return None
    for item in node.get("value", "").split(","):
        path = Path(item) if Path(item).is_absolute() else cfg.parent / item
        if not path.is_file():
            continue
        for rr in ET.parse(path).getroot().iter("rerouter"):
            for interval in rr.findall("interval"):
                close = interval.find("closingReroute")
                if close is not None:
                    return {"edge": close.get("id"), "begin_s": float(interval.get("begin")), "end_s": float(interval.get("end"))}
    return None


class ClosureMonitor:
    """Counts vehicles that ENTER the closed edge while the closure is active (should be 0).
    Vehicles already on the edge when the closure starts are allowed to leave and are reported."""
    def __init__(self, closure: dict):
        self.edge, self.begin, self.end = closure["edge"], closure["begin_s"], closure["end_s"]
        self.on_edge_at_begin: set | None = None
        self.previous: set = set()
        self.entered_during_closure: list[str] = []
        self.entered_before = 0
        self.applied = False
        self.rerouted_at_start = 0
        self.committed: set = set()          # already inside the junction towards the edge at closure start
        self.unavoidable: set = set()        # no alternative route found at closure start
        self.unable_to_stop = 0              # of committed: approaching too fast to stop before the closed edge

    def observe(self, now: float, vehicles_on_edge) -> None:
        current = set(vehicles_on_edge)
        new = current - self.previous
        if now < self.begin:
            self.entered_before += len(new)
        elif now < self.end:
            if self.on_edge_at_begin is None:
                self.on_edge_at_begin = set(current)
                new -= current
            allowed = self.on_edge_at_begin | self.committed
            self.entered_during_closure.extend((v, now) for v in sorted(new) if v not in allowed)
        self.previous = current

    def report(self) -> dict:
        return {"edge": self.edge, "begin_s": self.begin, "end_s": self.end,
                "vehicles_entered_before_closure": self.entered_before,
                "vehicles_on_edge_when_closed": len(self.on_edge_at_begin or ()),
                "vehicles_rerouted_at_closure_start": self.rerouted_at_start,
                "vehicles_committed_in_junction_at_start": len(self.committed),
                "of_which_unable_to_stop_before_edge": self.unable_to_stop,
                "vehicles_still_routed_over_edge_after_reroute_call": len(self.unavoidable),
                "vehicles_entered_during_closure": len(self.entered_during_closure),
                "examples": [{"vehicle": v, "time": t} for v, t in self.entered_during_closure[:5]]}


def gui_requested(gui: bool | None) -> bool:
    if gui is not None:
        return bool(gui)
    return os.environ.get("TSI_SUMO_GUI", "").strip().lower() in {"1", "true", "yes"}


class SessionHook:
    """Optional per-run extension (live state, emergency priority, ...). Every method is optional.
    Hooks run after measurement in each step, so they observe exactly what the controllers observe."""
    def on_start(self, session: "SumoSession") -> None: ...
    def on_step(self, session: "SumoSession") -> None: ...
    def on_close(self, session: "SumoSession") -> None: ...


class SumoSession:
    def __init__(self, sumocfg, seed: int, gui: bool | None = None, auditor=None, output_dir=None,
                 hooks=None, port: int | None = None, extra_args=None):
        if traci is None:
            raise RuntimeError("TraCI is required to run SUMO experiments; install SUMO with Python bindings.")
        self.sumocfg, self.seed, self.gui = str(sumocfg), int(seed), gui_requested(gui)
        self.now = 0.0
        self.lane_values: dict = {}
        self.tl_values: dict = {}
        self.auditor = auditor
        self.output_dir = Path(output_dir) if output_dir is not None else None
        closure = closure_from_cfg(self.sumocfg)
        self.closure = ClosureMonitor(closure) if closure else None
        self.sumo_version = None
        self.hooks = list(hooks or [])
        self.port = port                      # explicit TraCI port (isolated parallel runs); None = SUMO picks a free one
        self.extra_args = [str(a) for a in (extra_args or [])]
        self.arrived_ids: list = []
        self.departed_ids: list = []

    def start(self) -> None:
        name = "sumo-gui" if self.gui else "sumo"
        binary = find_sumo_binary(name)
        if binary is None:
            raise RuntimeError(f"{name} is required to run experiments; install SUMO and add it to PATH.")
        cmd = [binary, "-c", self.sumocfg, "--seed", str(self.seed), "--no-step-log", "true"]
        if self.gui:
            cmd += ["--start", "--quit-on-end"]
        cmd += self.extra_args
        if self.output_dir is not None:
            # SUMO's own outputs: per-trip timeLoss/stops/reroutes and run-level failure counts.
            self.output_dir.mkdir(parents=True, exist_ok=True)
            cmd += ["--tripinfo-output", str(self.output_dir / "tripinfo.xml"),
                    "--tripinfo-output.write-unfinished", "true",
                    "--statistic-output", str(self.output_dir / "statistics.xml")]
        if self.port is not None:
            traci.start(cmd, port=int(self.port))
        else:
            traci.start(cmd)
        try:
            self.sumo_version = traci.getVersion()[1]
        except Exception:
            self.sumo_version = None
        lane_vars = [tc.LAST_STEP_VEHICLE_HALTING_NUMBER, tc.LAST_STEP_OCCUPANCY]
        for lane in traci.lane.getIDList():
            traci.lane.subscribe(lane, lane_vars)
        for tls in traci.trafficlight.getIDList():
            traci.trafficlight.subscribe(tls, [tc.TL_CURRENT_PHASE, tc.TL_RED_YELLOW_GREEN_STATE])
        self._read_signals()
        for hook in self.hooks:
            if hasattr(hook, "on_start"):
                hook.on_start(self)

    def _read_signals(self) -> None:
        self.tl_values = traci.trafficlight.getAllSubscriptionResults()
        if self.auditor is not None:
            for tls, v in self.tl_values.items():
                self.auditor.observe(self.now, tls, v[tc.TL_RED_YELLOW_GREEN_STATE], int(v[tc.TL_CURRENT_PHASE]))

    def phase(self, tls: str) -> int | None:
        v = self.tl_values.get(tls)
        return int(v[tc.TL_CURRENT_PHASE]) if v else None

    def running(self, max_time: float) -> bool:
        return traci.simulation.getMinExpectedNumber() > 0 and self.now < max_time

    def step(self, collector: TelemetryCollector) -> int:
        """Advance one step, record vehicle/queue telemetry, return total halting vehicles."""
        traci.simulationStep()
        self.now = traci.simulation.getTime()
        vehicle_vars = [tc.VAR_WAITING_TIME, tc.VAR_SPEED, tc.VAR_FUELCONSUMPTION, tc.VAR_CO2EMISSION]
        self.departed_ids = list(traci.simulation.getDepartedIDList())
        for vid in self.departed_ids:
            traci.vehicle.subscribe(vid, vehicle_vars)
        for vid, v in traci.vehicle.getAllSubscriptionResults().items():
            collector.observe_vehicle(vid, self.now, v[tc.VAR_WAITING_TIME], v[tc.VAR_SPEED],
                                      v[tc.VAR_FUELCONSUMPTION], v[tc.VAR_CO2EMISSION])
        self.arrived_ids = list(traci.simulation.getArrivedIDList())
        for vid in self.arrived_ids:
            collector.vehicle_arrived(vid, self.now)
        self.lane_values = traci.lane.getAllSubscriptionResults()
        queue = sum(int(v[tc.LAST_STEP_VEHICLE_HALTING_NUMBER]) for v in self.lane_values.values())
        collector.observe_queue(queue)
        self._read_signals()
        if self.closure is not None and self.now < self.closure.end + 1:
            if not self.closure.applied and self.now >= self.closure.begin:
                self._reroute_for_closure()
            self.closure.observe(self.now, traci.edge.getLastStepVehicleIDs(self.closure.edge))
        for hook in self.hooks:
            if hasattr(hook, "on_step"):
                hook.on_step(self)
        return queue

    def _reroute_for_closure(self) -> None:
        """SUMO rerouters only act when a vehicle enters a trigger edge, so vehicles already on an
        approach road when the closure starts would still drive onto the closed edge. Re-route them
        once at closure start (same for every controller). Vehicles already inside the junction
        towards the edge cannot be diverted and are recorded as committed.
        closingReroute does not change lane permissions or the global router's weights (verified on
        SUMO 1.27.1), so a plain rerouteTraveltime keeps the closed edge; the vehicle's own travel
        time for the edge is therefore set prohibitively high before rerouting."""
        c = self.closure
        c.applied = True
        for vid in traci.vehicle.getIDList():
            route, idx = traci.vehicle.getRoute(vid), traci.vehicle.getRouteIndex(vid)
            if c.edge not in route[idx + 1:]:
                continue
            if traci.vehicle.getRoadID(vid).startswith(":"):
                c.committed.add(vid)
                continue
            if route[idx + 1] == c.edge:
                # Next edge is the closed one: a vehicle that cannot stop before the stop line with its
                # normal deceleration is physically committed (SUMO also refuses to divert it).
                v, decel = traci.vehicle.getSpeed(vid), traci.vehicle.getDecel(vid)
                remaining = traci.lane.getLength(traci.vehicle.getLaneID(vid)) - traci.vehicle.getLanePosition(vid)
                if decel > 0 and remaining < v * v / (2 * decel):
                    c.committed.add(vid)
                    c.unable_to_stop += 1
                    continue
            traci.vehicle.setAdaptedTraveltime(vid, c.edge, CLOSED_EDGE_TRAVEL_TIME_S)
            traci.vehicle.rerouteTraveltime(vid)
            new_route, new_idx = traci.vehicle.getRoute(vid), traci.vehicle.getRouteIndex(vid)
            if c.edge in new_route[new_idx + 1:]:
                c.unavoidable.add(vid)
            else:
                c.rerouted_at_start += 1

    def halting(self, lane: str) -> int:
        v = self.lane_values.get(lane)
        return int(v[tc.LAST_STEP_VEHICLE_HALTING_NUMBER]) if v else 0

    def occupancy(self, lane: str) -> float:
        """Lane occupancy as a fraction in [0, 1].

        TraCI's LAST_STEP_OCCUPANCY is already a fraction (vehicle length on the lane / lane
        length; verified against SUMO 1.27.1). Up to v1.1.0 this value was divided by 100, which
        made every occupancy 100x too small and disabled the swarm's downstream-saturation term."""
        v = self.lane_values.get(lane)
        return min(1.0, max(0.0, float(v[tc.LAST_STEP_OCCUPANCY]))) if v else 0.0

    def close(self) -> None:
        for hook in self.hooks:
            if hasattr(hook, "on_close"):
                try:
                    hook.on_close(self)
                except Exception:          # a reporting hook must never prevent SUMO from being shut down
                    pass
        try:
            traci.close()
        except Exception:
            pass
