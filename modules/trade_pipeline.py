"""Orchestrates signal → probability → search → risk → confluence validation."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from modules import (
    confluence_engine,
    execution_engine,
    probability_engine,
    signal_engine,
    signal_decision_log,
)
from modules.risk_engine import SessionRiskEngine
from modules.quant_engine import DigitStatsEngine


@dataclass
class PipelineContext:
    strategy: Dict[str, Any]
    stats: DigitStatsEngine
    risk: SessionRiskEngine
    last_digits: List[int]
    api_token: str
    symbol: str
    account_id: str | None
    session_pnl: float
    trades_count: int
    loss_streak: int
    outcomes: List[str]
    take_profit: float
    stop_loss: float
    ticks_since_last_trade: int
    cooldown_ticks: int


@dataclass
class PipelineResult:
    approved: bool
    decision: Optional[Dict[str, Any]] = None
    signal: Optional[signal_engine.SignalResult] = None
    probability: Optional[probability_engine.ProbabilityResult] = None
    confluence: Optional[confluence_engine.ConfluenceResult] = None
    pre_execution: Optional[execution_engine.PreExecutionResult] = None
    risk: Optional[Any] = None
    log_lines: List[str] = field(default_factory=list)
    skip_reason: str = ""
    signal_decision: Optional[Dict[str, Any]] = None


def _build_signal_decision(
    *,
    signal: signal_engine.SignalResult,
    prob: probability_engine.ProbabilityResult | None,
    search_passed: bool,
    confluence_passed: bool,
    risk_passed: bool,
    executed: bool,
    skip_reason: str,
) -> Dict[str, Any]:
    return signal_decision_log.build_decision_record(
        repeat_digit=signal.repeated_digit,
        signal_digits=list(signal.signal_digits),
        side=signal.side,
        contract_type=signal.contract_type,
        barrier=signal.barrier,
        p_over=prob.p_over if prob else None,
        p_under=prob.p_under if prob else None,
        probability_gate_passed=bool(prob.passed) if prob else False,
        search_passed=search_passed,
        confluence_passed=confluence_passed,
        risk_passed=risk_passed,
        executed=executed,
        skip_reason=skip_reason,
    )


class TradePipeline:
    def evaluate(self, ctx: PipelineContext) -> PipelineResult:
        lines: List[str] = []

        if ctx.cooldown_ticks > 0 and ctx.ticks_since_last_trade < ctx.cooldown_ticks:
            remaining = ctx.cooldown_ticks - ctx.ticks_since_last_trade
            lines.extend(
                [
                    "[Cooldown]",
                    f"active: {remaining} ticks remaining",
                ]
            )
            return PipelineResult(approved=False, log_lines=lines, skip_reason="cooldown active")

        if not signal_engine.repeat3_trigger(ctx.last_digits):
            return PipelineResult(approved=False, log_lines=lines, skip_reason="no trigger")

        signal_digits = list(ctx.last_digits)
        repeated = signal_digits[-1]
        regime = ctx.stats.regime()

        signal = signal_engine.build_signal(
            strategy=ctx.strategy,
            signal_digits=signal_digits,
            repeated_digit=repeated,
            regime=regime,
        )
        if signal is None:
            lines.append("[Signal] conditions not met")
            return PipelineResult(approved=False, log_lines=lines, skip_reason="strategy conditions not met")

        lines.extend(signal.log_lines)

        if signal.active_action != "over_under":
            lines.append("[Pipeline] rise/fall not fully gated — proceeding")
            decision = execution_engine.decision_from_signal(signal, 0.5)
            return PipelineResult(
                approved=True,
                decision=decision,
                signal=signal,
                log_lines=lines,
            )

        model_cfg = dict(ctx.strategy.get("model") or {})
        prob = probability_engine.check_probability_gate(
            stats=ctx.stats,
            repeated_digit=repeated,
            side=signal.side,
            model_cfg=model_cfg,
            min_samples=int(model_cfg.get("min_samples", 120)),
        )
        lines.extend(prob.log_lines)
        if not prob.passed:
            decision_log = _build_signal_decision(
                signal=signal,
                prob=prob,
                search_passed=False,
                confluence_passed=False,
                risk_passed=False,
                executed=False,
                skip_reason=prob.skip_reason,
            )
            signal_decision_log.log_signal_decision(decision_log)
            return PipelineResult(
                approved=False,
                signal=signal,
                probability=prob,
                log_lines=lines,
                skip_reason=prob.skip_reason,
                signal_decision=decision_log,
            )

        decision = execution_engine.decision_from_signal(signal, prob.picked_prob)
        decision["model"] = {
            **signal.model_context,
            "p_over": prob.p_over,
            "p_under": prob.p_under,
            "picked_prob": prob.picked_prob,
        }

        trans = probability_engine.transition_probs(ctx.stats, repeated)
        pre = execution_engine.apply_search_layer(
            decision,
            strategy=ctx.strategy,
            repeated_digit=repeated,
            transition_probs=trans,
            confidence=prob.picked_prob,
        )
        lines.extend(pre.log_lines)
        if not pre.passed:
            decision_log = _build_signal_decision(
                signal=signal,
                prob=prob,
                search_passed=False,
                confluence_passed=False,
                risk_passed=False,
                executed=False,
                skip_reason=pre.skip_reason,
            )
            signal_decision_log.log_signal_decision(decision_log)
            return PipelineResult(
                approved=False,
                signal=signal,
                probability=prob,
                pre_execution=pre,
                log_lines=lines,
                skip_reason=pre.skip_reason,
                signal_decision=decision_log,
            )
        decision = pre.decision

        risk = ctx.risk.check(
            trades_count=ctx.trades_count,
            loss_streak=ctx.loss_streak,
            session_pnl=ctx.session_pnl,
            outcomes=ctx.outcomes,
            stats_regime=regime,
            take_profit=ctx.take_profit,
            stop_loss=ctx.stop_loss,
        )
        lines.extend(risk.log_lines)
        if not risk.allowed:
            if risk.paused:
                ctx.risk.mark_paused(risk.reason)
            decision_log = _build_signal_decision(
                signal=signal,
                prob=prob,
                search_passed=True,
                confluence_passed=False,
                risk_passed=False,
                executed=False,
                skip_reason=f"Risk gate blocked: {risk.reason}",
            )
            signal_decision_log.log_signal_decision(decision_log)
            return PipelineResult(
                approved=False,
                signal=signal,
                probability=prob,
                pre_execution=pre,
                risk=risk,
                log_lines=lines,
                skip_reason=f"Risk gate blocked: {risk.reason}",
                signal_decision=decision_log,
            )

        conf_cfg = dict(ctx.strategy.get("confluence") or {})
        if bool(ctx.strategy.get("research_mode")):
            conf_cfg = {**conf_cfg, "enforce_confluence": False}
        conf = confluence_engine.evaluate_confluence(
            api_token=ctx.api_token,
            symbol=ctx.symbol,
            base_side=signal.side,
            confluence_cfg=conf_cfg,
            stats_regime=regime,
            account_id=ctx.account_id,
        )
        lines.extend(conf.log_lines)
        if not conf.passed:
            decision_log = _build_signal_decision(
                signal=signal,
                prob=prob,
                search_passed=True,
                confluence_passed=False,
                risk_passed=True,
                executed=False,
                skip_reason=conf.skip_reason or "confluence blocked",
            )
            signal_decision_log.log_signal_decision(decision_log)
            return PipelineResult(
                approved=False,
                signal=signal,
                probability=prob,
                pre_execution=pre,
                confluence=conf,
                risk=risk,
                log_lines=lines,
                skip_reason=conf.skip_reason or "confluence blocked",
                signal_decision=decision_log,
            )

        lines.extend(
            [
                "[Trade]",
                f"READY {decision.get('contract_type')} barrier={decision.get('barrier')} "
                f"p≈{prob.picked_prob:.2f}",
            ]
        )
        decision_log = _build_signal_decision(
            signal=signal,
            prob=prob,
            search_passed=True,
            confluence_passed=True,
            risk_passed=True,
            executed=False,
            skip_reason="",
        )
        signal_decision_log.log_signal_decision(decision_log)
        return PipelineResult(
            approved=True,
            decision=decision,
            signal=signal,
            probability=prob,
            pre_execution=pre,
            confluence=conf,
            risk=risk,
            log_lines=lines,
            signal_decision=decision_log,
        )
