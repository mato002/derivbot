"""Market data fetch fallbacks."""

from unittest.mock import MagicMock, patch

from modules import market_data


def test_public_ticks_history_parses_prices():
    fake_history = {
        "msg_type": "history",
        "history": {"prices": [1.0, 2.0], "times": [100, 101]},
    }

    class FakeWs:
        def send(self, _payload: str) -> None:
            pass

        def recv(self) -> str:
            import json

            return json.dumps(fake_history)

        def close(self) -> None:
            pass

    with patch("modules.market_data.websocket.create_connection", return_value=FakeWs()):
        ticks = market_data.fetch_ticks_history_public("R_100", count=20)
    assert len(ticks) == 2
    assert ticks[0]["price"] == 1.0


def test_fetch_ticks_falls_back_when_authorize_rejected():
    auth_error = {"error": {"message": "Input validation failed: authorize"}}

    class FakeWs:
        def send(self, _payload: str) -> None:
            pass

        def recv(self) -> str:
            import json

            return json.dumps(auth_error)

        def close(self) -> None:
            pass

    with patch("modules.market_data.open_ws_for_token", return_value=(FakeWs(), True, None)):
        with patch(
            "modules.market_data.fetch_ticks_history_public",
            return_value=[{"epoch": 1, "price": 1.23}],
        ) as pub:
            ticks = market_data.fetch_ticks_history("not_a_pat_token", "R_100", count=50)
    pub.assert_called_once()
    assert ticks[0]["price"] == 1.23
