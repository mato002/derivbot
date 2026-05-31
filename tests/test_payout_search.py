"""Tests for payout-aware search layer."""

from modules import payout_search


def test_skips_low_barrier_over_signal_policy():
    strategy = {
        "search": {
            "enabled": True,
            "barrier_policy": "signal",
            "min_estimated_ratio": 1.5,
            "avoid_extreme_barriers": True,
            "min_barrier_over": 4,
            "max_barrier_under": 5,
        },
        "execution": {"min_payout_to_stake": 1.75},
    }
    decision = {"contract_type": "DIGITOVER", "barrier": 0, "win_probability": 0.92}
    refined, reason = payout_search.refine_digit_decision(
        decision, strategy=strategy, repeated_digit=0, confidence=0.92
    )
    assert refined is None
    assert "too low" in reason


def test_efficiency_remaps_barrier_for_better_ratio():
    strategy = {
        "search": {
            "enabled": True,
            "barrier_policy": "efficiency",
            "min_estimated_ratio": 1.5,
            "min_barrier_over": 4,
            "max_barrier_under": 5,
        },
        "execution": {"min_payout_to_stake": 1.75},
    }
    decision = {"contract_type": "DIGITOVER", "barrier": 0, "win_probability": 0.92}
    refined, reason = payout_search.refine_digit_decision(
        decision, strategy=strategy, repeated_digit=0, confidence=0.92
    )
    assert reason == ""
    assert refined is not None
    assert int(refined["barrier"]) >= 4
    assert int(refined["barrier"]) <= payout_search.MAX_DIGIT_BARRIER
    meta = refined.get("search_meta") or {}
    assert float(meta["estimated_payout_ratio"]) >= 1.5


def test_efficiency_never_selects_barrier_nine():
    strategy = {
        "search": {
            "enabled": True,
            "barrier_policy": "efficiency",
            "min_estimated_ratio": 1.5,
            "min_barrier_over": 4,
        },
        "execution": {"min_payout_to_stake": 1.5},
    }
    decision = {"contract_type": "DIGITOVER", "barrier": 0, "win_probability": 0.92}
    refined, reason = payout_search.refine_digit_decision(
        decision, strategy=strategy, repeated_digit=0, confidence=0.92
    )
    assert reason == ""
    assert refined is not None
    assert int(refined["barrier"]) <= payout_search.MAX_DIGIT_BARRIER
    assert int(refined["barrier"]) != 9


def test_adaptive_ratio_lowers_threshold_for_high_confidence():
    strategy = {
        "search": {
            "enabled": True,
            "adaptive_ratio": True,
            "adaptive_ratio_tiers": [
                {"min_confidence": 0.90, "min_ratio": 1.15},
                {"min_confidence": 0.75, "min_ratio": 1.40},
            ],
            "min_estimated_ratio": 1.75,
        },
        "execution": {"min_payout_to_stake": 1.75},
    }
    assert payout_search.required_min_ratio(strategy["search"], strategy["execution"], 0.95) == 1.15
    assert payout_search.required_min_ratio(strategy["search"], strategy["execution"], 0.80) == 1.40
    assert payout_search.required_min_ratio(strategy["search"], strategy["execution"], 0.50) == 1.75
