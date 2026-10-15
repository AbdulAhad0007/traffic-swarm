# Implementation Status

## Evaluation pipeline (`1.3.2-eval`, 2026-10-13): reproducible, statistically analysed results

**Status: the pipeline is complete. The matrix is INCOMPLETE: 138 of 320 planned cells are done.**
- Every number below is preliminary simulation evidence. None of it is a proven result.
- Method: `docs/RESEARCH_METHODOLOGY.md`.
- Generated report: `experiments/reports/eval-v1/report.md`. Machine-readable outputs sit next to it:
  - `runs.csv`
  - `attempts.csv`
  - `descriptives.csv`
  - `paired_tests.csv`
  - `summary.json`
  - `figures/`
- Backups of the modified files: `backups/pre-eval-2026-10-13/`.

### What was built or changed
- **Matrix runner** (`experiments/tools/evaluate_matrix.py`):
  - Staged, resumable and cancellable.
  - New `--rerun` option.
  - An existing run directory is *moved* to `experiments/evaluation/<name>/superseded/<UTC>/` before any re-attempt. Nothing is deleted.
  - Each ledger line records `tsi_version`.
- **Analysis** (`experiments/tools/analyze_evaluation.py`), recomputed from raw tripinfo, statistics and time series:
  - New primary delay metric `mean_total_delay_all_s`. It uses the same vehicle set for every controller and includes unfinished vehicles (censored).
  - `mean_queue_veh` now averages over the fixed demand window. Before, it averaged over each run's own length, which is a denominator bias.
  - New metrics: `halted_vehicle_hours`, `arrived_share`, prediction RMSE and fallback share.
  - New per-test check `arrived_mismatch_max_pct`. When it exceeds 1 %, per-arrived metrics get a CAUTION.
  - Attempt history (including superseded attempts) and actual analysis package versions.
  - A runtime/cost table, a prediction section and ablation notes (GA not implemented; safety gate never disabled).
  - Relative-change forest plots.
  - A power-floor limitation note.
- **Real road closure fixed** (`simulation/runtime.py`, `simulation/network/scenario_builder.py`):
  1. **Rerouting.** SUMO's `closingReroute` does not change the router's weights (verified on SUMO 1.27.1). So `rerouteTraveltime` at closure start kept 4 of 4 approaching vehicles on the closed edge, and one drove onto the closed road. Each such vehicle now gets a prohibitive personal travel time for the edge before rerouting.
  2. **Physically committed vehicles.** Vehicles that cannot stop before the stop line (remaining distance < v²/2b) are recorded as committed, like vehicles already inside the junction.
  3. **Edge selection.** The old check was node-level. It accepted closures at grid corners where traffic arriving from one side had no legal detour (no U-turns). SUMO itself logged `No connection between edge 'J0_1__J0_0' and edge 'J4_0__S0'`. Selection now follows lane connections for every predecessor → closed edge → successor movement and skips trip origin/destination edges. Unit tests: `simulation/test_closure_selection.py`.
  4. **Likely cause of the 9×9 SUMO crashes.** The 4 earlier 9×9 road-closure SUMO crashes ("Connection closed by SUMO", swarm only) occurred with the old closure code. One of them (seed 47) completed after fix 1 in an isolated run, with 0 vehicles entering the closed edge. That is consistent with the closure bug being the cause, but it is not proven.
- `docs/RESEARCH_METHODOLOGY.md` (new) is the single definition of design, controllers, metrics, statistics and validity threats. The missing `docs/CONTROLLERS.md` reference now points there.

### Matrix execution status (`python -m experiments.tools.evaluate_matrix status`)

| Stage | Planned | Completed | Notes |
|---|---|---|---|
| core: normal, rush-hour, uneven, sudden-congestion | 120 | 120 | `1.3.0-features`. Unaffected by the closure fixes, which only touch the closure code path. |
| core: road-closure | 30 | 18 | 3×3 and 5×5: 9 + 9 completed, 1 + 1 failed, all with `1.3.1-eval` (rerouting fix, old edge selection). 9×9: 10 cancelled (stopped on purpose when the edge-selection bug was found). **All 30 must be re-run with `1.3.2-eval`**: 14 of the 30 cells get a different closure edge under the corrected selection. |
| ablation | 50 | 0 | Was running when the background job was stopped by Claude Code because the machine ran low on memory (16 GB RAM, 10 parallel workers). No ablation attempt was recorded. |
| emergency | 20 | 0 | not started |
| mixed | 100 | 0 | not started |

### Preliminary core findings (completed cells only; seeds 42–51; Holm-corrected per stage)

The road-closure rows come from `1.3.1-eval` and are superseded once re-run.

| Metric | actuated vs fixed | swarm vs fixed | swarm vs actuated |
|---|---|---|---|
| Mean total delay, all vehicles | lower in 14/14 network×scenario cells (−12 % to −87 %); significant in 8 | **no significant difference in 14/14** (−59 % to +16 %) | significantly worse in 8/14, never significantly better |
| Stops per vehicle | mixed (−55 % to +18 %); 2 significantly better, 1 significantly worse | **more stops in 14/14 (+17 % to +105 %)**; significant in 10 | significantly worse in 10/14 |
| Mean queue (demand window) | significantly lower in 11/14 | significantly lower in 10/14 (−8 % to −47 %) | mixed: 7 worse, 2 better |

How to read this:
- Within these simulated scenarios, SUMO's gap-based actuated control reduced delay compared with the unoptimised fixed-time programs.
- The swarm controller reduced network queues during the demand period. It did **not** reduce all-vehicle delay compared with fixed-time, and it increased stops.
- These are associations under matched demand, not causal claims about real traffic.
- The fixed-time baseline is a netconvert default, and the swarm has ideal sensing; see the methodology's threats to validity.
- Several large effects show "no significant difference" because of the n = 10 non-parametric p-value floor under a large Holm family. This is explained in the report; the rules were not changed after seeing the data.

### Tests (this session, SUMO 1.27.1 on PATH)

| Command | Result |
|---|---|
| `python -m pytest -q` | **114 passed**, 0 failed (includes SUMO smoke tests and 5 new tests: `experiments/tools/test_analyze_evaluation.py`, `simulation/test_closure_selection.py`) |
| `python tools/project_integrity.py` | OK |
| Backend `mvn test`, frontend `vite build` | **not run**: Java/Maven are not installed, and the frontend was not changed |

### To finish the matrix (one stage at a time; fewer workers because of the memory limit)

```
python -m experiments.tools.evaluate_matrix run --stage core --scenarios road-closure --rerun --workers 4
python -m experiments.tools.evaluate_matrix run --stage ablation  --workers 4
python -m experiments.tools.evaluate_matrix run --stage emergency --workers 4
python -m experiments.tools.evaluate_matrix run --stage mixed     --workers 4
python -m experiments.tools.analyze_evaluation
```

- The partial ablation directories left by the stopped job are moved to `superseded/` automatically before each cell runs.
- 9×9 swarm road-closure runs take about 20 minutes each.

---

## Phase 1: Signal-controller correctness and scalable generated grids

**Date:** 2026-10-13 · **Version tag:** `simulation/version.py` → `1.1.0-phase1`
**Scope:** objectives A–D of the approved Phase 1 request. This covers what `docs/MASTER_UPGRADE_PLAN.md` §6 calls Phase 2 (NetworkModel, PhaseMap, Controller V2) and Phase 3 (3×3 / 5×5 / 9×9 grids), plus the small Phase-0 fixes needed to run them (headless SUMO, validator label, duplicate controller, ZeroDivision). Advanced features (emergency, OSM, heatmap, Indian traffic, prediction, actuated baseline) were **not started**.

**Backups:** every pre-existing file that was modified is copied, unchanged, to `backups/pre-phase1-2026-10-13/` with the same relative paths. The repository is still not under git.

---

## 1. Completed work

### A. Signal-controller correctness (Controller V2)
- **Phase mapping derived from the real program** (`simulation/network/phase_map.py`). Each phase is classified from its state string as `green`, `yellow` (`y`/`Y`/`u`), `all_red`, or `clearance` (a strict reduction of the previous phase's greens, e.g. pedestrian clearance). Each green phase records the link indices and incoming lanes it actually serves. The NS/EW axis is computed from geometry and is informational only. **No phase index is assumed to mean a direction.**
- **Program validation before control.** The validator checks for vehicle links that go green→red without yellow, yellow shorter than `min_yellow_s`, `o`/`O` (off) signals, and state-length mismatches. A TLS with problems, or with only one green phase, is registered as `native` with an explicit reason, logged and counted, and keeps its SUMO program. It is never silently skipped.
- **Safe actuation only** (`simulation/swarm/adaptive_controller.py`). The controller changes only the *remaining duration of the current green phase* (`setPhaseDuration`), and only after re-checking that SUMO's current phase index **and** state string still equal that green (`apply_green_duration`). Yellow, all-red and pedestrian clearance phases always run their programmed durations. There is no `setPhase` or `setRedYellowGreenState`.
- **Bounds measured from phase start** (`SafetyGate.validate_green_plan` in `simulation/safety/risk_field.py`). Constraints: min green (raised to `pedestrian_min_green_s` when the phase serves crossings), max green, and an anti-starvation rule. The rule is: if a competing phase with waiting vehicles has been red for ≥ `max_red_s`, the current green ends as soon as its minimum allows. The gate receives timing and limits only, **never the optimizer score**. Programmed greens longer than `max_green_s` are bounded on entry.
- **Decision semantics** (`simulation/swarm/signal_agent.py`). The unchanged PSO+ACO engine compares *current-phase queue* (its "NS" slot) against the *largest competing-phase queue* (its "EW" slot):
  - `NS` → **serve**: keep the green for the proposed total.
  - `EW` → **yield**: end the green at its minimum.
- **Safe mode on failure.** If the optimizer raises or returns a malformed result, the proposal is rejected (`optimizer_error:<Type>`) and the current plan is kept. After `max_consecutive_optimizer_failures` consecutive failures the agent switches to `fallback` and the SUMO program runs unmodified. A TraCI apply error is also caught (`apply_failed:<Type>`).
- **Structured logs** per run:
  - `swarm/swarm_events.jsonl`: `agent_registered`, `proposed`, `applied`, `rejected`, `agent_fallback`, each with its reason.
  - `swarm/swarm_decisions.csv`: one row per decision, with status (`applied`, `rejected` or `deferred`) and reason.
  - `swarm/swarm_agents.json`: per-agent mode and counts.
  - Reason and status counts in `swarm_summary.json`.
- **Independent safety audit** (`simulation/safety/signal_audit.py`). It reads the states SUMO actually displayed at every step, for both controllers, and counts `missing_yellow`, `short_yellow`, `green_too_long` and `green_too_short` (for swarm-controlled TLS). Any violation fails `validate_run_artifacts.py`.

### B. Automatic network generation
- `simulation/config/networks.json` holds presets `grid3x3_legacy` (original J1–J9 network, unchanged), `grid3x3`, `grid5x5` and `grid9x9`, plus all grid, TLS, demand and controller settings. New sizes, including non-square grids, are added there with no Python edits. This is tested.
- `simulation/network/grid_generator.py` writes deterministic plain XML (junctions `J{row}_{col}`, edges `{from}__{to}`, fringe approach roads on every side, so every junction is a real 4-arm signalized junction). It builds with `netconvert` (`--tls.yellow.time 3 --tls.allred.time 1`). Optional pedestrian crossings are available via `grid.pedestrians`.
- `simulation/network/demand.py` creates straight-through flows on every row and column in both directions plus one seeded turning flow per entry. Every junction therefore has conflicting demand, which fixes audit bug B1 for generated grids. The demand seed is independent of the simulation seed.
- `simulation/network/network_model.py` discovers TLS ids, programs, controlled links with approach side, and the **neighbor graph** from the net file. It follows edges to the next TLS and handles degree 2, 3 and 4, isolated or unknown ids, and multi-junction TLS.
- `simulation/network/build_network.py` builds and **validates before simulation**:
  - TLS count = rows×cols
  - expected ids
  - adjacency edges = rows(cols−1)+cols(rows−1)
  - one connected component
  - every phase map controllable
  - unsafe programs are rejected

  Networks are cached under `simulation/scenarios/generated/<preset>/` (gitignored) together with `network_meta.json`, and rebuilt when the config hash changes.

### C. Scalable swarm architecture
- **Local only:** each agent reads its own approach lanes, publishes one observation (served queue, competing queue, mean incoming occupancy) and reads only its **direct neighbors** from the blackboard. There is no all-to-all communication.
- **Neighbor information now affects the decision:** served demand is discounted by downstream congestion (`downstream_discount × max occupancy of fresh downstream neighbors`). In the old engine the neighbor-pressure term was a constant and had no effect (audit bug B4).
- **Topology-agnostic blackboard** (`optimizer/app/swarm/blackboard.py`):
  - topology is injected
  - `prune()` expires stale entries
  - `neighbor_status()` reports fresh, stale and missing neighbors (logged per decision)
  - missing or disconnected neighbors contribute nothing, and the agent still decides
- `MultiAgentCoordinator` takes the injected graph. The engine's `NEIGHBORS` dict is kept only as `LEGACY_3X3_NEIGHBORS`, the default for the standalone FastAPI demo. FastAPI now accepts any junction id (pattern `^[A-Za-z0-9_.:#-]{1,64}$`) and has `PUT /api/swarm/topology`.
- Seeds come from `stable_seed(run_seed, tls_id, tick)` (crc32) instead of `int(id[1:])`.
- **Latency is measured** in every run (`decision_tick_latency_ms`, `optimizer_call_latency_ms`) and by `experiments/tools/benchmark_decisions.py`.
- Measurement now uses TraCI **subscriptions** (`simulation/runtime.py`, shared by both controllers). The legacy baseline got about 5× faster with **identical** KPIs (see §4).

### D. Experiments
- `run_experiment.py --network <preset> [--gui]`. Both controllers get the identical route file, network and seed. The legacy preset is the default and keeps its original output path, so the Spring Boot orchestrator still works unchanged. Generated networks write to `experiments/runs/<preset>/<scenario>/seed-<n>/`.
- `comparison.json → metadata` now records:
  - network preset, size, TLS count, adjacency, degree histogram and net hash
  - route file sha256
  - controller settings and demand settings
  - versions of TSI, Python, platform, SUMO, traci and netconvert
  - seed and max time
- `run_matrix.py --networks …`; `aggregate_matrix.py` understands the nested layout.
- `validate_run_artifacts.py` accepts the real `baseline` label (B7). It now fails on safety-audit violations, seed mismatch, controlled junctions without decisions, or unregistered junctions.
- Smoke tests for 3×3, 5×5 and 9×9; phase-mapping and clearance regression tests; adjacency and intersection-count validation; and a legacy-baseline regression against `experiments/reference/legacy_3x3_seed42.json` (values copied from the pre-Phase-1 artifacts).

### Small fixes from the audit
- B9: pheromone reinforcement is now `5/(1+max(0,score))`, applied only after a decision is applied, so there is no division by zero.
- B10: SUMO runs headless by default (`--gui` or `TSI_SUMO_GUI=1` for sumo-gui, with `--start --quit-on-end`).
- B11: the duplicate `AdaptiveController` was removed from `risk_field.py`.

---

## 2. Changed and added files

**Modified** (originals in `backups/pre-phase1-2026-10-13/`):

| File | Change |
|---|---|
| `simulation/swarm/adaptive_controller.py` | Rewritten as Controller V2 (same class name and `run()` signature). |
| `simulation/safety/risk_field.py` | Duplicate controller removed; `validate_green_plan` added; legacy `validate` kept. |
| `simulation/baseline/fixed_time_controller.py` | Uses the shared session (headless, subscriptions, audit); same KPIs. |
| `simulation/coordination/multi_agent_coordinator.py` | Injected neighbor graph. |
| `optimizer/app/swarm/engine.py` | `LEGACY_3X3_NEIGHBORS`, `stable_seed`, optional `neighbors` arg. PSO/ACO and objective unchanged. |
| `optimizer/app/swarm/blackboard.py` | Injected topology, occupancy field, prune, neighbor status. |
| `optimizer/app/main.py` | Generic id pattern; `PUT /api/swarm/topology`. |
| `experiments/tools/run_experiment.py`, `run_matrix.py`, `aggregate_matrix.py`, `validate_run_artifacts.py` | See §1D. |
| `tools/project_integrity.py` | New required files. |
| `pytest.ini` | `sumo` marker. |
| `.gitignore` | `simulation/scenarios/generated/` |
| `README.md` | Phase 1 usage section. |

**Added:**
- `simulation/config/networks.json`
- `simulation/network/{__init__,presets,grid_generator,network_model,phase_map,demand,build_network}.py`
- `simulation/runtime.py`, `simulation/version.py`, `simulation/requirements.txt`
- `simulation/swarm/signal_agent.py`, `simulation/safety/signal_audit.py`, `simulation/conftest.py`
- Tests: `simulation/test_phase_map.py`, `test_signal_controller.py`, `test_grid_generation.py`, `test_sumo_smoke.py`, `optimizer/tests/test_blackboard_topology.py`
- `experiments/tools/benchmark_decisions.py`, `experiments/reference/legacy_3x3_seed42.json`
- this file

**Not changed:** Spring Boot backend, MySQL schema and config, React frontend, scenario generator, KPI engine, telemetry KPI definitions, the legacy network files, and the saved `experiments/runs/`.

---

## 3. Test commands and actual results

Environment used:
- Windows 11, Python 3.12.0
- A scratch virtualenv with `eclipse-sumo==1.27.1`, `traci==1.27.1`, `pytest 9.1.1`, `fastapi 0.143.0` and `httpx`
- SUMO binaries came from that virtualenv's `Scripts/` folder on PATH
- Java, Maven and Docker are still **not installed**

| Command | Result |
|---|---|
| `python -m pytest -q` (SUMO on PATH) | **65 passed**, 0 failed, 0 skipped (63 s) |
| `python -m pytest -q` (SUMO binaries not on PATH) | **52 passed, 13 skipped** (every skip says "SUMO not installed") |
| `python tools/project_integrity.py` | OK: 51 required files, 52 Python files parse, frontend manifest complete |
| `python -m simulation.network.build_network --preset <p>` for all 4 presets | all valid (counts in §4.1) |
| `python -m experiments.tools.validate_run_artifacts <run>` | OK for all 33 new matrix runs and for the saved pre-Phase-1 runs, which previously failed on the label bug B7 |
| `python experiments/tools/benchmark_decisions.py --ticks 50` | §4.3 |
| Backend `mvn test` / frontend | **not run**: no Java or Maven. The frontend and backend were not modified. |

---

## 4. Measured results

All numbers below were produced in this session with SUMO 1.27.1, headless. Run outputs are in a scratch directory and are **not** committed. Re-create them with the commands in §3 and the ones listed in this section.

### 4.1 Network generation and validation (`build_network`)

| Preset | TLS | Adjacency edges | Degree histogram (deg: count) | Phase-map status |
|---|---|---|---|---|
| grid3x3_legacy | 9 | 12 | 2:4, 3:4, 4:1 | 5 controllable, 4 single green phase (corners), registered as `native` |
| grid3x3 | 9 | 12 | 2:4, 3:4, 4:1 | 9 controllable |
| grid5x5 | 25 | 40 | 2:4, 3:12, 4:9 | 25 controllable |
| grid9x9 | 81 | 144 | 2:4, 3:28, 4:49 | 81 controllable |

- Rebuilding a preset reproduces the identical net hash (tested).
- The legacy neighbor graph discovered from the net equals the old hard-coded J1–J9 dict (tested).

### 4.2 Regression against the existing 3×3 baseline
- The **original** pre-Phase-1 code, run headless here, reproduced the saved `normal`, `rush-hour` and `uneven` seed-42 artifacts **bit-for-bit**.
- After the refactor, the fixed-time baseline reproduces the saved artifacts in **all 15 legacy runs** (5 scenarios × seeds 42–44) to `rel_tol=1e-9`. So the measurement path did not regress.
- Baseline wall time for `normal` dropped from about 10 s to about 2 s thanks to subscriptions.

### 4.3 Decision latency vs. network size
`benchmark_decisions.py` (decision logic only, 50 ticks, synthetic queues):

| Junctions | Tick mean | Tick p95 | Per junction |
|---|---|---|---|
| 9 | 3.7 ms | 4.5 ms | 0.41 ms |
| 25 | 12.7 ms | 22.9 ms | 0.51 ms |
| 81 | 34.0 ms | 41.0 ms | 0.42 ms |

Cost per junction stays flat (linear scaling). In real runs, including TraCI apply calls, the 9×9 tick averaged about 40–46 ms (p95 ≈ 92 ms), against a 5 s decision interval.

### 4.4 Controller comparison matrix (fixed-time vs swarm)
Setup: same route file and seed per pair; seeds 42, 43, 44; values are mean ± sd of the swarm's improvement % over fixed-time (positive = swarm better). The matrix took 194 s for legacy and 1314 s for the grids.

| Network | Scenario | Travel time | Stops | Avg queue | Max queue | Audit violations (base/swarm) | Swarm decisions applied / rejected / deferred |
|---|---|---|---|---|---|---|---|
| legacy 3×3 | normal | +20.0 ± 7.2 | +9.8 ± 4.3 | +49.3 ± 18.3 | +40.5 ± 29.7 | 0/0 | 2305 / 0 / 480 |
| legacy 3×3 | road-closure | +15.5 ± 18.2 | +7.4 ± 13.9 | +40.4 ± 39.7 | +42.3 ± 32.1 | 0/0 | 2382 / 0 / 508 |
| legacy 3×3 | rush-hour | −4.1 ± 9.2 | −23.9 ± 16.2 | +24.5 ± 12.0 | +24.7 ± 13.3 | 0/0 | 3129 / 0 / 606 |
| legacy 3×3 | sudden-congestion | **−18.6 ± 1.9** | −33.9 ± 6.6 | +4.6 ± 1.7 | +23.5 ± 9.6 | 0/0 | 6642 / 0 / 1218 |
| legacy 3×3 | uneven | −13.1 ± 9.0 | −70.8 ± 53.5 | +22.3 ± 7.0 | +9.4 ± 12.0 | 0/0 | 4291 / 0 / 749 |
| grid 3×3 | normal | −2.9 ± 4.2 | −64.2 ± 8.1 | +13.2 ± 8.3 | +30.6 ± 6.0 | 0/0 | 4526 / 0 / 784 |
| grid 3×3 | rush-hour | +36.1 ± 17.3 | −29.0 ± 23.0 | +37.6 ± 16.5 | +26.3 ± 20.1 | 0/0 | 11175 / 0 / 642 |
| grid 5×5 | normal | −4.2 ± 6.2 | −81.9 ± 16.8 | +11.1 ± 13.0 | +20.8 ± 9.6 | 0/0 | 13090 / 0 / 3160 |
| grid 5×5 | rush-hour | **−43.4 ± 38.3** | −88.8 ± 16.0 | −19.1 ± 24.7 | −1.2 ± 17.1 | 0/0 | 40537 / 0 / 3288 |
| grid 9×9 | normal | −3.6 ± 1.6 | −93.4 ± 2.3 | +23.1 ± 1.7 | +24.2 ± 4.1 | 0/0 | 53120 / 0 / 12814 |
| grid 9×9 | rush-hour | −5.9 ± 44.1 | −61.0 ± 21.5 | +7.0 ± 29.9 | +12.0 ± 19.5 | 0/0 | 126229 / 0 / 13739 |

What this shows:
- **Correctness:**
  - 0 signal-safety violations in all 66 controller runs (33 pairs).
  - Every intersection was accounted for: no controlled junction went without decisions, and the 4 legacy corners are logged as `native`.
  - All 33 runs pass `validate_run_artifacts.py`.
- **The swarm controller now really acts.** Before Phase 1, only 3.4 % of its decisions were applied (fairness-timer and phase-parity bugs). Now no decision is rejected by the gate; "deferred" means the junction was in a clearance transition at the tick.
- **Performance is not better yet, and must not be claimed.**
  - The swarm consistently shortens queues.
  - It clearly **increases stops** on generated grids (up to about 2×).
  - Travel time is mixed: better on legacy normal and grid 3×3 rush-hour, worse on heavy legacy scenarios and on 5×5 rush-hour.
  - In **grid9x9 / rush-hour / seed 44 the swarm run hit the 3600 s cap with one vehicle unfinished** (`timed_out: true`, near-gridlock). The baseline finished at 2563 s.
  - With n = 3 seeds and very large spreads, none of these differences is statistically established.
- The `average_delay_s` column of `comparison.json` shows +50 % on most grids. That is the flawed metric from limitation 1 and is deliberately left out of the table.


---

## 5. Known limitations (honest boundary)

1. **The KPI definitions are unchanged and partly flawed** (audit K1/K2). `average_delay_s` is the mean of each vehicle's *longest single stop* (`getWaitingTime` resets on movement), not total delay. Throughput is identical whenever all vehicles arrive. **Do not quote the large delay "improvements" in §4 as results.** Travel time and stops are the more trustworthy signals today. Switching to tripinfo `timeLoss` is the first task of the next phase.
2. **Swarm control is not yet better on generated grids.** It reduces queues but **increases stops**, travel time is mixed, and one 9×9 rush-hour run hit the 3600 s cap (see §4.4). Phase 1 targeted correctness and scale, not tuning. In effect the decision rule is queue-actuated, re-evaluated every `decision_interval_s`, and switching earlier creates extra stop-and-go.
3. **Comparisons use 3 seeds with no significance testing.** CIs and paired tests are planned for the next phase.
4. **Only cyclic phase order is supported.** The controller extends or truncates greens; it does not skip to a non-adjacent phase. This is deliberate, because it keeps every clearance native, but it limits flexibility on multi-phase (OSM) programs.
5. **The legacy network's demand still has no conflicting movements** (audit B1). Legacy results only demonstrate correct actuation, not research value. Use generated grids for experiments.
6. **Pedestrian handling** is implemented (crossing links, clearance phases, pedestrian minimum green, ped links exempt from the yellow rule) and covered by unit tests. However, no pedestrian *demand* is generated and no SUMO run with `grid.pedestrians: true` has been made yet.
7. **`risk` is still always 0.** No risk field is computed.
8. Backend, DB and frontend are untouched. The dashboard still shows "J1–J9" and has no network selector. The DB credential and URL inconsistencies (audit D1–D3) are still open.
9. The repository is not under git. Rollback is via `backups/pre-phase1-2026-10-13/`.

---

## 6. Next phase (recommended)

**Phase 2: measurement validity and baselines** (no new features yet):
1. KPIs from SUMO `tripinfo` (`timeLoss`, `waitingTime`, `waitingCount`), `statistic-output` (teleports) and warm-up exclusion.
2. **SUMO actuated** controller as the third comparator (Feature 6 core), on identical demand.
3. ≥10 seeds per cell, mean ± 95 % CI, paired Wilcoxon test, and an updated validator.
4. Tune the swarm decision rule (hysteresis / minimum gap-out, stop penalty) **only after** steps 1–3, judged on the new KPIs.
5. Phase-0 leftovers: DB config alignment, removing the default credential, pinning npm versions, `git init` (with your approval).
