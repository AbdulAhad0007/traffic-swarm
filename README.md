# Traffic Swarm Intelligence

Simulation-first final-year B.Tech CSE project based on the supplied technical report. The system models a 3x3 network as nine cooperating intersection agents (J1–J9), uses a shared traffic-swarm blackboard/digital pheromone map, hybrid PSO+ACO signal optimization, safety gating, optional pheromone routing, reproducible scenario experiments, a Spring Boot orchestration API, PostgreSQL (Supabase) experiment storage, and a Next.js dashboard.

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
Install SUMO (including `sumo`, `netconvert`, and Python TraCI bindings), Java 21, Maven, Node/npm and Docker. The database is hosted on Supabase; set `DB_URL`, `DB_USER` and `DB_PASSWORD` for the backend.

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

### Real-world traffic signals (OpenStreetMap)
- **Signal Map** (`/ghaziabad`): pick a city, search any place or scan the visible map. Nodes are only placed where OSM has mapped `highway=traffic_signals`; signal heads of one crossing are merged into one junction, and junctions are linked only by the real road between them. Quick-pick cities open instantly from snapshots in `frontend/public/osm/` (refresh with `node frontend/scripts/osm-snapshot.mjs`); other areas are fetched from all public Overpass mirrors at once and cached in the browser for a week.
- **Live Lab real-world areas** (`/live`): add a place (≤ 4 km²); the lab downloads its OSM extract into `simulation/scenarios/osm/user/` and jobs on it run SUMO on the real roads and lights. The world map then draws every traffic light at its real coordinates (the net's UTM projection is inverted in `simulation/network/geo.py`). Synthetic grids are labelled as having no real location.
- OSM has no live traffic counts: queues, platoons and fuel are simulated on modelled demand. Data © OpenStreetMap contributors, ODbL 1.0.

### Evaluation matrix and statistics
Method: `docs/RESEARCH_METHODOLOGY.md`. Run `python -m experiments.tools.evaluate_matrix run --stage core --workers 4` (stages: core, ablation, emergency, mixed; check progress with `status`), then `python -m experiments.tools.analyze_evaluation`. The report goes to `experiments/reports/<matrix>/`. Results are preliminary until the matrix status shows every planned cell completed.

### Live Digital City (Overview)
The Overview page opens on a live view of a real SUMO run: vehicles, signals, road congestion, agent messages, emergency corridors and a guided walkthrough. It reads recorded frames and `live/events.jsonl` from the Lab API, and shows nothing when no real run is available. **Run demo scenario** starts the `demo_city` preset (12 signals, 2-lane roads, assumed vehicle mix) with real SUMO at 1x. Pause and 1x/2x/5x/10x apply to SUMO itself through `POST /api/lab/jobs/{id}/control`; an abandoned pause ends after 30 minutes. The default view is a top-down canvas, with the 3D view one click away. If the Lab API cannot be reached, the page offers Retry and a DEMO MODE: a small model in `components/command/browserDemo.js` that runs in the browser, is labelled on screen and is never mixed with SUMO data. Message travel time on screen is for display only. Road capacity is an estimate (lane metres / 7.5 m), and the six road levels are display conventions set in `simulation/config/live.json`.

Regional coordinators and the central supervisor exist only in the `swarm_hierarchical` and `swarm_hierarchical_priority` controllers. `swarm` never builds them, so its results are unchanged. In a first check (grid5x5, rush-hour, seed 42, 1200 s) `swarm_hierarchical` did worse than `swarm`: 1660 vs 1908 vehicles arrived, max queue 598 vs 412, 6.03 vs 5.44 stops per vehicle. It is a demonstration of coordination, not a measured improvement. Evaluate and tune it before making any performance claim.

Apply `db/migrations/004_live_city_section.sql` to control the section from the admin panel.

### Live Camera
`/live-camera` runs video through detection, tracking, traffic analytics, the swarm's agents and a safety validator. The code is in `camera_service/`, a separate service, so a camera or model failure cannot affect the simulation lab.

```bash
python -m venv --system-site-packages .venv
.venv/Scripts/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision   # or your CUDA build
.venv/Scripts/pip install -r camera_service/requirements.txt
.venv/Scripts/python -m uvicorn camera_service.api:app --host 127.0.0.1 --port 8091
```

Apply `db/migrations/005_live_camera_module.sql` before deploying. It adds the module, switched off, and its tables. Without it the service saves to a local SQLite file and says so on the page. Set `CAMERA_URL` and `TSI_GATEWAY_SECRET` on the website and the same secret on the service, plus `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the service so it can follow the admin toggles. Set `TSI_CAMERA_SECRET_KEY` to save credentials from the page. On a hosted website the service needs its own reachable, protected address. Frigate and go2rtc: `deploy/live-camera/`.

- **Labels:** webcams and USB cameras are always TEST SOURCE, and uploaded or file-backed streams are always REPLAY. LIVE is an administrator's statement that a source is a real roadside camera.
- **Video privacy:** video is visible to signed-in administrators only until **Public video previews** is turned on. Frames stay in memory unless a camera's retention setting saves snapshots.
- **Measurements:** without a calibration line, queues are in vehicles and speeds in pixels per second. With one, metres and m/s are estimates, because one scale cannot remove camera perspective.
- **Signal modes:** SIMULATION applies validated plans to SUMO through TraCI. SHADOW only records recommendations. REAL CONTROLLER is always refused: this project contains no code that sends commands to signal hardware.
- **Performance:** nothing here shows that camera-driven plans improve traffic. The SUMO scenario's traffic is not generated from the camera's traffic; simulation mode demonstrates the control path and its safety checks.

Tests: `pytest camera_service/tests`. The real pipeline test needs go2rtc, ffmpeg and a road video: see `camera_service/tests/test_e2e_real.py`.

### Admin panel
`/admin` turns the ten public modules and their sections on or off. Setup, environment variables and deployment: `docs/ADMIN_PANEL_DEPLOYMENT.md`. Tests: `cd frontend && npm run build && npm test`.

## Research integrity
The project does not ship fabricated KPI improvements. Research-paper percentages in the supplied report are scenario-specific literature results; this implementation is intended to measure its own SUMO results. Safety constraints take precedence over optimization.
