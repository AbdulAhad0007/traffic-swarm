"""The Lab API's optional gateway secret: inert when unset, required on everything but health when set."""
import pytest

pytest.importorskip("fastapi")


def client():
    from fastapi.testclient import TestClient
    from experiments.lab import api
    return TestClient(api.app)


def test_unset_secret_changes_nothing(monkeypatch):
    monkeypatch.delenv("TSI_GATEWAY_SECRET", raising=False)
    assert client().get("/api/lab/reports").status_code == 200


def test_set_secret_is_required(monkeypatch):
    monkeypatch.setenv("TSI_GATEWAY_SECRET", "s3cret")
    c = client()
    assert c.get("/api/lab/reports").status_code == 403
    assert c.post("/api/lab/stop-all").status_code == 403
    assert c.get("/api/lab/reports", headers={"X-TSI-Gateway-Secret": "wrong"}).status_code == 403
    assert c.get("/api/lab/reports", headers={"X-TSI-Gateway-Secret": "s3cret"}).status_code == 200


def test_health_stays_open(monkeypatch):
    monkeypatch.setenv("TSI_GATEWAY_SECRET", "s3cret")
    assert client().get("/api/lab/health").status_code == 200
