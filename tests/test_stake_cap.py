"""Stake must never exceed available balance."""

from modules.bot_engine import DerivBot


def test_cap_stake_when_balance_is_five_dollars():
    bot = DerivBot()
    with bot.lock:
        bot.balance = 5.0
    stake, ok, note = bot._cap_stake_to_balance(34.0)
    assert ok is True
    assert stake == 4.75
    assert "capped" in note.lower()


def test_blocks_trade_when_balance_too_low():
    bot = DerivBot()
    with bot.lock:
        bot.balance = 0.2
    stake, ok, note = bot._cap_stake_to_balance(1.0)
    assert ok is False
    assert stake == 0.0
    assert "insufficient" in note.lower()
