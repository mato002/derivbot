"""Market data + indicators (RSI, MA) for analysis / charts."""

from __future__ import annotations

import json
import logging
import time as time_module
from threading import Lock
from typing import Any, Dict, List, Sequence

import websocket

from modules.deriv_auth import get_legacy_ws_url, is_pat_token, open_ws_for_token

logger = logging.getLogger(__name__)
_MARKET_CACHE: dict[str, tuple[float, Dict[str, Any]]] = {}
_MARKET_CACHE_LOCK = Lock()
_MARKET_CACHE_TTL_SEC = 120.0

# PAT tick history needs the OTP websocket; cache responses so charts/confluence do not
# open a new PAT connection every poll (that exhausts Deriv connect limits).
_PAT_TICKS_CACHE: dict[str, tuple[float, List[Dict[str, Any]]]] = {}
_PAT_TICKS_CACHE_LOCK = Lock()
_PAT_TICKS_CACHE_TTL_SEC = 180.0


def _pat_ticks_cache_key(api_token: str, symbol: str, count: int, account_id: str | None) -> str:
    tok = str(api_token or "").strip()
    return f"{tok}\x00{symbol}\x00{count}\x00{(account_id or '').strip()}"


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


def _ticks_history_request(symbol: str, count: int) -> Dict[str, Any]:
    return {
        "ticks_history": symbol,
        "style": "ticks",
        "count": min(max(count, 10), 5000),
        "end": "latest",
    }


def _parse_ticks_history_response(resp: Dict[str, Any]) -> List[Dict[str, Any]]:
    if "error" in resp:
        raise RuntimeError(resp["error"].get("message", "ticks_history failed"))
    history = resp.get("history", {}) or {}
    prices = history.get("prices", []) or []
    times = history.get("times", []) or []
    ticks: List[Dict[str, Any]] = []
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
    return ticks


def _recv_ticks_history(ws: websocket.WebSocket, symbol: str, count: int) -> List[Dict[str, Any]]:
    ws.send(json.dumps(_ticks_history_request(symbol, count)))
    resp: Dict[str, Any] = {}
    for _ in range(50):
        raw = ws.recv()
        if not raw:
            continue
        resp = json.loads(raw)
        if resp.get("msg_type") == "history" or "history" in resp:
            return _parse_ticks_history_response(resp)
        if "error" in resp:
            return _parse_ticks_history_response(resp)
    return _parse_ticks_history_response(resp)


def fetch_ticks_history_public(symbol: str, count: int = 120) -> List[Dict[str, Any]]:
    """Read-only tick history on legacy WS (no token). Used for charts when authorize fails."""
    ws = websocket.create_connection(get_legacy_ws_url(), timeout=20)
    try:
        ticks = _recv_ticks_history(ws, symbol, count)
        logger.info("Fetched %s public ticks for %s", len(ticks), symbol)
        return ticks
    finally:
        try:
            ws.close()
        except Exception:
            pass


def _authorize_failed_use_public(msg: str) -> bool:
    m = str(msg or "").lower()
    return (
        "input validation failed" in m
        or "authorize failed" in m
        or "invalid token" in m
        or "please log in" in m
    )


def fetch_ticks_history(
    api_token: str,
    symbol: str,
    count: int = 120,
    *,
    account_id: str | None = None,
    bypass_cache: bool = False,
) -> List[Dict[str, Any]]:
    """Pull recent ticks via Deriv WebSocket ticks_history (PAT OTP, legacy authorize, or public fallback)."""
    tok = str(api_token or "").strip()
    if not tok:
        return fetch_ticks_history_public(symbol, count)

    pat_key: str | None = None
    if is_pat_token(tok):
        pat_key = _pat_ticks_cache_key(tok, symbol, count, account_id)
        if not bypass_cache:
            with _PAT_TICKS_CACHE_LOCK:
                cached = _PAT_TICKS_CACHE.get(pat_key)
                if cached and (time_module.monotonic() - cached[0]) <= _PAT_TICKS_CACHE_TTL_SEC:
                    return list(cached[1])

    try:
        ws, requires_authorize, _account_hint = open_ws_for_token(
            tok, timeout=20, account_id=account_id
        )
    except Exception as exc:
        if _authorize_failed_use_public(str(exc)):
            logger.warning("WS open failed (%s); using public ticks for %s", exc, symbol)
            return fetch_ticks_history_public(symbol, count)
        raise

    ticks: List[Dict[str, Any]] = []
    try:
        if requires_authorize:
            ws.send(json.dumps({"authorize": tok}))
            auth = json.loads(ws.recv())
            if "error" in auth:
                msg = str(auth["error"].get("message", "authorize failed"))
                if _authorize_failed_use_public(msg):
                    logger.warning(
                        "Legacy authorize rejected (%s). OAuth2 tokens need a PAT (pat_…) "
                        "or legacy acct/token login. Using public tick history for charts.",
                        msg,
                    )
                    return fetch_ticks_history_public(symbol, count)
                raise RuntimeError(msg)

        ticks = _recv_ticks_history(ws, symbol, count)
        logger.info("Fetched %s ticks for %s", len(ticks), symbol)
    finally:
        try:
            ws.close()
        except Exception:
            pass

    if pat_key is not None and ticks:
        with _PAT_TICKS_CACHE_LOCK:
            _PAT_TICKS_CACHE[pat_key] = (time_module.monotonic(), list(ticks))
    return ticks


def build_market_payload(
    api_token: str,
    symbol: str,
    timeframe: str = "tick",
    *,
    account_id: str | None = None,
    fresh: bool = False,
) -> Dict[str, Any]:
    """
    timeframe: reserved for future OHLC aggregation; currently tick-based series.
    """
    raw = fetch_ticks_history(
        api_token, symbol, count=150, account_id=account_id, bypass_cache=fresh
    )
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
    payload = {
        "symbol": symbol,
        "timeframe": timeframe,
        "last_price": last.get("price"),
        "last_rsi14": last.get("rsi14"),
        "last_ma20": last.get("ma20"),
        "points": series[-80:],  # trim for API payload
    }
    cache_key = f"{symbol}::{timeframe}::{(account_id or '').strip() or '-'}"
    with _MARKET_CACHE_LOCK:
        _MARKET_CACHE[cache_key] = (time_module.monotonic(), payload)
    return payload


def get_cached_market_payload(symbol: str, timeframe: str = "tick", *, account_id: str | None = None) -> Dict[str, Any] | None:
    cache_key = f"{symbol}::{timeframe}::{(account_id or '').strip() or '-'}"
    with _MARKET_CACHE_LOCK:
        cached = _MARKET_CACHE.get(cache_key)
    if not cached:
        return None
    age = time_module.monotonic() - cached[0]
    if age > _MARKET_CACHE_TTL_SEC:
        return None
    return dict(cached[1])
