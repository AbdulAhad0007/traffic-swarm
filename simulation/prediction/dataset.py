"""Supervised samples from recorded per-junction queues (tls_timeseries.csv), without leakage.

A sample uses the `lags` observations ending at time t (inclusive) of one junction in one run and
targets the same junction's queue at t + horizon * step. Windows never cross a gap or a missing
value, never cross runs, and every sample asserts feature_end_time < target_time. Train and test
sets are separated by RUN (never by shuffling time steps), and runs with the same seed may not
appear on both sides.
"""
from __future__ import annotations
import csv, re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Sample:
    run: str
    tls: str
    features: tuple          # oldest .. newest (newest observed at feature_end_time)
    target: float
    feature_end_time: float
    target_time: float
    lanes: int


def load_series(run_dir: Path) -> dict[str, list[tuple[float, float | None, int]]]:
    """{tls: [(time, queue or None, lanes), ...]} sorted by time."""
    path = Path(run_dir) / "tls_timeseries.csv"
    if not path.is_file():
        raise FileNotFoundError(f"no tls_timeseries.csv in {run_dir}")
    out: dict[str, list] = {}
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            q = row["queue"]
            out.setdefault(row["tls"], []).append((float(row["time"]), None if q == "" else float(q), int(row["lanes"] or 0)))
    for v in out.values():
        v.sort(key=lambda r: r[0])
    return out


def seed_of(run_dir: Path) -> int | None:
    for part in reversed(Path(run_dir).resolve().parts):
        m = re.fullmatch(r"seed-(\d+)", part)
        if m:
            return int(m.group(1))
    return None


def check_split(train: list[Path], test: list[Path]) -> None:
    tr = {Path(p).resolve() for p in train}
    te = {Path(p).resolve() for p in test}
    if tr & te:
        raise ValueError(f"the same run is in train and test: {sorted(map(str, tr & te))[:3]}")
    shared = {seed_of(p) for p in tr} & {seed_of(p) for p in te} - {None}
    if shared:
        raise ValueError(f"train and test runs share seed(s) {sorted(shared)}; split by seed to avoid leakage")


def make_samples(run: str, series: dict, lags: int, horizon: int, step: float) -> list[Sample]:
    out = []
    for tls, rows in series.items():
        n = len(rows)
        for i in range(lags - 1, n - horizon):
            window = rows[i - lags + 1:i + 1]
            target = rows[i + horizon]
            if any(r[1] is None for r in window) or target[1] is None:
                continue
            times = [r[0] for r in window]
            # Equally spaced window, and the target exactly `horizon` steps after it (no gaps).
            if any(abs((b - a) - step) > 1e-6 for a, b in zip(times, times[1:])):
                continue
            if abs(target[0] - times[-1] - horizon * step) > 1e-6:
                continue
            s = Sample(run, tls, tuple(r[1] for r in window), target[1], window[-1][0], target[0], window[-1][2])
            assert s.feature_end_time < s.target_time, "leakage: feature window reaches the target time"
            out.append(s)
    return out
