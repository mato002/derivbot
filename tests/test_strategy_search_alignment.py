"""Search layer alignment with signal engine."""

from modules.strategy_engine import search_signal_compatibility, validate_strategy, DEFAULT_STRATEGY


def test_all_signal_digits_reachable_after_validation():
    strat = validate_strategy(
        {
            **DEFAULT_STRATEGY,
            "rules": {"if_digit_greater_equal": 6, "trade": "UNDER", "else_trade": "OVER"},
            "model": {"use_probability_gate": False, "min_win_probability": 0.0, "min_samples": 50},
            "search": {
                **DEFAULT_STRATEGY["search"],
                "min_estimated_ratio": 1.01,
            },
        }
    )
    paths = search_signal_compatibility(strat)
    blocked = [p for p in paths if not p["reachable"]]
    assert blocked == [], f"Blocked paths: {blocked}"


def test_probability_gate_disabled_in_strategy():
    strat = validate_strategy({**DEFAULT_STRATEGY, "model": {"use_probability_gate": False}})
    assert strat["model"]["use_probability_gate"] is False
