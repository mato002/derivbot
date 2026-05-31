"""Payout-aware search: barrier selection and pre-proposal expectancy filters."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# Deriv API: digit barrier must be 0–8 (digits are 0–9; barrier 9 is rejected on proposal).
MAX_DIGIT_BARRIER = 8

# Typical Digit Over/Under payout ratios on volatility indices (approximate).
_STATIC_RATIO_HINTS: Dict[str, Dict[int, float]] = {
    "DIGITOVER": {0: 1.1, 1: 1.2, 2: 1.35, 3: 1.5, 4: 1.75, 5: 2.0, 6: 2.5, 7: 3.2, 8: 4.5},
    "DIGITUNDER": {0: 8.0, 1: 4.5, 2: 3.2, 3: 2.5, 4: 2.0, 5: 1.75, 6: 1.5, 7: 1.35, 8: 1.2},
}


def clamp_digit_barrier(barrier: int) -> int:
    return max(0, min(MAX_DIGIT_BARRIER, int(barrier)))

HOUSE_EDGE = 0.03


def uniform_win_probability(contract_type: str, barrier: int) -> float:
    b = clamp_digit_barrier(barrier)
    if contract_type == "DIGITOVER":
        return max(0.05, min(0.95, (9 - b) / 10.0))
    if contract_type == "DIGITUNDER":
        return max(0.05, min(0.95, b / 10.0))
    return 0.5


def estimate_payout_ratio(
    contract_type: str,
    barrier: int,
    *,
    win_prob: float | None = None,
) -> float:
    """Estimate payout/stake before requesting a live proposal."""
    hints = _STATIC_RATIO_HINTS.get(contract_type, {})
    hinted = hints.get(clamp_digit_barrier(barrier))
    if hinted is not None:
        return float(hinted)
    p = float(win_prob if win_prob is not None else uniform_win_probability(contract_type, barrier))
    p = max(0.05, min(0.95, p))
    return max(1.01, min(10.0, (1.0 - HOUSE_EDGE) / p))


def expectancy_factor(win_prob: float, payout_ratio: float) -> float:
    """Per-unit-stake expectancy: win_prob * payout - 1."""
    return win_prob * payout_ratio - 1.0


def required_min_ratio(
    search_cfg: Dict[str, Any],
    execution_cfg: Dict[str, Any],
    confidence: float,
) -> float:
    """Resolve minimum payout ratio (search floor, optional adaptive tiers)."""
    base = float(
        search_cfg.get("min_estimated_ratio")
        or execution_cfg.get("min_payout_to_stake")
        or 1.75
    )
    if not bool(search_cfg.get("adaptive_ratio", False)):
        return base
    tiers: List[Dict[str, Any]] = list(search_cfg.get("adaptive_ratio_tiers") or [])
    conf = max(0.0, min(1.0, float(confidence)))
    chosen = base
    for tier in sorted(tiers, key=lambda t: float(t.get("min_confidence", 0)), reverse=True):
        if conf >= float(tier.get("min_confidence", 0)):
            chosen = float(tier.get("min_ratio", chosen))
            break
    return max(1.01, min(10.0, chosen))


def _barrier_candidates(contract_type: str, search_cfg: Dict[str, Any]) -> List[int]:
    if contract_type == "DIGITOVER":
        lo = int(search_cfg.get("min_barrier_over", 4))
        return list(range(max(0, min(MAX_DIGIT_BARRIER, lo)), MAX_DIGIT_BARRIER + 1))
    if contract_type == "DIGITUNDER":
        hi = int(search_cfg.get("max_barrier_under", 5))
        return list(range(0, min(MAX_DIGIT_BARRIER + 1, max(1, hi + 1))))
    return list(range(MAX_DIGIT_BARRIER + 1))


def select_efficient_barrier(
    contract_type: str,
    repeated_digit: int,
    *,
    min_ratio: float,
    search_cfg: Dict[str, Any],
    transition_probs: Dict[int, float] | None = None,
) -> Tuple[Optional[int], float, float, str]:
    """
    Pick a barrier on the same contract side that meets min ratio and maximizes expectancy.
    Returns (barrier, win_prob, estimated_ratio, reason).
    """
    candidates = _barrier_candidates(contract_type, search_cfg)
    if not candidates:
        return None, 0.0, 0.0, "no_barrier_candidates"

    best: Tuple[int, float, float, float] | None = None
    for b in candidates:
        if transition_probs:
            if contract_type == "DIGITOVER":
                wp = sum(v for k, v in transition_probs.items() if k > b)
            else:
                wp = sum(v for k, v in transition_probs.items() if k < b)
            wp = max(0.05, min(0.95, wp))
        else:
            wp = uniform_win_probability(contract_type, b)
        ratio = estimate_payout_ratio(contract_type, b, win_prob=wp)
        if ratio < min_ratio:
            continue
        ev = expectancy_factor(wp, ratio)
        if best is None or ev > best[3]:
            best = (b, wp, ratio, ev)

    if best is None:
        return (
            None,
            0.0,
            0.0,
            f"no barrier meets estimated ratio >= {min_ratio:.2f}",
        )
    b, wp, ratio, ev = best
    policy_note = "efficiency"
    if b != repeated_digit:
        policy_note = f"efficiency remapped {repeated_digit}->{b}"
    return b, wp, ratio, f"{policy_note} ev={ev:.3f} p={wp:.2f} ratio≈{ratio:.2f}"


def refine_digit_decision(
    decision: Dict[str, object],
    *,
    strategy: Dict[str, Any],
    repeated_digit: int,
    transition_probs: Dict[int, float] | None = None,
    confidence: float = 0.0,
) -> Tuple[Optional[Dict[str, object]], str]:
    """
    Apply search-layer filters and barrier policy before proposal/execution.
    Returns (decision_or_none, skip_reason).
    """
    search_cfg = dict(strategy.get("search") or {})
    if not bool(search_cfg.get("enabled", True)):
        return decision, ""

    execution_cfg = dict(strategy.get("execution") or {})
    contract_type = str(decision.get("contract_type") or "")
    if contract_type not in {"DIGITOVER", "DIGITUNDER"}:
        return decision, ""

    min_ratio = required_min_ratio(search_cfg, execution_cfg, confidence)
    policy = str(search_cfg.get("barrier_policy", "efficiency")).strip().lower()
    signal_barrier = int(decision.get("barrier") if decision.get("barrier") is not None else repeated_digit)

    if policy == "signal":
        barrier = clamp_digit_barrier(signal_barrier)
        if bool(search_cfg.get("avoid_extreme_barriers", True)):
            if contract_type == "DIGITOVER" and barrier < int(search_cfg.get("min_barrier_over", 4)):
                return None, (
                    f"search: barrier {barrier} too low for OVER "
                    f"(min {search_cfg.get('min_barrier_over', 4)})"
                )
            if contract_type == "DIGITUNDER" and barrier > int(search_cfg.get("max_barrier_under", 5)):
                return None, (
                    f"search: barrier {barrier} too high for UNDER "
                    f"(max {search_cfg.get('max_barrier_under', 5)})"
                )
        if transition_probs:
            if contract_type == "DIGITOVER":
                wp = sum(v for k, v in transition_probs.items() if k > barrier)
            else:
                wp = sum(v for k, v in transition_probs.items() if k < barrier)
            wp = max(0.05, min(0.95, wp))
        else:
            wp = uniform_win_probability(contract_type, barrier)
        ratio = estimate_payout_ratio(contract_type, barrier, win_prob=wp)
        reason = f"signal barrier {barrier}"
    else:
        barrier, wp, ratio, reason = select_efficient_barrier(
            contract_type,
            repeated_digit,
            min_ratio=min_ratio,
            search_cfg=search_cfg,
            transition_probs=transition_probs,
        )
        if barrier is None:
            return None, f"search: {reason}"

    if ratio < min_ratio:
        return None, f"search: estimated ratio {ratio:.2f} < {min_ratio:.2f} ({reason})"

    out = dict(decision)
    out["barrier"] = clamp_digit_barrier(int(barrier))
    out["search_meta"] = {
        "policy": policy,
        "signal_barrier": signal_barrier,
        "selected_barrier": barrier,
        "estimated_win_prob": round(wp, 4),
        "estimated_payout_ratio": round(ratio, 3),
        "min_ratio_required": round(min_ratio, 3),
        "expectancy_factor": round(expectancy_factor(wp, ratio), 4),
        "note": reason,
    }
    return out, ""
