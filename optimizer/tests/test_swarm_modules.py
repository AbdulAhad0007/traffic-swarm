from optimizer.app.swarm.engine import TrafficState, PheromoneMap, optimize
from optimizer.app.swarm.blackboard import SwarmBlackboard, AgentObservation
from optimizer.app.swarm.multi_objective import ObjectiveWeights, score, pareto_front


def test_blackboard_neighbor_pressure_respects_simulation_clock_and_ttl():
    b = SwarmBlackboard(observation_ttl=60)
    b.publish(AgentObservation('J2', 3, 4, timestamp=100.0))
    b.publish(AgentObservation('J4', 2, 1, timestamp=100.0))
    assert b.neighbor_pressure('J1', now=120.0) == 10
    assert b.neighbor_pressure('J1', now=161.0) == 0


def test_optimizer_is_reproducible():
    s = TrafficState('J5', 10, 4, ns_wait=5, ew_wait=2)
    a = optimize(s, PheromoneMap(), seed=42)
    b = optimize(s, PheromoneMap(), seed=42)
    assert a == b and 10 <= a['green_seconds'] <= 60


def test_multi_objective_pareto():
    a = {'queue': 1, 'delay': 2, 'stops': 1, 'emissions': 10, 'safety_risk': 0}
    b = {'queue': 2, 'delay': 3, 'stops': 2, 'emissions': 12, 'safety_risk': .1}
    assert score(a, ObjectiveWeights()) < score(b, ObjectiveWeights())
    assert pareto_front([a, b]) == [a]
