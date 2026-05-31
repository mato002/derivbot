"""Tests for production-aligned backtest engine."""

from modules.backtest_engine import run_pipeline_backtest
from modules.strategy_engine import validate_strategy, DEFAULT_STRATEGY


def test_backtest_next_tick_no_look_ahead():
    # Warmup without repeat-3, then 666 -> UNDER@6 resolves on next tick 5 (win)
    digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] * 15 + [6, 6, 6, 5]
    strat = validate_strategy(
        {
            **DEFAULT_STRATEGY,
            "rules": {"if_digit_greater_equal": 6, "trade": "UNDER", "else_trade": "OVER"},
            "model": {"use_probability_gate": False, "min_win_probability": 0.0, "min_samples": 50},
            "execution": {"min_payout_to_stake": 1.01, "max_proposal_latency_ms": 1500},
            "search": {
                **DEFAULT_STRATEGY["search"],
                "min_estimated_ratio": 1.01,
            },
            "confluence": {"enabled": False},
            "cooldown": {"cooldown_ticks": 0},
            "portfolio": {"enabled": False},
        }
    )
    result = run_pipeline_backtest(digits, strat, stake=1.0, skip_confluence=True)
    assert result.total_trades >= 1
    t = result.trades[-1]
    assert t.repeated_digit == 6
    assert t.side == "UNDER"
    assert t.won is True


def test_backtest_returns_full_metrics():
    import random

    random.seed(99)
    digits = [random.randint(0, 9) for _ in range(800)]
    strat = validate_strategy(
        {
            **DEFAULT_STRATEGY,
            "model": {"use_probability_gate": False, "min_samples": 50},
            "execution": {"min_payout_to_stake": 1.01, "max_proposal_latency_ms": 1500},
            "confluence": {"enabled": False},
            "cooldown": {"cooldown_ticks": 0},
            "portfolio": {"enabled": False},
            "search": {**DEFAULT_STRATEGY["search"], "min_estimated_ratio": 1.01},
        }
    )
    result = run_pipeline_backtest(digits, strat, stake=1.0, skip_confluence=True)
    d = result.to_dict()
    for key in (
        "total_trades",
        "wins",
        "losses",
        "win_rate",
        "expectancy",
        "max_drawdown",
        "avg_loss_streak",
    ):
        assert key in d
