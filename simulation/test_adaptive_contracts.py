from simulation.safety.risk_field import SafetyGate
from simulation.routing.pheromone_router import PheromoneRouter, RouteOption

def test_safety_rejects_invalid_and_risky_decisions():
    g=SafetyGate()
    assert g.validate('BAD',20,0).fallback
    assert g.validate('NS',20,2).fallback
    assert g.validate('NS',20,0).allowed

def test_safety_rejects_over_extended_green_to_prevent_starvation():
    g=SafetyGate(max_continuous_green=90.0)
    # Still within the fairness window: allowed as normal.
    assert g.validate('NS',20,0,continuous_green=60.0).allowed
    # Same direction has held green too long: must be rejected so the
    # perpendicular approach is not starved into gridlock.
    decision=g.validate('NS',20,0,continuous_green=95.0)
    assert not decision.allowed
    assert decision.fallback
    assert decision.reason=='fairness_cap_reached'

def test_router_avoids_risky_route_and_evaporates():
    r=PheromoneRouter(evaporation=.2)
    a=RouteOption('a',10,pheromone=0,risk=0)
    b=RouteOption('b',8,pheromone=0,risk=1)
    assert r.choose([a,b]).route_id=='a'
    r.reinforce('a',10); r.evaporate(); assert r.trails['a']==8