"""Online queue prediction for the swarm controller, with a reliability gate and fallback.

Per traffic light and green phase, the queue on that phase's served lanes is recorded at every
decision tick. predict() returns the expected served/competing queue `horizon_steps` ticks ahead
plus a reliability flag. A prediction is 'reliable' only when the same series' own recent
predictions have been checked against what actually happened (at least `min_checked` of them)
and their rolling MAE is <= `max_mae` vehicles. Otherwise the controller uses the current state.

Predictions only replace the optimizer's queue inputs. The safety gate always uses the measured
current state (elapsed green, competing red time, waiting demand), so a wrong prediction can at
worst choose a different, still-safe green length.
"""
from __future__ import annotations
import json, time
from collections import deque
from pathlib import Path
from simulation.prediction.models import make_predictor

DEFAULTS = {"model": "linear_trend", "window": 4, "horizon_steps": 1, "max_mae": 2.0, "min_checked": 10,
            "error_window": 20, "history": 24, "model_file": None}


class OnlinePredictor:
    def __init__(self, predictor, horizon_steps=1, max_mae=2.0, min_checked=10, error_window=20, history=24):
        self.model = predictor
        self.h = int(horizon_steps)
        self.max_mae = float(max_mae)
        self.min_checked = int(min_checked)
        self.error_window = int(error_window)
        self.history_len = max(int(history), getattr(predictor, "min_history", 1) + 1)
        self.series: dict[tuple, deque] = {}
        self.pending: dict[tuple, deque] = {}       # key -> (target_tick, predicted)
        self.errors: dict[tuple, deque] = {}
        self.tick: dict[str, int] = {}
        self.calls = 0
        self.reliable_calls = 0
        self.latency_us: list[float] = []
        self.checked = []

    @classmethod
    def from_settings(cls, spec: dict) -> "OnlinePredictor":
        spec = {**DEFAULTS, **(spec or {})}
        if spec.get("model_file"):
            model_spec = json.loads(Path(spec["model_file"]).read_text(encoding="utf-8"))
        else:
            model_spec = {"name": spec["model"], "window": spec["window"]}
        return cls(make_predictor(model_spec), spec["horizon_steps"], spec["max_mae"], spec["min_checked"],
                   spec["error_window"], spec["history"])

    def update(self, tls: str, now: float, per_green: dict) -> None:
        """Record the measured queue of every green phase at this decision tick."""
        tick = self.tick.get(tls, -1) + 1
        self.tick[tls] = tick
        for g, value in per_green.items():
            key = (tls, g)
            hist = self.series.setdefault(key, deque(maxlen=self.history_len))
            hist.append(float(value))
            pend = self.pending.setdefault(key, deque())
            while pend and pend[0][0] <= tick:
                target, predicted = pend.popleft()
                if target == tick:
                    self.errors.setdefault(key, deque(maxlen=self.error_window)).append(abs(predicted - value))
                    if len(self.checked) < 5000:
                        self.checked.append((predicted, float(value)))
            # Predict the value h ticks ahead from data up to now only.
            t0 = time.perf_counter()
            p = self.model.predict(list(hist), self.h)
            self.latency_us.append((time.perf_counter() - t0) * 1e6)
            if p is not None:
                pend.append((tick + self.h, p))

    def _reliable(self, key) -> bool:
        errs = self.errors.get(key)
        return bool(errs) and len(errs) >= self.min_checked and sum(errs) / len(errs) <= self.max_mae

    def predict(self, tls: str, now: float, current_green: int) -> dict | None:
        self.calls += 1
        keys = [k for k in self.series if k[0] == tls]
        cur = (tls, current_green)
        if cur not in self.series or not self.pending.get(cur):
            return None
        served = self.pending[cur][-1][1]
        others = [self.pending[k][-1][1] for k in keys if k != cur and self.pending.get(k)]
        if len(others) < len(keys) - 1:
            return None                     # a competing phase has no prediction yet -> treat as missing
        reliable = self._reliable(cur) and all(self._reliable(k) for k in keys if k != cur)
        if reliable:
            self.reliable_calls += 1
        return {"served": round(served, 3), "competing": round(max(others) if others else 0.0, 3), "reliable": reliable}

    def report(self) -> dict:
        lat = sorted(self.latency_us)
        pairs = self.checked
        from simulation.prediction.models import mae, rmse
        return {"model": self.model.to_dict(), "horizon_steps": self.h, "max_mae": self.max_mae,
                "min_checked": self.min_checked, "predict_calls": self.calls, "reliable_calls": self.reliable_calls,
                "fallback_share": None if not self.calls else round(1 - self.reliable_calls / self.calls, 4),
                "online_mae": None if not pairs else round(mae(pairs), 4),
                "online_rmse": None if not pairs else round(rmse(pairs), 4), "online_checked": len(pairs),
                "latency_us": {"n": len(lat), "mean": round(sum(lat) / len(lat), 2) if lat else None,
                               "p95": round(lat[int(0.95 * (len(lat) - 1))], 2) if lat else None}}
