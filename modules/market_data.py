"""Market data + indicators (RSI, MA) for analysis / charts."""

from __future__ import annotations

import json
import logging
import time as time_module
from typing import Any, Dict, List, Sequence

import websocket

from modules.deriv_auth import open_ws_for_token

logger = logging.getLogger(__name__)


def _sma(values: Sequence[float], period: int) -> List[float | None]:
    out: List[float | None] = []
    for i in range(len(values)):
        if i + 1 < period:
            out.append(None)
        else:
            window = values[i + 1 - period : i + 1]
            out.append(sum(window) / period)
    return out


def _rsi(closes: Sequence[float], period: int = 14) -> List[float | None]:
    if len(closes) < period + 1:
        return [None] * len(closes)
    out: List[float | None] = [None] * len(closes)
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


def fetch_ticks_history(api_token: str, symbol: str, count: int = 120) -> List[Dict[str, Any]]:
    """Pull recent ticks via Deriv WebSocket ticks_history."""
    ws, requires_authorize, _account_hint = open_ws_for_token(api_token, timeout=20)
    ticks: List[Dict[str, Any]] = []
    try:
        if requires_authorize:
            ws.send(json.dumps({"authorize": api_token}))
            auth = json.loads(ws.recv())
            if "error" in auth:
                raise RuntimeError(auth["error"].get("message", "authorize failed"))

        req = {
            "ticks_history": symbol,
            "style": "ticks",
            "count": min(max(count, 10), 5000),
            "end": "latest",
        }
        ws.send(json.dumps(req))
        resp = {}
        for _ in range(50):
            raw = ws.recv()
            if not raw:
                continue
            resp = json.loads(raw)
            if resp.get("msg_type") == "history" or "history" in resp:
                break
            if "error" in resp:
                raise RuntimeError(resp["error"].get("message", "ticks_history failed"))
        if "error" in resp:
            raise RuntimeError(resp["error"].get("message", "ticks_history failed"))
        history = resp.get("history", {}) or {}
        prices = history.get("prices", []) or []
        times = history.get("times", []) or []
        if not prices and isinstance(history.get("ticks"), list):
            for row in history["ticks"]:
                if not isinstance(row, dict):
                    continue
                q = row.get("quote")
                if q is None:
                    q = row.get("price")
                if q is None:
                    continue
                ticks.append({"epoch": row.get("epoch"), "price": float(q)})
        else:
            for i, price in enumerate(prices):
                ts = times[i] if i < len(times) else None
                ticks.append({"epoch": ts, "price": float(price)})
        logger.info("Fetched %s ticks for %s", len(ticks), symbol)
    finally:
        try:
            ws.close()
        except Exception:
            pass
    return ticks


def build_market_payload(api_token: str, symbol: str, timeframe: str = "tick") -> Dict[str, Any]:
    """
    timeframe: reserved for future OHLC aggregation; currently tick-based series.
    """
    raw = fetch_ticks_history(api_token, symbol, count=150)
    prices = [t["price"] for t in raw]
    ma20 = _sma(prices, 20)
    rsi14 = _rsi(prices, 14)
    series = []
    last_chart_time: int | None = None
    for i, t in enumerate(raw):
        ts = t.get("epoch")
        chart_time: int | None
        if ts is not None:
            chart_time = int(ts)
            if last_chart_time is not None and chart_time <= last_chart_time:
                chart_time = last_chart_time + 1
            last_chart_time = chart_time
        else:
            if last_chart_time is None:
                last_chart_time = int(time_module.time()) - max(len(raw), 1)
            last_chart_time += 1
            chart_time = last_chart_time
        series.append(
            {
                "time": chart_time,
                "price": t["price"],
                "ma20": ma20[i],
                "rsi14": rsi14[i],
            }
        )
    last = series[-1] if series else {}
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "last_price": last.get("price"),
        "last_rsi14": last.get("rsi14"),
        "last_ma20": last.get("ma20"),
        "points": series[-80:],  # trim for API payload
    }
