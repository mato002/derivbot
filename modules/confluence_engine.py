"""Strict confluence gating for digit Over/Under (RSI, trend, momentum, volatility)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from modules import over_under_strategy_engine


@dataclass
class ConfluenceResult:
    passed: bool
    enabled: bool
    enforce: bool
    snapshot: Dict[str, Any]
    log_lines: List[str]
    skip_reason: str = ""


def _momentum_label(trend: str, rsi: float | None) -> str:
    if trend == "UP":
        return "Bullish"
    if trend == "DOWN":
        return "Bearish"
    if rsi is not None:
        if rsi >= 60:
            return "Bullish"
        if rsi <= 40:
            return "Bearish"
    return "Neutral"


def _volatility_label(market_mode: str, regime: str) -> str:
    if market_mode == "RANGE":
        return "Range"
    if regime == "volatile":
        return "Elevated"
    return "Stable"


def evaluate_confluence(
    *,
    api_token: str,
    symbol: str,
    base_side: str,
    confluence_cfg: Dict[str, Any],
    stats_regime: str,
    account_id: str | None = None,
) -> ConfluenceResult:
    enforce = bool(confluence_cfg.get("enforce_confluence", False))
    enabled = bool(confluence_cfg.get("enabled", False))

    if not enabled:
        snap = {
            "enabled": False,
            "enforce_confluence": enforce,
            "entry_allowed": True,
            "signal": base_side,
            "confidence": 100.0,
            "marketMode": "N/A",
            "base_side": base_side,
            "reasons": ["Confluence disabled"],
        }
        return ConfluenceResult(
            passed=True,
            enabled=False,
            enforce=enforce,
            snapshot=snap,
            log_lines=["[Confluence]", "DISABLED — skipped"],
        )

    try:
        raw = over_under_strategy_engine.run_confluence(
            api_token,
            symbol,
            base_side,  # type: ignore[arg-type]
            confluence_cfg,
            account_id=account_id,
        )
    except Exception as exc:
        raw = {
            "confluence_enabled": True,
            "entry_allowed": False,
            "signal": "NONE",
            "confidence": 0.0,
            "reasons": [f"Engine error: {exc}"],
            "marketMode": "CHOP",
            "over_score": 0.0,
            "under_score": 0.0,
            "confirmations": 0,
        }

    reasons = list(raw.get("reasons") or [])
    rsi_val = None
    for r in reasons:
        if "RSI" in str(r):
            try:
                part = str(r).split("RSI")[-1].strip().split()[0].replace("=", "").replace(":", "")
                rsi_val = float(part)
            except Exception:
                pass

    market_mode = str(raw.get("marketMode") or "CHOP")
    trend_hint = "CHOP"
    for r in reasons:
        rs = str(r).upper()
        if "TREND" in rs and "UP" in rs:
            trend_hint = "UP"
        elif "TREND" in rs and "DOWN" in rs:
            trend_hint = "DOWN"

    entry_allowed = bool(raw.get("entry_allowed"))
    signal = str(raw.get("signal") or "NONE")
    passed = entry_allowed and signal == base_side

    lines = [
        "[Confluence]",
        f"RSI={rsi_val if rsi_val is not None else 'n/a'}",
        f"Momentum={_momentum_label(trend_hint, rsi_val)}",
        f"Volatility={_volatility_label(market_mode, stats_regime)}",
        f"Signal={signal} base={base_side}",
        f"Confirmations={raw.get('confirmations', 0)}",
    ]
    if passed:
        lines.append("PASSED")
    else:
        lines.append("BLOCKED")
        if reasons:
            lines.append(f"Reason={reasons[-1][:120]}")

    snap: Dict[str, Any] = {
        "enabled": True,
        "enforce_confluence": enforce,
        "signal": signal,
        "confidence": raw.get("confidence"),
        "marketMode": market_mode,
        "entry_allowed": entry_allowed,
        "base_side": base_side,
        "over_score": raw.get("over_score"),
        "under_score": raw.get("under_score"),
        "confirmations": raw.get("confirmations"),
        "reasons": reasons[-24:],
    }

    if passed:
        return ConfluenceResult(passed=True, enabled=True, enforce=enforce, snapshot=snap, log_lines=lines)

    skip = "Confluence blocked entry"
    if not enforce:
        lines.append("ADVISORY — enforce=false, not blocking")
        return ConfluenceResult(
            passed=True,
            enabled=True,
            enforce=False,
            snapshot=snap,
            log_lines=lines,
        )

    return ConfluenceResult(
        passed=False,
        enabled=True,
        enforce=True,
        snapshot=snap,
        log_lines=lines,
        skip_reason=skip,
    )
