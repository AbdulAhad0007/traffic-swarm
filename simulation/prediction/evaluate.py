#!/usr/bin/env python3
"""Train/test evaluation of the short-term queue predictors on recorded simulation runs.

    python -m simulation.prediction.evaluate --train <run dirs> --test <run dirs> --out <dir>
           [--horizons 1 2 6] [--lags 6] [--save-model model.json]

Run dirs are controller output directories that contain tls_timeseries.csv (written by every
experiment, e.g. experiments/runs/grid5x5/normal/seed-42/baseline). Outputs:
  prediction_metrics.json   MAE / RMSE (vehicles), congestion-class accuracy and macro-F1,
                            per-prediction latency, sample counts, split and configuration
  prediction_samples.csv    predicted vs actual for the test runs (dashboard)
The learned model (ridge_ar) is fitted on training runs only; its alpha is chosen on a
validation run held out from the training runs. If it does not beat the best baseline on the
test runs, that is reported and the baseline should be used.
"""
from __future__ import annotations
import argparse, csv, json, statistics, time
from pathlib import Path
from simulation.live.congestion import load_live_config
from simulation.prediction.dataset import check_split, load_series, make_samples, seed_of
from simulation.prediction.models import LinearTrend, MovingAverage, Persistence, RidgeAR, mae, rmse

ALPHAS = (0.1, 1.0, 10.0, 100.0)


def queue_class(queue: float, lanes: int, cfg: dict) -> str:
    """Congestion class from queue per lane only (occupancy is not predicted)."""
    levels = cfg["levels"]
    if lanes <= 0:
        return cfg.get("no_data_level", "no_data")
    qpl = queue / lanes
    for lv in levels[:-1]:
        if qpl <= lv["max_queue_per_lane"]:
            return lv["name"]
    return levels[-1]["name"]


def class_metrics(pred: list[str], actual: list[str], labels: list[str]) -> dict:
    if not actual:
        return {"accuracy": None, "macro_f1": None}
    acc = sum(p == a for p, a in zip(pred, actual)) / len(actual)
    f1s, per = [], {}
    for lab in labels:
        tp = sum(p == lab and a == lab for p, a in zip(pred, actual))
        fp = sum(p == lab and a != lab for p, a in zip(pred, actual))
        fn = sum(p != lab and a == lab for p, a in zip(pred, actual))
        support = tp + fn
        if support == 0 and fp == 0:
            continue                      # class absent from both: excluded from the macro average
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        f1s.append(f1)
        per[lab] = {"f1": round(f1, 4), "support": support}
    return {"accuracy": round(acc, 4), "macro_f1": round(sum(f1s) / len(f1s), 4) if f1s else None, "per_class": per}


def collect(dirs, lags, horizon, step):
    out = []
    for d in dirs:
        out += make_samples(str(d), load_series(d), lags, horizon, step)
    return out


def fit_ridge(train_dirs, lags, horizon, step) -> tuple[RidgeAR, dict]:
    train_dirs = list(train_dirs)
    if len(train_dirs) >= 2:
        val_dir, fit_dirs = train_dirs[-1], train_dirs[:-1]
        fit, val = collect(fit_dirs, lags, horizon, step), collect([val_dir], lags, horizon, step)
        scores = {}
        for a in ALPHAS:
            m = RidgeAR(lags, a).fit([s.features for s in fit], [s.target for s in fit], horizon)
            scores[a] = mae((m.predict(s.features, horizon), s.target) for s in val)
        alpha = min(scores, key=lambda a: (scores[a], a))
        selection = {"validation_run": str(val_dir), "validation_mae_by_alpha": {str(k): round(v, 4) for k, v in scores.items()}}
    else:
        alpha, selection = 1.0, {"note": "single training run: alpha fixed at 1.0 (no validation run)"}
    full = collect(train_dirs, lags, horizon, step)
    model = RidgeAR(lags, alpha).fit([s.features for s in full], [s.target for s in full], horizon)
    model.trained_on = [str(d) for d in train_dirs]
    return model, {"alpha": alpha, "train_samples": len(full), **selection}


def evaluate(train_dirs, test_dirs, horizons=(1, 2, 6), lags=6, step=None, out=None, save_model=None) -> dict:
    check_split(train_dirs, test_dirs)
    cfg = load_live_config()
    step = float(step or cfg.get("sample_interval_s", 5))
    labels = [lv["name"] for lv in cfg["levels"]]
    result = {"split": {"train_runs": [str(d) for d in train_dirs], "test_runs": [str(d) for d in test_dirs],
                        "train_seeds": sorted({seed_of(d) for d in train_dirs} - {None}),
                        "test_seeds": sorted({seed_of(d) for d in test_dirs} - {None}),
                        "rule": "split by run; no seed on both sides; windows never cross runs or gaps"},
              "target": "halting vehicles on a junction's incoming vehicle lanes (TraCI, speed < 0.1 m/s)",
              "step_s": step, "lags": lags, "horizons": {}}
    rows = []
    for h in horizons:
        test = collect(test_dirs, lags, h, step)
        ridge, ridge_info = fit_ridge(train_dirs, lags, h, step)
        models = [Persistence(), MovingAverage(4), LinearTrend(4), ridge]
        hr = {"horizon_s": h * step, "test_samples": len(test), "ridge_training": ridge_info, "models": {}}
        for m in models:
            preds, lat = [], []
            for s in test:
                t0 = time.perf_counter()
                p = m.predict(s.features, h)
                lat.append((time.perf_counter() - t0) * 1e6)
                preds.append(p)
            pairs = [(p, s.target) for p, s in zip(preds, test) if p is not None]
            cls = class_metrics([queue_class(p, s.lanes, cfg) for p, s in zip(preds, test) if p is not None],
                                [queue_class(s.target, s.lanes, cfg) for p, s in zip(preds, test) if p is not None], labels)
            hr["models"][m.name] = {"learned": m.learned, "n": len(pairs),
                                    "mae": None if not pairs else round(mae(pairs), 4),
                                    "rmse": None if not pairs else round(rmse(pairs), 4),
                                    "class_accuracy": cls["accuracy"], "class_macro_f1": cls["macro_f1"],
                                    "latency_us_mean": round(statistics.fmean(lat), 3) if lat else None,
                                    "latency_us_p95": round(sorted(lat)[int(0.95 * (len(lat) - 1))], 3) if lat else None,
                                    "config": m.to_dict() if not m.learned else {k: v for k, v in m.to_dict().items() if k != "trained_on"}}
            if h == horizons[0]:
                for p, s in zip(preds, test):
                    rows.append({"model": m.name, "horizon_s": h * step, "run": s.run, "tls": s.tls,
                                 "time": s.target_time, "actual": s.target, "predicted": None if p is None else round(p, 3)})
        baselines = {k: v for k, v in hr["models"].items() if not v["learned"] and v["mae"] is not None}
        best_base = min(baselines, key=lambda k: baselines[k]["mae"]) if baselines else None
        r = hr["models"]["ridge_ar"]["mae"]
        hr["best_baseline"] = best_base
        hr["learned_beats_best_baseline"] = None if r is None or best_base is None else r < baselines[best_base]["mae"]
        result["horizons"][str(h)] = hr
        if save_model and h == horizons[0]:
            Path(save_model).write_text(json.dumps(ridge.to_dict(), indent=2), encoding="utf-8")
    if out:
        out = Path(out); out.mkdir(parents=True, exist_ok=True)
        (out / "prediction_metrics.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        with (out / "prediction_samples.csv").open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["model", "horizon_s", "run", "tls", "time", "actual", "predicted"])
            w.writeheader(); w.writerows(rows)
    return result


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--train", nargs="+", type=Path, required=True)
    p.add_argument("--test", nargs="+", type=Path, required=True)
    p.add_argument("--horizons", nargs="+", type=int, default=[1, 2, 6], help="steps ahead (1 step = sample interval)")
    p.add_argument("--lags", type=int, default=6)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--save-model", type=Path, default=None, help="write the trained ridge_ar (first horizon) as JSON")
    a = p.parse_args()
    if any(h < 1 or h > 120 for h in a.horizons) or not 2 <= a.lags <= 60:
        p.error("horizons must be in [1, 120] and lags in [2, 60]")
    r = evaluate(a.train, a.test, tuple(a.horizons), a.lags, out=a.out, save_model=a.save_model)
    for h, hr in r["horizons"].items():
        print(f"horizon {hr['horizon_s']:.0f}s  n={hr['test_samples']}  best baseline={hr['best_baseline']}  "
              f"learned beats it={hr['learned_beats_best_baseline']}")
        for name, m in hr["models"].items():
            print(f"  {name:15s} MAE={m['mae']} RMSE={m['rmse']} acc={m['class_accuracy']} F1={m['class_macro_f1']} lat={m['latency_us_mean']}us")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
