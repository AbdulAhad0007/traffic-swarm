from dataclasses import dataclass

@dataclass(frozen=True)
class ObjectiveWeights:
    queue: float = 1.0
    delay: float = 0.8
    stops: float = 0.35
    throughput: float = 0.45
    safety: float = 5.0
    emissions: float = 0.2

    def __post_init__(self):
        if any(v < 0 for v in (self.queue, self.delay, self.stops, self.throughput, self.safety, self.emissions)):
            raise ValueError("objective weights must be non-negative")

def score(metrics, weights=ObjectiveWeights()):
    return (
        weights.queue * metrics.get("queue", 0)
        + weights.delay * metrics.get("delay", 0)
        + weights.stops * metrics.get("stops", 0)
        - weights.throughput * metrics.get("throughput", 0)
        + weights.safety * metrics.get("safety_risk", 0)
        + weights.emissions * metrics.get("emissions", 0)
    )

def dominates(a, b):
    keys = ("queue", "delay", "stops", "emissions", "safety_risk")
    av = [float(a.get(k, 0)) for k in keys]; bv = [float(b.get(k, 0)) for k in keys]
    return all(x <= y for x, y in zip(av, bv)) and any(x < y for x, y in zip(av, bv))

def pareto_front(items):
    items = list(items)
    return [x for i, x in enumerate(items) if not any(dominates(y, x) for j, y in enumerate(items) if i != j)]
