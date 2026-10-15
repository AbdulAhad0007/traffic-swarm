from __future__ import annotations
from dataclasses import dataclass, field
import math, random, zlib

@dataclass
class TrafficState:
    intersection: str
    ns_queue: float
    ew_queue: float
    ns_arrival: float = 0.0
    ew_arrival: float = 0.0
    ns_wait: float = 0.0
    ew_wait: float = 0.0
    current_phase: int = 0
    risk: float = 0.0

@dataclass
class PheromoneMap:
    values: dict[str, float] = field(default_factory=dict)
    evaporation: float = 0.12
    minimum: float = 0.0
    maximum: float = 100.0

    def get(self, key: str) -> float:
        return self.values.get(key, 0.0)

    def reinforce(self, key: str, amount: float) -> None:
        self.values[key] = min(self.maximum, max(self.minimum, self.get(key) + max(0.0, amount)))

    def evaporate(self) -> None:
        for key, value in list(self.values.items()):
            self.values[key] = max(self.minimum, value * (1.0 - self.evaporation))

@dataclass
class SwarmConfig:
    particles: int = 18
    iterations: int = 12
    min_green: int = 10
    max_green: int = 60
    inertia: float = 0.72
    cognitive: float = 1.35
    social: float = 1.45
    queue_weight: float = 1.0
    delay_weight: float = 0.8
    stops_weight: float = 0.35
    throughput_weight: float = 0.45
    safety_weight: float = 5.0

# Topology of the original hand-written 3x3 network only. Simulation runs derive the neighbor
# graph from the SUMO network (simulation/network/network_model.py); this map is kept as the
# default for the standalone FastAPI demo and for backward compatibility.
LEGACY_3X3_NEIGHBORS = {
    "J1": ["J2", "J4"], "J2": ["J1", "J3", "J5"], "J3": ["J2", "J6"],
    "J4": ["J1", "J5", "J7"], "J5": ["J2", "J4", "J6", "J8"],
    "J6": ["J3", "J5", "J9"], "J7": ["J4", "J8"], "J8": ["J5", "J7", "J9"],
    "J9": ["J6", "J8"],
}
NEIGHBORS = LEGACY_3X3_NEIGHBORS  # backward-compatible alias


def stable_seed(*parts) -> int:
    """Deterministic per-agent seed that does not depend on the shape of the junction id."""
    return zlib.crc32(":".join(str(p) for p in parts).encode("utf-8"))

def objective(state: TrafficState, direction: str, green: float, neighbor_pressure: float = 0.0, pheromone: float = 0.0, cfg: SwarmConfig | None = None) -> float:
    cfg = cfg or SwarmConfig()
    served = green / max(cfg.max_green, 1)
    ns = state.ns_queue if direction == "NS" else state.ew_queue
    ew = state.ew_queue if direction == "NS" else state.ns_queue
    residual = max(0.0, ns * (1.0 - served)) + max(0.0, ew * (0.35 + 0.35 * served))
    delay = state.ns_wait + state.ew_wait
    stops = state.ns_arrival + state.ew_arrival
    throughput = ns * served + ew * (1.0 - served)
    return (cfg.queue_weight * residual + cfg.delay_weight * delay + cfg.stops_weight * stops
            - cfg.throughput_weight * throughput - 0.08 * pheromone + 0.12 * neighbor_pressure
            + cfg.safety_weight * max(0.0, state.risk))

def optimize(state: TrafficState, pheromones: PheromoneMap | None = None, neighbor_pressure: float = 0.0,
             cfg: SwarmConfig | None = None, seed: int | None = None, neighbors: list[str] | None = None) -> dict:
    cfg = cfg or SwarmConfig()
    rng = random.Random(seed)
    pheromones = pheromones or PheromoneMap()
    positions = [[rng.uniform(cfg.min_green, cfg.max_green), rng.choice([0, 1])] for _ in range(cfg.particles)]
    velocities = [[rng.uniform(-4, 4), rng.uniform(-0.3, 0.3)] for _ in positions]
    pbest = [p[:] for p in positions]
    pbest_scores = [float('inf')] * len(positions)
    gbest = positions[0][:]
    gbest_score = float('inf')
    for _ in range(cfg.iterations):
        for i, p in enumerate(positions):
            direction = "NS" if round(p[1]) == 0 else "EW"
            score = objective(state, direction, p[0], neighbor_pressure, pheromones.get(f"{state.intersection}:{direction}"), cfg)
            if score < pbest_scores[i]:
                pbest_scores[i], pbest[i] = score, p[:]
            if score < gbest_score:
                gbest_score, gbest = score, p[:]
        for i, p in enumerate(positions):
            r1, r2 = rng.random(), rng.random()
            velocities[i][0] = cfg.inertia * velocities[i][0] + cfg.cognitive*r1*(pbest[i][0]-p[0]) + cfg.social*r2*(gbest[0]-p[0])
            velocities[i][1] = cfg.inertia * velocities[i][1] + cfg.cognitive*r1*(pbest[i][1]-p[1]) + cfg.social*r2*(gbest[1]-p[1])
            p[0] = min(cfg.max_green, max(cfg.min_green, p[0] + velocities[i][0]))
            p[1] = min(1.0, max(0.0, p[1] + velocities[i][1]))
    direction = "NS" if round(gbest[1]) == 0 else "EW"
    key = f"{state.intersection}:{direction}"
    pheromones.reinforce(key, max(0.0, 10.0 / (1.0 + max(gbest_score, 0.0))))
    return {"intersection": state.intersection, "direction": direction, "green_seconds": round(gbest[0], 2),
            "score": round(gbest_score, 4),
            "neighbors": list(neighbors) if neighbors is not None else NEIGHBORS.get(state.intersection, []),
            "safety_validated": state.risk <= 1.0, "algorithm": "Hybrid PSO+ACO"}
