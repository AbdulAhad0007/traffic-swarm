"""Intersection agents on camera data, built from the swarm's existing parts.

The blackboard, PSO+ACO optimizer, region partitioning and central review are the same code the simulation controller
uses. An agent receives structured traffic state only, never video. Every message here is published as it happens,
which is what animates the page: no message, no packet.
"""
from __future__ import annotations
import threading
import time

from camera_service.events import EventHub, StageTracker, iso
from camera_service.settings import AGENT_TIMEOUT_S, DECISION_INTERVAL_S
from camera_service import signals as sig
from optimizer.app.swarm.blackboard import AgentObservation, SwarmBlackboard
from optimizer.app.swarm.engine import SwarmConfig, TrafficState, objective, optimize, stable_seed
from simulation.coordination.hierarchy import DEFAULTS as HIERARCHY, partition_regions, review_extension

CENTRAL = "CENTRAL"


def axis_demand(approaches: dict) -> dict:
    out = {a: {"queue": 0.0, "wait": 0.0, "arrival": 0.0, "vehicles": 0} for a in sig.AXES}
    for ap in approaches.values():
        d = out[ap["axis"]]
        d["queue"] += ap["queue_vehicles"]
        d["wait"] = max(d["wait"], ap["mean_wait_s"])
        d["arrival"] += ap["arrivals_per_min"] / 60.0
        d["vehicles"] += ap["vehicles"]
    return out


def state_message(camera_id: str, intersection_id: str, ts: float, snap: dict, source: str) -> dict:
    return {"camera_id": camera_id, "intersection_id": intersection_id, "timestamp": iso(ts), "vehicle_count": snap["vehicle_count"],
            "queue_length": snap["queue_length_m"], "queue_vehicles": snap["queue_vehicles"], "average_speed": snap["average_speed_mps"],
            "lane_occupancy": snap["lane_occupancy"], "congestion_level": snap["congestion_level"],
            "downstream_capacity": snap["downstream_capacity"], "measurement_quality": snap["quality"], "source": source}


class AgentNetwork:
    def __init__(self, hub: EventHub, tracker: StageTracker):
        self.hub, self.tracker = hub, tracker
        self.lock = threading.RLock()
        self.board = SwarmBlackboard(observation_ttl=30.0, neighbors={})
        self.agents: dict[str, dict] = {}
        self.regions: dict[str, list[str]] = {}
        self.region_of: dict[str, str] = {}
        self.escalated: set = set()
        self.counts = {"messages": 0, "alerts": 0, "requests": 0, "proposals": 0, "accepted": 0, "rejected": 0, "cut_back": 0}
        self.central_beat = None

    def set_topology(self, intersections: list[dict]) -> None:
        """intersections: dicts with id, and optional x, y and neighbors."""
        with self.lock:
            self.regions = partition_regions([{"id": i["id"], "x": i.get("x"), "y": i.get("y")} for i in intersections])
            self.region_of = {j: r for r, members in self.regions.items() for j in members}
            ids = {i["id"] for i in intersections}
            if any(i.get("neighbors") for i in intersections):
                neighbors = {i["id"]: [n for n in i.get("neighbors", []) if n in ids] for i in intersections}
            else:
                # With no declared road links, junctions in one region are treated as neighbours.
                neighbors = {j: [m for m in self.regions[self.region_of[j]] if m != j] for j in ids}
            self.board.set_topology(neighbors)
            for j in ids:
                self.agents.setdefault(j, {"id": j, "status": "IDLE", "last_seen": None, "last_decision_at": 0.0, "state": None, "proposal": None, "decision": None, "camera_id": None})
            for j in set(self.agents) - ids:
                del self.agents[j]

    def _msg(self, kind: str, sender: str, receiver: str, camera_id: str | None, data: dict, data_class: str | None, stage: str = "coordination",
             to_stage: str | None = None, level: str = "info", text: str = "") -> dict:
        self.counts["messages"] += 1
        return self.hub.publish("agent_message", text or kind.replace("_", " "), level=level, stage=stage, to_stage=to_stage, camera_id=camera_id, data_class=data_class,
                                data={"type": kind, "from": sender, "to": receiver, **data})

    def receive_state(self, message: dict, approaches: dict, data_class: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        j, cam = message["intersection_id"], message["camera_id"]
        with self.lock:
            agent = self.agents.get(j)
            if agent is None:
                return
            was_down = agent["status"] == "DISCONNECTED"
            agent.update(status="RUNNING", last_seen=now, state=message, camera_id=cam, data_class=data_class, approaches=approaches)
            self.tracker.work("agent")
            region = self.region_of.get(j)
            if was_down:
                self._msg("agent_reconnected", j, region or CENTRAL, cam, {}, data_class, stage="agent", text=f"{j} is receiving traffic state again")
            self._msg("traffic_state", cam, j, cam, {"state": message}, data_class, stage="analytics", to_stage="agent", text=f"{cam} sent traffic state to {j}")
            self._msg("heartbeat", j, region or CENTRAL, cam, {}, data_class, stage="agent", text=f"{j} heartbeat")
            demand = axis_demand(approaches)
            self.board.publish(AgentObservation(j, demand["NS"]["queue"], demand["EW"]["queue"], timestamp=now, occupancy=message.get("lane_occupancy") or 0.0))
            congested = message.get("congestion_level") in ("HIGH", "SEVERE")
            downstream = message.get("downstream_capacity")
            saturated = downstream is not None and 1.0 - downstream >= HIERARCHY["exit_saturated_occupancy"]
            if not region:
                return
            if (congested or saturated) and region not in self.escalated:
                self.escalated.add(region)
                self.counts["alerts"] += 1
                self._msg("congestion_alert", j, region, cam, {"congestion_level": message.get("congestion_level")}, data_class, level="warn", stage="agent", to_stage="coordination",
                          text=f"{j} reports {message.get('congestion_level')} congestion to {region}")
                self._msg("regional_escalation", region, CENTRAL, cam, {"junctions": self.regions[region]}, data_class, level="warn", text=f"{region} asks the central supervisor to review its plans")
            elif region in self.escalated and not congested and not saturated and not any(self._still_congested(m) for m in self.regions[region]):
                self.escalated.discard(region)
                self._msg("regional_clear", region, CENTRAL, cam, {}, data_class, text=f"{region} has recovered")

    def _still_congested(self, j: str) -> bool:
        state = (self.agents.get(j) or {}).get("state") or {}
        return state.get("congestion_level") in ("HIGH", "SEVERE")

    def due(self, j: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self.lock:
            agent = self.agents.get(j)
            return bool(agent and agent["state"] and agent["status"] == "RUNNING" and agent.get("approaches") and now - agent["last_decision_at"] >= DECISION_INTERVAL_S)

    def propose(self, j: str, ctx: sig.PlanContext, now: float | None = None) -> dict | None:
        """Agent and coordination. Returns a proposal for the validator, or None when the data cannot support one."""
        now = time.time() if now is None else now
        with self.lock:
            if not self.due(j, now):
                return None
            agent = self.agents[j]
            agent["last_decision_at"] = now
            cam, data_class = agent["camera_id"], agent.get("data_class")
            demand = axis_demand(agent["approaches"])
            if demand["NS"]["vehicles"] + demand["EW"]["vehicles"] == 0:
                return None
            self.counts["requests"] += 1
            region = self.region_of.get(j, CENTRAL)
            self._msg("signal_plan_request", j, region, cam, {"demand": demand}, data_class, stage="agent", to_stage="coordination", text=f"{j} requests a signal plan")
            pressure = self.board.neighbor_pressure(j, now)
            # Moving vehicles count for less than waiting ones, but a free-flowing approach still has demand.
            traffic = TrafficState(j, ns_queue=demand["NS"]["queue"] + 0.25 * demand["NS"]["vehicles"], ew_queue=demand["EW"]["queue"] + 0.25 * demand["EW"]["vehicles"],
                                   ns_arrival=demand["NS"]["arrival"], ew_arrival=demand["EW"]["arrival"], ns_wait=demand["NS"]["wait"], ew_wait=demand["EW"]["wait"],
                                   current_phase=0 if ctx.current_axis == "NS" else 1)
            result = optimize(traffic, self.board.pheromone, pressure, SwarmConfig(min_green=int(ctx.min_green_s), max_green=int(ctx.max_green_s)),
                              seed=stable_seed(j, int(now / DECISION_INTERVAL_S)), neighbors=self.board.neighbors.get(j, []))
            self.board.evaporate()
            green = float(result["green_seconds"])
            # The search is random and can occasionally settle on the worse direction, so its green time is
            # compared for both directions under the same objective it optimizes.
            axis = min(sig.AXES, key=lambda a: objective(traffic, a, green, pressure, self.board.pheromone.get(f"{j}:{a}")))
            other_axis = "EW" if axis == "NS" else "NS"
            served, other = demand[axis], demand[other_axis]
            reason = (f"{axis}: {served['vehicles']} vehicles, {served['queue']:.0f} queued. "
                      f"{other_axis}: {other['vehicles']} vehicles, {other['queue']:.0f} queued. Neighbour pressure {pressure:.0f}.")
            verdict = None
            downstream = agent["state"].get("downstream_capacity")
            if region in self.escalated:
                verdict, reviewed = review_extension(green, ctx.elapsed_s, ctx.min_green_s, 0.0 if downstream is None else 1.0 - downstream, other["queue"])
                self._msg("central_decision", CENTRAL, j, cam, {"verdict": verdict, "proposed_green_s": green, "approved_green_s": reviewed}, data_class,
                          text=f"Central review of {j}: {verdict.replace('_', ' ')}")
                self.central_beat = now
                if verdict == "cut_back":
                    self.counts["cut_back"] += 1
                    reason += f" Road ahead is nearly full: central cut the green from {green:.0f}s to {reviewed:.0f}s."
                    green = reviewed
            self.counts["proposals"] += 1
            self.tracker.work("coordination")
            proposal = {"intersection_id": j, "camera_id": cam, "axis": axis, "green_s": round(green, 1), "reason": reason, "demand": demand, "algorithm": result["algorithm"],
                        "score": result["score"], "neighbour_pressure": round(pressure, 1), "central_verdict": verdict, "region": region, "data_class": data_class,
                        "state_timestamp": agent["last_seen"], "emergency": "not used: camera classes do not identify emergency vehicles reliably"}
            agent["proposal"] = proposal
            self._msg("signal_plan_proposal", j, "SAFETY", cam, {"axis": axis, "green_s": proposal["green_s"], "reason": reason}, data_class, to_stage="safety",
                      text=f"{j} proposes {axis} green for {proposal['green_s']:.0f}s")
            return proposal

    def record_decision(self, j: str, proposal: dict, validation: sig.Validation, outcome: dict) -> None:
        with self.lock:
            accepted = validation.status != "REJECTED"
            self.counts["accepted" if accepted else "rejected"] += 1
            agent = self.agents.get(j)
            if agent:
                agent["decision"] = {"status": validation.status, "approved_axis": validation.approved_axis, "approved_green_s": validation.approved_green_s, "reasons": validation.reasons, "at": iso()}
            self._msg("plan_accepted" if accepted else "plan_rejected", "SAFETY", j, proposal["camera_id"], {"status": validation.status, "reasons": validation.reasons, "outcome": outcome},
                      proposal.get("data_class"), stage="safety", to_stage="signal" if accepted else None, level="info" if accepted else "warn",
                      text=f"Safety {validation.status.lower()} {proposal['axis']} at {j}: {'; '.join(validation.reasons)}")

    def watchdog(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self.lock:
            for j, agent in self.agents.items():
                if agent["status"] == "RUNNING" and agent["last_seen"] and now - agent["last_seen"] > AGENT_TIMEOUT_S:
                    agent["status"] = "DISCONNECTED"
                    self._msg("agent_disconnected", j, self.region_of.get(j, CENTRAL), agent["camera_id"], {}, agent.get("data_class"), stage="agent", level="warn",
                              text=f"{j} has received no traffic state for {AGENT_TIMEOUT_S:.0f}s")

    def snapshot(self) -> dict:
        now = time.time()
        with self.lock:
            return {
                "agents": [{"id": a["id"], "status": a["status"], "camera_id": a["camera_id"], "region": self.region_of.get(a["id"]), "neighbours": self.board.neighbors.get(a["id"], []),
                            "last_heartbeat": iso(a["last_seen"]) if a["last_seen"] else None, "state": a["state"], "proposal": a["proposal"], "decision": a["decision"]} for a in self.agents.values()],
                "regions": [{"id": r, "junctions": m, "escalated": r in self.escalated} for r, m in self.regions.items()],
                "central": {"id": CENTRAL, "reviewing": sorted(self.escalated), "last_review": iso(self.central_beat) if self.central_beat else None,
                            "active": bool(self.central_beat and now - self.central_beat < 30)},
                "counts": dict(self.counts),
            }
