"""HTTP smoke tests for the FastAPI trading platform (no live Deriv WebSocket)."""

from __future__ import annotations

import importlib
import json

import pytest

import modules.strategy_engine as strategy_engine


@pytest.fixture
def client(monkeypatch, tmp_path):
    strat = tmp_path / "strategy.json"
    strat.write_text(json.dumps(strategy_engine.DEFAULT_STRATEGY), encoding="utf-8")
    monkeypatch.setattr(strategy_engine, "STRATEGY_PATH", strat)
    import app as app_module

    importlib.reload(app_module)
    from starlette.testclient import TestClient

    return TestClient(app_module.app)


def test_pages_return_html(client):
    for path in (
        "/",
        "/analysis",
        "/builder",
        "/copy-trading",
        "/manual-trader",
        "/strategies",
    ):
        response = client.get(path)
        assert response.status_code == 200
        assert "text/html" in response.headers.get("content-type", "")


def test_status_and_history(client):
    status = client.get("/status")
    assert status.status_code == 200
    body = status.json()
    assert "running" in body
    assert "balance" in body
    history = client.get("/history")
    assert history.status_code == 200
    assert isinstance(history.json(), list)


def test_auth_me_not_logged_in(client):
    response = client.get("/auth/deriv/me")
    assert response.status_code == 200
    data = response.json()
    assert data["logged_in"] is False
    assert data.get("accounts") == []
    assert data.get("has_demo") is False
    assert data.get("has_real") is False


def test_deriv_select_account_returns_404_without_matching_session(client):
    response = client.post("/auth/deriv/select-account", json={"account": "VRTC999"})
    assert response.status_code == 404


def test_start_stop_bot(client):
    start = client.post("/start-bot")
    assert start.status_code == 200
    assert "success" in start.json()
    stop = client.post("/stop-bot")
    assert stop.status_code == 200


def test_legacy_start_stop_aliases(client):
    assert client.post("/start").status_code == 200
    assert client.post("/stop").status_code == 200


def test_update_settings(client):
    payload = {"stake": 5.0, "take_profit": 100.0, "stop_loss": -50.0}
    response = client.post("/update-settings", json=payload)
    assert response.status_code == 200
    assert response.json()["success"] is True


def test_copy_flow(client):
    client.post("/copy-master", json={"master_id": "m1"})
    client.post("/copy-follow", json={"follower_id": "f1"})
    snap = client.get("/copy-status")
    assert snap.status_code == 200
    data = snap.json()
    assert data.get("master_id") == "m1"
    assert "f1" in (data.get("followers") or [])
    unf = client.post("/copy-unfollow", json={"follower_id": "f1"})
    assert unf.status_code == 200


def test_save_load_strategy(client):
    strat = {
        "type": "digit_strategy",
        "condition": "repeat_3",
        "action": "over_under",
        "rules": {
            "if_digit_greater_equal": 6,
            "trade": "OVER",
            "else_trade": "UNDER",
        },
    }
    saved = client.post("/save-strategy", json=strat)
    assert saved.status_code == 200
    loaded = client.get("/load-strategy")
    assert loaded.status_code == 200
    assert loaded.json()["rules"]["if_digit_greater_equal"] == 6


def test_manual_trade_bad_contract(client):
    response = client.post(
        "/manual-trade",
        json={
            "contract_type": "FOOBAR",
            "barrier": 5,
            "stake": 1.0,
            "symbol": "R_100",
        },
    )
    assert response.status_code == 400


def test_manual_trade_mocked(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(
        app_module.bot,
        "manual_trade",
        lambda contract_type, barrier, stake, symbol="R_100": {
            "success": True,
            "won": True,
            "payout": 2.0,
            "profit_delta": 0.9,
        },
    )
    response = client.post(
        "/manual-trade",
        json={
            "contract_type": "DIGITOVER",
            "barrier": 5,
            "stake": 1.0,
            "symbol": "R_100",
        },
    )
    assert response.status_code == 200
    assert response.json()["won"] is True


def test_market_data_mocked(client, monkeypatch):
    import app as app_module

    def fake_payload(token, symbol, timeframe="tick"):
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "last_price": 100.0,
            "last_rsi14": 50.0,
            "last_ma20": 99.0,
            "points": [
                {
                    "time": 1_700_000_000 + i,
                    "price": 100.0 + i * 0.01,
                    "ma20": 100.0,
                    "rsi14": 50.0,
                }
                for i in range(25)
            ],
        }

    monkeypatch.setattr(app_module.market_data, "build_market_payload", fake_payload)
    response = client.get("/market-data?symbol=R_100")
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert len(payload["data"]["points"]) == 25
