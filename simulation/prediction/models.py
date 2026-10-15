"""Short-term queue predictors (pure Python, no external ML dependency).

All predictors map a history of equally spaced observations (oldest first, values up to and
including "now") to the value `horizon` steps ahead. None of them sees anything after "now".

  persistence     y(t+h) = y(t)                                   - baseline
  moving_average  mean of the last `window` values                - baseline
  linear_trend    least-squares line over the last `window` values, extrapolated h steps (>= 0)
  ridge_ar        ridge-regularised linear autoregression on the last `lags` values; the only
                  model whose parameters are learned from data (training runs only)

Only `ridge_ar` is a statistical learning model; the others are fixed rules and are labelled as such.
"""
from __future__ import annotations
import math


class Predictor:
    name = "base"
    learned = False
    min_history = 1

    def predict(self, history, horizon: int = 1) -> float | None:
        raise NotImplementedError

    def to_dict(self) -> dict:
        return {"name": self.name}


class Persistence(Predictor):
    name = "persistence"

    def predict(self, history, horizon=1):
        return float(history[-1]) if len(history) >= 1 else None


class MovingAverage(Predictor):
    name = "moving_average"

    def __init__(self, window: int = 4):
        self.window = int(window)
        self.min_history = self.window

    def predict(self, history, horizon=1):
        if len(history) < self.window:
            return None
        recent = history[-self.window:]
        return sum(recent) / len(recent)

    def to_dict(self):
        return {"name": self.name, "window": self.window}


class LinearTrend(Predictor):
    name = "linear_trend"

    def __init__(self, window: int = 4):
        self.window = max(2, int(window))
        self.min_history = self.window

    def predict(self, history, horizon=1):
        if len(history) < self.window:
            return None
        y = [float(v) for v in history[-self.window:]]
        n = len(y)
        xm, ym = (n - 1) / 2.0, sum(y) / n
        sxx = sum((i - xm) ** 2 for i in range(n))
        slope = sum((i - xm) * (v - ym) for i, v in enumerate(y)) / sxx if sxx else 0.0
        return max(0.0, ym + slope * ((n - 1 - xm) + horizon))

    def to_dict(self):
        return {"name": self.name, "window": self.window}


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting (small dense systems)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            raise ValueError("singular system")
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                for k in range(c, n + 1):
                    m[r][k] -= f * m[c][k]
    return [m[i][n] / m[i][i] for i in range(n)]


class RidgeAR(Predictor):
    name = "ridge_ar"
    learned = True

    def __init__(self, lags: int = 6, alpha: float = 1.0, weights=None, horizon: int | None = None):
        self.lags = int(lags)
        self.alpha = float(alpha)
        self.weights = list(weights) if weights is not None else None    # [bias, w_oldest .. w_newest]
        self.horizon = horizon
        self.min_history = self.lags
        self.trained_on = None

    def fit(self, X: list[list[float]], y: list[float], horizon: int) -> "RidgeAR":
        if not X:
            raise ValueError("no training samples")
        d = self.lags + 1
        xtx = [[0.0] * d for _ in range(d)]
        xty = [0.0] * d
        for row, target in zip(X, y):
            v = [1.0] + [float(x) for x in row[-self.lags:]]
            for i in range(d):
                xty[i] += v[i] * target
                for j in range(d):
                    xtx[i][j] += v[i] * v[j]
        for i in range(1, d):              # the bias is not penalised
            xtx[i][i] += self.alpha
        self.weights = _solve(xtx, xty)
        self.horizon = horizon
        return self

    def predict(self, history, horizon=1):
        if self.weights is None or len(history) < self.lags:
            return None
        if self.horizon is not None and horizon != self.horizon:
            raise ValueError(f"model trained for horizon {self.horizon}, asked for {horizon}")
        v = [1.0] + [float(x) for x in history[-self.lags:]]
        return max(0.0, sum(w * x for w, x in zip(self.weights, v)))

    def to_dict(self):
        return {"name": self.name, "lags": self.lags, "alpha": self.alpha, "weights": self.weights,
                "horizon": self.horizon, "trained_on": self.trained_on}

    @classmethod
    def from_dict(cls, d: dict) -> "RidgeAR":
        m = cls(d["lags"], d.get("alpha", 1.0), d["weights"], d.get("horizon"))
        m.trained_on = d.get("trained_on")
        return m


def make_predictor(spec: dict) -> Predictor:
    name = spec.get("name", spec.get("model", "moving_average"))
    if name == "persistence":
        return Persistence()
    if name == "moving_average":
        return MovingAverage(spec.get("window", 4))
    if name == "linear_trend":
        return LinearTrend(spec.get("window", 4))
    if name == "ridge_ar":
        if spec.get("weights") is None:
            raise ValueError("ridge_ar needs trained weights (run simulation.prediction.evaluate --save-model)")
        return RidgeAR.from_dict(spec)
    raise ValueError(f"unknown predictor '{name}'")


def mae(pairs) -> float | None:
    pairs = list(pairs)
    return sum(abs(p - a) for p, a in pairs) / len(pairs) if pairs else None


def rmse(pairs) -> float | None:
    pairs = list(pairs)
    return math.sqrt(sum((p - a) ** 2 for p, a in pairs) / len(pairs)) if pairs else None
