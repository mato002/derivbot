"""Repeat-digit trigger and direction mapping for digit Over/Under strategies."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

Side = str  # "OVER" | "UNDER"


@dataclass
class SignalResult:
    triggered: bool
    signal_digits: List[int]
    repeated_digit: int
    side: Side
    contract_type: str
    barrier: int
    active_action: str
    threshold: int
    regime: str
    model_context: Dict[str, Any]
    log_lines: List[str]


def repeat3_trigger(last_digits: List[int]) -> bool:
    return len(last_digits) == 3 and len(set(last_digits)) == 1


def build_signal(
    *,
    strategy: Dict[str, Any],
    signal_digits: List[int],
    repeated_digit: int,
    regime: str,
) -> Optional[SignalResult]:
    """Map repeat-3 trigger to contract direction (no probability/confluence yet)."""
    if strategy.get("type") != "digit_strategy":
        return None
    if strategy.get("condition") != "repeat_3":
        return None

    active_action = str(strategy.get("active_action") or strategy.get("action") or "over_under").strip().lower()
    portfolio = strategy.get("portfolio") if isinstance(strategy.get("portfolio"), dict) else {}
    if bool(portfolio.get("enabled", True)):
        regime_map = portfolio.get("regime_action_map") if isinstance(portfolio.get("regime_action_map"), dict) else {}
        mapped = str(regime_map.get(regime, active_action)).strip().lower()
        if mapped in {"over_under", "rise_fall"}:
            active_action = mapped

    if active_action not in {"over_under", "rise_fall"}:
        return None

    actions = strategy.get("actions") if isinstance(strategy.get("actions"), dict) else {}
    action_cfg = actions.get(active_action) if isinstance(actions, dict) else None
    if not isinstance(action_cfg, dict):
        action_cfg = {"enabled": True, "rules": strategy.get("rules", {})}
    if not bool(action_cfg.get("enabled", True)):
        return None

    rules = action_cfg.get("rules", {})
    if not isinstance(rules, dict):
        rules = {}
    threshold = int(rules.get("if_digit_greater_equal", 5))
    defaults = {"over_under": ("UNDER", "OVER"), "rise_fall": ("RISE", "FALL")}
    default_trade, default_else_trade = defaults[active_action]
    high_trade = str(rules.get("trade", default_trade)).upper()
    low_trade = str(rules.get("else_trade", default_else_trade)).upper()
    selected = high_trade if repeated_digit >= threshold else low_trade

    log_lines = [
        "[Signal]",
        f"Trigger={signal_digits}",
        f"Direction={selected}",
    ]

    if active_action == "over_under":
        if selected not in {"UNDER", "OVER"}:
            return None
        contract_type = "DIGITUNDER" if selected == "UNDER" else "DIGITOVER"
        barrier = int(repeated_digit)
        log_lines.append(f"Barrier={barrier}")
        return SignalResult(
            triggered=True,
            signal_digits=list(signal_digits),
            repeated_digit=int(repeated_digit),
            side=selected,
            contract_type=contract_type,
            barrier=barrier,
            active_action=active_action,
            threshold=threshold,
            regime=regime,
            model_context={
                "selected_side": selected,
                "repeated_digit": repeated_digit,
                "regime": regime,
                "active_action": active_action,
                "threshold": threshold,
            },
            log_lines=log_lines,
        )

    if selected not in {"RISE", "FALL"}:
        return None
    log_lines.append("Barrier=N/A")
    return SignalResult(
        triggered=True,
        signal_digits=list(signal_digits),
        repeated_digit=int(repeated_digit),
        side=selected,
        contract_type="CALL" if selected == "RISE" else "PUT",
        barrier=-1,
        active_action=active_action,
        threshold=threshold,
        regime=regime,
        model_context={
            "selected_side": selected,
            "repeated_digit": repeated_digit,
            "regime": regime,
            "active_action": active_action,
        },
        log_lines=log_lines,
    )
