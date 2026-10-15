"""Emergency-vehicle (ambulance) signal priority / green corridor - SIMULATION ONLY.

This is a research prototype for SUMO experiments. It is NOT certified, validated or intended for
real emergency traffic systems or real signal hardware.

How it works (a SumoSession hook, usable with the fixed-time and the swarm controller):
  identification  vehicles whose vClass is in `vclasses` (default: 'emergency') are tracked from
                  departure; their route and the ordered traffic lights on it are recorded.
  request         each step, every traffic light the ambulance will reach within `horizon_m`
                  (TraCI getNextTLS: tls id, controlled link, distance) gets a priority request for
                  the green phase that serves that link (from the real program's phase map).
  arbitration     per junction the earliest request owns it; another ambulance needing the same
                  green shares it, one needing a conflicting green waits ('waiting_conflict').
  action          only the two safe actions of Controller V2, via setPhaseDuration on a GREEN phase
                  after re-checking SUMO's current phase and state (apply_green_duration):
                    - target green active   -> extend its remaining time to cover the ambulance's
                                               ETA + margin, never beyond max_green_s from phase start
                    - conflicting green     -> end it, but only once its minimum green (pedestrian
                                               minimum included) has elapsed
                    - yellow/all-red/ped clearance -> never touched; SUMO runs it as programmed
                  Signal states are never written, so no unsafe simultaneous green can be created;
                  the independent signal audit checks every run.
  release/expiry  a request ends when the ambulance passes the junction ('served'), leaves the
                  network, or after `max_request_s` ('expired', not re-requested for that junction).
  fallback        a junction that cannot be controlled (native program) or whose TraCI call fails is
                  left to the normal controller, which keeps running everywhere it is not locked.
With `enabled=False` the same vehicles are tracked and measured but no action is taken, which is
the 'no priority' arm of the evaluation.
"""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from pathlib import Path
import xml.etree.ElementTree as ET
from simulation.swarm.adaptive_controller import apply_green_duration

DEFAULTS = {"horizon_m": 250.0, "max_tls_ahead": 2, "margin_s": 4.0, "max_request_s": 120.0,
            "min_eta_speed_mps": 3.0, "live_interval_s": 2.0}


@dataclass
class Request:
    vehicle: str
    tls: str
    link_index: int
    target_phase: int | None
    requested_at: float
    distance_m: float
    status: str = "pending"
    outcome: str | None = None
    released_at: float | None = None
    actions: int = 0


@dataclass
class Ambulance:
    id: str
    depart: float
    route: list
    tls_on_route: list
    arrival: float | None = None
    stops: int = 0
    stopped: bool = False
    expired_tls: set = field(default_factory=set)
    requests: list = field(default_factory=list)
    lost: bool = False


class EmergencyPriority:
    def __init__(self, phase_maps: dict, settings: dict, enabled: bool = True, out_dir=None,
                 vclasses=("emergency",), options: dict | None = None, api=None):
        self.phase_maps = phase_maps                  # tls -> PhaseMap (controllable programs only)
        self.max_green = float(settings["max_green_s"])
        self.enabled = bool(enabled)
        self.out = Path(out_dir) if out_dir else None
        self.vclasses = set(vclasses)
        self.opt = {**DEFAULTS, **(options or {})}
        self._api = api
        self.ambulances: dict[str, Ambulance] = {}
        self.active: dict[tuple[str, str], Request] = {}       # (vehicle, tls) -> request
        self.phase_start: dict[str, tuple[int, float]] = {}
        self.truncated: set = set()                            # (tls, phase, phase_start) already ended
        self.disabled_tls: dict[str, str] = {}
        self.events: list[dict] = []
        self.next_live = 0.0

    @property
    def api(self):
        if self._api is None:
            import traci
            self._api = traci
        return self._api

    # ------------------------------------------------------------------ hook API
    def on_start(self, session) -> None:
        self.events.append({"event": "priority_mode", "time": session.now, "enabled": self.enabled, **self.opt})

    def locked_tls(self) -> set:
        """Junctions currently owned by a priority request (the swarm defers there)."""
        if not self.enabled:
            return set()
        return {r.tls for r in self.active.values() if r.status in ("granted", "waiting_min_green", "in_clearance")}

    def on_step(self, session) -> None:
        now = session.now
        self._track_phases(session, now)
        for vid in session.departed_ids:
            self._maybe_register(vid, now)
        for vid in session.arrived_ids:
            amb = self.ambulances.get(vid)
            if amb is not None and amb.arrival is None:
                amb.arrival = now
                self._release_vehicle(vid, now, "arrived")
        for amb in list(self.ambulances.values()):
            if amb.arrival is None and not amb.lost:
                self._update(amb, now, session)
        if self.enabled:
            self._arbitrate_and_act(now)
        if self.out is not None and now >= self.next_live:
            self._write_live(now)
            self.next_live = now + float(self.opt["live_interval_s"])

    def on_close(self, session) -> None:
        if self.out is None:
            return
        self.out.mkdir(parents=True, exist_ok=True)
        with (self.out / "emergency_events.jsonl").open("w", encoding="utf-8") as f:
            for e in self.events:
                f.write(json.dumps(e) + "\n")
        self._write_live(session.now)

    def report(self) -> dict:
        """Per-ambulance results; time loss comes from SUMO tripinfo when available."""
        tripinfo = self._tripinfo()
        vehicles = []
        for amb in self.ambulances.values():
            outcomes: dict[str, int] = {}
            for r in amb.requests:
                outcomes[r.outcome or r.status] = outcomes.get(r.outcome or r.status, 0) + 1
            ti = tripinfo.get(amb.id, {})
            vehicles.append({"id": amb.id, "depart_s": amb.depart, "arrival_s": amb.arrival,
                             "travel_time_s": None if amb.arrival is None else round(amb.arrival - amb.depart, 2),
                             "time_loss_s": ti.get("timeLoss"), "waiting_time_s": ti.get("waitingTime"),
                             "stops": amb.stops, "lost": amb.lost, "tls_on_route": amb.tls_on_route,
                             "route_edges": len(amb.route), "requests": outcomes})
        done = [v["travel_time_s"] for v in vehicles if v["travel_time_s"] is not None]
        actions: dict[str, int] = {}
        for e in self.events:
            if e["event"] == "action":
                actions[e["action"]] = actions.get(e["action"], 0) + 1
        return {"emergency": {"priority_enabled": self.enabled, "options": self.opt, "ambulances": len(vehicles),
                              "ambulances_arrived": len(done),
                              "mean_travel_time_s": round(sum(done) / len(done), 2) if done else None,
                              "vehicles": vehicles, "actions": actions, "disabled_tls": self.disabled_tls,
                              "disclaimer": "simulation prototype; not certified for real emergency traffic systems"}}

    # ------------------------------------------------------------------ tracking
    def _track_phases(self, session, now: float) -> None:
        for tid in self.phase_maps:
            phase = session.phase(tid)
            if phase is None:
                continue
            prev = self.phase_start.get(tid)
            if prev is None:
                self.phase_start[tid] = (phase, 0.0)
            elif prev[0] != phase:
                self.phase_start[tid] = (phase, now)

    def _maybe_register(self, vid: str, now: float) -> None:
        try:
            if self.api.vehicle.getVehicleClass(vid) not in self.vclasses:
                return
            route = list(self.api.vehicle.getRoute(vid))
            tls = [t[0] for t in self.api.vehicle.getNextTLS(vid)]
        except Exception as exc:
            self.events.append({"event": "register_failed", "time": now, "vehicle": vid, "error": type(exc).__name__})
            return
        self.ambulances[vid] = Ambulance(vid, now, route, tls)
        self.events.append({"event": "ambulance_departed", "time": now, "vehicle": vid, "route_edges": len(route),
                            "tls_on_route": tls})

    def _update(self, amb: Ambulance, now: float, session) -> None:
        try:
            speed = self.api.vehicle.getSpeed(amb.id)
            upcoming = self.api.vehicle.getNextTLS(amb.id)
        except Exception:
            # Vehicle left the simulation without an arrival event (teleport/vaporised).
            amb.lost = True
            self._release_vehicle(amb.id, now, "vehicle_lost")
            self.events.append({"event": "ambulance_lost", "time": now, "vehicle": amb.id})
            return
        if speed < 0.1 and not amb.stopped:
            amb.stops += 1
        amb.stopped = speed < 0.1
        ahead = {}
        for tls, link, dist, _state in upcoming:
            if dist > float(self.opt["horizon_m"]) or len(ahead) >= int(self.opt["max_tls_ahead"]):
                break
            ahead[tls] = (int(link), float(dist))
        # Release junctions the ambulance has passed.
        for (vid, tls), req in list(self.active.items()):
            if vid == amb.id and tls not in ahead:
                self._release(req, now, "served")
        eta_speed = max(speed, float(self.opt["min_eta_speed_mps"]))
        for tls, (link, dist) in ahead.items():
            key = (amb.id, tls)
            req = self.active.get(key)
            if req is None:
                if tls in amb.expired_tls:
                    continue
                pm = self.phase_maps.get(tls)
                target = None
                if pm is not None:
                    target = next((g.index for g in pm.greens if link in g.served_links), None)
                req = Request(amb.id, tls, link, target, now, dist)
                amb.requests.append(req)
                self.events.append({"event": "requested", "time": now, "vehicle": amb.id, "tls": tls, "link": link,
                                    "target_phase": target, "distance_m": round(dist, 1)})
                if not self.enabled:
                    req.status = "observe_only"
                elif pm is None or target is None or tls in self.disabled_tls:
                    why = self.disabled_tls.get(tls) or ("not_controllable" if pm is None else "no_green_serves_link")
                    req.status, req.outcome = "denied", why
                    self.events.append({"event": "denied", "time": now, "vehicle": amb.id, "tls": tls, "reason": why})
                self.active[key] = req
            req.distance_m = dist
            req.eta_s = dist / eta_speed
            if self.enabled and req.status not in ("denied",) and now - req.requested_at > float(self.opt["max_request_s"]):
                amb.expired_tls.add(tls)
                self._release(req, now, "expired")

    def _release(self, req: Request, now: float, outcome: str) -> None:
        if req.status != "denied":          # a denial keeps its reason as the outcome
            req.outcome = outcome
        req.status, req.released_at = "released", now
        self.active.pop((req.vehicle, req.tls), None)
        self.events.append({"event": "released", "time": now, "vehicle": req.vehicle, "tls": req.tls,
                            "outcome": req.outcome, "held_s": round(now - req.requested_at, 1)})

    def _release_vehicle(self, vid: str, now: float, outcome: str) -> None:
        for (v, _tls), req in list(self.active.items()):
            if v == vid:
                self._release(req, now, outcome)

    # ------------------------------------------------------------------ priority actions
    def _arbitrate_and_act(self, now: float) -> None:
        by_tls: dict[str, list[Request]] = {}
        for req in self.active.values():
            if req.status != "denied" and req.target_phase is not None:
                by_tls.setdefault(req.tls, []).append(req)
        for tls, reqs in by_tls.items():
            reqs.sort(key=lambda r: (r.requested_at, r.distance_m, r.vehicle))
            owner = reqs[0]
            for other in reqs[1:]:
                other.status = "granted" if other.target_phase == owner.target_phase else "waiting_conflict"
            try:
                owner.status = self._act(tls, owner, now)
            except Exception as exc:          # never let priority logic break the run
                self.disabled_tls[tls] = f"action_error:{type(exc).__name__}"
                for r in reqs:
                    r.status, r.outcome = "denied", self.disabled_tls[tls]
                self.events.append({"event": "tls_disabled", "time": now, "tls": tls, "reason": self.disabled_tls[tls]})

    def _act(self, tls: str, req: Request, now: float) -> str:
        pm = self.phase_maps[tls]
        phase, start = self.phase_start.get(tls, (None, 0.0))
        green = pm.green_by_index(phase) if phase is not None else None
        if green is None:
            return "in_clearance"
        elapsed = now - start
        tl = self.api.trafficlight
        if green.index == req.target_phase:
            allowed = self.max_green - elapsed
            desired = min(getattr(req, "eta_s", 0.0) + float(self.opt["margin_s"]), allowed)
            remaining = tl.getNextSwitch(tls) - now
            if desired > remaining + 0.5:
                ok, why = apply_green_duration(tl, tls, green.index, green.state, desired)
                self._log_action(now, req, "extend_target_green", ok, why, remaining_set_s=round(desired, 2))
            return "granted"
        if elapsed + 1e-9 < green.min_green:
            return "waiting_min_green"
        key = (tls, green.index, start)
        if key not in self.truncated:
            ok, why = apply_green_duration(tl, tls, green.index, green.state, 0.0)
            self._log_action(now, req, "end_conflicting_green", ok, why, phase=green.index, elapsed_s=round(elapsed, 1))
            if ok:
                self.truncated.add(key)
        return "granted"

    def _log_action(self, now, req, action, ok, why, **extra) -> None:
        req.actions += 1
        self.events.append({"event": "action", "time": now, "vehicle": req.vehicle, "tls": req.tls, "action": action,
                            "applied": ok, "detail": why, **extra})

    # ------------------------------------------------------------------ outputs
    def _write_live(self, now: float) -> None:
        from simulation.live.recorder import write_json_atomic
        data = {"sim_time_s": now, "priority_enabled": self.enabled,
                "ambulances": [{"id": a.id, "depart_s": a.depart, "arrival_s": a.arrival, "lost": a.lost,
                                "travel_time_s": None if a.arrival is None else round(a.arrival - a.depart, 1),
                                "elapsed_s": round((a.arrival or now) - a.depart, 1), "stops": a.stops,
                                "tls_on_route": a.tls_on_route,
                                "requests": [{"tls": r.tls, "status": r.status, "outcome": r.outcome,
                                              "target_phase": r.target_phase} for r in a.requests]}
                               for a in self.ambulances.values()]}
        try:
            (self.out / "live").mkdir(parents=True, exist_ok=True)
            write_json_atomic(self.out / "live" / "emergency.json", data)
        except OSError:
            pass

    def _tripinfo(self) -> dict:
        path = None if self.out is None else self.out / "tripinfo.xml"
        if path is None or not path.is_file():
            return {}
        out = {}
        try:
            for t in ET.parse(path).getroot().findall("tripinfo"):
                if t.get("id") in self.ambulances:
                    out[t.get("id")] = {"timeLoss": float(t.get("timeLoss")), "waitingTime": float(t.get("waitingTime"))}
        except ET.ParseError:
            return {}
        return out
