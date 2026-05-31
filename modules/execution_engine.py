"""Pre-trade search filters and live proposal execution validation."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from modules import payout_search


@dataclass
class PreExecutionResult:
    passed: bool
    decision: Dict[str, Any]
    log_lines: List[str]
    skip_reason: str = ""


@dataclass
class ProposalValidation:
    passed: bool
    payout_ratio: float
    latency_ms: int
    payout_preview: float
    ask_price: float
    log_lines: List[str]
    skip_reason: str = ""


def decision_from_signal(signal: Any, win_probability: float) -> Dict[str, Any]:
    barrier = signal.barrier if signal.barrier >= 0 else None
    return {
        "contract_type": signal.contract_type,
        "barrier": barrier,
        "win_probability": win_probability,
        "signal_digits": list(signal.signal_digits),
        "side": signal.side,
        "repeated_digit": signal.repeated_digit,
    }


def apply_search_layer(
    decision: Dict[str, Any],
    *,
    strategy: Dict[str, Any],
    repeated_digit: int,
    transition_probs: Dict[int, float] | None,
    confidence: float,
) -> PreExecutionResult:
    refined, skip = payout_search.refine_digit_decision(
        decision,
        strategy=strategy,
        repeated_digit=repeated_digit,
        transition_probs=transition_probs,
        confidence=confidence,
    )
    execution_cfg = dict(strategy.get("execution") or {})
    min_ratio = float(execution_cfg.get("min_payout_to_stake", 2.2))

    if refined is None:
        lines = [
            "[Execution]",
            f"Pre-filter BLOCKED: {skip}",
        ]
        return PreExecutionResult(passed=False, decision=decision, log_lines=lines, skip_reason=skip)

    meta = refined.get("search_meta") if isinstance(refined.get("search_meta"), dict) else {}
    ratio = float(meta.get("estimated_payout_ratio") or 0.0)
    lines = [
        "[Execution]",
        f"Policy={meta.get('policy', 'search')}",
        f"Barrier={refined.get('barrier')}",
        f"EstRatio={ratio:.2f}",
        f"MinRatio={min_ratio:.2f}",
    ]
    if ratio < min_ratio:
        lines.append(f"BLOCKED: {ratio:.2f} < {min_ratio:.2f}")
        return PreExecutionResult(
            passed=False,
            decision=refined,
            log_lines=lines,
            skip_reason=f"payout ratio too low: {ratio:.2f} < {min_ratio:.2f}",
        )
    lines.append("Pre-filter PASSED")
    return PreExecutionResult(passed=True, decision=refined, log_lines=lines)


def validate_live_proposal(
    *,
    proposal: Dict[str, Any],
    stake: float,
    execution_cfg: Dict[str, Any],
    proposal_latency_ms: int,
) -> ProposalValidation:
    ask_price = float(proposal.get("ask_price", stake) or stake)
    payout_preview = float(proposal.get("payout", 0.0) or 0.0)
    min_ratio = float(execution_cfg.get("min_payout_to_stake", 2.2))
    max_latency_ms = int(execution_cfg.get("max_proposal_latency_ms", 1500))
    ratio = (payout_preview / ask_price) if ask_price > 0 else 0.0

    lines = [
        "[Execution]",
        f"PayoutRatio={ratio:.2f}",
        f"Latency={proposal_latency_ms}ms",
    ]

    if proposal_latency_ms > max_latency_ms:
        lines.append(f"BLOCKED: latency {proposal_latency_ms}ms > {max_latency_ms}ms")
        return ProposalValidation(
            passed=False,
            payout_ratio=ratio,
            latency_ms=proposal_latency_ms,
            payout_preview=payout_preview,
            ask_price=ask_price,
            log_lines=lines,
            skip_reason=f"proposal latency too high ({proposal_latency_ms}ms > {max_latency_ms}ms)",
        )

    if ratio < min_ratio:
        lines.append(f"BLOCKED: {ratio:.2f} < {min_ratio:.2f}")
        return ProposalValidation(
            passed=False,
            payout_ratio=ratio,
            latency_ms=proposal_latency_ms,
            payout_preview=payout_preview,
            ask_price=ask_price,
            log_lines=lines,
            skip_reason=f"payout ratio too low: {ratio:.2f} < {min_ratio:.2f}",
        )

    lines.append("PASSED")
    return ProposalValidation(
        passed=True,
        payout_ratio=ratio,
        latency_ms=proposal_latency_ms,
        payout_preview=payout_preview,
        ask_price=ask_price,
        log_lines=lines,
    )
