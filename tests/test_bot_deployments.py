"""Tests for bot deployment registry API."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app as app_module
from modules.bot_deployment_store import BotDeploymentStore
from modules.builder_strategy_store import BuilderStrategyStore


def _sample_strategy() -> dict:
    return {
        "type": "digit_strategy",
        "condition": "repeat_3",
        "action": "over_under",
        "active_action": "over_under",
        "actions": {
            "over_under": {
                "enabled": True,
                "rules": {
                    "if_digit_greater_equal": 5,
                    "trade": "UNDER",
                    "else_trade": "OVER",
                },
            },
        },
    }


def _sample_xml() -> str:
    return """
<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="repeat_3_condition" x="40" y="40"></block>
</xml>""".strip()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    builder_db = tmp_path / "builder.db"
    deploy_db = tmp_path / "deploy.db"
    monkeypatch.setattr(app_module, "_builder_store", BuilderStrategyStore(builder_db))
    monkeypatch.setattr(app_module, "_deployment_store", BotDeploymentStore(deploy_db))
    monkeypatch.setattr(app_module, "_ensure_config_token_session", lambda request: None)
    monkeypatch.setattr(app_module, "_require_deriv_session", lambda r: {"account": "demo"})
    return TestClient(app_module.app)


def test_bots_registry_and_deploy_flow(client):
    created = client.post(
        "/builder/strategies",
        json={
            "name": "Deploy Bot",
            "market": "R_100",
            "contract_type": "DIGITUNDER",
            "stake": 1.0,
            "risk_level": "Low",
            "strategy": _sample_strategy(),
            "blockly_xml": _sample_xml(),
        },
    )
    assert created.status_code == 200
    sid = created.json()["strategy"]["id"]

    registry = client.get("/bots/registry")
    assert registry.status_code == 200
    assert any(s["id"] == sid for s in registry.json()["strategies"])

    deployed = client.post("/bots/deploy", json={"strategy_id": sid, "account": "demo", "start": False})
    assert deployed.status_code == 200
    dep_id = deployed.json()["deployment"]["id"]

    listed = client.get("/bots/deployments")
    assert listed.status_code == 200
    assert any(d["id"] == dep_id for d in listed.json()["deployments"])

    paused = client.post(f"/bots/deployments/{dep_id}/pause")
    assert paused.status_code == 200
    assert paused.json()["deployment"]["status"] == "paused"

    stopped = client.post(f"/bots/deployments/{dep_id}/stop")
    assert stopped.status_code == 200
    assert stopped.json()["deployment"]["status"] == "stopped"

    analytics = client.get("/bots/analytics")
    assert analytics.status_code == 200
    assert analytics.json()["success"] is True

    logs = client.get(f"/bots/deployments/{dep_id}/logs")
    assert logs.status_code == 200
    assert isinstance(logs.json()["logs"], list)
