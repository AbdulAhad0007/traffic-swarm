# Phase 10 — Experiments, KPI comparison and reproducibility

The experiment layer runs the fixed-time baseline and swarm controller against the same generated scenario and seed. Outputs are stored below `experiments/runs/<scenario>/seed-<seed>/`.

Each run contains:

- scenario-specific route file
- SUMO configuration copy
- baseline summary + timeseries
- swarm summary + decision log + timeseries
- `comparison.json` with raw measurements and percentage changes

## Metrics

The comparison engine supports average delay, maximum/average queue, average travel time, average stops, fuel, CO2 and throughput. Missing measurements remain `null`; the system never converts unavailable values into fabricated zeros.

## Scenarios

- normal
- rush-hour
- uneven
- sudden-congestion
- road-closure

The road-closure scenario is currently implemented as a demand/capacity stress proxy in the scenario generator, not as a physical edge deletion. This limitation is intentionally documented.

## Reproducibility

Baseline and swarm receive the same seed for each comparison. The matrix defaults to seeds `42 43 44`. The final validation should confirm that repeated runs with the same seed produce stable simulator inputs and comparable outputs.

## Validation boundary

Static Python checks pass in the current environment. SUMO/TraCI, Maven, npm dependency installation/build, and Docker database checks require their respective runtime tools and are not claimed as passed until actually executed.

### Post-run release gate
After a real SUMO run, validate the generated directory with `experiments/tools/validate_run_artifacts.py`. The gate checks controller identity, required measured KPI fields, numeric/non-negative values, comparison coverage, and expected telemetry/decision artifacts. It does not generate or replace missing measurements.
