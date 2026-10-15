# Traffic Swarm Intelligence — Release Status

## Included
- 3x3 SUMO signalized grid specification and scenario generator
- Fixed-time baseline controller with measured telemetry
- Hybrid PSO + ACO swarm optimizer
- Shared traffic-swarm blackboard / digital pheromone
- J1–J9 multi-agent coordination
- Multi-objective scoring and Pareto helpers
- Safety gate with conservative signal-update behavior
- Pheromone/risk-aware routing component
- Five reproducible experiment scenarios
- KPI comparison and multi-seed aggregation tools
- FastAPI optimizer service
- Spring Boot experiment API and PostgreSQL persistence
- React/Vite dashboard with experiment history and KPI charts
- Runtime preflight, scenario validation, run-artifact validation and project integrity checks
- Environment examples and reproducibility documentation

## Verification completed in the build environment
- Python compilation: PASS
- Python unit/integration-style tests: 12/12 PASS
- Scenario generation/validation: 5/5 PASS
- Project integrity checks: PASS

## Environment-dependent verification boundary
The build environment used for this release does not contain SUMO/netconvert/TraCI, Maven, Docker, or a completed npm dependency installation. Therefore the release does **not** claim that an actual SUMO simulation, Spring Boot Maven build, PostgreSQL container, or browser production bundle was executed here. No KPI improvement numbers are fabricated to compensate for that limitation.

Once the project is opened in an environment with those dependencies, the documented runners execute the real baseline-vs-swarm experiments and write measured artifacts under `experiments/runs/`.

## Research integrity
The project does not copy literature percentages from the supplied report as project results. All improvement values shown by the dashboard/comparison tools must come from measured experiment artifacts.
