"""SUMO/TraCI swarm controller driven by the network's real signal programs.

Phase 1 (Controller V2) behaviour:
- intersections, signal programs, controlled movements and neighbors are discovered from the
  network file (no J1-J9 / NS-EW / phase-parity assumptions);
- only green phases are ever re-timed, and only through setPhaseDuration on the green that the
  decision was made for (re-checked immediately before applying); yellow, all-red and pedestrian
  clearance phases always run with their programmed durations;
- every proposal, rejection and application is logged with a reason;
- optimizer failures leave the current plan unchanged, and repeated failures put that agent in
  fallback mode (the SUMO program runs unmodified).
"""
import csv, json, statistics, time
from pathlib import Path
try:
    import traci
    import traci.constants as tc
except ImportError:
    traci = None
    tc = None
from optimizer.app.swarm.engine import TrafficState, PheromoneMap, optimize, stable_seed
from optimizer.app.swarm.blackboard import SwarmBlackboard, AgentObservation
from simulation.safety.risk_field import SafetyGate
from simulation.metrics import sumo_kpis
from simulation.safety.signal_audit import build_auditor
from simulation.coordination.multi_agent_coordinator import MultiAgentCoordinator, AgentDecision
from simulation.network.network_model import NetworkModel
from simulation.network.phase_map import build_all
from simulation.network.presets import resolve_preset, LEGACY_PRESET
from simulation.runtime import SumoSession, net_file_from_cfg
from simulation.swarm.signal_agent import (SignalAgent, MODE_SWARM, downstream_saturation, interpret)
from simulation.telemetry import TelemetryCollector

DECISION_FIELDS = ["time", "tick", "intersection", "phase_index", "phase_axis", "elapsed_s", "served_queue",
                   "competing_queue", "competing_red_s", "downstream_saturation", "neighbors_fresh",
                   "neighbors_stale", "neighbors_missing", "neighbor_pressure", "direction", "green_seconds",
                   "score", "action", "proposed_total_s", "coordinated_total_s", "status", "reason",
                   "applied_total_s", "remaining_set_s", "optimizer_ms", "algorithm", "input_source",
                   "predicted_served", "predicted_competing", "green_wave_call"]


def apply_green_duration(api, tls_id: str, phase_index: int, expected_state: str, remaining: float) -> tuple[bool, str]:
    """Set the remaining duration of a green phase, but only if SUMO is still in exactly that green.

    `api` is the traci.trafficlight module (or a test double). Never touches transition phases.
    """
    try:
        if api.getPhase(tls_id) != phase_index:
            return False, "phase_changed_before_apply"
        if api.getRedYellowGreenState(tls_id) != expected_state:
            return False, "state_mismatch_before_apply"
        api.setPhaseDuration(tls_id, max(0.0, float(remaining)))
        return True, "phase_duration_updated"
    except Exception as exc:  # TraCI errors must not crash the run; agent keeps the native plan
        return False, f"apply_failed:{type(exc).__name__}"


def _percentiles(values):
    if not values:
        return {"n": 0, "mean": None, "p95": None, "max": None}
    ordered = sorted(values)
    return {"n": len(values), "mean": round(statistics.fmean(values), 3),
            "p95": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 3), "max": round(ordered[-1], 3)}


class AdaptiveController:
    def __init__(self, seed=42, decision_interval=None, settings=None, gui=None, optimizer=optimize,
                 hooks=None, port=None, predictor=None):
        self.seed = seed
        self.settings = dict(settings or resolve_preset(LEGACY_PRESET)["controller"])
        if decision_interval is not None:
            self.settings["decision_interval_s"] = decision_interval
        s = self.settings
        self.decision_interval = float(s["decision_interval_s"])
        self.safety = SafetyGate(min_green=s["min_green_s"], max_green=s["max_green_s"], max_risk=s["max_risk"],
                                 max_red=s["max_red_s"])
        self.gui = gui
        self.optimizer = optimizer
        self.agents: dict[str, SignalAgent] = {}
        self.hooks = list(hooks or [])
        self.port = port
        # Ablation switches (defaults = full controller). The safety gate has no switch.
        self.use_blackboard = bool(s.get("use_blackboard", True))
        self.use_pheromone = bool(s.get("use_pheromone", True))
        self.use_prediction = bool(s.get("use_prediction", False))
        self.use_green_wave = bool(s.get("use_green_wave", True))
        self.green_wave = None
        self.predictor = predictor
        if self.use_prediction and self.predictor is None:
            from simulation.prediction.online import OnlinePredictor
            self.predictor = OnlinePredictor.from_settings(s.get("prediction", {}))

    # ------------------------------------------------------------------ setup
    def build_agents(self, model: NetworkModel) -> dict:
        graph = model.neighbor_graph()
        self.blackboard = SwarmBlackboard(observation_ttl=float(self.settings["observation_ttl_s"]),
                                          neighbors={t: sorted(n) for t, n in graph.items()})
        self.coordinator = MultiAgentCoordinator(float(self.settings["green_wave_cap_s"]), self.blackboard.neighbors)
        self.agents = {t: SignalAgent(t, pm, sorted(graph.get(t, {})))
                       for t, pm in build_all(model, self.settings).items()}
        if self.use_green_wave:
            try:
                from simulation.coordination.green_wave import GreenWave
                self.green_wave = GreenWave(self, model, self.settings, self.seed)
            except Exception:
                self.green_wave = None
        return self.agents

    # ------------------------------------------------------------------ one decision tick
    def decide(self, now: float, tick: int, halting, occupancy, events: list) -> list[dict]:
        """Observe -> publish -> propose -> coordinate -> safety gate. Returns decision records
        (status 'pending' for those to apply). Pure Python apart from the halting/occupancy callables."""
        s = self.settings
        locked = set()
        for hook in self.hooks:
            if hasattr(hook, "locked_tls"):
                locked |= set(hook.locked_tls())
        observations = {}
        for tid, agent in self.agents.items():
            obs = agent.observe(now, halting, occupancy)
            observations[tid] = obs
            if self.use_blackboard:
                self.blackboard.publish(AgentObservation(tid, obs.served_queue, obs.competing_queue, timestamp=now,
                                                         occupancy=obs.occupancy))
            if self.predictor is not None and agent.active:
                self.predictor.update(tid, now, {g.index: float(sum(halting(l) for l in g.served_lanes))
                                                 for g in agent.phase_map.greens})
        self.blackboard.prune(now)
        self.blackboard.evaporate()
        records, serving = [], []
        for tid, agent in self.agents.items():
            if not agent.active:
                continue
            obs, green = observations[tid], agent.current_green()
            base = {"time": now, "tick": tick, "intersection": tid, "phase_index": obs.phase_index,
                    "elapsed_s": round(obs.elapsed, 3), "served_queue": obs.served_queue,
                    "competing_queue": obs.competing_queue, "competing_red_s": round(obs.competing_red, 3)}
            if green is None:
                agent.counts["deferred"] += 1
                records.append({**base, "status": "deferred", "reason": "in_transition"})
                continue
            if tid in locked:
                # An emergency-priority request owns this junction; its own safe actions apply.
                agent.counts["deferred"] += 1
                records.append({**base, "status": "deferred", "reason": "emergency_priority"})
                continue
            fresh = self.blackboard.fresh_neighbor_observations(tid, now)
            status = self.blackboard.neighbor_status(tid, now)
            saturation, _ = downstream_saturation(green, fresh)
            served_in, competing_in, source, pred = obs.served_queue, obs.competing_queue, "current", None
            if self.use_prediction and self.predictor is not None:
                # Predictions only change the optimizer's queue inputs, and only when the predictor's
                # own recent error is acceptable. Timing limits always come from the current state.
                pred = self.predictor.predict(tid, now, green.index)
                if pred is not None and pred["reliable"]:
                    served_in, competing_in, source = pred["served"], pred["competing"], "predicted"
                else:
                    source = "current_fallback"
            effective_served = served_in * (1.0 - float(s["downstream_discount"]) * saturation)
            pressure = self.blackboard.neighbor_pressure(tid, now)
            rec = {**base, "phase_axis": green.axis, "downstream_saturation": round(saturation, 4),
                   "neighbors_fresh": status["fresh"], "neighbors_stale": status["stale"],
                   "neighbors_missing": status["missing"], "neighbor_pressure": pressure, "input_source": source,
                   "predicted_served": None if pred is None else pred.get("served"),
                   "predicted_competing": None if pred is None else pred.get("competing")}
            agent.counts["proposed"] += 1
            t0 = time.perf_counter()
            try:
                state = TrafficState(tid, effective_served, competing_in, current_phase=obs.phase_index, risk=0.0)
                pheromone = self.blackboard.pheromone if self.use_pheromone else PheromoneMap()
                result = self.optimizer(state, pheromone, pressure, seed=stable_seed(self.seed, tid, tick),
                                        neighbors=agent.neighbors)
                action, proposed = interpret(result, obs.elapsed, green.min_green)
            except Exception as exc:
                rec["optimizer_ms"] = round((time.perf_counter() - t0) * 1000, 3)
                events.append({"event": "proposed", **rec})
                agent.counts["rejected"] += 1
                rec.update(status="rejected", reason=f"optimizer_error:{type(exc).__name__}")
                events.append({"event": "rejected", **rec})
                if agent.record_failure(int(s["max_consecutive_optimizer_failures"])):
                    events.append({"event": "agent_fallback", "time": now, "intersection": tid, "reason": agent.mode_reason})
                records.append(rec)
                continue
            rec["optimizer_ms"] = round((time.perf_counter() - t0) * 1000, 3)
            agent.consecutive_failures = 0
            rec.update(direction=result["direction"], green_seconds=result["green_seconds"], score=result.get("score"),
                       algorithm=result.get("algorithm"), action=action, proposed_total_s=round(proposed, 3))
            events.append({"event": "proposed", **rec})
            records.append(rec)
            if action == "serve":
                serving.append(AgentDecision(tid, green.axis, proposed, proposed))
        capped = {d.intersection: d.coordinated_green for d in self.coordinator.coordinate(serving)}
        for rec in records:
            if "action" not in rec or rec.get("status"):
                continue
            agent = self.agents[rec["intersection"]]
            green = agent.current_green()
            total = capped.get(rec["intersection"], rec["proposed_total_s"]) if rec["action"] == "serve" else rec["proposed_total_s"]
            if self.green_wave is not None and green is not None:
                total, wave_call = self.green_wave.constrain(rec["intersection"], green.index, now, total)
                if wave_call:
                    rec["green_wave_call"] = wave_call
            rec["coordinated_total_s"] = round(total, 3)
            obs = observations[rec["intersection"]]
            # Safety gate sees timing, phase state and limits only - never the optimizer score.
            decision = self.safety.validate_green_plan(total, obs.elapsed, green.min_green, risk=0.0,
                                                       competing_red=obs.competing_red,
                                                       competing_demand=obs.competing_demand)
            rec["reason"] = decision.reason
            if not decision.allowed:
                agent.counts["rejected"] += 1
                rec["status"] = "rejected"
                events.append({"event": "rejected", **rec})
                continue
            rec["status"] = "pending"
            rec["applied_total_s"] = round(decision.green_seconds, 3)
            rec["remaining_set_s"] = round(max(0.0, decision.green_seconds - obs.elapsed), 3)
        return records

    def apply(self, records: list, events: list) -> None:
        for rec in records:
            if rec.get("status") != "pending":
                continue
            agent = self.agents[rec["intersection"]]
            green = agent.current_green()
            ok, why = (False, "phase_changed_before_apply") if green is None or green.index != rec["phase_index"] else \
                apply_green_duration(traci.trafficlight, agent.tls_id, green.index, green.state, rec["remaining_set_s"])
            if ok:
                agent.planned_total = rec["applied_total_s"]
                agent.consecutive_failures = 0
                agent.counts["applied"] += 1
                rec["status"] = "applied"
                rec["apply_detail"] = why
                if rec.get("score") is not None and self.use_pheromone:
                    self.blackboard.pheromone.reinforce(f"{agent.tls_id}:{rec['direction']}", 5.0 / (1.0 + max(0.0, float(rec["score"]))))
                events.append({"event": "applied", **rec})
            else:
                agent.counts["rejected"] += 1
                rec.update(status="rejected", reason=why, applied_total_s=None, remaining_set_s=None)
                events.append({"event": "rejected", **rec})
                if why.startswith("apply_failed") and agent.record_failure(int(self.settings["max_consecutive_optimizer_failures"])):
                    events.append({"event": "agent_fallback", "time": rec["time"], "intersection": agent.tls_id, "reason": agent.mode_reason})

    # ------------------------------------------------------------------ run
    def run(self, sumocfg, output_dir, max_time=3600.0):
        out = Path(output_dir); out.mkdir(parents=True, exist_ok=True)
        model = NetworkModel.from_net_file(net_file_from_cfg(sumocfg))
        self.build_agents(model)
        auditor = build_auditor(model, self.settings, {t: a.phase_map for t, a in self.agents.items() if a.active})
        session = SumoSession(sumocfg, self.seed, self.gui, auditor=auditor, output_dir=out, hooks=self.hooks, port=self.port)
        wall0 = time.perf_counter()
        session.start()
        if self.green_wave is not None:
            self.green_wave.start(session)
        decisions, events, ts, tick_ms, telemetry = [], [], [], [], TelemetryCollector()
        for agent in self.agents.values():
            events.append({"event": "agent_registered", "time": 0.0, "intersection": agent.tls_id, "mode": agent.mode,
                           "reason": agent.mode_reason, "phase_map_status": agent.phase_map.status,
                           "green_phases": [g.index for g in agent.phase_map.greens], "neighbors": agent.neighbors})
        tick, next_decision = 0, 0.0
        max_green = float(self.settings["max_green_s"])
        try:
            self._sync_phases(session, max_green, events)
            while session.running(max_time):
                queue = session.step(telemetry)
                now = session.now
                if self.green_wave is not None:
                    self.green_wave.step(session)
                self._sync_phases(session, max_green, events)
                if now >= next_decision:
                    t0 = time.perf_counter()
                    records = self.decide(now, tick, session.halting, session.occupancy, events)
                    self.apply(records, events)
                    tick_ms.append((time.perf_counter() - t0) * 1000)
                    decisions.extend(records)
                    tick += 1
                    next_decision = now + self.decision_interval
                ts.append({"time": now, "total_halting": queue})
            timed_out = session.running(float("inf"))
            summary = {"seed": self.seed, "controller": "swarm", "samples": len(ts), "decision_count": len(decisions),
                       "timed_out": timed_out, **telemetry.summary(session.now), "sumo_version": session.sumo_version,
                       "safety_audit": auditor.report(), "simulated_end_s": session.now}
        finally:
            session.close()
        summary["wall_time_s"] = round(time.perf_counter() - wall0, 3)
        summary["ablation"] = {"use_blackboard": self.use_blackboard, "use_pheromone": self.use_pheromone,
                               "use_prediction": self.use_prediction, "use_green_wave": self.use_green_wave,
                               "safety_gate": "always_on"}
        if self.predictor is not None:
            summary["prediction"] = self.predictor.report()
        for hook in self.hooks:
            if hasattr(hook, "report"):
                summary.update(hook.report())
        if self.green_wave is not None:
            summary.update(self.green_wave.finish(out))
        summary.update(sumo_kpis(out, summary["vehicles_observed"], summary["vehicles_arrived"], timed_out))
        if session.closure is not None:
            summary["closure_check"] = session.closure.report()
        summary.update(self._summarize(decisions, tick_ms))
        with (out / "swarm_decisions.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=DECISION_FIELDS, extrasaction="ignore"); w.writeheader(); w.writerows(decisions)
        with (out / "swarm_events.jsonl").open("w", encoding="utf-8") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")
        with (out / "swarm_timeseries.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["time", "total_halting"]); w.writeheader(); w.writerows(ts)
        (out / "swarm_agents.json").write_text(json.dumps({t: {"mode": a.mode, "reason": a.mode_reason, "counts": a.counts,
                                                              "neighbors": a.neighbors} for t, a in self.agents.items()}, indent=2))
        (out / "swarm_summary.json").write_text(json.dumps(summary, indent=2)); return summary

    def _sync_phases(self, session, max_green, events):
        now = session.now
        for tid, agent in self.agents.items():
            phase = session.phase(tid)
            if phase is None:
                continue
            bounded = agent.on_phase(phase, now, max_green)
            if bounded is not None:
                green = agent.current_green()
                ok, why = apply_green_duration(traci.trafficlight, tid, green.index, green.state, bounded)
                events.append({"event": "applied" if ok else "rejected", "time": now, "intersection": tid,
                               "phase_index": green.index, "reason": "bounded_programmed_green", "detail": why,
                               "applied_total_s": bounded if ok else None})

    def _summarize(self, decisions, tick_ms):
        by_status, by_reason = {}, {}
        for d in decisions:
            by_status[d["status"]] = by_status.get(d["status"], 0) + 1
            key = f"{d['status']}:{d.get('reason')}"
            by_reason[key] = by_reason.get(key, 0) + 1
        modes = {}
        for a in self.agents.values():
            modes[a.mode] = modes.get(a.mode, 0) + 1
        never = sorted(t for t, a in self.agents.items() if a.active and a.counts["proposed"] == 0)
        return {"tls_total": len(self.agents), "tls_modes": modes,
                "tls_native": {t: a.mode_reason for t, a in self.agents.items() if a.mode != MODE_SWARM},
                "active_tls_without_decisions": never,
                "decision_status_counts": by_status, "decision_reason_counts": dict(sorted(by_reason.items())),
                "decision_tick_latency_ms": _percentiles(tick_ms),
                "optimizer_call_latency_ms": _percentiles([d["optimizer_ms"] for d in decisions if d.get("optimizer_ms") is not None]),
                "controller_settings": self.settings}
