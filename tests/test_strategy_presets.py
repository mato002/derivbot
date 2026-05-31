"""Tests for strategy profile presets."""

from modules import strategy_engine


def test_apply_balanced_preset():
    base = {"type": "digit_strategy", "condition": "repeat_3", "action": "over_under"}
    merged = strategy_engine.apply_strategy_preset(base, "balanced")
    assert merged["profile"] == "balanced"
    assert merged["execution"]["min_payout_to_stake"] == 1.75
    assert merged["search"]["min_estimated_ratio"] == 1.75
    assert merged["search"]["min_barrier_over"] == 0
    assert merged["search"]["max_barrier_under"] == 8


def test_apply_sniper_preset_high_ratio():
    base = {"type": "digit_strategy", "condition": "repeat_3", "action": "over_under"}
    merged = strategy_engine.apply_strategy_preset(base, "sniper")
    assert merged["profile"] == "sniper"
    assert merged["execution"]["min_payout_to_stake"] >= 2.5
    assert merged["search"]["min_estimated_ratio"] >= 2.5


def test_list_presets():
    presets = strategy_engine.list_strategy_presets()
    ids = {p["id"] for p in presets}
    assert {"scalp_safe", "balanced", "sniper"} <= ids
