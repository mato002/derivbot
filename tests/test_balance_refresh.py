"""Balance refresh before manual trades."""

from unittest.mock import patch

from modules.bot_engine import DerivBot


def test_manual_trade_uses_refreshed_balance_not_stale_zero():
    bot = DerivBot()
    with bot.lock:
        bot.balance = 0.0
        bot.api_token = "test_token"

    with patch.object(bot, "_prepare_stake_for_trade", return_value=(1.0, True, "")) as prep:
        with patch.object(
            bot, "_place_trade_standalone", return_value=(2.0, True, True, 1.0, "", 2.0, 100)
        ):
            result = bot.manual_trade(
                "DIGITMATCH",
                barrier=5,
                stake=1.0,
                balance_fallback=50.0,
            )

    prep.assert_called_once()
    assert prep.call_args.kwargs.get("balance_fallback") == 50.0
    assert result["success"] is True


def test_cap_stake_blocks_only_when_balance_truly_low():
    bot = DerivBot()
    with bot.lock:
        bot.balance = 0.2
    stake, ok, note = bot._cap_stake_to_balance(1.0)
    assert ok is False
    assert "Insufficient" in note
