from app.swarm.engine import *
def test_optimize_bounds():
    r=optimize(TrafficState('J5',20,30,4,5,10,12),seed=42)
    assert r['direction'] in ('NS','EW') and 10<=r['green_seconds']<=60

def test_optimizer_is_reproducible_for_seed():
    state = TrafficState('J1', 20, 8)
    a = optimize(state, seed=123)
    b = optimize(state, seed=123)
    assert a == b
    assert 10 <= a['green_seconds'] <= 60
    assert a['algorithm'] == 'Hybrid PSO+ACO'
