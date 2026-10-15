from dataclasses import dataclass

@dataclass(frozen=True)
class RouteOption:
    route_id: str
    travel_time: float
    pheromone: float = 0.0
    risk: float = 0.0

class PheromoneRouter:
    def __init__(self, evaporation=0.1, risk_weight=5.0, pheromone_weight=0.7):
        if not 0 <= evaporation < 1: raise ValueError("evaporation must be in [0,1)")
        self.trails = {}; self.evaporation = evaporation
        self.risk_weight = risk_weight; self.pheromone_weight = pheromone_weight

    def cost(self, route):
        trail = self.trails.get(route.route_id, route.pheromone)
        return route.travel_time + self.pheromone_weight * trail + self.risk_weight * max(0.0, route.risk)

    def choose(self, routes):
        routes = list(routes)
        if not routes: raise ValueError("at least one route is required")
        return min(routes, key=self.cost)

    def reinforce(self, route_id, amount):
        self.trails[route_id] = max(0.0, self.trails.get(route_id, 0.0) + max(0.0, amount))

    def evaporate(self):
        self.trails = {k: v * (1-self.evaporation) for k,v in self.trails.items() if v * (1-self.evaporation) > 1e-9}
