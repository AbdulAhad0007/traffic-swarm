"""Green wave by junction-to-junction platoon calls - SIMULATION ONLY.

When a junction releases vehicles towards a neighbouring signal, it *calls* that neighbour:
"N vehicles are coming to your link L, first one in ~t1 s, last one in ~t2 s". The receiving
agent then re-times itself so the platoon can pass without stopping (fewer stops = less fuel
and less queueing), but only through the same safe actions as Controller V2:

  target green active      -> extend it to cover the platoon tail (never beyond max_green_s)
  conflicting green active -> end it early so the target green starts as the platoon arrives,
                              but only after its minimum green and only if the current green
                              serves less traffic than the platoon ("current_demand_higher")
  yellow / all-red / clearance -> never touched; the call is deferred until a green is active

Every proposed change goes through the SafetyGate (min/max green, max-red anti-starvation) and
apply_green_duration (re-checks SUMO's phase and state). The optimizer's next decision tick
respects an accepted call ("commitment") so a call is not undone a few seconds later.

Every call is traced end to end in swarm_calls.jsonl:
  sent_at -> deliver_at (comm latency, optional jitter/loss) -> received_at (step quantization)
  -> responded_at (deferral while the receiver is in transition) -> response + reason
  -> outcome: did the announced vehicles really pass the receiver without stopping, how far off
     the ETA was, and why vehicles that stopped did stop (red at arrival / queue ahead / ...).
The pure decision function `plan_response` is TraCI-free and unit tested.

Calls travel over explicit neighbour channels: `send_platoon_alert(sender, target_id, count, eta)` is the
single entry point (used by the platoon detector and available to other agents), every (sender, receiver)
pair keeps its own channel counters, and a human-readable inter-agent log is written to swarm_messages.jsonl.
"""
from __future__ import annotations
import json, math, random, statistics, time
from dataclasses import dataclass, field
from pathlib import Path
try:
    import traci
    import traci.constants as tc
except ImportError:
    traci = None
    tc = None
from simulation.network.phase_map import GreenPhase

DEFAULTS = {
    "batch_window_s": 2.0,          # vehicles released within this window form one platoon call
    "platoon_max_vehicles": 8,      # a call is sent immediately when this many vehicles are batched
    "comm_latency_s": 0.0,          # simulated one-way message latency (0 = same simulation step)
    "comm_jitter_s": 0.0,           # uniform extra latency in [0, jitter]
    "drop_probability": 0.0,        # simulated message loss (diagnostics / robustness tests)
    "eta_speed_factor": 0.8,        # ETA speed = max(current speed, factor * allowed speed)
    "min_eta_speed_mps": 3.0,
    "max_eta_s": 60.0,              # vehicles further away than this are not announced
    "arrival_margin_s": 2.0,        # extra green after the platoon tail's ETA
    "startup_lost_s": 1.0,          # target green should start this much before the platoon head
    "switch_max_served_queue": 2,   # early switch allowed if current served queue <= max(this, platoon/2)
    "outcome_timeout_s": 120.0,     # after the tail ETA: unresolved vehicles are reported as such
    "max_defer_s": 30.0,            # a call deferred longer than this is answered 'expired'
}
STOPPED_MPS = 0.1
RESP_EXTEND, RESP_PARTIAL, RESP_SWITCH, RESP_NOCHANGE, RESP_DECLINED, RESP_DEFER = (
    "extend", "partial_extend", "early_switch", "no_change", "declined", "defer")
PROMISES_GREEN = {RESP_EXTEND, RESP_SWITCH, RESP_NOCHANGE}


def plan_response(now: float, eta_head: float, eta_tail: float, current: GreenPhase | None, elapsed: float,
                  planned_total: float | None, target: GreenPhase, next_green: int | None, served_queue: float,
                  platoon_size: int, max_green: float, cfg: dict, hold_active: bool = False):
    """Decide how a receiving agent answers a platoon call.

    eta_head/eta_tail are absolute simulation times. Returns (response, total_green, reason) where
    total_green is the new total length of the CURRENT green measured from its start (None = no change).
    """
    if current is None:
        return RESP_DEFER, None, "receiver_in_transition"
    margin = float(cfg["arrival_margin_s"])
    upper = max(float(max_green), current.min_green)
    if current.index == target.index:
        needed = elapsed + max(0.0, eta_tail - now) + margin
        if planned_total is not None and planned_total >= needed:
            return RESP_NOCHANGE, None, "green_already_covers_platoon"
        if needed <= upper:
            return RESP_EXTEND, needed, "extend_to_cover_platoon_tail"
        if planned_total is not None and planned_total >= upper:
            return RESP_DECLINED, None, "max_green_reached"
        return RESP_PARTIAL, upper, "clamped_max_green"
    if next_green != target.index:
        return RESP_DECLINED, None, "target_not_next_phase"
    if hold_active:
        return RESP_DECLINED, None, "current_green_held_for_other_platoon"
    transition = current.yellow_s + current.all_red_s + current.clearance_s
    desired_end_in = (eta_head - now) - transition - float(cfg["startup_lost_s"])
    earliest_end_in = max(0.0, current.min_green - elapsed)
    end_in = max(desired_end_in, earliest_end_in, 0.0)
    planned_end_in = math.inf if planned_total is None else planned_total - elapsed
    if planned_end_in <= end_in + 1e-9:
        return RESP_NOCHANGE, None, "switch_already_on_time"
    if served_queue > max(float(cfg["switch_max_served_queue"]), platoon_size * 0.5):
        return RESP_DECLINED, None, "current_demand_higher"
    reason = "early_switch_limited_by_min_green" if earliest_end_in > desired_end_in else "early_switch_on_time"
    return RESP_SWITCH, elapsed + end_in, reason


def _pct(values):
    if not values:
        return {"n": 0, "mean": None, "p50": None, "p95": None, "max": None}
    v = sorted(values)
    pick = lambda q: round(v[min(len(v) - 1, int(q * len(v)))], 3)
    return {"n": len(v), "mean": round(statistics.fmean(v), 3), "p50": pick(0.5), "p95": pick(0.95), "max": round(v[-1], 3)}


@dataclass
class Call:
    id: str
    sender: str
    receiver: str
    target_phase: int
    sent_at: float
    deliver_at: float | None               # None = message lost
    vehicles: dict                          # vid -> {"eta_at", "dist_m", "link", "approach_edge"}
    eta_head: float
    eta_tail: float
    received_at: float | None = None
    responded_at: float | None = None
    response: str | None = None
    reason: str | None = None
    total_set_s: float | None = None
    handler_ms: float = 0.0
    attempts: int = 0
    defer_reasons: list = field(default_factory=list)
    follow_up: dict | None = None
    track: dict = field(default_factory=dict)   # vid -> {"seen", "stopped", "cause", "passed_at"}
    closed: bool = False

    def record(self) -> dict:
        lat = None if self.responded_at is None else round(self.responded_at - self.sent_at, 3)
        breakdown = {}
        if self.deliver_at is not None:
            breakdown["comm_latency_s"] = round(self.deliver_at - self.sent_at, 3)
            if self.received_at is not None:
                breakdown["step_quantization_s"] = round(self.received_at - self.deliver_at, 3)
                if self.responded_at is not None:
                    breakdown["deferred_s"] = round(self.responded_at - self.received_at, 3)
        passed = [t for t in self.track.values() if t["passed_at"] is not None]
        no_stop = sum(1 for t in passed if not t["stopped"])
        stopped = sum(1 for t in self.track.values() if t["stopped"])
        eta_err = [round(t["passed_at"] - self.vehicles[v]["eta_at"], 3) for v, t in self.track.items() if t["passed_at"] is not None]
        causes = {}
        for t in self.track.values():
            if t["stopped"]:
                causes[t["cause"]] = causes.get(t["cause"], 0) + 1
        if not passed:
            outcome = "unresolved"
        elif stopped == 0 and len(passed) == len(self.vehicles):
            outcome = "green_arrival"
        elif no_stop == 0:
            outcome = "stopped"
        else:
            outcome = "partial"
        correct = (outcome == "green_arrival") if self.response in PROMISES_GREEN else None
        return {"call_id": self.id, "from": self.sender, "to": self.receiver, "target_phase": self.target_phase,
                "vehicles": len(self.vehicles), "sent_at": self.sent_at,
                "eta_head_s": round(self.eta_head - self.sent_at, 2), "eta_tail_s": round(self.eta_tail - self.sent_at, 2),
                "delivered": self.deliver_at is not None, "received_at": self.received_at,
                "responded_at": self.responded_at, "response": self.response, "reason": self.reason,
                "total_green_set_s": self.total_set_s, "response_latency_s": lat, "latency_breakdown": breakdown,
                "defer_reasons": sorted(set(self.defer_reasons)), "handler_ms": round(self.handler_ms, 3),
                "follow_up": self.follow_up, "outcome": outcome, "response_correct": correct,
                "passed": len(passed), "passed_without_stop": no_stop, "stopped": stopped, "stop_causes": causes,
                "eta_error_s": eta_err}


class GreenWave:
    """Platoon calls between agents. Owned by AdaptiveController; `step` runs once per SUMO step."""

    def __init__(self, controller, model, settings: dict, seed: int):
        self.ctl = controller
        self.model = model
        self.cfg = {**DEFAULTS, **(settings.get("green_wave") or {})}
        self.rng = random.Random(seed * 7919 + 17)
        self.max_green = float(settings["max_green_s"])
        self.exit_lanes: dict[str, str] = {}      # lane -> sender tls
        for tid, tl in model.tls.items():
            for links in tl.links.values():
                for link in links:
                    if not link.pedestrian and link.to_lane:
                        self.exit_lanes.setdefault(link.to_lane, tid)
        self.prev_ids: dict[str, set] = {}
        self.batches: dict[tuple, dict] = {}
        self.inflight: list[Call] = []
        self.pending: list[Call] = []             # delivered, waiting for a green at the receiver
        self.open: list[Call] = []                # responded, outcome being tracked
        self.done: list[dict] = []
        self.commitments: dict[str, list] = {}    # tls -> [{"phase","kind","total","until","call"}]
        self.n = 0
        self.kept_by_optimizer = 0
        self.channels: dict[tuple, dict] = {}     # (sender, receiver) -> channel counters
        self.messages: list[dict] = []            # inter-agent log (swarm_messages.jsonl)

    # ------------------------------------------------------------------ setup
    def start(self, session) -> None:
        vars_ = [tc.LAST_STEP_VEHICLE_HALTING_NUMBER, tc.LAST_STEP_OCCUPANCY, tc.LAST_STEP_VEHICLE_ID_LIST]
        known = set(traci.lane.getIDList())
        for lane in self.exit_lanes:
            if lane in known:
                traci.lane.subscribe(lane, vars_)   # replaces the session subscription with a superset

    # ------------------------------------------------------------------ optimizer integration
    def commitment(self, tls: str, phase: int, now: float):
        """Active accepted call for this junction's current green, merged into one constraint."""
        items = [c for c in self.commitments.get(tls, []) if c["phase"] == phase and c["until"] >= now]
        self.commitments[tls] = items
        if not items:
            return None
        holds = [c for c in items if c["kind"] == "hold"]
        if holds:
            best = max(holds, key=lambda c: c["total"])
            return {"kind": "hold", "total": best["total"], "call": best["call"]}
        best = min(items, key=lambda c: c["total"])
        return {"kind": "end_by", "total": best["total"], "call": best["call"]}

    def constrain(self, tls: str, phase: int, now: float, total: float):
        """Apply a commitment to an optimizer total. Returns (total, call_id or None)."""
        c = self.commitment(tls, phase, now)
        if c is None:
            return total, None
        new = max(total, c["total"]) if c["kind"] == "hold" else min(total, c["total"])
        if abs(new - total) > 1e-9:
            self.kept_by_optimizer += 1
        return new, c["call"]

    # ------------------------------------------------------------------ per step
    def step(self, session) -> None:
        now = session.now
        self._detect(session, now)
        self._flush(now, force=False)
        self._deliver(session, now)
        self._track(session, now)

    def _detect(self, session, now):
        for lane, sender in self.exit_lanes.items():
            v = session.lane_values.get(lane)
            if not v or tc.LAST_STEP_VEHICLE_ID_LIST not in v:
                continue
            ids = set(v[tc.LAST_STEP_VEHICLE_ID_LIST])
            new = ids - self.prev_ids.get(lane, set())
            self.prev_ids[lane] = ids
            for vid in sorted(new):
                self._announce(sender, vid, now)

    def _announce(self, sender, vid, now):
        try:
            upcoming = traci.vehicle.getNextTLS(vid)
            speed = traci.vehicle.getSpeed(vid)
            allowed = traci.vehicle.getAllowedSpeed(vid)
        except Exception:
            return
        nxt = next((u for u in upcoming if u[0] != sender), None)
        if nxt is None:
            return
        receiver, link, dist = nxt[0], int(nxt[1]), float(nxt[2])
        agent = self.ctl.agents.get(receiver)
        if agent is None:
            return
        target = next((g for g in agent.phase_map.greens if link in g.served_links), None)
        if target is None:
            return
        eta = dist / max(speed, float(self.cfg["eta_speed_factor"]) * allowed, float(self.cfg["min_eta_speed_mps"]))
        if eta > float(self.cfg["max_eta_s"]):
            return
        links = self.model.tls[receiver].links.get(link, [])
        approach = next((l.from_edge for l in links if not l.pedestrian), None)
        key = (sender, receiver, target.index)
        batch = self.batches.setdefault(key, {"first": now, "vehicles": {}})
        batch["vehicles"][vid] = {"eta_at": round(now + eta, 3), "dist_m": round(dist, 1), "link": link,
                                  "approach_edge": approach}
        if len(batch["vehicles"]) >= int(self.cfg["platoon_max_vehicles"]):
            self._send(key, now)

    def _flush(self, now, force):
        for key in [k for k, b in self.batches.items() if force or now - b["first"] >= float(self.cfg["batch_window_s"])]:
            self._send(key, now)

    def _send(self, key, now):
        batch = self.batches.pop(key)
        etas = [v["eta_at"] for v in batch["vehicles"].values()]
        self.send_platoon_alert(key[0], key[1], len(etas), min(etas) - now, target_phase=key[2],
                                vehicles=batch["vehicles"], now=now)

    def send_platoon_alert(self, sender: str, target_id: str, count: int, eta: float, *, now: float,
                           target_phase: int | None = None, vehicles: dict | None = None) -> Call:
        """Send "`count` vehicles reach you in ~`eta` s" from `sender` to its neighbour `target_id`.

        `vehicles` (vid -> eta/link details) enables per-vehicle outcome tracking; without it the call is
        still delivered and answered but its outcome stays 'unresolved'. Returns the Call.
        """
        if target_phase is None:
            target_phase = self.ctl.agents[target_id].phase_map.greens[0].index
        vehicles = vehicles or {}
        etas = [v["eta_at"] for v in vehicles.values()] or [now + eta]
        self.n += 1
        lost = self.rng.random() < float(self.cfg["drop_probability"])
        latency = float(self.cfg["comm_latency_s"]) + self.rng.uniform(0.0, float(self.cfg["comm_jitter_s"]))
        call = Call(f"C{self.n:06d}", sender, target_id, target_phase, now, None if lost else now + latency,
                    vehicles, min(etas), max(etas))
        call.track = {v: {"seen": False, "stopped": False, "cause": None, "passed_at": None} for v in vehicles}
        ch = self.channels.setdefault((sender, target_id), {"sent": 0, "lost": 0, "vehicles": 0, "last_sent_at": None})
        ch["sent"] += 1
        ch["vehicles"] += count
        ch["last_sent_at"] = now
        self._message(now, sender, target_id, "platoon_alert",
                      f"Broadcasting {count} veh to {target_id} (ETA {max(0.0, call.eta_head - now):.0f}s, "
                      f"phase {target_phase})." + (" Message lost." if lost else ""))
        if lost:
            ch["lost"] += 1
            call.response, call.reason = None, "message_lost"
            self.open.append(call)          # still track the vehicles: what happens without the call
        else:
            self.inflight.append(call)
        return call

    def _message(self, now, sender, receiver, kind, text):
        self.messages.append({"time": round(now, 2), "from": sender, "to": receiver, "kind": kind, "text": text})

    def _deliver(self, session, now):
        still = []
        for call in self.inflight:
            if call.deliver_at <= now + 1e-9:
                call.received_at = now
                self.pending.append(call)
            else:
                still.append(call)
        self.inflight = still
        waiting = []
        for call in self.pending:
            if not self._handle(call, session, now):
                waiting.append(call)
        self.pending = waiting
        for call in self.open:
            fu = call.follow_up
            if fu is not None and fu.get("status") == "waiting" and not call.closed:
                agent = self.ctl.agents[call.receiver]
                if agent.current_phase == call.target_phase and agent.current_green() is not None:
                    self._follow_up(call, session, now)

    def _receiver_blocked(self, call):
        agent = self.ctl.agents[call.receiver]
        if not agent.active:
            return f"receiver_{agent.mode}"
        for hook in self.ctl.hooks:
            if hasattr(hook, "locked_tls") and call.receiver in set(hook.locked_tls()):
                return "emergency_priority"
        return None

    def _handle(self, call, session, now) -> bool:
        """Answer one delivered call. Returns False if it stays deferred."""
        t0 = time.perf_counter()
        call.attempts += 1
        try:
            blocked = self._receiver_blocked(call)
            if blocked:
                self._respond(call, now, RESP_DECLINED, blocked)
                return True
            if now - call.received_at > float(self.cfg["max_defer_s"]) or now > call.eta_tail:
                self._respond(call, now, RESP_DECLINED, "expired_platoon_already_arrived")
                return True
            response, total, reason = self._plan(call, session, now)
            if response == RESP_DEFER:
                call.defer_reasons.append(reason)
                return False
            if total is not None:
                response, total, reason = self._apply(call, session, now, response, total, reason)
            self._respond(call, now, response, reason, total)
            if response == RESP_SWITCH or (response == RESP_NOCHANGE and reason == "switch_already_on_time"):
                call.follow_up = {"status": "waiting"}     # re-check tail coverage when the target green starts
            return True
        finally:
            call.handler_ms += (time.perf_counter() - t0) * 1000

    def _plan(self, call, session, now):
        agent = self.ctl.agents[call.receiver]
        current = agent.current_green()
        target = agent.phase_map.green_by_index(call.target_phase)
        elapsed = now - agent.phase_start
        served = 0.0
        next_green = None
        if current is not None:
            served = float(sum(session.halting(l) for l in current.served_lanes))
            greens = agent.phase_map.greens
            pos = next(i for i, g in enumerate(greens) if g.index == current.index)
            next_green = greens[(pos + 1) % len(greens)].index
        hold = self.commitment(call.receiver, agent.current_phase, now)
        return plan_response(now, call.eta_head, call.eta_tail, current, elapsed, agent.planned_total, target,
                             next_green, served, len(call.vehicles), self.max_green, self.cfg,
                             hold_active=bool(hold and hold["kind"] == "hold"))

    def _apply(self, call, session, now, response, total, reason):
        from simulation.swarm.adaptive_controller import apply_green_duration
        agent = self.ctl.agents[call.receiver]
        green = agent.current_green()
        obs = agent.observe(now, session.halting, session.occupancy)
        decision = self.ctl.safety.validate_green_plan(total, obs.elapsed, green.min_green, risk=0.0,
                                                       competing_red=obs.competing_red,
                                                       competing_demand=obs.competing_demand)
        if not decision.allowed:
            return RESP_DECLINED, None, f"safety:{decision.reason}"
        if decision.reason == "fairness_max_red" and response in (RESP_EXTEND, RESP_PARTIAL):
            return RESP_DECLINED, None, "safety:fairness_max_red"
        applied = decision.green_seconds
        ok, why = apply_green_duration(traci.trafficlight, agent.tls_id, green.index, green.state,
                                       max(0.0, applied - obs.elapsed))
        if not ok:
            return RESP_DECLINED, None, why
        agent.planned_total = applied
        kind = "hold" if response in (RESP_EXTEND, RESP_PARTIAL) else "end_by"
        until = call.eta_tail + float(self.cfg["arrival_margin_s"]) if kind == "hold" else call.eta_head
        self.commitments.setdefault(agent.tls_id, []).append(
            {"phase": green.index, "kind": kind, "total": applied, "until": until, "call": call.id})
        if decision.reason not in ("validated",):
            reason = f"{reason}+{decision.reason}"
        return response, round(applied, 3), reason

    def _follow_up(self, call, session, now):
        response, total, reason = self._plan(call, session, now)
        if total is not None and response in (RESP_EXTEND, RESP_PARTIAL):
            response, total, reason = self._apply(call, session, now, response, total, reason)
        call.follow_up = {"status": "done", "at": now, "response": response, "reason": reason, "total_green_set_s": total}

    def _respond(self, call, now, response, reason, total=None):
        call.responded_at, call.response, call.reason, call.total_set_s = now, response, reason, total
        self.open.append(call)
        plan = f", green set to {total:.0f}s" if total is not None else ""
        self._message(now, call.receiver, call.sender, "response",
                      f"Received lookahead alert {call.id} from {call.sender}: {len(call.vehicles)} veh, "
                      f"ETA {max(0.0, call.eta_head - now):.0f}s -> {response} ({reason}{plan}).")

    # ------------------------------------------------------------------ outcome verification
    def _track(self, session, now):
        values = session.vehicle_values
        states = session.tl_values
        keep = []
        for call in self.open:
            for vid, t in call.track.items():
                if t["passed_at"] is not None:
                    continue
                v = values.get(vid)
                if v is None:
                    t["passed_at"] = None
                    t.setdefault("lost", True)
                    continue
                road, speed = v[tc.VAR_ROAD_ID], v[tc.VAR_SPEED]
                approach = call.vehicles[vid]["approach_edge"]
                if road == approach:
                    t["seen"] = True
                    if speed < STOPPED_MPS and not t["stopped"]:
                        t["stopped"] = True
                        st = states.get(call.receiver)
                        link = call.vehicles[vid]["link"]
                        sig = st[tc.TL_RED_YELLOW_GREEN_STATE][link] if st else "?"
                        t["cause"] = "queue_ahead_on_green" if sig in "Gg" else "red_or_yellow_at_arrival"
                elif t["seen"]:
                    t["passed_at"] = now
                elif speed < STOPPED_MPS and not t["stopped"] and not road.startswith(":"):
                    t["stopped"], t["cause"] = True, "stopped_before_receiver_approach"
            resolved = all(t["passed_at"] is not None or t.get("lost") for t in call.track.values())
            if resolved or now > call.eta_tail + float(self.cfg["outcome_timeout_s"]):
                self._close(call)
            else:
                keep.append(call)
        self.open = keep

    def _close(self, call):
        if call.closed:
            return
        call.closed = True
        self.done.append(call.record())

    # ------------------------------------------------------------------ reporting
    def finish(self, out_dir) -> dict:
        for call in self.inflight:
            call.reason = "undelivered_at_end"
            self._close(call)
        for call in self.pending:
            call.response, call.reason = None, "unanswered_at_end:" + ",".join(sorted(set(call.defer_reasons)))
            self._close(call)
        for call in self.open:
            self._close(call)
        self.inflight, self.pending, self.open = [], [], []
        with (Path(out_dir) / "swarm_calls.jsonl").open("w", encoding="utf-8") as f:
            for r in self.done:
                f.write(json.dumps(r) + "\n")
        with (Path(out_dir) / "swarm_messages.jsonl").open("w", encoding="utf-8") as f:
            for m in self.messages:
                f.write(json.dumps(m) + "\n")
        summary = summarize_calls(self.done, self.kept_by_optimizer, self.cfg)
        summary["channels"] = {f"{a}->{b}": v for (a, b), v in sorted(self.channels.items())}
        summary["messages_logged"] = len(self.messages)
        return {"green_wave": summary}


def summarize_calls(records: list, kept_by_optimizer: int = 0, cfg: dict | None = None) -> dict:
    count = lambda key: dict(sorted(((k, sum(1 for r in records if key(r) == k)) for k in {key(r) for r in records}),
                                    key=lambda kv: -kv[1]))
    answered = [r for r in records if r["response"] is not None]
    promised = [r for r in records if r["response_correct"] is not None]
    delays = {}
    for r in answered:
        b = r["latency_breakdown"]
        for name in ("comm_latency_s", "step_quantization_s", "deferred_s"):
            if b.get(name, 0) > 0:
                delays[name] = delays.get(name, 0) + 1
        for why in r["defer_reasons"]:
            delays[f"deferred:{why}"] = delays.get(f"deferred:{why}", 0) + 1
    causes = {}
    for r in records:
        for k, v in r["stop_causes"].items():
            causes[k] = causes.get(k, 0) + v
    announced = sum(r["vehicles"] for r in records)
    pairs = {}
    for r in records:
        p = pairs.setdefault(f"{r['from']}->{r['to']}", {"calls": 0, "vehicles": 0, "no_stop": 0, "passed": 0})
        p["calls"] += 1; p["vehicles"] += r["vehicles"]; p["no_stop"] += r["passed_without_stop"]; p["passed"] += r["passed"]
    top = dict(sorted(pairs.items(), key=lambda kv: -kv[1]["calls"])[:15])
    passed = sum(r["passed"] for r in records)
    return {
        "calls_sent": len(records), "calls_delivered": sum(1 for r in records if r["delivered"]),
        "calls_answered": len(answered), "vehicles_announced": announced,
        "responses": count(lambda r: r["response"]), "response_reasons": count(lambda r: f"{r['response']}:{r['reason']}"),
        "response_latency_s": _pct([r["response_latency_s"] for r in answered]),
        "handler_ms": _pct([r["handler_ms"] for r in records if r["handler_ms"]]),
        "delay_sources": dict(sorted(delays.items(), key=lambda kv: -kv[1])),
        "outcomes": count(lambda r: r["outcome"]),
        "response_correct_rate": round(sum(1 for r in promised if r["response_correct"]) / len(promised), 4) if promised else None,
        "promised_green_calls": len(promised),
        "outcome_by_response": {resp: count(lambda r: r["outcome"]) if False else
                                {o: sum(1 for r in records if r["response"] == resp and r["outcome"] == o)
                                 for o in {r["outcome"] for r in records if r["response"] == resp}}
                                for resp in {r["response"] for r in records}},
        "announced_vehicles_passed": passed,
        "announced_vehicles_without_stop_share": round(sum(r["passed_without_stop"] for r in records) / passed, 4) if passed else None,
        "stop_causes": dict(sorted(causes.items(), key=lambda kv: -kv[1])),
        "eta_abs_error_s": _pct([abs(e) for r in records for e in r["eta_error_s"]]),
        "optimizer_decisions_constrained_by_calls": kept_by_optimizer,
        "busiest_pairs": top,
        "settings": cfg,
    }
