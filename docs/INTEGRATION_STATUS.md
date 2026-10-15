# Integration Status

This repository is the reconstructed Traffic Swarm Intelligence implementation based on the supplied technical report. The target is a simulation-first digital traffic laboratory: a 3x3 SUMO network, fixed-time baseline, swarm signal control, shared traffic-pressure/pheromone state, optional routing, safety gating, experiment orchestration, KPI comparison and a React dashboard.

## Completed source phases

1. Foundation and API contracts
2. SUMO 3x3 network source files and TraCI adapters
3. Fixed-time baseline and measured KPI telemetry
4. Hybrid PSO + ACO optimizer
5. Shared Traffic Swarm Blackboard and digital pheromone
6. J1-J9 neighbor coordination
7. Multi-objective scoring and Pareto utilities
8. Pheromone routing and hard safety gate
9. React experiment dashboard and KPI charting
10. Scenario generation, reproducibility, comparison and aggregation tooling

## Automated verification

- Python compilation: PASS
- Python tests: **12 passed**
- Scenario validation: **5/5 passed**
- No fabricated KPI results are included.

## Environment-dependent verification

The current build environment has Python, Java 21 and npm. It does not currently provide SUMO, netconvert, TraCI, Maven or Docker. Those checks therefore remain explicitly unverified rather than being reported as successful.

A final release must pass these environment-dependent checks on a machine with the required tools, then execute at least one complete baseline-vs-swarm run and a reproducible multi-seed matrix before the final ZIP is produced.

## Release-gate hardening completed

- Blackboard freshness now accepts the simulation clock used by SUMO, so J1–J9 neighbor pressure is not incorrectly compared against wall-clock Unix time.
- Telemetry stop-state is an explicit dataclass field; no dynamic/private attributes are used.
- Average travel time is normalized by vehicles that actually arrived, not all observed vehicles.
- Experiment CLI validates the seed, scenario directory and SUMO executable before starting, and uses portable POSIX paths inside generated SUMO XML.
- Backend CORS is configurable through `TSI_WEB_ALLOWED_ORIGINS` for the React development server and deployment environments.
- Vite React configuration and environment examples are included.
- A static `tools/project_integrity.py` release gate checks required files, Python syntax, frontend dependency declarations and placeholder tokens.

The source-level release gate and all currently executable tests pass. The only remaining verification boundary is environmental: this workspace still lacks SUMO/TraCI, Maven and a successful npm dependency installation, so a real SUMO run, Spring Boot build and production frontend build must not be represented as passed until those runtimes are available.

### Latest hardening pass
- Experiment results now include UTC generation metadata and same-seed/controller provenance.
- KPI percentage-change handling rejects non-numeric/NaN values instead of producing misleading output.
- Frontend API URL handling is normalized for trailing slashes and API error bodies are surfaced to the UI.
- Added `experiments/tools/validate_run_artifacts.py` as a strict post-run artifact/schema gate.
- Static release gate now covers the project test modules and artifact validator.
- Latest source-only verification: Python compilation PASS, 12 tests PASS, 5/5 scenario validation PASS, static release gate PASS.
