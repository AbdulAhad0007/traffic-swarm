from dataclasses import dataclass, field
from time import time
from .engine import PheromoneMap, LEGACY_3X3_NEIGHBORS

@dataclass
class AgentObservation:
    intersection: str
    ns_queue: float
    ew_queue: float
    timestamp: float = field(default_factory=time)
    occupancy: float = 0.0   # mean incoming-lane occupancy in [0, 1]

class SwarmBlackboard:
    """Shared, local-neighborhood view of agent observations.

    Agents publish their own observation and read only their direct neighbors' entries, so the
    work per agent grows with node degree, not with network size. Timestamps may be simulation
    time or wall-clock time, as long as one board uses one clock.
    """
    def __init__(self, observation_ttl: float = 30.0, neighbors: dict | None = None):
        self.observations: dict[str, AgentObservation] = {}
        self.pheromone = PheromoneMap()
        self.observation_ttl = observation_ttl
        self.set_topology(LEGACY_3X3_NEIGHBORS if neighbors is None else neighbors)

    def set_topology(self, neighbors: dict) -> None:
        self.neighbors = {k: list(v) for k, v in neighbors.items()}

    def publish(self, observation: AgentObservation):
        self.observations[observation.intersection] = observation

    def _fresh(self, observation: AgentObservation, now: float | None = None) -> bool:
        reference = time() if now is None else float(now)
        age = reference - observation.timestamp
        return 0.0 <= age <= self.observation_ttl

    def fresh_neighbor_observations(self, intersection: str, now: float | None = None) -> dict:
        return {n: self.observations[n] for n in self.neighbors.get(intersection, [])
                if n in self.observations and self._fresh(self.observations[n], now)}

    def neighbor_status(self, intersection: str, now: float | None = None) -> dict:
        """Counts of fresh / stale / missing neighbor observations (missing = never published)."""
        status = {"fresh": 0, "stale": 0, "missing": 0}
        for n in self.neighbors.get(intersection, []):
            if n not in self.observations:
                status["missing"] += 1
            elif self._fresh(self.observations[n], now):
                status["fresh"] += 1
            else:
                status["stale"] += 1
        return status

    def neighbor_pressure(self, intersection: str, now: float | None = None) -> float:
        return sum(o.ns_queue + o.ew_queue for o in self.fresh_neighbor_observations(intersection, now).values())

    def prune(self, now: float | None = None) -> int:
        """Drop expired observations. Returns how many were removed."""
        stale = [k for k, o in self.observations.items() if not self._fresh(o, now)]
        for k in stale:
            del self.observations[k]
        return len(stale)

    def evaporate(self):
        self.pheromone.evaporate()

    def snapshot(self):
        return {"observations": {k: vars(v) for k,v in self.observations.items()}, "pheromone": dict(self.pheromone.values)}
