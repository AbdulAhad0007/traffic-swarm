import pytest
from optimizer.app.swarm.blackboard import SwarmBlackboard, AgentObservation
from optimizer.app.swarm.engine import TrafficState, optimize, stable_seed


def test_injected_topology_and_arbitrary_ids():
    b = SwarmBlackboard(observation_ttl=30, neighbors={"J0_0": ["J0_1"], "J0_1": ["J0_0", "J1_1"], "X-9": []})
    b.publish(AgentObservation("J0_1", 2, 3, timestamp=10.0))
    assert b.neighbor_pressure("J0_0", now=20.0) == 5
    assert b.neighbor_pressure("X-9", now=20.0) == 0          # isolated junction
    assert b.neighbor_pressure("unknown", now=20.0) == 0      # not in topology


def test_missing_stale_and_prune():
    b = SwarmBlackboard(observation_ttl=30, neighbors={"A": ["B", "C", "D"]})
    b.publish(AgentObservation("B", 1, 1, timestamp=100.0))
    b.publish(AgentObservation("C", 1, 1, timestamp=10.0))
    assert b.neighbor_status("A", now=110.0) == {"fresh": 1, "stale": 1, "missing": 1}
    assert b.prune(now=110.0) == 1 and "C" not in b.observations
    assert b.neighbor_status("A", now=110.0) == {"fresh": 1, "stale": 0, "missing": 2}


def test_future_timestamps_are_not_fresh():
    b = SwarmBlackboard(observation_ttl=30, neighbors={"A": ["B"]})
    b.publish(AgentObservation("B", 5, 5, timestamp=200.0))
    assert b.neighbor_pressure("A", now=100.0) == 0


def test_stable_seed_does_not_depend_on_id_shape():
    assert stable_seed(42, "J1_2", 3) == stable_seed(42, "J1_2", 3)
    assert stable_seed(42, "J1_2", 3) != stable_seed(42, "J2_1", 3)
    r = optimize(TrafficState("cluster_123#4", 5, 1), seed=stable_seed(1, "cluster_123#4", 0), neighbors=[])
    assert r["neighbors"] == [] and 10 <= r["green_seconds"] <= 60


def test_api_accepts_generated_ids_and_topology():
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    from optimizer.app.main import app
    c = TestClient(app)
    assert c.put("/api/swarm/topology", json={"neighbors": {"J8_8": ["J8_7", "J7_8"]}}).status_code == 200
    r = c.post("/api/swarm/optimize", json={"intersection": "J8_8", "ns_queue": 4, "ew_queue": 1, "seed": 1})
    assert r.status_code == 200 and r.json()["neighbors"] == ["J8_7", "J7_8"]
    assert c.post("/api/swarm/optimize", json={"intersection": "bad id!"}).status_code == 422
