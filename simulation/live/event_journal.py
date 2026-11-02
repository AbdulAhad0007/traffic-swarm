"""Append-only journal of what the agents did, written while the simulation runs.

The controllers keep their logs in memory until the run ends. JournalHook copies the relevant entries to
<out>/live/events.jsonl each step so the browser can follow them live. It only reads those logs and never
touches the simulation. Every line: {id, sim, step, t, source, kind, payload}. `id` increases by one per run.
"""
from __future__ import annotations
import json
from pathlib import Path

# Controller log entries worth showing. 'proposed' is left out: its content is repeated on 'applied' and 'rejected'.
CONTROLLER_EVENTS = {"agent_registered", "agent_fallback", "applied", "rejected", "regional_report", "regional_escalation",
                     "regional_clear", "central_decision"}
DECISION_FIELDS = ("intersection", "phase_index", "served_queue", "competing_queue", "downstream_saturation", "action",
                   "proposed_total_s", "coordinated_total_s", "applied_total_s", "elapsed_s", "reason", "status", "supervisor",
                   "green_wave_call")


def read_events(live_dir: Path, after: int = 0, limit: int = 500) -> list[dict] | None:
    """Events with id > after, oldest first. None when this run has no journal."""
    path = Path(live_dir) / "events.jsonl"
    if not path.is_file():
        return None
    out = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                break       # the writer is partway through this line; it arrives on the next poll
            if event["id"] > after:
                out.append(event)
                if len(out) >= limit:
                    break
    return out


class JournalHook:
    def __init__(self, out_dir, sim_id: str):
        self.path = Path(out_dir) / "live" / "events.jsonl"
        self.sim_id = sim_id
        self.next_id = 1
        self.step_no = 0
        self.controller = None
        self.road_monitor = None
        self._file = None
        self._seen = {"controller": 0, "messages": 0, "emergency": 0, "roads": 0}

    def bind(self, controller) -> None:
        self.controller = controller

    def emit(self, t: float, source: str, kind: str, payload: dict) -> None:
        record = {"id": self.next_id, "sim": self.sim_id, "step": self.step_no, "t": t, "source": source, "kind": kind, "payload": payload}
        self.next_id += 1
        self._file.write(json.dumps(record, separators=(",", ":")) + "\n")

    def _drain(self, name: str, items: list | None):
        if not items:
            return []
        fresh = items[self._seen[name]:]
        self._seen[name] = len(items)
        return fresh

    def _copy(self, session) -> None:
        now = session.now
        for e in self._drain("controller", getattr(self.controller, "live_events", None)):
            kind = e.get("event")
            if kind not in CONTROLLER_EVENTS:
                continue
            if kind in ("applied", "rejected"):
                payload = {k: e[k] for k in DECISION_FIELDS if e.get(k) is not None}
            else:
                payload = {k: v for k, v in e.items() if k not in ("event", "time")}
            self.emit(e.get("time", now), e.get("intersection") or e.get("from") or "controller", kind, payload)
        wave = getattr(self.controller, "green_wave", None)
        for m in self._drain("messages", None if wave is None else wave.messages):
            self.emit(m["time"], m["from"], m["kind"], {"from": m["from"], "to": m["to"], "text": m["text"]})
        for hook in session.hooks:
            if hasattr(hook, "ambulances"):
                for e in self._drain("emergency", hook.events):
                    kind = e["event"]
                    self.emit(e.get("time", now), e.get("vehicle") or e.get("tls") or "emergency", f"emergency_{kind}",
                              {k: v for k, v in e.items() if k not in ("event", "time")})
        for e in self._drain("roads", None if self.road_monitor is None else self.road_monitor.events):
            self.emit(e["t"], e["road"], e["kind"], {k: v for k, v in e.items() if k not in ("t", "kind")})

    # ------------------------------------------------------------------ hook API
    def on_start(self, session) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.path.open("w", encoding="utf-8")
        for hook in session.hooks:
            if hasattr(hook, "road_monitor"):
                self.road_monitor = hook.road_monitor

    def on_step(self, session) -> None:
        self.step_no += 1
        self._copy(session)
        self._file.flush()

    def on_close(self, session) -> None:
        if self._file is None:
            return
        self._copy(session)
        self._file.close()
        self._file = None

    def report(self) -> dict:
        return {"event_journal": {"events": self.next_id - 1}}
