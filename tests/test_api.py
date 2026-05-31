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
    # Smoke tests assume no Deriv API token auto-login; bootstrap from config would confuse /auth/me.
    monkeypatch.setattr(app_module, "_ensure_config_token_session", lambda request: None)
    from starlette.testclient import TestClient

    return TestClient(app_module.app)


def _logged_in_dummy():
    return {"account": "TST", "account_id": "TST", "token": "dummy", "currency": "USD"}


def test_pages_return_html(client):
    for path in (
        "/",
        "/analysis",
        "/builder",
        "/copy-trading",
        "/manual-trader",
        "/matches",
        "/strategies",
        "/trading-bots",
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
    stats = client.get("/stats")
    assert stats.status_code == 200
    assert stats.json()["success"] is True
    journal = client.get("/journal")
    assert journal.status_code == 200
    assert journal.json()["success"] is True
    events = client.get("/events")
    assert events.status_code == 200
    edata = events.json()
    assert edata["success"] is True
    assert "latest_seq" in edata
    assert isinstance(edata.get("events"), list)


def test_auth_me_not_logged_in(client):
    response = client.get("/auth/deriv/me")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data.get("logged_in"), bool)
    assert isinstance(data.get("accounts"), list)
    assert isinstance(data.get("has_demo"), bool)
    assert isinstance(data.get("has_real"), bool)


def test_deriv_select_account_returns_404_without_matching_session(client):
    response = client.post("/auth/deriv/select-account", json={"account": "VRTC999"})
    assert response.status_code == 404


def test_start_stop_bot(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "_require_deriv_session", lambda r: _logged_in_dummy())
    start = client.post("/start-bot")
    assert start.status_code == 200
    assert "success" in start.json()
    stop = client.post("/stop-bot")
    assert stop.status_code == 200


def test_legacy_start_stop_aliases(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "_require_deriv_session", lambda r: _logged_in_dummy())
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


def test_strategy_presets_api(client):
    listed = client.get("/strategy-presets")
    assert listed.status_code == 200
    ids = {p["id"] for p in listed.json().get("presets", [])}
    assert "balanced" in ids

    applied = client.post("/strategy-preset", json={"preset": "sniper"})
    assert applied.status_code == 200
    body = applied.json()
    assert body.get("profile") == "sniper"
    loaded = client.get("/load-strategy")
    assert loaded.json().get("profile") == "sniper"
    assert loaded.json()["search"]["min_estimated_ratio"] >= 2.5


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


def test_strategy_runtime_and_risk_endpoints(client):
    runtime = client.get("/strategy/runtime")
    assert runtime.status_code == 200
    body = runtime.json()
    assert body.get("success") is True
    assert "active_action" in body
    assert "compatibility" in body

    decisions = client.get("/strategy/signal-decisions")
    assert decisions.status_code == 200
    assert decisions.json().get("success") is True
    assert isinstance(decisions.json().get("decisions"), list)

    risk = client.post(
        "/strategy-risk",
        json={"max_consecutive_losses": 3, "research_mode": False, "cooldown_ticks": 12},
    )
    assert risk.status_code == 200
    rb = risk.json()
    assert rb.get("success") is True
    assert rb["risk"]["max_consecutive_losses"] == 3
    assert rb["cooldown"]["cooldown_ticks"] == 12


def test_manual_trade_bad_contract(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "_require_deriv_session", lambda request: {"account": "TEST"})
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


def test_manual_trade_digit_match_ok(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "_require_deriv_session", lambda r: _logged_in_dummy())
    monkeypatch.setattr(
        app_module.bot,
        "manual_trade",
        lambda *a, **k: {
            "success": True,
            "won": False,
            "payout": 0.0,
            "profit_delta": -1.0,
            "duration_sec": 0.5,
        },
    )
    response = client.post(
        "/manual-trade",
        json={
            "contract_type": "DIGITMATCH",
            "barrier": 3,
            "stake": 1.0,
            "symbol": "R_100",
            "duration_ticks": 5,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body.get("won") is False
    assert body.get("profit_delta") == -1.0


def test_manual_trade_mocked(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "_require_deriv_session", lambda r: _logged_in_dummy())

    monkeypatch.setattr(
        app_module.bot,
        "manual_trade",
        lambda *args, **kwargs: {
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

    monkeypatch.setattr(app_module, "_require_deriv_session", lambda r: _logged_in_dummy())

    def fake_payload(token, symbol, timeframe="tick", *, account_id=None):
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


def test_market_data_rate_limit_uses_cached_payload(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "_require_deriv_session", lambda r: _logged_in_dummy())

    cached_payload = {
        "symbol": "R_100",
        "timeframe": "tick",
        "last_price": 101.0,
        "last_rsi14": 55.0,
        "last_ma20": 100.5,
        "points": [{"time": 1_700_000_999, "price": 101.0, "ma20": 100.5, "rsi14": 55.0}],
    }

    def failing_payload(*args, **kwargs):
        raise RuntimeError("PAT WebSocket rate-limited (retry_after=30s)")

    monkeypatch.setattr(app_module.market_data, "build_market_payload", failing_payload)
    monkeypatch.setattr(app_module.market_data, "get_cached_market_payload", lambda *a, **k: cached_payload)
    response = client.get("/market-data?symbol=R_100")
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body.get("stale") is True
    assert body.get("rate_limited") is True
    assert body["data"]["last_price"] == 101.0
