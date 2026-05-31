"""Rolling transition-probability gate for digit Over/Under trades."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from modules.quant_engine import DigitStatsEngine


@dataclass
class ProbabilityResult:
    passed: bool
    p_over: float
    p_under: float
    picked_prob: float
    min_threshold: float
    gate_enabled: bool
    side: str
    log_lines: List[str]
    skip_reason: str = ""


def transition_probs(stats: DigitStatsEngine, repeated_digit: int) -> Dict[int, float]:
    return stats.transition_probabilities(repeated_digit)


def compute_over_under_probs(probs: Dict[int, float], repeated_digit: int) -> tuple[float, float]:
    p_over = sum(v for k, v in probs.items() if k > repeated_digit)
    p_under = sum(v for k, v in probs.items() if k < repeated_digit)
    return round(p_over, 4), round(p_under, 4)


def check_probability_gate(
    *,
    stats: DigitStatsEngine,
    repeated_digit: int,
    side: str,
    model_cfg: Dict[str, Any],
    min_samples: int | None = None,
) -> ProbabilityResult:
    warmup = int(min_samples if min_samples is not None else 120)
    """Require estimated win probability for the chosen side before execution."""
    probs = transition_probs(stats, repeated_digit)
    p_over, p_under = compute_over_under_probs(probs, repeated_digit)
    gate_on = bool(model_cfg.get("use_probability_gate", False))
    min_prob = max(0.0, min(0.95, float(model_cfg.get("min_win_probability") or 0.0)))
    picked = p_under if side == "UNDER" else p_over

    lines = [
        "[Probability]",
        f"OVER={p_over:.2f}",
        f"UNDER={p_under:.2f}",
        f"Threshold={min_prob:.2f}",
    ]

    if not gate_on:
        lines.append("GATE=disabled PASSED")
        return ProbabilityResult(
            passed=True,
            p_over=p_over,
            p_under=p_under,
            picked_prob=picked,
            min_threshold=min_prob,
            gate_enabled=False,
            side=side,
            log_lines=lines,
        )

    if min_prob <= 1e-6:
        lines.append("GATE=off (threshold 0) PASSED")
        return ProbabilityResult(
            passed=True,
            p_over=p_over,
            p_under=p_under,
            picked_prob=picked,
            min_threshold=min_prob,
            gate_enabled=True,
            side=side,
            log_lines=lines,
        )

    if not stats.ready(warmup):
        reason = f"warming up ({stats.snapshot().get('window_size', 0)}/{warmup} samples)"
        lines.append(f"BLOCKED ({reason})")
        return ProbabilityResult(
            passed=False,
            p_over=p_over,
            p_under=p_under,
            picked_prob=picked,
            min_threshold=min_prob,
            gate_enabled=True,
            side=side,
            log_lines=lines,
            skip_reason=f"Probability gate: {reason}",
        )

    picked_side = side.upper()
    if picked >= min_prob:
        lines.append(f"{picked_side}={picked:.2f} PASSED")
        return ProbabilityResult(
            passed=True,
            p_over=p_over,
            p_under=p_under,
            picked_prob=picked,
            min_threshold=min_prob,
            gate_enabled=True,
            side=side,
            log_lines=lines,
        )

    lines.append(f"{picked_side}={picked:.2f} < {min_prob:.2f} BLOCKED")
    return ProbabilityResult(
        passed=False,
        p_over=p_over,
        p_under=p_under,
        picked_prob=picked,
        min_threshold=min_prob,
        gate_enabled=True,
        side=side,
        log_lines=lines,
        skip_reason=f"Probability gate blocked: {picked_side}={picked:.2f} < {min_prob:.2f}",
    )
