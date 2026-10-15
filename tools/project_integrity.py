#!/usr/bin/env python3
"""Static release-gate checks that do not require SUMO, Maven, or npm downloads."""
from pathlib import Path
import ast, json, sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "README.md", "docker-compose.yml", "backend/pom.xml",
    "frontend/package.json", "frontend/index.html", "frontend/src/main.jsx",
    "frontend/src/style.css", "frontend/vite.config.js",
    "optimizer/app/main.py", "optimizer/app/swarm/engine.py",
    "optimizer/app/swarm/blackboard.py", "optimizer/app/swarm/multi_objective.py", "optimizer/tests/test_swarm.py", "optimizer/tests/test_swarm_modules.py",
    "simulation/telemetry.py", "simulation/baseline/fixed_time_controller.py",
    "simulation/swarm/adaptive_controller.py",
    "simulation/coordination/multi_agent_coordinator.py", "simulation/test_telemetry.py", "simulation/test_adaptive_contracts.py",
    "simulation/routing/pheromone_router.py", "simulation/safety/risk_field.py",
    "experiments/tools/run_experiment.py", "experiments/tools/run_matrix.py",
    "experiments/tools/kpi_engine.py", "experiments/tools/aggregate_matrix.py",
    "experiments/tools/scenario_generator.py", "experiments/tools/validate_scenarios.py", "experiments/tools/test_kpi_engine.py", "experiments/tools/test_matrix_aggregate.py", "experiments/tools/validate_run_artifacts.py",
    # Phase 1: generated networks, phase mapping, Controller V2, audit
    "simulation/config/networks.json", "simulation/network/presets.py", "simulation/network/grid_generator.py",
    "simulation/network/network_model.py", "simulation/network/phase_map.py", "simulation/network/demand.py",
    "simulation/network/build_network.py", "simulation/runtime.py", "simulation/version.py",
    "simulation/swarm/signal_agent.py", "simulation/safety/signal_audit.py", "simulation/conftest.py",
    "simulation/test_phase_map.py", "simulation/test_signal_controller.py", "simulation/test_grid_generation.py",
    "simulation/test_sumo_smoke.py", "optimizer/tests/test_blackboard_topology.py",
    "experiments/tools/benchmark_decisions.py", "experiments/reference/legacy_3x3_seed42.json",
    "docs/IMPLEMENTATION_STATUS.md",
]

def main() -> int:
    missing = [p for p in REQUIRED if not (ROOT / p).is_file()]
    if missing:
        print("MISSING:")
        print("\n".join(missing))
        return 1
    py_files = list((ROOT / "optimizer").rglob("*.py")) + list((ROOT / "simulation").rglob("*.py")) + list((ROOT / "experiments").rglob("*.py")) + list((ROOT / "tools").rglob("*.py"))
    for path in py_files:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    pkg = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    for key in ("react", "react-dom", "vite", "@vitejs/plugin-react", "recharts", "lucide-react"):
        if key not in pkg.get("dependencies", {}):
            print(f"MISSING FRONTEND DEPENDENCY: {key}")
            return 1
    forbidden = ["TODO", "FIXME", "YOUR_API_KEY", "example@example.com"]
    text = "\n".join((ROOT / p).read_text(encoding="utf-8", errors="ignore") for p in REQUIRED if (ROOT / p).suffix in {".py", ".java", ".jsx", ".js", ".json", ".md", ".properties"})
    found = [x for x in forbidden if x in text]
    if found:
        print("PLACEHOLDER TOKENS:", ", ".join(found))
        return 1
    print(f"OK: {len(REQUIRED)} required project files present")
    print(f"OK: {len(py_files)} Python files parse successfully")
    print("OK: frontend dependency manifest is structurally complete")
    return 0

if __name__ == "__main__":
    sys.exit(main())
