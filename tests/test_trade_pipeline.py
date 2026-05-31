"""Unit tests for selective trade pipeline engines."""

from __future__ import annotations

from modules import payout_search, probability_engine, signal_engine
from modules.quant_engine import DigitStatsEngine
from modules.risk_engine import SessionRiskEngine
from modules.trade_pipeline import PipelineContext, TradePipeline
import modules.strategy_engine as strategy_engine


def _warm_stats(stats: DigitStatsEngine, n: int = 200) -> None:
    for i in range(n):
        stats.update(i % 10)


def test_probability_gate_blocks_low_confidence():
    stats = DigitStatsEngine()
    _warm_stats(stats)
    result = probability_engine.check_probability_gate(
        stats=stats,
        repeated_digit=7,
        side="UNDER",
        model_cfg={"use_probability_gate": True, "min_win_probability": 0.99},
        min_samples=50,
    )
    assert result.gate_enabled is True
    assert result.passed is False
    assert "BLOCKED" in "\n".join(result.log_lines)


def test_signal_barrier_policy_keeps_repeated_digit():
    strategy = dict(strategy_engine.DEFAULT_STRATEGY)
    strategy["search"]["barrier_policy"] = "signal"
    strategy["search"]["enabled"] = True
    strategy["search"]["min_estimated_ratio"] = 1.2
    strategy["search"]["max_barrier_under"] = 8
    strategy["execution"]["min_payout_to_stake"] = 1.2
    decision = {
        "contract_type": "DIGITUNDER",
        "barrier": 7,
        "win_probability": 0.65,
    }
    refined, skip = payout_search.refine_digit_decision(
        decision,
        strategy=strategy,
        repeated_digit=7,
        transition_probs={d: 0.1 for d in range(10)},
        confidence=0.65,
    )
    assert skip == ""
    assert refined is not None
    assert refined["barrier"] == 7


def test_pipeline_cooldown_blocks_back_to_back():
    stats = DigitStatsEngine()
    _warm_stats(stats)
    strategy = dict(strategy_engine.DEFAULT_STRATEGY)
    strategy["confluence"]["enabled"] = False
    strategy["model"]["use_probability_gate"] = False
    risk = SessionRiskEngine(strategy.get("risk"))
    risk.start_session(1000.0)
    pipe = TradePipeline()
    ctx = PipelineContext(
        strategy=strategy,
        stats=stats,
        risk=risk,
        last_digits=[7, 7, 7],
        api_token="",
        symbol="R_100",
        account_id=None,
        session_pnl=0.0,
        trades_count=0,
        loss_streak=0,
        outcomes=[],
        take_profit=500.0,
        stop_loss=-200.0,
        ticks_since_last_trade=3,
        cooldown_ticks=10,
    )
    result = pipe.evaluate(ctx)
    assert result.approved is False
    assert "cooldown" in result.skip_reason.lower()


def test_repeat3_builds_under_for_high_digit():
    strategy = dict(strategy_engine.DEFAULT_STRATEGY)
    sig = signal_engine.build_signal(
        strategy=strategy,
        signal_digits=[8, 8, 8],
        repeated_digit=8,
        regime="range",
    )
    assert sig is not None
    assert sig.side == "UNDER"
    assert sig.barrier == 8
