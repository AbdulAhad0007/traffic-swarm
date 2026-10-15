# Traffic Swarm Intelligence — Master Upgrade Plan

**Audit date:** 2026-10-12. Repository snapshot: the working tree (it is **not** a git repository).
**Scope:** I read every source file, config, doc and test, and I analysed the saved experiment artifacts. No application source code or configuration was modified.

## 0. How to read this document

Every finding has one of these evidence labels:

| Label | Meaning |
|---|---|
| **[CODE]** | Observed directly in source/config at the cited path. |
| **[DATA]** | Computed from saved artifacts under `experiments/runs/` (read-only analysis script run during this audit). |
| **[RAN]** | Executed during this audit in this environment. The output is quoted or summarized. |
| **[DOC-EXT]** | Relies on documented SUMO/TraCI behaviour, not verified on a running SUMO here. |
| **[ASSUMPTION]** | Inference or design proposal that has not been verified. |
| **[UNVERIFIED]** | Runtime behaviour that could not be checked here (SUMO, Java/Maven, Docker and MySQL are not installed). |

### What was executed during the audit **[RAN]**

| Check | Result |
|---|---|
| `python tools/runtime_preflight.py` | PYTHON OK, NPM OK. **SUMO, NETCONVERT, MAVEN, DOCKER and TraCI are MISSING.** `java` is also not on PATH. |
| `pytest -p no:cacheprovider -q` (scratch venv with pytest, fastapi, pydantic, httpx) | **13 passed** in 0.24 s. The docs say 12; one test was added later. |
| `python tools/project_integrity.py` | OK: 31 required files, 34 Python files parse, frontend manifest complete. |
| `validate_run_artifacts.py` on `experiments/runs/normal/seed-42` | **FAILS** with `baseline artifact must identify controller=fixed-time` (see Bug B7). |
| `npx vite build --outDir <scratchpad>` | **Builds** with Vite 8.3.0, React 19.3.0 and Recharts 3.10.1. One 586 kB chunk-size warning. |
| FastAPI `TestClient` smoke test against `optimizer/app/main.py` | `/health` returns UP. `/api/swarm/optimize` works for `J5`, returns **422 for `J10`**, and `risk=5` returns `safety_validated: False`. |
| Neighbor-pressure sensitivity: `optimize(state, pressure=0)` vs `optimize(state, pressure=500)`, same seed | **Same direction and same green time.** Only the score changes, from −2.4 to 57.6 (see Bug B4). |

Not executed: any SUMO run, Maven build or test, Docker or MySQL, a live backend, or `validate_scenarios.py`. That last one writes and deletes a temporary folder inside the repo, so I skipped it to avoid touching the tree.

---

## 1. Existing architecture and data flow

```
React (frontend/src/main.jsx, single file)
   │  polls every 5 s / 3 s
   ▼
Spring Boot (backend/…/ExperimentController, ExperimentService, ExperimentOrchestrator)
   │  JDBC (MySQL connector only)          │  ProcessBuilder: python experiments/tools/run_experiment.py
   ▼                                       ▼
MySQL table `experiments` (schema.sql)    run_experiment.run()
                                            ├─ scenario_generator.generate()   (scales flow rates)
                                            ├─ FixedTimeController.run()       (SUMO default static program)
                                            ├─ AdaptiveController.run()        (TraCI loop, imports optimizer engine IN-PROCESS)
                                            │     ├─ optimizer.app.swarm.engine.optimize()  (PSO + pheromone dict)
                                            │     ├─ SwarmBlackboard (neighbor pressure)
                                            │     ├─ MultiAgentCoordinator (green cap)
                                            │     └─ SafetyGate (risk_field.py)
                                            └─ kpi_engine.build_comparison() → comparison.json
   ◄── orchestrator reads comparison.json → UPDATE experiments.result (JSON)

FastAPI optimizer (optimizer/app/main.py, port 8001): standalone. Nothing calls it. [CODE: no reference to 8001 or to its endpoints outside README]
```

Key structural facts **[CODE]**:
- The simulation **does not use the FastAPI service**. `simulation/swarm/adaptive_controller.py` imports `optimizer.app.swarm.engine` directly.
- Spring Boot never talks to FastAPI. It shells out to Python and waits for the whole run to finish. There is no live telemetry.
- `PheromoneRouter` (`simulation/routing/pheromone_router.py`) and `multi_objective.score/pareto_front` (`optimizer/app/swarm/multi_objective.py`) are **used only by tests**. They play no part in any simulation or decision.
- The `controller` value accepted by `POST /api/experiments` (`baseline`, `swarm` or `comparison`) is stored but **ignored**. `ExperimentOrchestrator.execute` always runs the full comparison.

---

## 2. Repository-specific findings

### 2.1 SUMO network and demand (`simulation/scenarios/grid3x3/`)

| # | Finding | Evidence |
|---|---|---|
| N1 | The nodes `N`, `S`, `W` and `E` are declared in `grid.nod.xml`, but **no edge uses them**. They do not appear in `build.net.xml`. The grid has **no boundary approach roads**. | [CODE] |
| N2 | The corner junctions J1, J3, J7 and J9 have only two edges each, so netconvert produced a **single-phase program `GG` with a 90 s duration**. They are signalized in name only, with no conflicting movements. | [CODE] `build.net.xml` lines 348–389 |
| N3 | J2, J4, J6 and J8 are **T-junctions** (3 approaches). Only J5 is a 4-arm junction. | [CODE] `incLanes` attributes |
| N4 | **Demand defect.** All 8 routes in `routes.rou.xml` are 2-edge routes. Each one crosses **exactly one** signal (J2, J4, J5 or J8) from a single axis: r1/r2 cross J2 E–W, r3/r4 cross J5 E–W, r5/r6 cross J8 E–W, r7/r8 cross J4 N–S. **No junction receives conflicting demand**, and J1, J3, J6, J7 and J9 have no signal-crossing traffic at all. Signal optimization therefore has almost nothing to optimize, and no comparison on this demand can support a research claim. | [CODE] + [DATA] (route/approach analysis) |
| N5 | All roads are single-lane. There are no turn lanes, sidewalks or pedestrian crossings, and only one vehicle type (`car`). | [CODE] |
| N6 | `build.net.xml` is committed even though `.gitignore` excludes it. Its header records it was built by **netconvert 1.27.1** using absolute paths on a different user's machine. | [CODE] |

### 2.2 Controller V2 phase-mapping fix: **does not exist**

- I found no "V2", "phase mapping" or "Controller V2" string anywhere in the code or docs **[CODE]**. The only phase mapping is in `AdaptiveController._apply_timing` (`simulation/swarm/adaptive_controller.py:40–54`):
  `expected = 0 if direction=="NS" else 1; if phase % 2 != expected: reject`.
- Phase parity is **not** a direction. Here is how each junction's real program compares with what the code assumes **[CODE]**:

| TLS | Real green phases (straight movements) | Code assumption | Consequence |
|---|---|---|---|
| J5 (4-arm) | phase 0 = N+S, phase 2 = E+W; phases 1 and 3 are yellow | 0/even = NS, 1/odd = EW | An "EW" decision can only match a **yellow** phase. An "NS" decision also matches phase 2 (the **EW** green). |
| J2, J8 (T) | phase 0 = **E+W**, phase 2 = minor approach | phase 0 = NS | Directions are **inverted**. |
| J4, J6 (T) | phase 0 = N+S | phase 0 = NS | Correct by coincidence. |
| J1, J3, J7, J9 | single `GG` phase | phase 0 = NS | "NS" decisions are logged as `applied` to a no-op program. |

- **Lane grouping is also wrong** (`_lane_groups`, line 22). It splits unique controlled lanes by alternating index (`[::2]`, `[1::2]`). The result is correct for J5 but labels **E+W as "NS"** at J2, and **N+W as "NS"** at J6 and J8 [CODE + DATA].
- **Latent safety hazard.** The yellow phases of T-junctions contain a `G` character, for example J6 phase 1 `Gyyyyyrrr`. That means `_current_phase_is_green` returns True during yellow. If a decision fires while a T-junction is in yellow and the optimizer chose "EW", `setPhaseDuration` **extends a yellow phase to 10–60 s**. This was **not observed in the saved runs**: EW was applied 0 times [DATA]. It is reachable in code [CODE].
- **Max green is not enforced on the total phase.** `setPhaseDuration` sets the *remaining* duration [DOC-EXT]. Setting 60 s at 30 s into a green gives a 90 s green, even though `SafetyGate.max_green=60`.

### 2.3 Can decisions switch phases safely?

**No [CODE].** The controller can only change the remaining duration of whatever phase is current. It never selects a phase, never triggers a transition, and has no all-red or min-green tracking per phase. It cannot switch phases at all. The only safety comes from SUMO's own fixed sequence, and the yellow-extension path above can undermine that.

### 2.4 The fairness/safety gate disables the controller **[CODE + DATA]**

- `continuous_green` is measured from the last time `phase % 2` changed at a 30 s decision sample (`adaptive_controller.py:92–96`). Both green phases are even, and yellow is only 3 s, so the "direction" almost never changes. After 90 s the time keeps accumulating (up to 1050 s in `sudden-congestion/seed-44`). Corner junctions never change phase.
- Result across all 15 saved runs: **5463 decisions**. Of those, **5058 (92.6 %) were rejected with `fairness_cap_reached`**, 218 were rejected as `different_direction_phase`, and **187 (3.4 %) were applied**. Of the applied ones, **120 fall in the first decision cycle (t ≤ 31 s)**. **EW decisions were never applied.**
- In practice the "swarm" run is the fixed-time program plus a few duration tweaks in the first ~90 s.

### 2.5 Optimizer: what is actually implemented (`optimizer/app/swarm/engine.py`)

| Claim | Reality |
|---|---|
| PSO | **Implemented.** 18 particles × 12 iterations over (green ∈ [10,60], direction gene). Velocity, pbest and gbest updates are real. |
| ACO | **Minimal.** A `PheromoneMap` dict keyed `"<id>:<dir>"` with reinforce and evaporate, entering the objective as `-0.08*pheromone`. There are no ants, no path construction and no probabilistic transition rule. It is a pheromone-biased PSO rather than hybrid ACO. |
| Blackboard / neighbor coordination | Neighbor pressure enters the objective as a **constant additive term (`+0.12*neighbor_pressure`)**, independent of the decision variables, so **it cannot change the decision** [RAN: same decision at pressure 0 and 500]. The same applies to the `delay`, `stops` and `risk` terms. |
| Objective shape | The objective is linear in `served`, so the optimum is always at a bound (10 or 60 s), apart from PSO noise. Saved data shows 60 s is the most frequent green [DATA]. |
| Multi-agent coordination | `MultiAgentCoordinator.coordinate` caps green at min(45, same-direction neighbors' green). There are no offsets and no green wave. It is built from a dynamic class: `type("D",(),r)()`. |
| Multi-objective / Pareto | Implemented but unused in decisions. |
| Pheromone reinforcement | Reinforcement happens twice per decision, once inside `optimize()` and once in the controller (`5.0/(1.0+score)`, line 105). For score in (−1, 0) the value explodes and is clamped to 100. For score < −1 it is negative and becomes 0. **For score exactly −1.0 it raises `ZeroDivisionError` and the run crashes** (latent, [CODE]). |

### 2.6 Risk field (`simulation/safety/risk_field.py`)

- **It does not compute any risk.** `SafetyGate.validate` only checks a *supplied* `risk` value against `max_risk`. The controller always passes `risk=0` (`adaptive_controller.py:77`), so the risk check never triggers [CODE].
- The file **also contains a full duplicate copy of `AdaptiveController`** (lines 37–143). That copy launches `"sumo"`, while the real one launches `"sumo-gui"`. It is dead code, but it runs at import time [CODE].

### 2.7 Road-closure scenario

**Not a closure [CODE].** `scenario_generator.SCENARIOS['road-closure'] = 1.25` multiplies every flow by 1.25. No edge or lane is closed and there is no rerouting. `docs/PHASE_10.md` admits this. Similarly, `sudden-congestion` is a constant ×1.55 multiplier on the whole horizon (×2.5 on two flows), with **no time-varying surge**, and `uneven` boosts the first 4 flows.

### 2.8 KPI measurement (`simulation/telemetry.py`)

| # | Finding | Evidence |
|---|---|---|
| K1 | `average_delay_s` is computed from `traci.vehicle.getWaitingTime`, which **resets each time the vehicle moves**. `getAccumulatedWaitingTime` is the cumulative one. The comment "SUMO waiting time is cumulative" is wrong. The metric is "mean of each vehicle's longest single stop", not delay. | [CODE] + [DOC-EXT] |
| K2 | `throughput` equals `vehicles_observed` in **all 30 summaries**, because every vehicle arrives under this light demand. It cannot discriminate between controllers. | [DATA] |
| K3 | Fuel and CO₂ are summed per step, assuming a 1 s step and mg/s units. Units differ between SUMO versions. | [ASSUMPTION / DOC-EXT] |
| K4 | Per-step polling makes 4 TraCI calls per vehicle per step plus one per lane. This is a scaling bottleneck (§9). | [CODE] |
| K5 | There is no warm-up exclusion, no teleport count and no `tripinfo`/`timeLoss` output. | [CODE] |

### 2.9 Do saved results support the claims? **[DATA]**

Aggregated `improvement_pct` (positive means swarm is better), with n = 3 seeds (42–44) per scenario:

| Scenario | Avg delay | Travel time | Avg queue | Max queue |
|---|---|---|---|---|
| normal | +2.59 ± 1.94 | +1.21 ± 0.83 | +2.54 ± 2.01 | +14.8 ± 17.4 |
| rush-hour | +4.81 ± 6.87 | +2.03 ± 2.85 | +4.39 ± 6.40 | +10.7 ± 21.0 |
| sudden-congestion | −0.17 ± 2.75 | −0.29 ± 1.37 | +0.20 ± 1.69 | +6.3 ± 13.4 |
| road-closure | +0.65 ± 2.25 | +0.13 ± 0.75 | −0.26 ± 3.68 | +17.1 ± 15.9 |
| uneven | **−2.41 ± 0.54** (worse in 3/3 seeds) | −1.28 ± 0.33 | −0.16 ± 1.78 | −13.8 ± 12.4 |

Conclusions:
- The data shows **no consistent improvement**. Differences are within seed noise, and the swarm is worse on `uneven` in every seed. With n = 3 no difference is statistically supportable.
- `max_queue` is a single-sample peak and is very noisy. For example, normal/seed-42 shows "30.8 % improvement" while seed-43 is worse. It must not be quoted as a headline.
- The README and FINAL_RELEASE_STATUS **do not claim specific % numbers**, which is good. However, they **do** claim "J1–J9 multi-agent coordination", "hard safety gate", "pheromone/risk-aware routing" and "PostgreSQL persistence". Based on §2.2–2.6 and §2.10, these claims are overstated or wrong.
- `normal/seed-45` is **incomplete**: it has a baseline only and no swarm run or comparison.
- The saved `sumo.sumocfg` files contain **absolute paths from another machine**, so the runs cannot be replayed as-is here.
- `samples = 958` although `sumocfg` sets `end=900`. The run continued until the network emptied. I did not verify why with TraCI-driven SUMO **[UNVERIFIED]**.
- Both controllers launch **`sumo-gui`** (`fixed_time_controller.py:18`, `adaptive_controller.py:59`), while `run_experiment.py` only checks that `sumo` exists. Batch runs need a display, and the GUI may wait for a manual close [DOC-EXT / UNVERIFIED].

### 2.10 Backend, database and configuration

| # | Finding | Evidence |
|---|---|---|
| D1 | **The DB story is inconsistent.** `pom.xml` has only `mysql-connector-j`. `schema.sql` uses MySQL syntax (`INDEX` inside `CREATE TABLE`, `DATETIME`, `JSON`). `docker-compose.yml` starts MySQL 8. But the root `.env.example` sets `DB_URL=jdbc:postgresql://…`, and `FINAL_RELEASE_STATUS.md` says "PostgreSQL persistence". Using the root `.env.example` would fail: there is no Postgres driver and the schema is MySQL-only. | [CODE] |
| D2 | `application.properties` falls back to **`DB_USER=root` with a hard-coded non-empty default password** (value not reproduced here). That default matches **neither** compose credential, and the `DB_PASSWORD` values in both `.env.example` files also differ from compose. With the documented setup, a backend started without explicit env vars probably fails authentication. | [CODE] (values compared programmatically, not printed); connection failure itself [UNVERIFIED] |
| D3 | `docker-compose.yml` hard-codes MySQL user and root passwords (marked `dev_only`). These are development secrets committed in plain text, and the port binds 3306 on all interfaces. | [CODE] |
| D4 | Spring Boot does not read `.env` files by itself. The `.env.example` values must be exported or injected. | [DOC-EXT] |
| D5 | Schema management uses `spring.sql.init.mode=always` with no migrations. Changing the schema later needs Flyway or Liquibase. | [CODE] |
| D6 | `ExperimentOrchestrator` uses an **unbounded `newCachedThreadPool`**. Two runs with the same scenario and seed write to the same directory. Runs left `RUNNING` when the app restarts are never recovered. Output is read only at the end, so there is no streaming. | [CODE] |
| D7 | `ApiExceptionHandler.unexpected` returns raw exception messages to clients. There is no auth on any endpoint. Inputs are allow-listed, so command injection via ProcessBuilder is not possible today. | [CODE] |
| D8 | `backend/target/classes` contains compiled classes plus an empty `config/` package, which suggests a stale earlier build. I could not verify a Maven build because Java and Maven are missing. | [CODE] / [UNVERIFIED] |

### 2.11 Frontend (`frontend/src/main.jsx`, one 25-line file)

- It has a health card, a scenario select, a "Run baseline + swarm" button with **seed hard-coded to 42**, a history list, a Baseline-vs-Swarm bar chart and a raw JSON view [CODE].
- The "Agents: J1–J9" text is hard-coded. There is **no map, no live view and no heatmap**.
- `package.json` pins every dependency to `"latest"`, which is non-reproducible. The lockfile currently resolves React 19.3, Vite 8.3 and Recharts 3.10 [RAN].
- The build works [RAN]. There are no frontend tests.

### 2.12 Tests

- 13 Python unit tests, all pure-Python. **None exercises TraCI or SUMO** (no mocks), so the phase-mapping and fairness bugs are untested. `test_matrix_aggregate.py` only imports a module [CODE].
- The one Java test only checks a record accessor [CODE].
- `validate_run_artifacts.py` cannot pass on any existing artifact (B7).

### 2.13 Hard-coded 3×3 assumptions (all must go for 5×5, 9×9 and OSM) **[CODE]**

`engine.NEIGHBORS` (static J1–J9 dict) · `adaptive_controller.INTERSECTIONS = [f"J{i}" for i in range(1,10)]` (also duplicated in risk_field.py) · `seed=self.seed+int(state.intersection[1:])` (breaks on non-`J<n>` ids) · `OptimizeRequest.intersection` regex `^J[1-9]$` · binary NS/EW model everywhere (`TrafficState`, `SafetyGate`, `objective`) · `_lane_groups` alternating split · phase-parity mapping · `run_experiment.py` path `simulation/scenarios/grid3x3` · scenario names duplicated in 4 places (Python ×2, Java, JSX) plus the DB CHECK constraint · frontend "J1–J9" label.

---

## 3. Feature status table

| Feature / claim | Status | Basis |
|---|---|---|
| 3×3 SUMO grid | **Partial** | Exists, but corner junctions are single-phase, there are no boundary roads, and no junction has conflicting demand (N1–N4). |
| Fixed-time baseline | **Complete (weak)** | netconvert default 42/3/42/3 static program, not tuned (e.g. Webster). Runs `sumo-gui`. |
| SUMO actuated baseline | **Missing** | |
| Swarm controller (PSO) | **Partial** | PSO is real, but the objective ignores neighbors, delay and risk (§2.5), and decisions are mostly blocked (§2.4). |
| ACO | **Partial / overstated** | Only a pheromone bias term. |
| Blackboard coordination | **Partial / ineffective** | Published and read, but has no effect on decisions [RAN]. |
| Multi-agent coordination | **Partial** | Green cap only. No offsets or green waves. |
| Safety gate | **Partial, with defects** | Bounds check works. Fairness tracking is broken, max green is not enforced, the yellow-extension path exists, and risk is always 0. |
| Phase mapping (Controller V2) | **Missing** | No V2 code exists. The current mapping is wrong for 5 of 9 TLS. |
| Risk field / proactive safety | **Missing** | Only validates a supplied number. |
| Pheromone routing | **Implemented but unused** | Tests only. |
| Multi-objective / Pareto | **Implemented but unused** | Tests only. |
| Scenarios (5) | **Partial** | Scalar demand multipliers. Road closure is not a closure, and the congestion is not sudden. |
| KPI engine and aggregation | **Partial** | Delay metric is wrong (K1), throughput is uninformative, and there are no CI or significance tests. |
| Run artifact validator | **Broken** | B7. |
| FastAPI optimizer | **Complete but orphaned** | Works [RAN]; nothing uses it. |
| Spring Boot API and orchestration | **Partial** | Works in code. Build and run [UNVERIFIED]. `controller` field ignored, no concurrency control. |
| MySQL persistence | **Partial / misconfigured** | D1–D3. Runtime [UNVERIFIED]. |
| React dashboard | **Partial** | Builds [RAN]. No live view, map or heatmap. |
| Feature 1: emergency priority and green corridor | **Missing** | |
| Feature 2: OSM import | **Missing** | |
| Feature 3: live heatmap | **Missing** | |
| Feature 4: heterogeneous Indian traffic | **Missing** | Only one `car` vType. |
| Feature 5: congestion prediction | **Missing** | |
| Feature 6: fixed vs actuated vs swarm comparison | **Partial** | 2 of 3 controllers, on non-conflicting demand. |
| 5×5 / 9×9 grid generation | **Missing** | |
| Docker Compose | **Partial** | MySQL only. Not runnable here [UNVERIFIED]. |

---

## 4. Confirmed bugs and impact (priority order)

| ID | Bug | Location | Impact | Severity |
|---|---|---|---|---|
| B1 | Demand creates no conflicting movements at any junction | `simulation/scenarios/grid3x3/routes.rou.xml` | Signal control has nothing meaningful to optimize, so **every saved result is research-invalid** | **Critical** |
| B2 | Phase ↔ direction mapping uses `phase % 2` | `adaptive_controller.py:_apply_timing` | Wrong phase extended at J2, J5, J8. EW never served. Possible **yellow extension** at T-junctions (latent) | **Critical (safety)** |
| B3 | Fairness timer keyed on phase parity sampled every 30 s | `adaptive_controller.py:92–96` | 92.6 % of decisions vetoed, so the swarm is effectively fixed-time | **Critical** |
| B4 | Neighbor pressure, delay, stops and risk are constant terms in the objective | `engine.objective` | Coordination and blackboard claims are false in behaviour | High |
| B5 | Lane grouping by alternating index | `_lane_groups` | Queues are mislabeled at J2, J6 and J8 | High |
| B6 | Delay KPI uses the non-cumulative `getWaitingTime` | `telemetry.py`, both controllers | Headline KPI is mis-defined | High |
| B7 | Validator expects `controller="fixed-time"`, but the baseline writes `"baseline"` | `validate_run_artifacts.py:23` vs `fixed_time_controller.py:33` | The release gate can never pass | Medium |
| B8 | `setPhaseDuration` sets the remaining time, so total green can exceed `max_green` | `_apply_timing` | Safety bound is not enforced | High |
| B9 | `5.0/(1.0+score)` raises ZeroDivisionError at score = −1 and explodes near it | `adaptive_controller.py:105` | Possible mid-run crash. Erratic pheromone values | Medium |
| B10 | `sumo-gui` is launched for batch runs | both controllers | Headless and server runs fail or hang [UNVERIFIED] | Medium |
| B11 | Duplicate `AdaptiveController` inside `risk_field.py` | `simulation/safety/risk_field.py:37–143` | Maintenance trap. Divergent copies | Medium |
| B12 | DB driver, URL, credential and doc mismatch | `.env.example`, `application.properties`, `docker-compose.yml`, `FINAL_RELEASE_STATUS.md` | Backend likely cannot connect with documented setup | Medium |
| B13 | Hard-coded default DB password in app config, plain-text compose passwords | `application.properties`, `docker-compose.yml` | Secret hygiene | Medium |
| B14 | Unbounded thread pool, same-directory collisions, stuck `RUNNING` | `ExperimentOrchestrator` | Corrupted results under concurrent clicks | Medium |
| B15 | `controller` request field ignored | `ExperimentController` / `Orchestrator` | API contract misleading | Low |
| B16 | Road-closure and sudden-congestion are mislabeled | `scenario_generator.py` | Scenario claims invalid | Medium |
| B17 | `"latest"` npm versions | `frontend/package.json` | Non-reproducible builds | Low |
| B18 | Docs: test count, PostgreSQL claim, "SUMO not run" (runs now exist) | `README.md`, `FINAL_RELEASE_STATUS.md`, `docs/INTEGRATION_STATUS.md` | Documentation credibility | Low |

---

## 5. Recommended target architecture

Keep the current 3-tier shape: Python simulation, Spring Boot API with MySQL, and React. **Do not add microservices.** The FastAPI optimizer becomes optional, either as a "decision service" for demos or merged into the sim package.

```
React (Vite)  ── REST + SSE ──►  Spring Boot  ── JDBC ──► MySQL (metadata, KPIs, sampled series)
                                     │  ProcessBuilder (bounded queue, 1–N workers)
                                     ▼
                       Python `tsi` package (single codebase)
                       ├─ tsi.network   : grid generator (netgenerate), OSM import (netconvert), NetworkModel
                       ├─ tsi.demand    : randomTrips/duarouter, vType mixes, time-varying profiles, closures
                       ├─ tsi.control   : ControllerBase → FixedTime | SumoActuated | Swarm | (Emergency overlay)
                       │                   PhaseMap + SignalStateMachine + SafetyGate (hard constraints)
                       ├─ tsi.swarm     : PSO/ACO engine (id-agnostic), Blackboard keyed by TLS id, sim-clock
                       ├─ tsi.metrics   : tripinfo/edgedata parsing, KPIs, stats (CI, paired tests)
                       ├─ tsi.predict   : baseline + ML forecaster, evaluation, fallback
                       └─ tsi.runner    : run one (network, demand, controller, seed); emits events on stdout
```

### 5.1 Network model, generated not hard-coded **[ASSUMPTION: design]**
- `NetworkModel.from_net(net_file)` uses `sumolib.net.readNet`. It lists all TLS (`getTrafficLights()`), each TLS's controlled connections with link indices, incoming lanes per approach, approach bearing (from geometry), and **neighbors** (TLS reachable by one edge or edge chain without passing another TLS, with distance and travel time).
- The neighbor graph is computed and never typed by hand. A 9×9 grid must give 81 TLS and 2·9·8 = 144 undirected adjacencies.
- IDs are opaque strings everywhere. Delete `NEIGHBORS`, `INTERSECTIONS`, `int(id[1:])` and the `^J[1-9]$` regex. Seeds become `hash((run_seed, tls_id))` via a stable hash.

### 5.2 PhaseMap and SignalStateMachine (the real "Controller V2")
- `PhaseMap.from_program(tls)`: classify each phase as **green** (some link `G`/`g` that is not carried over from the previous phase's yellow) or **transition** (contains `y`, or all-red). For each green phase, record the **set of served movements** (link indices → incoming lane/approach). This works for 4-arm, T, corner, 5-leg and OSM junctions, with no NS/EW assumption.
- Agents decide **per phase**, not per direction: "extend current green by Δ" or "terminate now and go to green phase k".
- `SignalStateMachine` performs the change only via **SUMO-native transitions**:
  - **Terminate:** `setPhase(next_transition_index)`, which must be the yellow that follows the current green in the program.
  - **Skip to a non-adjacent green:** build the transition (yellow for every link going G/g→r, then optional all-red) from the two state strings and install it with `setProgramLogic` (or an extended program generated once at start).
  - **Extend:** only within `max_green` of the phase's **start time**. The machine tracks elapsed time itself instead of trusting `setPhaseDuration` semantics.
- `SafetyGate` hard constraints, checked on every actuation: min green, `max_green` measured from phase start, yellow ≥ 3 s (configurable), all-red ≥ 1 s optional, no G→r without yellow, **max red time per movement** (true fairness), pedestrian minimum walk when crossings exist, emergency preemption rules. Violations raise an alarm and fall back to the default program. Every rejected or accepted actuation goes to an audit log.

### 5.3 Swarm decision with coordination that actually affects decisions
- **Per-phase pressure state:** upstream queue minus downstream occupancy for each green phase's movements. Downstream spill-back risk comes from neighbor occupancy on the blackboard, so neighbor information becomes **decision-dependent**.
- PSO optimizes the **green split** (vector of green times per phase over a short horizon, cycle-bounded). The ACO-style pheromone stores which phase choices reduced measured pressure in recent cycles (reinforce by measured improvement and evaporate). This gives a real stigmergy loop with feedback from outcomes rather than from the predicted score.
- **Coordination:** for corridors, compute offsets from link travel time (green-wave) and add a neighbor-consistency penalty term. Use asynchronous, event-driven decisions per agent at phase boundaries, not a global 30 s tick. That scales to 81 agents.
- Keep the PSO cost bounded: decisions at phase ends only, with roughly 81 agents × 216 evaluations of pure-Python arithmetic per agent decision. The real cost is TraCI I/O, not PSO.

### 5.4 Live telemetry path (enables the heatmap)
- The Python runner prints **NDJSON events** on stdout (`{"type":"frame","t":…,"edges":{id:[occupancy,speed,halting]},"tls":{id:{phase,…}}}`) every *k* sim-seconds, plus `decision`, `safety` and `emergency` events.
- `ExperimentOrchestrator` switches from `readAllBytes` to line-by-line reading and fans events out through an `SseEmitter` (`GET /api/runs/{id}/stream`). It stores a down-sampled copy.
- This needs no extra broker, WebSocket service or Redis.

---

## 6. Dependency-aware implementation roadmap

Each phase ends with its acceptance gate (§8). No phase starts until the previous gate passes.

### Phase 0: Hygiene and truthfulness (no behaviour changes, about 1–2 days)
1. `git init` with an initial snapshot commit, **after your approval**.
2. Single DB story (**MySQL**): fix the root `.env.example`, remove the default password fallback (fail fast if `DB_PASSWORD` is unset), align compose and env examples using `${MYSQL_PASSWORD}` variable substitution in compose, and correct `FINAL_RELEASE_STATUS.md`. Back up the docs first.
3. Pin npm versions to the lockfile versions.
4. Add a `--gui` flag and default to headless `sumo`. Add `--quit-on-end`.
5. Fix B7 (controller label), B9 (division) and B11 (remove the duplicate class from `risk_field.py`, keeping only `SafetyGate`).
6. Write `docs/` corrections, after backing up the originals to `docs/archive/`.

### Phase 1: Measurement correctness (depends on 0)
- KPIs from SUMO outputs: `--tripinfo-output` (duration, `timeLoss`, `waitingTime`, `waitingCount`), `--statistic-output` (teleports, inserted/not-inserted vehicles), `--edgedata-output` (period 60 s), emissions device. Keep `TelemetryCollector` only for live frames.
- Add a warm-up exclusion, counts of unfinished and teleported vehicles, and penalties.
- `stats.py`: mean, 95 % CI (t-distribution / bootstrap), paired Wilcoxon signed-rank, and effect size. Comparison JSON schema v2.
- Re-run the validator on new artifacts. Archive the old `experiments/runs/` as *legacy, invalid demand* without deleting it.

### Phase 2: Network model, PhaseMap and Controller V2 on 3×3 (depends on 1)
- Rebuild the 3×3 grid with `netgenerate --grid` plus `--grid.attach-length` boundary roads, giving 4-arm signalized junctions everywhere. Keep the old `grid3x3/` as `grid3x3_legacy/`.
- **Demand with conflicting movements:** `randomTrips.py --fringe-factor` with turning traffic, plus time-varying profiles (ramp-up, peak, decay).
- `NetworkModel`, `PhaseMap`, `SignalStateMachine` and the new `SafetyGate` (§5.2). Port the swarm to per-phase pressure (§5.3).
- **Real scenarios:** road closure via `traci.lane.setDisallowed` / `edge.setMaxSpeed` at time *T*, or a SUMO `<rerouter>` with `closingReroute`, with `device.rerouting` on. Sudden congestion as a time-bounded surge on chosen edges.
- **Feature 6 (core):** three controllers, fixed-time (default plus optional Webster-tuned), **SUMO actuated** (`netconvert --tls.default-type actuated`, or `traci.trafficlight.setProgram` to the actuated program), and swarm, all on identical net, routes and seeds.

### Phase 3: Scalable grids 3×3, 5×5 and 9×9 (depends on 2)
- `tsi.network.generate_grid(n, length, lanes, left_turn_lanes)` produces a net and metadata JSON (TLS count, neighbor graph hash).
- Performance: replace per-vehicle polling with TraCI **subscriptions** (`vehicle.subscribe`, `lane.subscribe`, or `junction.subscribeContext`), with optional `libsumo` (`import libsumo as traci`) when available. Use outputs for KPIs.
- Bounded parallel runs (process pool) for seed matrices.

### Phase 4: Live dashboard and heatmap (Feature 3) (depends on 3; needs the stable topology API)
- Backend: `GET /api/networks/{id}/topology` returns simplified edge polylines from the net (pre-computed once, cached as JSON), and `GET /api/runs/{id}/stream` serves SSE.
- Frontend: split `main.jsx` into components. Add an SVG/canvas map (no paid map APIs; for OSM networks, optional free OSM tiles via Leaflet with attribution) with edges coloured by occupancy, speed ratio or halting. Add a time scrubber for replay of stored frames, TLS phase markers and a legend.

### Phase 5: Heterogeneous Indian traffic (Feature 4) (depends on 2; ideally 3)
- vType distribution: passenger, `motorcycle`, `bus`, auto-rickshaw, and pedestrians.
  - **Auto-rickshaw:** SUMO has no rickshaw vClass that I could verify here **[DOC-EXT/ASSUMPTION]**. Model it as a custom vType (≈3.2 m long, ≈1.4 m wide, max speed ≈ 12.5 m/s, lower acceleration) on a permitted class. Check `guiShape` support on the installed SUMO version.
  - Sublane model (`--lateral-resolution 0.8`) for lane filtering by two-wheelers.
- Pedestrians: `netconvert --sidewalks.guess --crossings.guess` and `personFlow`. PhaseMap must include crossing links, and the SafetyGate must enforce minimum walk and clearance times.
- Every parameter goes in a config file with its source cited, or is labelled "assumed, not calibrated".

### Phase 6: Emergency priority and green corridors (Feature 1) (depends on 2, 5)
- An `emergency` vType with `device.bluelight` (requires sublane).
- Detection: `vehicle.getNextTLS(ev)` gives the ordered TLS list with distances. ETA comes from distance and speed.
- **Corridor plan:** for each TLS within the horizon, a preemption request with a target phase (the one serving the EV's link index) and an activation time of ETA − (transition + min-green margin).
- The SignalStateMachine performs the **safe transition**. Yellow and all-red are never shortened, and min green is reduced only to a configured preemption floor. It holds green until the EV clears, then recovers (compensating the starved phases).
- Conflicts: multiple EVs are prioritized by ETA. Preemption is logged as an event.

### Phase 7: OSM import (Feature 2) (depends on 2, 3, 5)
- Input: a user-supplied `.osm` file, or an optional bounding-box download through the free Overpass API (rate-limited; optional; never required).
- Use `netconvert --osm-files … --tls.guess-signals --tls.join --junctions.join --ramps.guess --remove-edges.isolated --geometry.remove`, with typemap for vClasses, then `--sidewalks.guess` when pedestrians are enabled.
- Validation report: TLS count, unsupported or odd programs, disconnected components. Any TLS whose PhaseMap cannot be derived safely **keeps its default program** (excluded from swarm control) and is reported.
- Ship one small sample `.osm` (an Indian city area, a few dozen TLS) with ODbL attribution.

### Phase 8: Short-term congestion prediction (Feature 5) (depends on 3, 4 data)
- **Target:** per-edge occupancy (or mean-speed ratio) and a binary "congested" label (occupancy > θ, θ set from data) at horizons **+5 min and +15 min**.
- **Training data:** `edgedata` (60 s) from the simulated matrix (≥ 3 networks × 5 scenarios × ≥ 20 seeds). **Split by seed and scenario** (train seeds 1–14, validation 15–17, test 18–20), plus one fully held-out scenario. No temporal leakage.
- **Features:** last 5–15 lags of the edge, upstream and downstream neighbor lags, time-in-scenario, TLS green ratio.
- **Models:** persistence and historical mean (baselines), then ridge regression, then gradient boosting (scikit-learn, CPU, free).
- **Metrics:** MAE and RMSE for regression, and F1/AUROC for the congested label. Report per horizon.
- **Fallback:** if the model file is missing, features are stale, or confidence or drift checks fail, use persistence. The dashboard labels which predictor is active.
- Use in control is optional and behind a feature flag, evaluated as a separate controller variant.

### Phase 9: Experiment campaign and write-up (depends on all)
- A full matrix (networks × scenarios × 3 controllers × ≥ 10 seeds), with CIs and paired tests. Negative results are reported honestly.

---

## 7. API and database changes

### 7.1 REST (Spring Boot)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/networks` | `{kind:"grid", size:3/5/9, lanes, length}` or `{kind:"osm", fileId}`. Generates asynchronously. |
| POST | `/api/networks/osm-upload` | multipart `.osm` upload (size-limited) |
| GET | `/api/networks`, `/api/networks/{id}`, `/api/networks/{id}/topology` | list, metadata, and map geometry with TLS and neighbor graph |
| POST | `/api/experiments` | `{networkId, scenario, controllers:["fixed","actuated","swarm"], seeds:[…], vehicleMix, emergency:{…}, prediction:bool}` |
| GET | `/api/experiments/{id}` / `/runs` / `/comparison` | experiment, child runs, aggregated stats with CI and p-values |
| POST | `/api/runs/{id}/cancel` | kill the process and mark CANCELLED |
| GET | `/api/runs/{id}/stream` | SSE live frames and events |
| GET | `/api/runs/{id}/frames?from=&to=` | replay for the heatmap |
| GET | `/api/runs/{id}/emergency-events`, `/predictions` | feature data |

Keep the existing `/api/experiments` endpoints working through Phase 2 as a compatibility layer, then version them (`/api/v2`).

FastAPI: remove the `^J[1-9]$` constraint and accept phase-based state. Mark it explicitly as an optional demo endpoint, or retire it. Decide in Phase 2.

### 7.2 Database (MySQL 8, migrations via **Flyway**)
- `networks(id, kind, size, source_hash, net_file_path, tls_count, created_at, status)`
- `experiments(id, network_id FK, scenario, config JSON, status, created_at, …)`. Migrate the existing rows: **additive change, no drops**.
- `runs(id, experiment_id FK, controller, seed, status, started_at, completed_at, artifact_dir, summary JSON, error_message)` with `UNIQUE(experiment_id, controller, seed)`.
- `run_kpis(run_id FK, metric, value, PRIMARY KEY(run_id, metric))` for SQL aggregation.
- `run_frames(run_id, sim_time, payload JSON)`, **down-sampled**: for example 81 TLS / ~300 edges every 10 s over 1 h gives 360 rows per run. Full-resolution series stay as files in `artifact_dir`.
- `emergency_events(run_id, vehicle_id, tls_id, requested_at, granted_at, cleared_at, outcome)`
- `prediction_eval(model_version, horizon_s, split, mae, rmse, f1, auroc, created_at)`
- Remove scenario and controller CHECK lists from the schema, or move them into a lookup table, so new scenarios don't need DDL changes.
- Credentials come only from the environment, with no default fallback. Create a non-root app user.

---

## 8. Testing strategy and acceptance criteria

### 8.1 Test layers
1. **Pure unit (always run):** PhaseMap derivation on **checked-in net fixtures** (3×3 legacy, 4-arm, T, corner, generated 5×5, OSM sample). SafetyGate property tests with `hypothesis` (no G→r without yellow, min/max green, max red). NetworkModel neighbor counts. KPI parsing from tripinfo fixtures. Stats functions.
2. **Mocked-TraCI unit:** a fake `traci` module drives the SignalStateMachine. This is where B2, B3 and B8 regression tests go.
3. **SUMO integration (`@pytest.mark.sumo`, skipped when SUMO is missing):** a 120 s run per controller. Same seed gives an identical tripinfo hash (determinism). A safety audit log with zero violations.
4. **Backend:** `@WebMvcTest` for controllers, plus repository tests on MySQL via Testcontainers when Docker is present (H2 in MySQL mode as fallback).
5. **Frontend:** Vitest and React Testing Library for the comparison table and the heatmap colour scale. `npm run build` in CI.
6. **Experiment gate:** a strict `validate_run_artifacts.py` v2 on every run.

### 8.2 Measurable acceptance criteria

| Phase | Criterion |
|---|---|
| 0 | `project_integrity`, `pytest` and `vite build` pass. Backend starts against compose MySQL using only env vars (verified on a machine with Java and Docker). No credential literals in tracked config except clearly marked compose dev vars. |
| 1 | KPIs come from tripinfo. Validator v2 passes. Each comparison reports mean, 95 % CI and p-value over ≥ 10 seeds. |
| 2 | **0 safety violations** in the audit log across all runs (no G→r without ≥ 3 s yellow; green ≤ max_green from phase start; max red ≤ configured bound). Decision application rate and rejection reasons are reported. Every green phase of every TLS is reachable. Actuated baseline runs on the same routes. |
| 3 | Auto-discovered TLS count = N² for N ∈ {3,5,9}, and the neighbor graph has 2N(N−1) undirected edges. A 9×9, 3600 s headless run completes. Steps/s and wall-clock are **recorded** (target ≤ 15 min on the dev laptop, to be measured, not assumed). |
| 4 | Heatmap renders 81 TLS / all edges at ≥ 1 frame/s with < 2 s lag from sim time in a live run. Replay matches stored frames. |
| 5 | Vehicle-type shares in tripinfo are within ±2 percentage points of the configured mix. Pedestrian crossings get walk time ≥ configured minimum. |
| 6 | EV travel time and number of stops reported vs a no-preemption control over ≥ 10 seeds. 0 safety violations. Change in general-traffic delay reported. |
| 7 | The sample OSM net imports reproducibly (same hash). Every TLS is either controlled or explicitly excluded with a reason. One full comparison run completes. |
| 8 | On held-out seeds the model beats persistence by ≥ 10 % MAE at +5 min. **If not, report it as a negative result and keep persistence as the active predictor.** Fallback path is tested. |
| 9 | All claims in README and report trace to an artifact path and a statistical test. |

---

## 9. Risks, performance bottlenecks and safety constraints

**Performance**
- TraCI round-trips dominate. The current loop makes about 4·V + L calls per step. With roughly 3000 vehicles on 9×9, that is ~12k calls per step, likely minutes per simulated minute **[ASSUMPTION; to be measured]**. Mitigation: subscriptions or libsumo, output files for KPIs, and frames every 5–10 s.
- Use event-driven decisions at phase ends instead of one global tick for all 81 TLS.
- Frontend: render the map with canvas, or SVG with a single path per edge, and diff frames. Keep SSE payloads small (quantized values, edge index arrays).
- MySQL: never store per-step series in rows (§7.2).

**Research validity**
- The baseline must be non-trivial: include actuated, and optionally Webster-tuned fixed time.
- Report negative results. Use ≥ 10 seeds. Exclude warm-up. Count teleports and unfinished trips.
- Prediction: avoid leakage by splitting by seed and scenario, and compare against persistence.

**Technical**
- SUMO version drift: the net was built with 1.27.1. Pin and record the SUMO version in run metadata, and regenerate nets instead of committing machine-specific ones.
- Windows path handling: keep POSIX paths in generated XML (already done) and avoid absolute paths in committed artifacts.
- OSM networks have irregular TLS programs (joined clusters, many phases). Mitigate with PhaseMap validation and default-program fallback per TLS.
- Scope and time for a final-year project: Phases 0–3 plus Feature 6 deliver the research core. Features 1–5 are layered on top and can be trimmed without breaking the core.

**Safety constraints (non-negotiable, enforced in SafetyGate rather than the optimizer)**
- Never shorten or extend yellow beyond configured bounds. Never go G→r without yellow. Always include all-red where configured.
- min green ≤ green ≤ max green, measured from **phase start**.
- Every movement's max red is bounded (fairness and anti-starvation).
- Pedestrian walk and clearance minimums.
- Emergency preemption uses the same transitions. Only min green may be reduced, to a floor.
- On any exception or inconsistency, fall back to the default program for that TLS and log it.

---

## 10. Commands to validate the existing project

```bash
# environment
python tools/runtime_preflight.py
python tools/project_integrity.py

# python tests (needs: pip install pytest fastapi "pydantic>=2.7" httpx)
python -m pytest -q

# scenario generation check: run from repo root (uses repo-relative paths);
# writes and then deletes experiments/.scenario-validation/
PYTHONPATH=experiments/tools python experiments/tools/validate_scenarios.py

# artifact validator (currently FAILS by design flaw B7)
python -m experiments.tools.validate_run_artifacts experiments/runs/normal/seed-42

# aggregate saved results
python experiments/tools/aggregate_matrix.py

# optimizer API
cd optimizer && python -m uvicorn app.main:app --port 8001
curl -s localhost:8001/health

# SUMO run (needs SUMO + TraCI on PATH; controllers currently open sumo-gui)
python experiments/tools/run_experiment.py --scenario normal --seed 42 --root . --max-time 1200

# backend (needs Java 21 + Maven + MySQL; export DB_URL/DB_USER/DB_PASSWORD first)
docker compose up -d mysql
cd backend && mvn -q test && mvn spring-boot:run
curl -s localhost:8080/api/health

# frontend
cd frontend && npm ci && npm run build && npm run dev
```

Executed in this audit: preflight, integrity, pytest (13 passed), artifact validator (fails as expected), FastAPI TestClient smoke and Vite build into a scratch directory. Everything else is **[UNVERIFIED]** here.
