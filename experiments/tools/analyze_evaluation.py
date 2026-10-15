#!/usr/bin/env python3
"""Analyse the evaluation matrix from RAW run artifacts and write a report.

    python -m experiments.tools.analyze_evaluation [--config ...] [--out experiments/reports/<name>]

Nothing is copied from earlier summaries or reports. Per run and controller the KPIs are
recomputed from the raw files (tripinfo.xml, statistics.xml, the per-step time series); only
fuel/CO2 totals, decision latencies and online prediction errors - which have no raw file - are
read from that run's own summary JSON. Outputs (in --out):
  runs.csv            one row per (cell, controller) incl. failed / cancelled / not-run cells
  descriptives.csv    n, mean, sd, 95 % CI, median per (stage, network, scenario, controller, metric)
  paired_tests.csv    matched-seed comparisons, assumption check, primary test, Holm-adjusted p, d_z
  summary.json        everything above for the dashboard
  report.md + figures/*.png
"""
from __future__ import annotations
import argparse, csv, json, math, platform, sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
from experiments.tools.evaluate_matrix import load_matrix, eval_dir, cells, cell_id, read_ledger
from experiments.tools.run_experiment import VARIANTS
from experiments.tools import stats

PREFIX = {"fixed": "baseline", "actuated": "actuated", "swarm": "swarm"}

# name: (label, unit, lower_is_better, definition)
METRICS = {
    "mean_delay_s": ("Mean delay", "s/veh", True,
                     "Mean SUMO tripinfo timeLoss of arrived non-emergency vehicles: time lost versus driving at the desired speed (includes waiting at signals)."),
    "mean_travel_time_s": ("Mean travel time", "s/veh", True,
                           "Mean tripinfo duration (arrival - departure) of arrived non-emergency vehicles."),
    "stops_per_vehicle": ("Stops per vehicle", "stops/veh", True,
                          "Mean tripinfo waitingCount of arrived non-emergency vehicles (number of times speed fell below 0.1 m/s)."),
    "mean_total_delay_all_s": ("Mean total delay, all vehicles", "s/veh", True,
                               "Mean of tripinfo timeLoss + departDelay over ALL non-emergency vehicles that departed, including vehicles still "
                               "en route at the end (SUMO write-unfinished values, censored at the run end, i.e. a lower bound for them). Same "
                               "denominator for every controller of a cell; the primary delay metric when arrived counts differ."),
    "mean_queue_veh": ("Mean network queue (demand period)", "veh", True,
                       "Mean of the network-wide halting-vehicle count (speed < 0.1 m/s, all lanes, every 1 s step) over the demand "
                       "period [demand begin, demand end] - the same time window for every controller."),
    "max_queue_veh": ("Max network queue", "veh", True, "Maximum over all steps of the run of the network-wide halting-vehicle count."),
    "halted_vehicle_hours": ("Halted vehicle-hours", "veh·h", True,
                             "Sum over all steps of the network-wide halting-vehicle count × step length / 3600 (whole run; censored at the cap for timed-out runs)."),
    "arrived_share": ("Arrived share", "fraction", False, "Arrived non-emergency vehicles / loaded non-emergency vehicles."),
    "arrived_vehicles": ("Arrived vehicles", "veh", False,
                         "Non-emergency vehicles that reached their destination before the end of the run (throughput)."),
    "unfinished_vehicles": ("Unfinished vehicles", "veh", True,
                            "Vehicles loaded but not arrived when the run ended (still driving, waiting to insert, or removed)."),
    "fuel_g_per_vehicle": ("Fuel per vehicle", "g/veh", True,
                           "Total fuel from SUMO's default emission model (summed per step for all vehicles) / vehicles observed. Not valid for the mixed-traffic stage (one passenger-car model for all types)."),
    "co2_g_per_vehicle": ("CO2 per vehicle", "g/veh", True, "As fuel, for CO2."),
    "teleports": ("Teleports", "count", True, "SUMO teleports (vehicles removed after being stuck for time-to-teleport): a simulation failure indicator."),
    "decision_latency_ms": ("Decision latency (mean)", "ms/tick", True,
                            "Swarm controllers only: wall time of one decision tick for the whole network (observe, optimise every junction, coordinate, gate, apply)."),
    "optimizer_ms": ("Optimizer time per decision", "ms", True, "Swarm controllers only: mean wall time of one PSO+ACO optimizer call."),
    "sim_wall_time_s": ("Simulation runtime", "s", True, "Wall-clock time of the run (SUMO + controller), on the machine and parallel load of the matrix run."),
    "ambulance_travel_time_s": ("Ambulance travel time", "s", True, "Mean tripinfo duration of the run's ambulances (emergency stage)."),
    "ambulance_delay_s": ("Ambulance delay", "s", True, "Mean tripinfo timeLoss of the run's ambulances (emergency stage)."),
    "prediction_online_mae": ("Online prediction MAE", "veh", True,
                              "swarm_prediction only: mean absolute error of the controller's own one-step-ahead per-phase queue predictions, checked online against the later observation."),
    "prediction_online_rmse": ("Online prediction RMSE", "veh", True, "As the MAE, root mean squared error."),
    "prediction_fallback_share": ("Prediction fallback share", "fraction", True,
                                  "Share of predict calls in which the predictor was not reliable yet (rolling MAE above max_mae, or too few checks), so the controller used the current state."),
}
TESTED = ["mean_total_delay_all_s", "mean_delay_s", "mean_travel_time_s", "stops_per_vehicle", "mean_queue_veh", "max_queue_veh",
          "halted_vehicle_hours", "arrived_vehicles", "fuel_g_per_vehicle", "co2_g_per_vehicle", "ambulance_travel_time_s", "ambulance_delay_s"]
PER_ARRIVED = {"mean_delay_s", "mean_travel_time_s", "stops_per_vehicle"}   # denominator = arrived vehicles only
ARRIVED_MISMATCH_PCT = 1.0
LIGHT = {"fixed": "#2a78d6", "actuated": "#eb6834", "swarm": "#1baf7a", "fixed_priority": "#eda100", "swarm_priority": "#e87ba4",
         "swarm_no_blackboard": "#008300", "swarm_no_pheromone": "#6250d6", "swarm_prediction": "#e34948"}


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def raw_metrics(sub: Path, kind: str, demand_window=None) -> dict:
    """KPIs of one controller run, recomputed from its raw files."""
    out = {}
    trips, ambs, all_delay, not_departed = [], [], [], 0
    root = ET.parse(sub / "tripinfo.xml").getroot()
    for t in root.findall("tripinfo"):
        is_amb = t.get("vType") == "ambulance"
        if float(t.get("depart", -1)) < 0:
            not_departed += 0 if is_amb else 1
            continue
        if not is_amb:
            all_delay.append(float(t.get("timeLoss")) + float(t.get("departDelay") or 0))
        if float(t.get("arrival", -1)) < 0:
            continue
        rec = (float(t.get("duration")), float(t.get("timeLoss")), float(t.get("waitingCount")))
        (ambs if is_amb else trips).append(rec)
    out["mean_total_delay_all_s"] = _mean(all_delay)
    out["vehicles_not_departed"] = not_departed
    out["mean_travel_time_s"] = _mean([r[0] for r in trips])
    out["mean_delay_s"] = _mean([r[1] for r in trips])
    out["stops_per_vehicle"] = _mean([r[2] for r in trips])
    out["arrived_vehicles"] = len(trips)
    out["ambulance_travel_time_s"] = _mean([r[0] for r in ambs]) if ambs else None
    out["ambulance_delay_s"] = _mean([r[1] for r in ambs]) if ambs else None
    stat = ET.parse(sub / "statistics.xml").getroot()
    veh, tel = stat.find("vehicles").attrib, stat.find("teleports").attrib
    out["unfinished_vehicles"] = int(veh.get("loaded", 0)) - len(trips) - len(ambs)
    loaded_regular = len(all_delay) + not_departed
    out["arrived_share"] = len(trips) / loaded_regular if loaded_regular else None
    out["teleports"] = int(tel.get("total", 0))
    q, window_q, prev_t, halted_s = [], [], 0.0, 0.0
    with (sub / f"{PREFIX[kind]}_timeseries.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            t, h = float(row["time"]), float(row["total_halting"])
            halted_s += h * (t - prev_t)
            prev_t = t
            q.append(h)
            if demand_window and demand_window[0] < t <= demand_window[1]:
                window_q.append(h)
    qw = window_q if demand_window else q
    out["mean_queue_veh"] = sum(qw) / len(qw) if qw else None
    out["max_queue_veh"] = max(q) if q else None
    out["halted_vehicle_hours"] = halted_s / 3600
    summ = json.loads((sub / f"{PREFIX[kind]}_summary.json").read_text(encoding="utf-8"))
    n_obs = summ.get("vehicles_observed") or 0
    out["fuel_g_per_vehicle"] = summ["fuel_mg"] / 1000 / n_obs if n_obs else None
    out["co2_g_per_vehicle"] = summ["co2_mg"] / 1000 / n_obs if n_obs else None
    lat = summ.get("decision_tick_latency_ms") or {}
    out["decision_latency_ms"] = lat.get("mean") if isinstance(lat, dict) else None
    opt = summ.get("optimizer_call_latency_ms") or {}
    out["optimizer_ms"] = opt.get("mean") if isinstance(opt, dict) else None
    out["sim_wall_time_s"] = summ.get("wall_time_s")
    pred = summ.get("prediction") or {}
    out["prediction_online_mae"] = pred.get("online_mae")
    out["prediction_online_rmse"] = pred.get("online_rmse")
    out["prediction_fallback_share"] = pred.get("fallback_share")
    out["timed_out"] = bool(summ.get("timed_out"))
    out["safety_violations"] = (summ.get("safety_audit") or {}).get("total_violations")
    out["sumo_version"] = summ.get("sumo_version")
    return out


def collect(cfg, base: Path, stages=None):
    ledger = read_ledger(base)
    rows, meta_example, versions = [], None, defaultdict(set)
    for c in cells(cfg):
        if stages and c["stage"] not in stages:
            continue
        led = ledger.get(cell_id(c), {})
        status = led.get("status", "not_run")
        run_dir = base / "runs" / cell_id(c)
        for ctl in c["controllers"]:
            row = {"stage": c["stage"], "network": c["network"], "scenario": c["scenario"], "seed": c["seed"],
                   "controller": ctl, "cell_status": status, "error": led.get("error")}
            if status == "completed":
                try:
                    meta = json.loads((run_dir / "comparison.json").read_text(encoding="utf-8")).get("metadata") or {}
                    dem = meta.get("demand") if isinstance(meta.get("demand"), dict) else {}
                    window = (float(dem["begin_s"]), float(dem["end_s"])) if "begin_s" in dem and "end_s" in dem else None
                    row.update(raw_metrics(run_dir / VARIANTS[ctl][1], VARIANTS[ctl][0], window))
                    row["status"] = "ok"
                    row["tsi_version"] = (meta.get("software") or {}).get("tsi_version")
                    versions[c["stage"]].add(str(row["tsi_version"]))
                    if meta_example is None:
                        meta_example = meta
                except (OSError, ET.ParseError, KeyError, ValueError) as exc:
                    row.update(status="raw_artifact_error", error=f"{type(exc).__name__}: {exc}")
            else:
                row["status"] = status
            rows.append(row)
    return rows, meta_example, {k: sorted(v) for k, v in versions.items()}


def analyse(cfg, rows):
    by = defaultdict(dict)       # (stage, network, scenario, controller) -> {seed: row}
    for r in rows:
        if r["status"] == "ok":
            by[(r["stage"], r["network"], r["scenario"], r["controller"])][r["seed"]] = r
    desc = []
    for (stage, net, sc, ctl), seeds in sorted(by.items()):
        for m in METRICS:
            d = stats.describe([s.get(m) for s in seeds.values()])
            if d["n"]:
                desc.append({"stage": stage, "network": net, "scenario": sc, "controller": ctl, "metric": m, **d})
    tests = []
    for stage, st in cfg["stages"].items():
        family = []
        for net in st["networks"]:
            for sc in st["scenarios"]:
                for a, b in st.get("comparisons", []):
                    A, B = by.get((stage, net, sc, a), {}), by.get((stage, net, sc, b), {})
                    seeds = sorted(set(A) | set(B))
                    for m in TESTED:
                        ca, cb = [A.get(s, {}).get(m) for s in seeds], [B.get(s, {}).get(m) for s in seeds]
                        if all(v is None for v in ca + cb):
                            continue
                        t = stats.paired_test(ca, cb)
                        matched = [s for s, x, y in zip(seeds, ca, cb) if x is not None and y is not None]
                        mism = [abs(A[s]["arrived_vehicles"] - B[s]["arrived_vehicles"]) / B[s]["arrived_vehicles"] * 100
                                for s in matched if B[s].get("arrived_vehicles")]
                        rec = {"stage": stage, "network": net, "scenario": sc, "metric": m, "controller": a, "reference": b,
                               "seeds_matched": matched, **t, "arrived_mismatch_max_pct": max(mism) if mism else None}
                        family.append(rec)
        adj = stats.holm([t["p_value"] if t["test"] not in ("identical", "insufficient_pairs") else None for t in family])
        for t, p in zip(family, adj):
            t["p_adjusted"] = p
            t["holm_family"] = f"stage:{stage} ({sum(1 for x in adj if x is not None)} tests)"
            t["verdict"] = stats.verdict(t, METRICS[t["metric"]][2], float(cfg.get("practical_threshold_pct", 5)))
            if t["metric"] in PER_ARRIVED and (t["arrived_mismatch_max_pct"] or 0) > ARRIVED_MISMATCH_PCT:
                t["verdict"] += f"; CAUTION arrived counts differ by up to {t['arrived_mismatch_max_pct']:.1f} % (compare all-vehicle delay)"
        tests += family
    return desc, tests


def write_csv(path: Path, rows: list, fields=None):
    fields = fields or sorted({k for r in rows for k in r})
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in r.items()})


def figures(desc, tests, out: Path, cfg) -> list[str]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    made = []
    (out / "figures").mkdir(exist_ok=True)
    for stage, st in cfg["stages"].items():
        for net in st["networks"]:
            metrics = ["mean_total_delay_all_s", "mean_travel_time_s", "stops_per_vehicle"] if stage != "emergency" else \
                      ["ambulance_travel_time_s", "mean_total_delay_all_s", "mean_travel_time_s"]
            sel = [d for d in desc if d["stage"] == stage and d["network"] == net]
            if not sel:
                continue
            fig, axes = plt.subplots(1, len(metrics), figsize=(5.2 * len(metrics), 3.6), constrained_layout=True)
            for ax, m in zip(axes, metrics):
                scen = [s for s in st["scenarios"] if any(d["scenario"] == s and d["metric"] == m for d in sel)]
                k = len(st["controllers"])
                for j, ctl in enumerate(st["controllers"]):
                    xs, ys, lo, hi = [], [], [], []
                    for i, s in enumerate(scen):
                        d = next((d for d in sel if d["scenario"] == s and d["metric"] == m and d["controller"] == ctl), None)
                        if d and d["mean"] is not None:
                            xs.append(i + (j - (k - 1) / 2) * 0.18); ys.append(d["mean"])
                            lo.append(d["mean"] - (d["ci_low"] if d["ci_low"] is not None else d["mean"]))
                            hi.append((d["ci_high"] if d["ci_high"] is not None else d["mean"]) - d["mean"])
                    if xs:
                        ax.errorbar(xs, ys, yerr=[lo, hi], fmt="o", ms=5, capsize=0, lw=2, color=LIGHT.get(ctl, "#555"), label=ctl)
                ax.set_xticks(range(len(scen)), scen, rotation=20, fontsize=8)
                ax.set_title(f"{METRICS[m][0]} ({METRICS[m][1]})", fontsize=10)
                ax.grid(axis="y", color="#e6e6e6"); ax.spines[["top", "right"]].set_visible(False)
            axes[0].legend(fontsize=8, frameon=False)
            fig.suptitle(f"{stage} · {net} · mean and 95 % CI over seeds", fontsize=11)
            name = f"figures/{stage}_{net}.png"
            fig.savefig(out / name, dpi=130); plt.close(fig)
            made.append(name)
    made += forest_figures(tests, out, cfg, plt)
    return made


def forest_figures(tests, out: Path, cfg, plt) -> list[str]:
    """Relative change (controller vs reference, % of the reference mean) with the 95 % CI of the paired difference."""
    made = []
    for stage, st in cfg["stages"].items():
        metric = "ambulance_travel_time_s" if stage == "emergency" else "mean_total_delay_all_s"
        sel = [t for t in tests if t["stage"] == stage and t["metric"] == metric and t.get("ref_mean") and t["diff_ci_low"] is not None]
        if not sel:
            continue
        sel.sort(key=lambda t: (f"{t['controller']} vs {t['reference']}", t["network"], st["scenarios"].index(t["scenario"])))
        fig, ax = plt.subplots(figsize=(7.5, 0.28 * len(sel) + 1.2), constrained_layout=True)
        for i, t in enumerate(sel):
            r = t["ref_mean"]
            sig = t.get("p_adjusted") is not None and t["p_adjusted"] < 0.05
            col = LIGHT.get(t["controller"], "#555")
            ax.plot([t["diff_ci_low"] / r * 100, t["diff_ci_high"] / r * 100], [i, i], color=col, lw=2)
            ax.plot([t["rel_change_pct"]], [i], "o", color=col, mfc=col if sig else "white", ms=5)
        ax.axvline(0, color="#888", lw=1)
        thr = float(cfg.get("practical_threshold_pct", 5))
        for x in (-thr, thr):
            ax.axvline(x, color="#ccc", lw=1, ls="--")
        ax.set_yticks(range(len(sel)), [f"{t['controller']} vs {t['reference']} · {t['network']} · {t['scenario']}" for t in sel], fontsize=7)
        ax.invert_yaxis()
        ax.set_xlabel("change vs reference, % of reference mean (line = 95 % CI)\nfilled dot = Holm-adjusted p < 0.05; dashed = practical threshold", fontsize=8)
        ax.set_title(f"{stage}: {METRICS[metric][0]}", fontsize=10)
        ax.grid(axis="x", color="#eee"); ax.spines[["top", "right"]].set_visible(False)
        name = f"figures/{stage}_forest_{metric}.png"
        fig.savefig(out / name, dpi=130); plt.close(fig)
        made.append(name)
    return made


def fmtv(v, d=2):
    return "—" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:.{d}f}"


def package_versions() -> dict:
    import numpy, scipy, matplotlib
    return {"python": platform.python_version(), "numpy": numpy.__version__, "scipy": scipy.__version__,
            "matplotlib": matplotlib.__version__}


def read_attempts(base: Path) -> list:
    """Every ledger line (append-only), with the last line per cell marked as the attempt that counts."""
    path = base / "ledger.jsonl"
    out = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                r.pop("traceback", None)
                out.append(r)
    last = {r["cell"]: i for i, r in enumerate(out)}
    for i, r in enumerate(out):
        r["is_latest_attempt"] = last[r["cell"]] == i
    return out


def runtime_table(desc, cfg) -> list[str]:
    L = ["## Runtime, computation cost and simulation failures", "",
         "Means over completed seeds (machine and parallel load as in the matrix run; see Limitations).", "",
         "| stage | network | controller | sim wall time (s) | decision tick (ms) | optimizer call (ms) | teleports | unfinished veh |",
         "|---|---|---|---|---|---|---|---|"]
    for stage, st in cfg["stages"].items():
        for n in st["networks"]:
            for c in st["controllers"]:
                vals = []
                for m in ("sim_wall_time_s", "decision_latency_ms", "optimizer_ms", "teleports", "unfinished_vehicles"):
                    xs = [d for d in desc if (d["stage"], d["network"], d["controller"], d["metric"]) == (stage, n, c, m)]
                    tot = sum(d["n"] for d in xs)
                    vals.append("—" if not tot else fmtv(sum(d["mean"] * d["n"] for d in xs) / tot, 1))
                if any(v != "—" for v in vals):
                    L.append(f"| {stage} | {n} | {c} | " + " | ".join(vals) + " |")
    return L + [""]


def prediction_section(rows) -> list[str]:
    sel = [r for r in rows if r["status"] == "ok" and r.get("prediction_online_mae") is not None]
    L = ["## Prediction errors", ""]
    if not sel:
        return L + ["_No completed run with the predictor enabled (`swarm_prediction`)._", ""]
    L += ["Online one-step-ahead per-phase queue prediction of `swarm_prediction` (predictor errors, not controller KPIs):", "",
          "| network | scenario | n runs | MAE (veh) mean ± sd | RMSE (veh) mean | fallback share mean |", "|---|---|---|---|---|---|"]
    by = defaultdict(list)
    for r in sel:
        by[(r["network"], r["scenario"])].append(r)
    for (n, sc), rs in sorted(by.items()):
        d = stats.describe([r["prediction_online_mae"] for r in rs])
        L.append(f"| {n} | {sc} | {d['n']} | {fmtv(d['mean'], 3)} ± {fmtv(d['sd'], 3)} | "
                 f"{fmtv(_mean([r.get('prediction_online_rmse') for r in rs]), 3)} | {fmtv(_mean([r.get('prediction_fallback_share') for r in rs]), 3)} |")
    return L + ["", "Offline train/test evaluation against persistence/moving-average baselines: `python -m simulation.prediction.evaluate` (not part of this matrix).", ""]


def report_md(cfg, rows, desc, tests, meta, figs, matrix_status, versions=None, attempts=None) -> str:
    L = [f"# Evaluation report: {cfg['name']}", "",
         f"Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')} by `experiments/tools/analyze_evaluation.py` "
         "from raw run artifacts (tripinfo.xml, statistics.xml, per-step time series). No numbers were copied from earlier reports.", "",
         "> **Preliminary research data.** Results are from SUMO simulations of generated/assumed demand. Statistical significance "
         "below means only that the matched difference is unlikely under the null hypothesis *for these simulated scenarios*; it is "
         "not proof of real-world benefit, and differences between controllers are associations within this experimental setup.", "",
         "## Matrix completion", "", "| stage / network | planned cells | completed | failed | cancelled | not run |", "|---|---|---|---|---|---|"]
    for k, s in matrix_status.items():
        L.append(f"| {k} | {s['planned']} | {s['completed']} | {s['failed']} | {s['cancelled']} | {s['not_run']} |")
    tot = {k: sum(s[k] for s in matrix_status.values()) for k in ("planned", "completed", "failed", "cancelled", "not_run")}
    L += ["", f"**{tot['completed']} of {tot['planned']} planned cells completed** "
          f"({'COMPLETE' if tot['completed'] == tot['planned'] else 'INCOMPLETE - only completed cells are analysed'}). "
          "A cell = one network × scenario × seed, running every controller of its stage on one prepared scenario.", ""]
    failed = [r for r in rows if r["cell_status"] in ("failed", "cancelled")]
    if failed:
        L += ["### Failed / cancelled cells", "", "| cell | status | error |", "|---|---|---|"]
        seen = set()
        for r in failed:
            key = (r["stage"], r["network"], r["scenario"], r["seed"])
            if key not in seen:
                seen.add(key)
                L.append(f"| {'/'.join(map(str, key))} | {r['cell_status']} | {(r.get('error') or '')[:160]} |")
        L.append("")
    if attempts:
        by_status = defaultdict(int)
        for r in attempts:
            by_status[(r["status"], r["is_latest_attempt"])] += 1
        L += ["### Attempt history", "",
              f"`ledger.jsonl` holds **{len(attempts)} attempts** for {len({r['cell'] for r in attempts})} cells "
              "(append-only; only the latest attempt of a cell counts, earlier artifacts are kept under `superseded/`). "
              "Every attempt is listed in `attempts.csv`.", "", "| status | latest attempt | earlier (superseded) attempts |", "|---|---|---|"]
        for st_ in sorted({k[0] for k in by_status}):
            L.append(f"| {st_} | {by_status[(st_, True)]} | {by_status[(st_, False)]} |")
        L.append("")
    timed = [r for r in rows if r.get("timed_out")]
    viol = [r for r in rows if r.get("safety_violations")]
    L += [f"Runs that hit the {cfg['max_time_s']:g} s cap (`timed_out`): **{len(timed)}**"
          + (": " + ", ".join(f"{r['network']}/{r['scenario']}/{r['seed']}/{r['controller']}" for r in timed[:20]) if timed else "") + ".",
          f"Runs with signal-safety audit violations: **{len(viol)}** (the matrix validator rejects such cells).", ""]
    L += ["## Configuration and software", "", f"- Seeds: {cfg['seeds']}; demand seed = run seed: {cfg.get('vary_demand')}; cap {cfg['max_time_s']:g} s.",
          f"- Reference controller: `{cfg['reference']}`; practical-relevance threshold: {cfg.get('practical_threshold_pct', 5)} % relative change."]
    if meta:
        sw = meta.get("software", {})
        pv = package_versions()
        L += [f"- Simulation software (from run metadata): {sw.get('sumo')}, traci {sw.get('traci')}, netconvert {sw.get('netconvert')}, "
              f"Python {sw.get('python')}, {sw.get('platform')}.",
              "- TSI code version of the analysed runs, per stage: "
              + "; ".join(f"{k}: {', '.join(v)}" for k, v in (versions or {}).items()) + " (see `tsi_version` in runs.csv).",
              f"- Analysis: Python {pv['python']}, numpy {pv['numpy']}, scipy {pv['scipy']}, matplotlib {pv['matplotlib']}.",
              f"- Controller settings: `{json.dumps(meta.get('controller_settings'))}`"]
    for sname, st in cfg["stages"].items():
        L.append(f"- Stage **{sname}**: {st['description']} Networks {st['networks']}, scenarios {st['scenarios']}, controllers {st['controllers']}"
                 + (f", {st['ambulances']} ambulances" if st.get("ambulances") else "") + ".")
    L += ["", "## Metric definitions", "", "| metric | unit | lower is better | definition |", "|---|---|---|---|"]
    for k, (lab, unit, low, d) in METRICS.items():
        L.append(f"| {lab} (`{k}`) | {unit} | {'yes' if low else 'no'} | {d} |")
    L += ["", "Denominators: travel time, `mean_delay_s` and stops per vehicle average over ARRIVED vehicles only. When controllers "
          f"of a cell leave different numbers of vehicles unfinished, those means are not directly comparable; paired tests flag this "
          f"(`arrived_mismatch_max_pct` > {ARRIVED_MISMATCH_PCT:g} %, 'CAUTION' in the verdict) and `mean_total_delay_all_s` (all departed vehicles) "
          "is the primary delay metric. Queue means use the same demand-period window for every controller.", "",
          "## Statistical method", "", stats.__doc__.strip(), "",
          "Verdict: 'significantly better/worse' requires Holm-adjusted p < 0.05; 'practically relevant' additionally requires |relative change| ≥ "
          f"{cfg.get('practical_threshold_pct', 5)} %.", ""]
    for sname, st in cfg["stages"].items():
        sel = [t for t in tests if t["stage"] == sname]
        if not sel:
            L += [f"## Stage {sname}", "", "_No completed cells._", ""]
            continue
        L += [f"## Stage {sname}", ""]
        for f in figs:
            if f.startswith(f"figures/{sname}_"):
                L.append(f"![{f}]({f})")
        if sname == "ablation":
            L += ["Ablated modules (one at a time against the full swarm, same cells and seeds): blackboard coordination "
                  "(`use_blackboard: false`), ACO pheromone (`use_pheromone: false`), and the short-term predictor added "
                  "(`use_prediction: true`). **Genetic-algorithm weight tuning is not implemented in this code base, so it is not ablated.** "
                  "The independent SafetyGate is never disabled in any variant; its behaviour is covered by dedicated tests "
                  "(`simulation/test_signal_controller.py`, `simulation/test_adaptive_contracts.py`) and by the per-run signal-safety "
                  "audit, which must report 0 violations for a cell to count as completed.", ""]
        key_metrics = ["ambulance_travel_time_s", "ambulance_delay_s", "mean_total_delay_all_s"] if sname == "emergency" else \
                      ["mean_total_delay_all_s", "mean_travel_time_s", "stops_per_vehicle", "mean_queue_veh"]
        for net in st["networks"]:
            L += ["", f"### {net}", "", "Mean ± 95 % CI half-width (n seeds):", "",
                  "| scenario | controller | " + " | ".join(f"{METRICS[m][0]} ({METRICS[m][1]})" for m in key_metrics) + " |",
                  "|---|---|" + "---|" * len(key_metrics)]
            for sc in st["scenarios"]:
                for ctl in st["controllers"]:
                    cells_ = []
                    for m in key_metrics:
                        d = next((d for d in desc if (d["stage"], d["network"], d["scenario"], d["controller"], d["metric"]) == (sname, net, sc, ctl, m)), None)
                        cells_.append("—" if not d else f"{fmtv(d['mean'])} ± {fmtv((d['ci_high'] - d['mean']) if d['ci_high'] is not None else None)} (n={d['n']})")
                    L.append(f"| {sc} | {ctl} | " + " | ".join(cells_) + " |")
            L += ["", "Paired comparisons (matched seeds):", "",
                  "| scenario | metric | comparison | pairs | mean diff [95 % CI] | change | test (normality p) | p raw | p Holm | d_z | verdict |",
                  "|---|---|---|---|---|---|---|---|---|---|---|"]
            for t in sel:
                if t["network"] != net or t["metric"] not in key_metrics + ["arrived_vehicles"]:
                    continue
                L.append(f"| {t['scenario']} | {METRICS[t['metric']][0]} | {t['controller']} vs {t['reference']} | {t['n_pairs']} | "
                         f"{fmtv(t['mean_diff'])} [{fmtv(t['diff_ci_low'])}, {fmtv(t['diff_ci_high'])}] | {fmtv(t['rel_change_pct'], 1)} % | "
                         f"{t['test']} ({fmtv(t['normality_p'], 3)}) | {fmtv(t['p_value'], 4)} | {fmtv(t['p_adjusted'], 4)} | {fmtv(t['effect_size_dz'])} | {t['verdict']} |")
        L.append("")
    L += runtime_table(desc, cfg)
    L += prediction_section(rows)
    L += ["## Limitations", "",
          "- This is preliminary simulation evidence. A significant paired difference is an association within this setup (same network, "
          "demand and seed), not a demonstration of causation in real traffic and not 'statistical proof' of superiority.",
          "- Delay of vehicles unfinished at the end is censored at the run end (lower bound); timed-out runs are listed above.",
          "- Simulated demand only (generated grid flows and an assumed Indian vehicle mix); not calibrated against counts from any real junction.",
          "- n = 10 seeds per cell: Shapiro-Wilk has low power, so the normality check is weak; permutation p-values are in paired_tests.csv for every comparison.",
          "- Holm correction is applied per stage (family = every primary test of that stage); tests across stages are not jointly corrected.",
          "- Power floor: with n = 10 pairs the smallest attainable exact Wilcoxon (and sign-flip permutation) p-value is 2/1024 ≈ 0.002. "
          "In a Holm family of several hundred tests, a comparison routed to Wilcoxon (non-normal differences) can therefore stay "
          "'no significant difference' even with a very large effect size; read d_z and the CI of the difference alongside the verdict. "
          "The final matrix should use more seeds (n = 15 lowers the floor to 2/32768) or a smaller pre-registered primary family. "
          "The test rules were not changed after seeing these data.",
          "- Fixed-time and SUMO-actuated programs are netconvert defaults, not optimised plans; a tuned fixed-time plan (e.g. Webster) would be a stronger baseline.",
          "- The actuated controller uses SUMO's automatically placed induction loops; the swarm reads exact halting counts and occupancy via TraCI (ideal sensing). See docs/RESEARCH_METHODOLOGY.md.",
          "- Fuel/CO2 per vehicle divide by vehicles observed in the run (all inserted vehicles), so they include partial trips of unfinished vehicles.",
          "- Fuel/CO2 come from SUMO's default passenger-car emission class for every vehicle; mixed-traffic emission values are not valid.",
          "- Wall-time and latency figures depend on the machine and on the number of parallel matrix workers.",
          "- Emergency priority is a simulation prototype, not certified for real emergency traffic systems.", "",
          "## Reproducibility", "", "```",
          "pip install -r simulation/requirements.txt -r experiments/requirements-analysis.txt",
          "python -m experiments.tools.evaluate_matrix run --stage core --workers 10      # also: ablation, emergency, mixed",
          "python -m experiments.tools.evaluate_matrix status",
          "python -m experiments.tools.analyze_evaluation", "```", "",
          "Raw artifacts: `experiments/evaluation/<name>/runs/<stage>/<network>/<scenario>/seed-<n>/<controller>/` "
          "(tripinfo.xml, statistics.xml, time series, decision logs); attempt log: `ledger.jsonl`."]
    return "\n".join(L) + "\n"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--config", default=None)
    p.add_argument("--stages", nargs="+", default=None)
    p.add_argument("--out", type=Path, default=None)
    a = p.parse_args()
    cfg = load_matrix(a.config)
    base = eval_dir(cfg)
    out = a.out or PROJECT_ROOT / "experiments" / "reports" / cfg["name"]
    out.mkdir(parents=True, exist_ok=True)
    rows, meta, versions = collect(cfg, base, a.stages)
    desc, tests = analyse(cfg, rows)
    from experiments.tools.evaluate_matrix import status
    mstat = {k: v for k, v in status(cfg, base).items() if not a.stages or k.split("/")[0] in a.stages}
    attempts = [r for r in read_attempts(base) if not a.stages or r["stage"] in a.stages]
    figs = figures(desc, tests, out, cfg)
    write_csv(out / "runs.csv", rows)
    write_csv(out / "attempts.csv", attempts)
    write_csv(out / "descriptives.csv", desc)
    write_csv(out / "paired_tests.csv", tests)
    planned = sum(s["planned"] for s in mstat.values())
    summary = {"report": cfg["name"], "kind": "evaluation", "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "matrix": {"planned": planned, "completed": sum(s["completed"] for s in mstat.values()),
                          "failed": sum(s["failed"] for s in mstat.values()), "by_stage_network": mstat},
               "metrics": {k: {"label": v[0], "unit": v[1], "lower_is_better": v[2], "definition": v[3]} for k, v in METRICS.items()},
               "descriptives": desc, "paired": tests, "config": cfg, "software": (meta or {}).get("software"),
               "tsi_versions_by_stage": versions, "analysis_software": package_versions(),
               "attempts": {"total": len(attempts), "latest_by_status": {s: sum(1 for r in attempts if r["is_latest_attempt"] and r["status"] == s)
                                                                       for s in sorted({r["status"] for r in attempts})}},
               "notes": ["Preliminary simulation results; significance is not proof of real-world benefit.",
                         "Holm correction per stage; see report.md for the method and limitations."]}
    (out / "summary.json").write_text(json.dumps(summary, indent=1, default=str), encoding="utf-8")
    (out / "report.md").write_text(report_md(cfg, rows, desc, tests, meta, figs, mstat, versions, attempts), encoding="utf-8")
    print(f"report written to {out} ({summary['matrix']['completed']}/{planned} cells completed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
