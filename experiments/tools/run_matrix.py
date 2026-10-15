#!/usr/bin/env python3
"""Run the reproducible scenario/seed experiment matrix."""
from pathlib import Path
import argparse
import json
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from experiments.tools.run_experiment import run, SCENARIOS
from simulation.network.presets import LEGACY_PRESET, preset_names


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the fixed-time vs swarm experiment matrix.")
    parser.add_argument("--root", default=str(PROJECT_ROOT))
    parser.add_argument("--seeds", nargs="+", type=int, default=[42, 43, 44])
    parser.add_argument("--scenarios", nargs="+", choices=SCENARIOS, default=list(SCENARIOS))
    parser.add_argument("--networks", nargs="+", default=[LEGACY_PRESET], choices=preset_names(),
                        help="Network presets from simulation/config/networks.json")
    parser.add_argument("--demand-seed", type=int, default=None, help="Fixed demand seed; default: the preset's")
    parser.add_argument("--vary-demand", action="store_true",
                        help="Use each run seed as the demand seed too (different demand per seed, shared by both controllers)")
    parser.add_argument("--max-time", type=float, default=3600.0, help="Safety cap (simulated seconds) per run so a gridlocked scenario cannot run indefinitely.")
    args = parser.parse_args()
    if any(seed < 0 for seed in args.seeds):
        parser.error("all seeds must be >= 0")
    root = Path(args.root).resolve()
    results = [run(scenario, seed, root, max_time=args.max_time, network=network,
                   demand_seed=seed if args.vary_demand else args.demand_seed)
               for network in args.networks for scenario in args.scenarios for seed in args.seeds]
    print(json.dumps({"runs": len(results), "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())