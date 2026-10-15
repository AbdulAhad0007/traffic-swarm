from dataclasses import dataclass
from optimizer.app.swarm.engine import LEGACY_3X3_NEIGHBORS

@dataclass(frozen=True)
class AgentDecision:
    intersection: str
    direction: str
    green_seconds: float
    coordinated_green: float

class MultiAgentCoordinator:
    """Coordinates adjacent agents without forcing identical timings.

    The neighbor graph is injected (derived from the network); the legacy 3x3 map is only the
    default for backward compatibility. Only direct neighbors are consulted.
    """
    def __init__(self, max_green_wave=45.0, neighbors=None):
        self.max_green_wave = max_green_wave
        self.neighbors = LEGACY_3X3_NEIGHBORS if neighbors is None else neighbors

    def coordinate(self, decisions):
        by_id = {d.intersection: d for d in decisions}
        out=[]
        for d in decisions:
            neighbor_greens = [by_id[n].green_seconds for n in self.neighbors.get(d.intersection, []) if n in by_id and by_id[n].direction == d.direction]
            cap = min([self.max_green_wave, *neighbor_greens]) if neighbor_greens else self.max_green_wave
            out.append(AgentDecision(d.intersection, d.direction, d.green_seconds, min(d.green_seconds, cap)))
        return out
