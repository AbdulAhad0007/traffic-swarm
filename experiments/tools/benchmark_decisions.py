#!/usr/bin/env python3
"""Measure swarm decision latency as the number of junctions grows (no SUMO run needed).

Builds each preset's network (netconvert required for generated grids), then times the
controller's full decision tick (observe -> blackboard -> PSO+ACO -> coordination -> safety gate)
on synthetic lane queues. TraCI I/O is excluded; it is reported separately by real runs
(swarm_summary.json: decision_tick_latency_ms).

  python experiments/tools/benchmark_decisions.py --presets grid3x3 grid5x5 grid9x9 --ticks 50
"""
from pathlib import Path
import argparse, json, random, statistics, sys, time

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from simulation.network.build_network import ensure_network
from simulation.swarm.adaptive_controller import AdaptiveController


def benchmark(preset: str, ticks: int, root: Path, seed: int = 1) -> dict:
    info = ensure_network(preset, root)
    controller = AdaptiveController(seed, settings=info["preset"]["controller"])
    agents = controller.build_agents(info["model"])
    rng = random.Random(seed)
    lanes = sorted({l for a in agents.values() for g in a.phase_map.greens for l in g.served_lanes})
    for a in agents.values():
        if a.phase_map.greens:
            a.on_phase(a.phase_map.greens[0].index, 0.0, controller.settings["max_green_s"])
    tick_ms = []
    for tick in range(ticks):
        queues = {l: rng.randint(0, 12) for l in lanes}
        occ = {l: rng.random() * 0.6 for l in lanes}
        now = 15.0 + tick * controller.decision_interval
        t0 = time.perf_counter()
        controller.decide(now, tick, lambda l: queues.get(l, 0), lambda l: occ.get(l, 0.0), [])
        tick_ms.append((time.perf_counter() - t0) * 1000)
    n = len(agents)
    ordered = sorted(tick_ms)
    return {"preset": preset, "junctions": n, "ticks": ticks,
            "tick_ms_mean": round(statistics.fmean(tick_ms), 3),
            "tick_ms_p95": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 3),
            "per_junction_ms_mean": round(statistics.fmean(tick_ms) / n, 4)}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--presets", nargs="+", default=["grid3x3", "grid5x5", "grid9x9"])
    p.add_argument("--ticks", type=int, default=50)
    p.add_argument("--root", default=str(PROJECT_ROOT))
    args = p.parse_args()
    results = [benchmark(name, args.ticks, Path(args.root).resolve()) for name in args.presets]
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
