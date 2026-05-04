"""Shared Deriv auth helpers for legacy WS tokens and PAT-based OTP WS."""

from __future__ import annotations

import json
import time
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

import websocket

import config as app_config

_PAT_ACCOUNTS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_PAT_ACCOUNTS_LOCK = Lock()
_PAT_ACCOUNTS_TTL_SEC = 20.0


def get_deriv_app_id() -> str:
    return str(
        getattr(
            app_config,
            "DERIV_APP_ID",
            getattr(
                app_config,
                "DERIV_OAUTH_CLIENT_ID",
                getattr(app_config, "DERIV_WS_APP_ID", "1089"),
            ),
        )
        or "1089"
    ).strip() or "1089"


def get_legacy_ws_url() -> str:
    aid = str(getattr(app_config, "DERIV_WS_APP_ID", "1089") or "1089").strip() or "1089"
    return f"wss://ws.derivws.com/websockets/v3?app_id={aid}"


def _rest_json(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    body = b""
    headers = {
        "Accept": "application/json",
        "Deriv-App-ID": get_deriv_app_id(),
        "Authorization": f"Bearer {token}",
    }
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    last_err: Exception | None = None
    for attempt in range(1, 4):
        req = UrlRequest(url=url, data=body, method=method.upper(), headers=headers)
        try:
            with urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
            try:
                return json.loads(raw)
            except Exception as exc:
                raise RuntimeError(f"Deriv REST {method} {url} non-JSON response: {raw[:180]}") from exc
        except HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            # Retry transient upstream failures only.
            if exc.code >= 500 and attempt < 3:
                last_err = RuntimeError(f"Deriv REST {method} {url} failed ({exc.code}): {err_body}")
                time.sleep(0.9 * attempt)
                continue
            raise RuntimeError(f"Deriv REST {method} {url} failed ({exc.code}): {err_body}") from exc
        except URLError as exc:
            last_err = RuntimeError(f"Deriv REST {method} {url} failed: {exc.reason}")
            if attempt < 3:
                time.sleep(0.9 * attempt)
                continue
            raise last_err from exc
    if last_err:
        raise last_err
    raise RuntimeError(f"Deriv REST {method} {url} failed")


def _extract_accounts(payload: dict) -> list[dict]:
    data = payload.get("data")
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        nested = data.get("accounts")
        if isinstance(nested, list):
            return [x for x in nested if isinstance(x, dict)]
    return []


def _map_pat_accounts(payload: dict) -> list[dict]:
    rows = _extract_accounts(payload)
    out: list[dict] = []
    for row in rows:
        account_id = str(row.get("account_id") or row.get("id") or "").strip()
        if not account_id:
            continue
        account_type = str(row.get("account_type") or "").strip().lower()
        account_upper = account_id.upper()
        if account_upper.startswith("DOT"):
            kind = "demo"
        elif account_upper.startswith("ROT"):
            kind = "real"
        elif any(tag in account_type for tag in ("demo", "virtual", "practice")):
            kind = "demo"
        else:
            kind = "real"
        currency = str(row.get("currency") or "USD").strip() or "USD"
        try:
            balance = float(row.get("balance", 0.0))
        except Exception:
            balance = 0.0
        out.append(
            {
                "account": account_id,
                "account_id": account_id,
                "account_type": account_type or kind,
                "kind": kind,
                "currency": currency,
                "balance": round(balance, 2),
            }
        )
    return out


def list_pat_accounts(token: str, *, force_refresh: bool = False) -> list[dict]:
    tok = str(token or "").strip()
    now = time.monotonic()
    if not force_refresh:
        with _PAT_ACCOUNTS_LOCK:
            cached = _PAT_ACCOUNTS_CACHE.get(tok)
        if cached and (now - cached[0]) <= _PAT_ACCOUNTS_TTL_SEC:
            return list(cached[1])
    try:
        payload = _rest_json("GET", "https://api.derivws.com/trading/v1/options/accounts", token=tok)
        mapped = _map_pat_accounts(payload)
        with _PAT_ACCOUNTS_LOCK:
            _PAT_ACCOUNTS_CACHE[tok] = (now, list(mapped))
        return mapped
    except Exception as exc:
        # If Deriv rate-limits account list calls, use stale cache.
        if "(429)" in str(exc):
            with _PAT_ACCOUNTS_LOCK:
                cached = _PAT_ACCOUNTS_CACHE.get(tok)
            if cached:
                return list(cached[1])
        raise


def get_pat_account_id(token: str) -> str:
    accounts = list_pat_accounts(token)
    if not accounts:
        raise RuntimeError("No options accounts found for PAT token")
    first = accounts[0]
    account_id = str(first.get("account_id") or "").strip()
    if not account_id:
        raise RuntimeError("Options account response missing account_id")
    return account_id


def get_pat_ws_url(token: str, account_id: str | None = None) -> tuple[str, str]:
    acct = (account_id or "").strip() or get_pat_account_id(token)
    payload = _rest_json(
        "POST",
        f"https://api.derivws.com/trading/v1/options/accounts/{acct}/otp",
        token=token,
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    ws_url = ""
    if isinstance(data, dict):
        ws_url = str(data.get("url") or "").strip()
    if not ws_url:
        ws_url = str(payload.get("url") or "").strip() if isinstance(payload, dict) else ""
    if not ws_url:
        raise RuntimeError(f"OTP response missing ws url: {payload}")
    return ws_url, acct


def open_ws_for_token(
    token: str, timeout: int = 20, account_id: str | None = None
) -> tuple[websocket.WebSocket, bool, str | None]:
    """Return (ws, requires_authorize, account_hint)."""
    tok = str(token or "").strip()
    if tok.startswith("pat_"):
        ws_url, acct = get_pat_ws_url(tok, account_id=account_id)
        return websocket.create_connection(ws_url, timeout=timeout), False, acct
    return websocket.create_connection(get_legacy_ws_url(), timeout=timeout), True, None
