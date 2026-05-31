"""Tests for Bot Builder strategy library API."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as app_module
from modules.builder_strategy_store import BuilderStrategyStore


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db = tmp_path / "test_builder.db"
    store = BuilderStrategyStore(db)
    monkeypatch.setattr(app_module, "_builder_store", store)
    return TestClient(app_module.app)


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
  <block type="digit_threshold" x="40" y="110">
    <field name="THRESHOLD">5</field>
  </block>
</xml>""".strip()


def test_builder_strategy_crud_and_versions(client):
    payload = {
        "name": "Test Strategy",
        "market": "R_100",
        "contract_type": "DIGITUNDER",
        "stake": 1.0,
        "risk_level": "Low",
        "strategy": _sample_strategy(),
        "blockly_xml": _sample_xml(),
    }
    created = client.post("/builder/strategies", json=payload)
    assert created.status_code == 200
    sid = created.json()["strategy"]["id"]
    assert created.json()["strategy"]["version"] == 1

    updated = client.post(
        "/builder/strategies",
        json={**payload, "id": sid, "name": "Test Strategy v2"},
    )
    assert updated.status_code == 200
    assert updated.json()["strategy"]["version"] == 2

    listed = client.get("/builder/strategies")
    assert listed.status_code == 200
    assert any(row["id"] == sid for row in listed.json()["strategies"])

    one = client.get(f"/builder/strategies/{sid}")
    assert one.status_code == 200
    assert one.json()["strategy"]["name"] == "Test Strategy v2"

    versions = client.get(f"/builder/strategies/{sid}/versions")
    assert versions.status_code == 200
    assert len(versions.json()["versions"]) >= 2

    restored = client.post(f"/builder/strategies/{sid}/versions/1/restore")
    assert restored.status_code == 200
    assert restored.json()["strategy"]["version"] >= 3

    opened = client.post(f"/builder/strategies/{sid}/open")
    assert opened.status_code == 200
    recent = client.get("/builder/strategies/recent")
    assert any(r["id"] == sid for r in recent.json()["strategies"])

    deleted = client.delete(f"/builder/strategies/{sid}")
    assert deleted.status_code == 200


def test_builder_validate_import_rejects_bad_block(client):
    bad_xml = '<xml><block type="evil_block" x="0" y="0"></block></xml>'
    res = client.post(
        "/builder/strategies/validate-import",
        json={"blockly_xml": bad_xml, "strategy": _sample_strategy()},
    )
    assert res.status_code == 400


def test_builder_import_strategy(client):
    res = client.post(
        "/builder/strategies/import",
        json={
            "name": "Imported",
            "strategy": _sample_strategy(),
            "blockly_xml": _sample_xml(),
        },
    )
    assert res.status_code == 200
    assert res.json()["strategy"]["status"] == "imported"


def test_builder_delete_blocked_while_running(client, monkeypatch):
    payload = {
        "name": "Running guard",
        "strategy": _sample_strategy(),
        "blockly_xml": _sample_xml(),
    }
    created = client.post("/builder/strategies", json=payload)
    sid = created.json()["strategy"]["id"]

    monkeypatch.setattr(
        app_module.bot,
        "status",
        lambda: {"running": True},
    )
    deleted = client.delete(f"/builder/strategies/{sid}")
    assert deleted.status_code == 409
