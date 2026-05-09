"""Shared Deriv auth helpers for legacy WS tokens and PAT-based OTP WS."""

from __future__ import annotations

import json
import re
import time
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

import websocket

import config as app_config


def is_pat_token(token: str | None) -> bool:
    """True if token is a Trading API Personal Access Token (OTP websocket path)."""
    return str(token or "").strip().startswith("pat_")


_PAT_ACCOUNTS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_PAT_ACCOUNTS_LOCK = Lock()
_PAT_ACCOUNTS_TTL_SEC = 300.0
# Serialize GET /options/accounts per token so concurrent requests do not stampede.
_PAT_LIST_FETCH_LOCKS: dict[str, Lock] = {}
_PAT_LIST_FETCH_GUARD = Lock()

# PAT OTP is expensive and rate-limited; cache ws URL per token+account.
_PAT_OTP_CACHE: dict[str, tuple[float, str, str]] = {}
_PAT_OTP_LOCK = Lock()
_PAT_OTP_TTL_SEC = 120.0
_PAT_OTP_STALE_MAX_SEC = 180.0
_PAT_WS_CONNECT_COOLDOWN_UNTIL: dict[str, float] = {}
_PAT_OTP_REST_COOLDOWN_UNTIL: dict[str, float] = {}


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
    for attempt in range(1, 6):
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
            # Retry transient upstream failures and rate limits (bounded backoff).
            if exc.code >= 500 and attempt < 4:
                last_err = RuntimeError(f"Deriv REST {method} {url} failed ({exc.code}): {err_body}")
                time.sleep(0.9 * attempt)
                continue
            if exc.code == 429 and attempt < 5:
                last_err = RuntimeError(f"Deriv REST {method} {url} failed ({exc.code}): {err_body}")
                delay = min(2.0 * attempt, 12.0)
                try:
                    parsed = json.loads(err_body)
                    ra = int(parsed.get("retry_after") or 0)
                    if ra > 0:
                        delay = min(float(ra), 15.0)
                except Exception:
                    pass
                time.sleep(delay)
                continue
            raise RuntimeError(f"Deriv REST {method} {url} failed ({exc.code}): {err_body}") from exc
        except URLError as exc:
            last_err = RuntimeError(f"Deriv REST {method} {url} failed: {exc.reason}")
            if attempt < 6:
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


def _pat_list_fetch_lock(tok: str) -> Lock:
    with _PAT_LIST_FETCH_GUARD:
        lk = _PAT_LIST_FETCH_LOCKS.get(tok)
        if lk is None:
            lk = Lock()
            _PAT_LIST_FETCH_LOCKS[tok] = lk
        return lk


def list_pat_accounts(token: str, *, force_refresh: bool = False) -> list[dict]:
    tok = str(token or "").strip()
    with _pat_list_fetch_lock(tok):
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
                _PAT_ACCOUNTS_CACHE[tok] = (time.monotonic(), list(mapped))
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


def _pat_otp_cache_key(token: str, account_id: str) -> str:
    return f"{token}\x00{account_id}"


def _extract_retry_after_seconds(text: str, default: int = 30) -> int:
    m = re.search(r"retry-after['\"]?\s*:\s*['\"]?(\d+)", text, flags=re.IGNORECASE)
    if not m:
        return int(default)
    try:
        return max(1, int(m.group(1)))
    except Exception:
        return int(default)


def get_pat_ws_url(token: str, account_id: str | None = None) -> tuple[str, str]:
    tok = str(token or "").strip()
    acct = (account_id or "").strip() or get_pat_account_id(tok)
    key = _pat_otp_cache_key(tok, acct)
    now = time.monotonic()
    with _PAT_OTP_LOCK:
        cached = _PAT_OTP_CACHE.get(key)
        rest_blocked_until = float(_PAT_OTP_REST_COOLDOWN_UNTIL.get(key, 0.0))
    if cached:
        age = now - cached[0]
        if age <= _PAT_OTP_TTL_SEC:
            return cached[1], cached[2]
    if rest_blocked_until > now:
        wait_sec = int(rest_blocked_until - now)
        if cached and (now - cached[0]) <= _PAT_OTP_STALE_MAX_SEC:
            return cached[1], cached[2]
        raise RuntimeError(f"PAT OTP cooldown active ({wait_sec}s remaining)")

    def _parse_ws_url(payload: dict) -> str:
        data = payload.get("data") if isinstance(payload, dict) else None
        ws_url = ""
        if isinstance(data, dict):
            ws_url = str(data.get("url") or "").strip()
        if not ws_url:
            ws_url = str(payload.get("url") or "").strip() if isinstance(payload, dict) else ""
        return ws_url

    try:
        payload = _rest_json(
            "POST",
            f"https://api.derivws.com/trading/v1/options/accounts/{acct}/otp",
            token=tok,
        )
        ws_url = _parse_ws_url(payload)
        if not ws_url:
            raise RuntimeError(f"OTP response missing ws url: {payload}")
        with _PAT_OTP_LOCK:
            _PAT_OTP_CACHE[key] = (time.monotonic(), ws_url, acct)
        return ws_url, acct
    except RuntimeError as exc:
        if "(429)" in str(exc) or "429" in str(exc):
            retry_after = _extract_retry_after_seconds(str(exc), default=30)
            with _PAT_OTP_LOCK:
                _PAT_OTP_REST_COOLDOWN_UNTIL[key] = time.monotonic() + min(retry_after, 7200)
            with _PAT_OTP_LOCK:
                stale = _PAT_OTP_CACHE.get(key)
            if stale and (now - stale[0]) <= _PAT_OTP_STALE_MAX_SEC:
                return stale[1], stale[2]
        raise


def open_ws_for_token(
    token: str, timeout: int = 20, account_id: str | None = None
) -> tuple[websocket.WebSocket, bool, str | None]:
    """Return (ws, requires_authorize, account_hint)."""
    tok = str(token or "").strip()
    if is_pat_token(tok):
        ws_url, acct = get_pat_ws_url(tok, account_id=account_id)
        key = _pat_otp_cache_key(tok, acct)

        def _connect_once(url: str) -> websocket.WebSocket:
            now = time.monotonic()
            with _PAT_OTP_LOCK:
                blocked_until = float(_PAT_WS_CONNECT_COOLDOWN_UNTIL.get(key, 0.0))
            if blocked_until > now:
                wait_sec = int(blocked_until - now)
                raise RuntimeError(f"PAT WebSocket connect cooldown active ({wait_sec}s remaining)")
            return websocket.create_connection(url, timeout=timeout)

        try:
            return _connect_once(ws_url), False, acct
        except websocket.WebSocketBadStatusException as exc:
            msg = str(exc)
            if "429" in msg or "1015" in msg:
                retry_after = _extract_retry_after_seconds(msg, default=30)
                with _PAT_OTP_LOCK:
                    _PAT_WS_CONNECT_COOLDOWN_UNTIL[key] = time.monotonic() + min(retry_after, 7200)
                raise RuntimeError(f"PAT WebSocket rate-limited (retry_after={retry_after}s)") from exc

            # OTP URLs can expire earlier than cache TTL. If Deriv returns 401/invalid OTP
            # during the WS handshake, purge OTP cache and retry once with a fresh OTP URL.
            lower_msg = msg.lower()
            otp_expired = (
                "401" in msg
                or "invalid or expired otp" in lower_msg
                or "invalid otp" in lower_msg
                or "expired otp" in lower_msg
            )
            if otp_expired:
                with _PAT_OTP_LOCK:
                    _PAT_OTP_CACHE.pop(key, None)
                    _PAT_OTP_REST_COOLDOWN_UNTIL.pop(key, None)
                fresh_url, fresh_acct = get_pat_ws_url(tok, account_id=acct)
                fresh_key = _pat_otp_cache_key(tok, fresh_acct)
                try:
                    return websocket.create_connection(fresh_url, timeout=timeout), False, fresh_acct
                except websocket.WebSocketBadStatusException as retry_exc:
                    retry_msg = str(retry_exc)
                    if "429" in retry_msg or "1015" in retry_msg:
                        retry_after = _extract_retry_after_seconds(retry_msg, default=30)
                        with _PAT_OTP_LOCK:
                            _PAT_WS_CONNECT_COOLDOWN_UNTIL[fresh_key] = time.monotonic() + min(retry_after, 7200)
                        raise RuntimeError(f"PAT WebSocket rate-limited (retry_after={retry_after}s)") from retry_exc
                    raise RuntimeError(f"PAT WebSocket handshake failed after OTP refresh: {retry_msg}") from retry_exc

            raise
    return websocket.create_connection(get_legacy_ws_url(), timeout=timeout), True, None
