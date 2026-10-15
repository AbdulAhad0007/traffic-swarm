# Traffic Swarm Intelligence

Simulation-first final-year B.Tech CSE project based on the supplied technical report. The system models a 3x3 network as nine cooperating intersection agents (J1–J9), uses a shared traffic-swarm blackboard/digital pheromone map, hybrid PSO+ACO signal optimization, safety gating, optional pheromone routing, reproducible scenario experiments, a Spring Boot orchestration API, MySQL experiment storage, and a React dashboard.

## Phases
1. Foundation/contracts — Python, Java, React, Docker structure and APIs.
2. SUMO network + traffic state collection — 3x3 signalized grid and TraCI adapters.
3. Fixed-time baseline + KPIs — baseline runner and comparison engine.
4. Hybrid PSO + ACO — particle velocity/pbest/gbest plus pheromone reinforcement/evaporation.
5. Traffic Swarm Blackboard — shared observations, neighbor pressure and pheromone state.
6. Multi-agent coordination — J1–J9 topology and coordinated green constraints.
7. Multi-objective optimization — queue/delay/stops/throughput/emissions/safety weighting and Pareto utility.
8. Routing + proactive safety — pheromone route choice and hard safety gate/fallback.
9. React dashboard — health, experiment runner and history UI.
10. Experiments/reproducibility — five scenarios, fixed seeds, raw artifacts, comparison JSON, aggregation and validation tooling.

## Release status
See `FINAL_RELEASE_STATUS.md` for the exact verification boundary. The source implementation is complete, while SUMO/Maven/npm runtime checks depend on external tools that are not installed in the current build environment.

## Run
Install SUMO (including `sumo`, `netconvert`, and Python TraCI bindings), Java 21, Maven, Node/npm and Docker. Start MySQL with `docker compose up -d mysql`.

Optimizer: `cd optimizer && python -m uvicorn app.main:app --reload --port 8001`
Backend: `cd backend && mvn spring-boot:run`
Frontend: `cd frontend && npm install && npm run dev`

Run one experiment from repository root: `python experiments/tools/run_experiment.py --scenario normal --seed 42 --root .`
Run matrix: `python experiments/tools/run_matrix.py --root .`
Runtime preflight: `python tools/runtime_preflight.py`

### Network presets (Phase 1)
Network size and timing are configured in `simulation/config/networks.json` (no code changes needed). Presets: `grid3x3_legacy` (original J1–J9 network, default), `grid3x3`, `grid5x5`, `grid9x9`.

- Build + validate a network: `python -m simulation.network.build_network --preset grid9x9`
- Run on a generated grid: `python experiments/tools/run_experiment.py --network grid9x9 --scenario normal --seed 42 --root .`
- SUMO runs headless by default; add `--gui` (or set `TSI_SUMO_GUI=1`) for sumo-gui.
- SUMO can be installed with pip: `pip install -r simulation/requirements.txt`

See `docs/IMPLEMENTATION_STATUS.md` for what Phase 1 changed, measured results and known limitations.

### Evaluation matrix and statistics
Method: `docs/RESEARCH_METHODOLOGY.md`. Run `python -m experiments.tools.evaluate_matrix run --stage core --workers 4` (stages: core, ablation, emergency, mixed; check progress with `status`), then `python -m experiments.tools.analyze_evaluation`. The report goes to `experiments/reports/<matrix>/`. Results are preliminary until the matrix status shows every planned cell completed.

## Research integrity
The project does not ship fabricated KPI improvements. Research-paper percentages in the supplied report are scenario-specific literature results; this implementation is intended to measure its own SUMO results. Safety constraints take precedence over optimization.
