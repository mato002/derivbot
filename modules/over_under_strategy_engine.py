"""
Professional Over/Under confluence engine for digit contracts.

Uses recent tick history (aggregated into synthetic OHLC) for trend, S/R, RSI,
candle patterns, and range detection. Designed to gate the existing digit signal
so trades require multi-factor confirmation.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple

from modules.market_data import fetch_ticks_history

logger = logging.getLogger(__name__)

TrendState = Literal["UP", "DOWN", "CHOP"]
MarketMode = Literal["TREND", "RANGE", "CHOP"]
Side = Literal["OVER", "UNDER"]


def _ema(closes: Sequence[float], period: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(closes)
    if period <= 0 or len(closes) < period:
        return out
    k = 2.0 / (period + 1)
    ema = sum(closes[:period]) / period
    out[period - 1] = ema
    for i in range(period, len(closes)):
        ema = closes[i] * k + ema * (1 - k)
        out[i] = ema
    return out


def _rsi(closes: Sequence[float], period: int = 14) -> List[Optional[float]]:
    if len(closes) < period + 1:
        return [None] * len(closes)
    out: List[Optional[float]] = [None] * len(closes)
    gains: List[float] = []
    losses: List[float] = []
    for i in range(1, len(closes)):
        delta = closes[i] - closes[i - 1]
        gains.append(max(delta, 0.0))
        losses.append(max(-delta, 0.0))
    for i in range(period, len(closes)):
        avg_gain = sum(gains[i - period : i]) / period
        avg_loss = sum(losses[i - period : i]) / period
        if avg_loss == 0:
            out[i] = 100.0 if avg_gain > 0 else 50.0
        else:
            rs = avg_gain / avg_loss
            out[i] = round(100 - (100 / (1 + rs)), 2)
    return out


def _ticks_to_ohlc(prices: Sequence[float], ticks_per_bar: int) -> List[Dict[str, float]]:
    out: List[Dict[str, float]] = []
    if ticks_per_bar < 3:
        ticks_per_bar = 3
    i = 0
    while i + ticks_per_bar <= len(prices):
        chunk = prices[i : i + ticks_per_bar]
        o, h, l, c = chunk[0], max(chunk), min(chunk), chunk[-1]
        out.append({"o": o, "h": h, "l": l, "c": c})
        i += ticks_per_bar
    return out


def _ema_slope(ema_series: Sequence[Optional[float]], lookback: int = 5) -> float:
    vals = [x for x in ema_series if x is not None]
    if len(vals) < lookback + 1:
        return 0.0
    recent = vals[-lookback:]
    base = abs(recent[-1]) or 1.0
    return (recent[-1] - recent[0]) / base


def _swing_levels(closes: Sequence[float], lookback: int) -> Tuple[float, float]:
    """Recent swing high / low from closing prices."""
    w = closes[-lookback:] if len(closes) >= lookback else closes
    return max(w), min(w)


def _near_zone(price: float, level: float, tolerance_pct: float) -> bool:
    if price <= 0:
        return False
    return abs(price - level) / price * 100.0 <= tolerance_pct


def _bullish_engulfing(prev: Dict[str, float], cur: Dict[str, float]) -> bool:
    pb = abs(prev["c"] - prev["o"])
    cb = abs(cur["c"] - cur["o"])
    prev_bear = prev["c"] < prev["o"]
    cur_bull = cur["c"] > cur["o"]
    return prev_bear and cur_bull and cur["o"] <= prev["c"] and cur["c"] >= prev["h"] and cb > pb


def _bearish_engulfing(prev: Dict[str, float], cur: Dict[str, float]) -> bool:
    pb = abs(prev["c"] - prev["o"])
    cb = abs(cur["c"] - cur["o"])
    prev_bull = prev["c"] > prev["o"]
    cur_bear = cur["c"] < cur["o"]
    return prev_bull and cur_bear and cur["o"] >= prev["c"] and cur["c"] <= prev["l"] and cb > pb


def _pin_bar_rejection_bull(bar: Dict[str, float]) -> bool:
    rng = bar["h"] - bar["l"]
    if rng <= 0:
        return False
    body = abs(bar["c"] - bar["o"])
    lower = min(bar["o"], bar["c"]) - bar["l"]
    return lower > body * 2 and body / rng < 0.35


def _pin_bar_rejection_bear(bar: Dict[str, float]) -> bool:
    rng = bar["h"] - bar["l"]
    if rng <= 0:
        return False
    body = abs(bar["c"] - bar["o"])
    upper = bar["h"] - max(bar["o"], bar["c"])
    return upper > body * 2 and body / rng < 0.35


def _doji_at_level(bar: Dict[str, float], level: float, tol_pct: float) -> bool:
    rng = bar["h"] - bar["l"]
    if rng <= 0:
        return False
    body = abs(bar["c"] - bar["o"])
    mid = (bar["h"] + bar["l"]) / 2.0
    if not _near_zone(mid, level, tol_pct * 1.5):
        return False
    return body / rng < 0.12


def run_confluence(
    api_token: str,
    symbol: str,
    base_side: Side,
    confluence: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Evaluate confluence for the proposed digit Over/Under side (base_side).

    Returns keys aligned with the product brief (signal, confidence, reasons,
    marketMode, entry_allowed) plus diagnostics for UI/API.
    """
    defaults = {
        "enabled": False,
        "min_score": 5,
        "min_confirmations": 2,
        "use_trend": True,
        "use_sr": True,
        "use_rsi": True,
        "use_candles": True,
        "use_range": True,
        "ticks_per_candle": 28,
        "sr_lookback": 90,
        "sr_tolerance_pct": 0.22,
        "history_ticks": 900,
        "flat_ema_slope_abs": 0.00035,
        "range_width_max_pct": 1.65,
        "range_min_crosses": 2,
    }
    cfg = {**defaults, **(confluence or {})}
    enabled = bool(cfg.get("enabled"))

    if not enabled:
        return {
            "confluence_enabled": False,
            "signal": base_side,
            "confidence": 100.0,
            "reasons": ["Confluence engine disabled — raw digit signal only"],
            "marketMode": "TREND",
            "entry_allowed": True,
            "over_score": 0.0,
            "under_score": 0.0,
            "confirmations": 0,
        }

    reasons: List[str] = []
    try:
        raw = fetch_ticks_history(api_token, symbol, count=int(cfg["history_ticks"]))
    except Exception as exc:
        logger.warning("confluence: tick history failed: %s", exc)
        return {
            "confluence_enabled": True,
            "signal": "NONE",
            "confidence": 0.0,
            "reasons": [f"Market data error: {exc}"],
            "marketMode": "CHOP",
            "entry_allowed": False,
            "over_score": 0.0,
            "under_score": 0.0,
            "confirmations": 0,
        }

    if len(raw) < 220:
        reasons.append(f"Insufficient history ({len(raw)} ticks) for confluence")
        return {
            "confluence_enabled": True,
            "signal": "NONE",
            "confidence": 0.0,
            "reasons": reasons,
            "marketMode": "CHOP",
            "entry_allowed": False,
            "over_score": 0.0,
            "under_score": 0.0,
            "confirmations": 0,
        }

    prices = [float(t["price"]) for t in raw]
    last = prices[-1]
    ema50_s = _ema(prices, 50)
    ema200_s = _ema(prices, 200)
    rsi_s = _rsi(prices, 14)
    ema50 = ema50_s[-1]
    ema200 = ema200_s[-1]
    rsi_val = rsi_s[-1]

    trend: TrendState = "CHOP"
    if ema50 is not None and ema200 is not None:
        if last > ema200 and ema50 > ema200:
            trend = "UP"
        elif last < ema200 and ema50 < ema200:
            trend = "DOWN"
        else:
            trend = "CHOP"

    lb = int(cfg["sr_lookback"])
    swing_hi, swing_lo = _swing_levels(prices, min(lb, len(prices) - 1))
    tol = float(cfg["sr_tolerance_pct"])
    touch_support = _near_zone(last, swing_lo, tol)
    touch_res = _near_zone(last, swing_hi, tol)

    ticks_per = int(cfg["ticks_per_candle"])
    ohlc = _ticks_to_ohlc(prices, ticks_per)
    flat_ema = abs(_ema_slope(ema50_s, 5)) < float(cfg["flat_ema_slope_abs"])

    mid = (swing_hi + swing_lo) / 2.0
    width_pct = ((swing_hi - swing_lo) / mid * 100.0) if mid else 999.0
    crosses = 0
    for i in range(max(1, len(prices) - lb), len(prices)):
        p = prices[i]
        if abs(p - swing_lo) / p * 100 < tol * 1.5 or abs(p - swing_hi) / p * 100 < tol * 1.5:
            crosses += 1
    range_mode = (
        width_pct <= float(cfg["range_width_max_pct"])
        and crosses >= int(cfg["range_min_crosses"])
        and flat_ema
    )

    if range_mode:
        market_mode: MarketMode = "RANGE"
    elif trend in ("UP", "DOWN"):
        market_mode = "TREND"
    else:
        market_mode = "CHOP"

    candle_bull = False
    candle_bear = False
    candle_pin_bull = False
    candle_pin_bear = False
    candle_doji_support = False
    candle_doji_res = False
    if len(ohlc) >= 3:
        p0, p1, p2 = ohlc[-3], ohlc[-2], ohlc[-1]
        candle_bull = _bullish_engulfing(p1, p2)
        candle_bear = _bearish_engulfing(p1, p2)
        candle_pin_bull = _pin_bar_rejection_bull(p2)
        candle_pin_bear = _pin_bar_rejection_bear(p2)
        candle_doji_support = _doji_at_level(p2, swing_lo, tol)
        candle_doji_res = _doji_at_level(p2, swing_hi, tol)

    over_score = 0.0
    under_score = 0.0
    over_modules: set[str] = set()
    under_modules: set[str] = set()

    use_trend = bool(cfg.get("use_trend"))
    use_sr = bool(cfg.get("use_sr"))
    use_rsi = bool(cfg.get("use_rsi"))
    use_candles = bool(cfg.get("use_candles"))
    use_range = bool(cfg.get("use_range"))

    if use_trend:
        if trend == "UP":
            over_score += 2
            over_modules.add("trend")
            reasons.append("Trend aligned UP (EMA50 > EMA200, price > EMA200)")
        elif trend == "DOWN":
            under_score += 2
            under_modules.add("trend")
            reasons.append("Trend aligned DOWN (EMA50 < EMA200, price < EMA200)")
        elif range_mode:
            reasons.append("Trend: EMA chop, range structure in play")
        else:
            reasons.append("Trend filter: chop / no clear EMA bias")

    if use_sr:
        if touch_support:
            over_score += 2
            over_modules.add("sr")
            reasons.append("Price near support zone")
        if touch_res:
            under_score += 2
            under_modules.add("sr")
            reasons.append("Price near resistance zone")

    if use_rsi and rsi_val is not None:
        if rsi_val < 30:
            over_score += 2
            over_modules.add("rsi")
            reasons.append("RSI oversold (<30) — strong OVER bias")
        elif rsi_val < 40:
            over_score += 1
            over_modules.add("rsi")
            reasons.append("RSI <40 — bullish bias")
        elif rsi_val > 70:
            under_score += 2
            under_modules.add("rsi")
            reasons.append("RSI overbought (>70) — strong UNDER bias")
        elif rsi_val > 60:
            under_score += 1
            under_modules.add("rsi")
            reasons.append("RSI >60 — bearish bias")

    if use_candles:
        if candle_bull or candle_pin_bull or candle_doji_support:
            over_score += 2
            over_modules.add("candle")
            if candle_bull:
                reasons.append("Bullish engulfing — OVER confirmation")
            elif candle_pin_bull:
                reasons.append("Bullish pin / rejection — reversal bias")
            else:
                reasons.append("Doji near support — possible reversal")
        if candle_bear or candle_pin_bear or candle_doji_res:
            under_score += 2
            under_modules.add("candle")
            if candle_bear:
                reasons.append("Bearish engulfing — UNDER confirmation")
            elif candle_pin_bear:
                reasons.append("Bearish pin / rejection — reversal bias")
            else:
                reasons.append("Doji near resistance — possible reversal")

    if use_range and range_mode:
        reasons.append(f"Range mode detected (width ~{width_pct:.2f}%)")
        if touch_support:
            over_score += 2
            over_modules.add("range")
            reasons.append("Range: support bounce context")
        if touch_res:
            under_score += 2
            under_modules.add("range")
            reasons.append("Range: resistance rejection context")

    # Hard chop veto when trend filter on and no clean trend (unless range context dominates)
    if use_trend and trend == "CHOP" and not range_mode:
        return {
            "confluence_enabled": True,
            "signal": "NONE",
            "confidence": 0.0,
            "reasons": reasons + ["Veto: chop regime — stand aside (trend filter)"],
            "marketMode": market_mode,
            "entry_allowed": False,
            "over_score": round(over_score, 2),
            "under_score": round(under_score, 2),
            "confirmations": 0,
        }

    min_score = float(cfg.get("min_score", 5))
    min_conf = int(cfg.get("min_confirmations", 2))

    active_score = over_score if base_side == "OVER" else under_score
    active_modules = over_modules if base_side == "OVER" else under_modules

    # Candle confirmation rule: at least one candle signal for the active side when candles enabled
    candle_ok = (not use_candles) or (
        (base_side == "OVER" and (candle_bull or candle_pin_bull or candle_doji_support))
        or (base_side == "UNDER" and (candle_bear or candle_pin_bear or candle_doji_res))
    )
    if use_candles and not candle_ok:
        reasons.append("Veto: no candle confirmation at zone for chosen side")
        entry_allowed = False
        conf = 0.0
        sig: Side | Literal["NONE"] = "NONE"
    else:
        confirmations = len(active_modules)
        entry_allowed = active_score >= min_score and confirmations >= min_conf
        conf = min(100.0, (active_score / 8.0) * 100.0)
        sig = base_side if entry_allowed else "NONE"

    if entry_allowed:
        reasons.append(f"TRADE ALLOWED: {base_side} (score={active_score:.1f}, modules={len(active_modules)})")
    else:
        reasons.append(
            f"No entry: need score>={min_score} & {min_conf}+ modules "
            f"(got score={active_score:.1f}, modules={len(active_modules)})"
        )

    return {
        "confluence_enabled": True,
        "signal": sig,
        "confidence": round(conf, 1),
        "reasons": reasons,
        "marketMode": market_mode,
        "entry_allowed": bool(entry_allowed),
        "over_score": round(over_score, 2),
        "under_score": round(under_score, 2),
        "confirmations": len(active_modules),
        "base_side": base_side,
    }
