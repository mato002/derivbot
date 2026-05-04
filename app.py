"""Deriv multi-module trading platform — FastAPI entry."""

from __future__ import annotations

import base64
import html
import json
import hashlib
import logging
import secrets
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request as UrlRequest, urlopen

from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware
from itsdangerous import BadSignature, URLSafeSerializer

import config as app_config
from config import SESSION_SECRET
from modules import copy_trading, market_data, strategy_engine
from modules.deriv_auth import list_pat_accounts, open_ws_for_token
from modules.bot_engine import DerivBot

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("derivbot")
DERIV_OAUTH_CLIENT_ID = str(
    getattr(app_config, "DERIV_OAUTH_CLIENT_ID", getattr(app_config, "DERIV_APP_ID", ""))
).strip()
CONFIG_API_TOKEN = str(getattr(app_config, "API_TOKEN", "") or "").strip()
_oauth_state_signer = URLSafeSerializer(SESSION_SECRET, salt="deriv-oauth-state")

app = FastAPI(title="Deriv Trading Platform")
templates = Jinja2Templates(directory="templates")
bot = DerivBot()
app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    same_site="lax",
    https_only=False,
)
app.mount("/static", StaticFiles(directory="static"), name="static")


def _page(request: Request, name: str) -> HTMLResponse:
    return templates.TemplateResponse(request=request, name=name)


@app.get("/", response_class=HTMLResponse)
def home(request: Request) -> HTMLResponse:
    return _page(request, "dashboard.html")


@app.get("/analysis", response_class=HTMLResponse)
def analysis_page(request: Request) -> HTMLResponse:
    return _page(request, "analysis.html")


@app.get("/tradingview", response_class=HTMLResponse)
def tradingview_page(request: Request) -> HTMLResponse:
    return _page(request, "tradingview.html")


@app.get("/builder", response_class=HTMLResponse)
def builder(request: Request) -> HTMLResponse:
    return _page(request, "builder.html")


@app.get("/copy-trading", response_class=HTMLResponse)
def copy_trading_page(request: Request) -> HTMLResponse:
    return _page(request, "copy.html")


@app.get("/manual-trader", response_class=HTMLResponse)
def manual_trader_page(request: Request) -> HTMLResponse:
    return _page(request, "manual_trader.html")


@app.get("/strategies", response_class=HTMLResponse)
def strategies_page(request: Request) -> HTMLResponse:
    return _page(request, "strategies.html")


# --- Deriv OAuth ---


def _pkce_code_verifier() -> str:
    return secrets.token_urlsafe(64)


def _pkce_code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _deriv_oauth_redirect_uri(request: Request) -> str:
    explicit = getattr(app_config, "DERIV_OAUTH_REDIRECT_URI", "").strip()
    if explicit:
        return explicit
    pub = getattr(app_config, "DERIV_PUBLIC_URL", "").strip()
    if pub:
        return f"{pub.rstrip('/')}/auth/deriv/callback"
    return str(request.url_for("deriv_callback"))


def _build_deriv_auth_url(
    callback: str,
    auth_flow: str,
    *,
    oauth_nonce: str | None = None,
    oauth_verifier: str | None = None,
) -> str:
    """Build Deriv auth URL for legacy or OAuth2 flow."""
    auth_flow = (auth_flow or "legacy").strip().lower()
    if auth_flow == "legacy":
        legacy_app_id = str(
            getattr(app_config, "DERIV_LEGACY_OAUTH_APP_ID", getattr(app_config, "DERIV_WS_APP_ID", "1089"))
            or "1089"
        ).strip() or "1089"
        prompt_mode = str(getattr(app_config, "DERIV_AUTH_PROMPT", "consent") or "").strip().lower()
        prompt_payload: dict[str, str] = {}
        if prompt_mode in {"consent", "login", "none"}:
            prompt_payload["prompt"] = prompt_mode
        state = secrets.token_urlsafe(16)
        legacy_login_base = str(
            getattr(app_config, "DERIV_LEGACY_LOGIN_BASE", "https://home.deriv.com/dashboard/login")
            or "https://home.deriv.com/dashboard/login"
        ).strip()
        legacy_params: dict[str, str] = {
            "app_id": legacy_app_id,
            "redirect_uri": callback,
            "state": state,
            **prompt_payload,
        }
        oauth_url = legacy_login_base + "?" + urlencode(legacy_params, quote_via=quote)
        log.info(
            "Deriv legacy OAuth: redirecting (app_id=%s, host=%s, base=%s)",
            legacy_app_id,
            callback.split("/")[2] if "://" in callback else callback,
            legacy_login_base,
        )
        return oauth_url

    nonce = str(oauth_nonce or "")
    verifier = str(oauth_verifier or "")
    if not nonce or not verifier:
        raise RuntimeError("OAuth2 flow requires nonce and verifier")
    challenge = _pkce_code_challenge(verifier)
    scope = str(getattr(app_config, "DERIV_OAUTH_SCOPE", "trade account_manage")).strip()
    params = {
        "response_type": "code",
        "client_id": DERIV_OAUTH_CLIENT_ID,
        "redirect_uri": callback,
        "scope": scope,
        "state": _oauth_state_signer.dumps({"n": nonce, "v": verifier, "ts": int(time.time())}),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return "https://auth.deriv.com/oauth2/auth?" + urlencode(params, quote_via=quote)


@app.get("/auth/deriv/login-url")
def deriv_login_url(request: Request) -> dict:
    callback = _deriv_oauth_redirect_uri(request)
    auth_flow = str(getattr(app_config, "DERIV_AUTH_FLOW", "legacy")).strip().lower()
    if auth_flow == "legacy":
        oauth_url = _build_deriv_auth_url(callback, auth_flow)
    else:
        nonce = secrets.token_urlsafe(24)
        verifier = _pkce_code_verifier()
        oauth_url = _build_deriv_auth_url(callback, auth_flow, oauth_nonce=nonce, oauth_verifier=verifier)
    return {"success": True, "flow": auth_flow, "callback": callback, "url": oauth_url}


@app.get("/auth/deriv/login")
def deriv_login(request: Request) -> RedirectResponse:
    """Start Deriv login. Default flow is legacy acct/token callback for WS trading."""
    callback = _deriv_oauth_redirect_uri(request)
    auth_flow = str(getattr(app_config, "DERIV_AUTH_FLOW", "legacy")).strip().lower()
    request.session["deriv_manual_logout"] = False
    if auth_flow == "legacy":
        oauth_url = _build_deriv_auth_url(callback, auth_flow)
    else:
        nonce = secrets.token_urlsafe(24)
        verifier = _pkce_code_verifier()
        request.session["deriv_oauth_state"] = nonce
        request.session["deriv_oauth_verifier"] = verifier
        request.session["deriv_oauth_redirect_uri"] = callback
        request.session.pop("deriv_oauth_last_code", None)
        oauth_url = _build_deriv_auth_url(callback, auth_flow, oauth_nonce=nonce, oauth_verifier=verifier)
    return RedirectResponse(url=oauth_url)


def _oauth2_exchange_code(code: str, redirect_uri: str, code_verifier: str) -> dict[str, Any]:
    payload = urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": DERIV_OAUTH_CLIENT_ID,
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
        }
    ).encode("utf-8")
    req = UrlRequest(
        url="https://auth.deriv.com/oauth2/token",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            # Deriv/Cloudflare may block default Python urllib UA on OAuth token endpoint.
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        },
    )
    try:
        with urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OAuth token exchange failed ({exc.code}): {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"OAuth token exchange failed: {exc.reason}") from exc
    try:
        return json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"OAuth token response was not JSON: {raw[:140]}") from exc


def _login_with_token(request: Request, token: str) -> RedirectResponse:
    bot.set_api_token(token)
    snapshot = bot.fetch_authorized_balance()
    selected = {
        "account": snapshot.get("account") or "ACCOUNT",
        "token": token,
        "currency": snapshot.get("currency") or "USD",
    }
    request.session["deriv_accounts"] = [selected]
    request.session["deriv_account"] = selected
    request.session["deriv_manual_logout"] = False
    log.info("Deriv OAuth callback: logged in as %s", selected.get("account"))
    return RedirectResponse(url="/")


@app.get("/auth/deriv/callback", name="deriv_callback", response_model=None)
def deriv_callback(request: Request) -> RedirectResponse | HTMLResponse:
    params = request.query_params
    # Legacy first: oauth.deriv.com returns acct1/token1/... (WS-usable session tokens)
    accounts: list[dict] = []
    for idx in range(1, 10):
        account = params.get(f"acct{idx}")
        token = params.get(f"token{idx}")
        currency = params.get(f"cur{idx}") or params.get(f"curr{idx}")
        if account and token:
            accounts.append({"account": account, "token": token, "currency": currency or "USD"})

    if accounts:
        selected = accounts[0]
        request.session["deriv_accounts"] = accounts
        request.session["deriv_account"] = selected
        request.session["deriv_manual_logout"] = False
        bot.set_api_token(selected["token"])
        log.info("Deriv OAuth callback (legacy): logged in as %s", selected.get("account"))
        return RedirectResponse(url="/")

    # OAuth2 fallback: code+PKCE flow.
    code = params.get("code")
    if code:
        # Authorization codes are single-use; browser refresh on callback can trigger a second exchange attempt.
        last_code = str(request.session.get("deriv_oauth_last_code") or "")
        if last_code and last_code == code:
            return HTMLResponse(
                content=(
                    "<h2>OAuth callback already processed</h2>"
                    "<p>This authorization code was already used. Return to the app home.</p>"
                    "<p><a href=\"/\">Go to dashboard</a></p>"
                ),
                status_code=200,
            )
        state = params.get("state") or ""
        expected_nonce = str(request.session.get("deriv_oauth_state") or "")
        verifier = str(request.session.get("deriv_oauth_verifier") or "")
        started_redirect_uri = str(request.session.get("deriv_oauth_redirect_uri") or "")
        signed_nonce = ""
        signed_verifier = ""
        if state:
            try:
                payload = _oauth_state_signer.loads(state)
                signed_nonce = str(payload.get("n") or "")
                signed_verifier = str(payload.get("v") or "")
            except BadSignature:
                signed_nonce = ""
                signed_verifier = ""
        # single-use values
        request.session.pop("deriv_oauth_state", None)
        request.session.pop("deriv_oauth_verifier", None)
        if not verifier and signed_verifier:
            verifier = signed_verifier
        if expected_nonce and signed_nonce and expected_nonce != signed_nonce:
            return HTMLResponse(
                content="<h2>OAuth state mismatch</h2><p>Please retry Login with Deriv.</p>",
                status_code=400,
            )
        if not verifier:
            return HTMLResponse(
                content="<h2>OAuth verifier missing</h2><p>Please retry Login with Deriv.</p>",
                status_code=400,
            )
        try:
            redirect_uri = started_redirect_uri or _deriv_oauth_redirect_uri(request)
            token_payload = _oauth2_exchange_code(code, redirect_uri, verifier)
            request.session["deriv_oauth_last_code"] = code
            access_token = str(token_payload.get("access_token") or "").strip()
            if not access_token:
                raise RuntimeError(f"No access_token returned: {token_payload}")
            try:
                return _login_with_token(request, access_token)
            except Exception as auth_exc:
                raise RuntimeError(
                    "OAuth token received, but Deriv WebSocket authorize failed. "
                    "This usually means OAuth2 access_token is not usable as WS authorize token for this bot. "
                    "Use legacy flow with a numeric app_id for acct/token callback."
                ) from auth_exc
        except Exception as exc:
            log.exception("OAuth2 callback failed")
            return HTMLResponse(
                content=(
                    f"<h2>OAuth token exchange failed</h2><p>{html.escape(str(exc))}</p>"
                    "<p>Tip: set <code>DERIV_AUTH_FLOW = \"legacy\"</code> in <code>config.py</code> "
                    "for acct/token callback flow used by this bot.</p>"
                ),
                status_code=502,
            )

    err = params.get("error")
    desc = params.get("error_description") or ""
    keys = list(params.keys())
    log.warning("OAuth callback without acct/token params. keys=%s error=%s", keys, err or "none")
    expected = html.escape(str(request.url_for("deriv_callback")))
    err_html = html.escape(err or "") if err else ""
    desc_html = html.escape(desc) if desc else ""
    body = f"""
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Deriv login — finish setup</title>
<style>
  body {{ font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 16px;
    background:#fff; color:#1a2634; }}
  h1 {{ font-size: 1.25rem; }}
  code {{ background:#f2f3f5; padding: 2px 8px; border-radius: 6px; }}
  a {{ color: #1b52c0; font-weight: 600; }}
  .box {{ background:#f7f8fa; border:1px solid #e6e9ef; border-radius:12px; padding:16px; margin-top:16px; }}
</style></head><body>
  <h1>Deriv did not return a usable OAuth response</h1>
  <p>Expected either OAuth2 <code>code</code> (new apps) or legacy <code>acct1</code>/<code>token1</code> params.</p>
  <div class="box">
    <p><strong>Register this URL</strong> in Deriv → Dashboard → Applications → your app → <strong>OAuth redirect URL</strong>:</p>
    <p><code>{expected}</code></p>
    <p>Use the <strong>same host</strong> in the browser as in that URL (e.g. <code>127.0.0.1</code> vs <code>localhost</code>).</p>
    <p>Your <code>DERIV_OAUTH_CLIENT_ID</code> in <code>config.py</code> must be that same OAuth application's client ID.</p>
  </div>
"""
    if err:
        body += f"<p><strong>OAuth error:</strong> {err_html}</p><p>{desc_html}</p>"
    body += "<p><a href=\"/auth/deriv/login\">Try Login with Deriv again</a> &nbsp;·&nbsp; <a href=\"/\">Home</a></p></body></html>"
    return HTMLResponse(content=body, status_code=200)


def _loginid_kind(loginid: str) -> str:
    """Heuristic account kind from login/account id prefix."""
    u = (loginid or "").strip().upper()
    # Deriv PAT/options account ids often use DOT (demo) and ROT (real).
    if u.startswith("DOT"):
        return "demo"
    if u.startswith("ROT"):
        return "real"
    # Legacy virtual login ids commonly start with VR / VRTC.
    if u.startswith("VR") or "VRTC" in u:
        return "demo"
    return "real"


def _account_kind(a: dict[str, Any]) -> str:
    from_login = _loginid_kind(str(a.get("account") or a.get("account_id") or ""))
    # Prefix-based ids are the most reliable for this app's sessions.
    if str(a.get("account") or "").strip().upper().startswith(("DOT", "ROT")):
        return from_login
    explicit = str(a.get("kind") or a.get("account_type") or "").strip().lower()
    if explicit in {"demo", "real"}:
        return explicit
    return from_login


def _account_public(a: dict[str, Any]) -> dict[str, Any]:
    balance = a.get("balance")
    balance_num: float | None
    try:
        balance_num = round(float(balance), 2) if balance is not None else None
    except Exception:
        balance_num = None
    return {
        "account": a.get("account"),
        "account_id": a.get("account_id") or a.get("account"),
        "currency": a.get("currency") or "USD",
        "kind": _account_kind(a),
        "balance": balance_num,
    }


def _ensure_config_token_session(request: Request) -> dict[str, Any] | None:
    """Single-account mode fallback: bootstrap session from config API_TOKEN."""
    if bool(request.session.get("deriv_manual_logout")):
        return None
    if request.session.get("deriv_account"):
        return request.session.get("deriv_account")
    if not CONFIG_API_TOKEN:
        return None
    try:
        bot.set_api_token(CONFIG_API_TOKEN)
        if CONFIG_API_TOKEN.startswith("pat_"):
            pat_accounts = list_pat_accounts(CONFIG_API_TOKEN)
            if not pat_accounts:
                return None
            for row in pat_accounts:
                row["token"] = CONFIG_API_TOKEN
            selected = next((a for a in pat_accounts if str(a.get("kind")) == "demo"), pat_accounts[0])
            request.session["deriv_accounts"] = pat_accounts
            request.session["deriv_account"] = selected
            bot.set_account_context(str(selected.get("account_id") or selected.get("account") or ""))
            log.info("Configured PAT session bootstrap succeeded for %s", selected.get("account"))
            return selected
        snapshot = bot.fetch_authorized_balance()
    except Exception as exc:
        log.warning("Configured API_TOKEN session bootstrap failed: %s", exc)
        return None
    selected = {
        "account": snapshot.get("account") or "ACCOUNT",
        "token": CONFIG_API_TOKEN,
        "currency": snapshot.get("currency") or "USD",
    }
    request.session["deriv_accounts"] = [selected]
    request.session["deriv_account"] = selected
    bot.set_account_context(str(selected.get("account_id") or selected.get("account") or ""))
    log.info("Configured API_TOKEN session bootstrap succeeded for %s", selected.get("account"))
    return selected


def _refresh_pat_accounts_if_available(request: Request) -> None:
    """Refresh PAT account list in session so Demo/Real switching stays available."""
    if bool(request.session.get("deriv_manual_logout")):
        return
    current = request.session.get("deriv_account") or {}
    token = str(current.get("token") or "").strip()
    if not token:
        token = CONFIG_API_TOKEN
    if not str(token).startswith("pat_"):
        return
    try:
        pat_accounts = list_pat_accounts(token)
        if not pat_accounts:
            return
        for row in pat_accounts:
            row["token"] = token
        current_id = str(current.get("account_id") or current.get("account") or "").strip()
        selected = next(
            (
                a
                for a in pat_accounts
                if str(a.get("account_id") or a.get("account") or "").strip() == current_id
            ),
            None,
        )
        # Keep user's current selection if we cannot map it reliably during refresh.
        # This prevents unexpected flips (e.g. real -> demo) during frequent /auth/deriv/me polling.
        if selected is None and current:
            selected = dict(current)
            selected["token"] = token
            # Refresh visible metadata when we can infer a matching kind.
            current_kind = _account_kind(selected)
            kind_match = next((a for a in pat_accounts if str(a.get("kind")) == current_kind), None)
            if kind_match:
                selected["currency"] = kind_match.get("currency") or selected.get("currency") or "USD"
                selected["balance"] = kind_match.get("balance", selected.get("balance"))
        if selected is None:
            selected = next((a for a in pat_accounts if str(a.get("kind")) == "demo"), pat_accounts[0])
        request.session["deriv_accounts"] = pat_accounts
        request.session["deriv_account"] = selected
        bot.set_api_token(token)
        bot.set_account_context(str(selected.get("account_id") or selected.get("account") or ""))
    except Exception as exc:
        log.warning("PAT account refresh failed: %s", exc)


def _require_deriv_session(request: Request) -> dict[str, Any]:
    account = request.session.get("deriv_account") or _ensure_config_token_session(request)
    if not account:
        raise HTTPException(status_code=401, detail="Login with Deriv first (authorized token required).")
    return account


@app.get("/auth/deriv/me")
def deriv_me(request: Request) -> dict:
    account = request.session.get("deriv_account") or _ensure_config_token_session(request)
    _refresh_pat_accounts_if_available(request)
    account = request.session.get("deriv_account") or account
    raw_list = list(request.session.get("deriv_accounts") or [])
    accounts_pub = [_account_public(x) for x in raw_list if x.get("account")]
    has_demo = any(x["kind"] == "demo" for x in accounts_pub)
    has_real = any(x["kind"] == "real" for x in accounts_pub)
    pub_current = None
    if account and account.get("account"):
        pub_current = _account_public(account)
    return {
        "logged_in": bool(account),
        "account": pub_current,
        "accounts": accounts_pub,
        "has_demo": has_demo,
        "has_real": has_real,
    }


class SelectDerivAccountPayload(BaseModel):
    account: str = Field(..., description="Deriv login id from OAuth list, e.g. VRTC123 or CR456")


@app.post("/auth/deriv/select-account")
def deriv_select_account(request: Request, payload: SelectDerivAccountPayload) -> dict:
    wanted = payload.account.strip()
    raw_list = list(request.session.get("deriv_accounts") or [])
    for row in raw_list:
        if str(row.get("account", "")).strip() == wanted:
            request.session["deriv_account"] = row
            bot.set_api_token(row["token"])
            bot.set_account_context(str(row.get("account_id") or row.get("account") or ""))
            log.info("Switched active Deriv account to %s", wanted)
            return {"success": True, "account": _account_public(row)}
    _refresh_pat_accounts_if_available(request)
    raw_list = list(request.session.get("deriv_accounts") or [])
    for row in raw_list:
        if str(row.get("account", "")).strip() == wanted:
            request.session["deriv_account"] = row
            bot.set_api_token(row["token"])
            bot.set_account_context(str(row.get("account_id") or row.get("account") or ""))
            log.info("Switched active Deriv account to %s", wanted)
            return {"success": True, "account": _account_public(row)}
    raise HTTPException(
        status_code=404,
        detail="That account is not in your current session. Log in with Deriv again.",
    )


@app.get("/auth/deriv/balance")
def deriv_balance(request: Request) -> dict:
    account = _require_deriv_session(request)
    token = str(account.get("token") or "").strip() or CONFIG_API_TOKEN
    selected_id = str(account.get("account_id") or account.get("account") or "").strip()
    if token.startswith("pat_"):
        try:
            rows = list_pat_accounts(token)
            if rows:
                match = next(
                    (
                        r
                        for r in rows
                        if str(r.get("account_id") or r.get("account") or "").strip() == selected_id
                    ),
                    None,
                )
                if match is None and selected_id:
                    # Fallback for legacy login-id style matching if upstream shape differs.
                    match = next(
                        (
                            r
                            for r in rows
                            if str(r.get("account") or "").strip().upper() == selected_id.upper()
                        ),
                        None,
                    )
                if match:
                    # Keep session balances fresh for profile dropdown and next requests.
                    raw_list = list(request.session.get("deriv_accounts") or [])
                    for row in raw_list:
                        row_id = str(row.get("account_id") or row.get("account") or "").strip()
                        if row_id == selected_id:
                            row["balance"] = match.get("balance")
                            row["currency"] = match.get("currency") or row.get("currency") or "USD"
                            break
                    request.session["deriv_accounts"] = raw_list
                    selected = dict(request.session.get("deriv_account") or {})
                    if selected:
                        selected["balance"] = match.get("balance")
                        selected["currency"] = match.get("currency") or selected.get("currency") or "USD"
                        request.session["deriv_account"] = selected
                    return {
                        "success": True,
                        "balance": {
                            "account": match.get("account") or match.get("account_id") or selected_id,
                            "currency": match.get("currency") or "USD",
                            "balance": round(float(match.get("balance", 0.0)), 2),
                        },
                    }
        except Exception as exc:
            log.warning("PAT direct balance lookup failed, falling back to WS balance: %s", exc)
    if token:
        bot.set_api_token(token)
    bot.set_account_context(selected_id)
    try:
        snapshot = bot.fetch_authorized_balance()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to fetch balance: {exc}") from exc
    return {"success": True, "balance": snapshot}


class QuickStrategyValidationPayload(BaseModel):
    stake: float = Field(..., gt=0)


@app.post("/auth/deriv/quick-validate")
def deriv_quick_strategy_validate(request: Request, payload: QuickStrategyValidationPayload) -> dict:
    account = _require_deriv_session(request)
    token = str(account.get("token") or "").strip() or CONFIG_API_TOKEN
    if not token:
        raise HTTPException(status_code=401, detail="Login with Deriv first.")
    selected_id = str(account.get("account_id") or account.get("account") or "").strip()

    ws = None
    requires_authorize = True
    settings_payload: dict[str, Any] = {}
    auth_payload: dict[str, Any] = {}
    try:
        ws, requires_authorize, _account_hint = open_ws_for_token(
            token,
            timeout=20,
            account_id=selected_id or None,
        )
        if requires_authorize:
            ws.send(json.dumps({"authorize": token}))
            auth_raw = json.loads(ws.recv())
            if "error" in auth_raw:
                raise RuntimeError(auth_raw["error"].get("message", "authorize failed"))
            auth_payload = auth_raw.get("authorize") or {}
        ws.send(json.dumps({"get_settings": 1}))
        settings_raw = json.loads(ws.recv())
        if "error" in settings_raw:
            raise RuntimeError(settings_raw["error"].get("message", "get_settings failed"))
        settings_payload = settings_raw.get("get_settings") or {}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Deriv quick validation failed: {exc}") from exc
    finally:
        try:
            if ws is not None:
                ws.close()
        except Exception:
            pass

    balance_val = auth_payload.get("balance")
    if balance_val is None:
        try:
            snapshot = bot.fetch_authorized_balance()
            balance_val = snapshot.get("balance")
        except Exception:
            balance_val = 0.0
    balance_num = float(balance_val or 0.0)
    return {
        "success": True,
        "authorized": True,
        "balance": round(balance_num, 2),
        "currency": str(auth_payload.get("currency") or account.get("currency") or "USD"),
        "can_trade": balance_num >= float(payload.stake),
        "settings": settings_payload,
    }


@app.post("/auth/deriv/logout")
def deriv_logout(request: Request) -> dict:
    request.session.pop("deriv_accounts", None)
    request.session.pop("deriv_account", None)
    request.session["deriv_manual_logout"] = True
    bot.set_api_token("")
    bot.set_account_context(None)
    return {"success": True}


# --- Bot control (new + legacy aliases) ---


def _start(request: Request) -> dict:
    _require_deriv_session(request)
    started = bot.start()
    msg = "Bot started." if started else "Bot is already running."
    log.info(msg)
    return {"success": started, "message": msg}


def _stop() -> dict:
    stopped = bot.stop()
    msg = "Bot stopped." if stopped else "Bot is not running."
    log.info(msg)
    return {"success": stopped, "message": msg}


@app.post("/start-bot")
def start_bot_new(request: Request) -> dict:
    return _start(request)


@app.post("/stop-bot")
def stop_bot_new() -> dict:
    return _stop()


@app.post("/start")
def start_bot_legacy(request: Request) -> dict:
    return _start(request)


@app.post("/stop")
def stop_bot_legacy() -> dict:
    return _stop()


@app.get("/status")
def bot_status() -> dict:
    return bot.status()


@app.get("/history")
def trade_history() -> list[dict]:
    return bot.history()


class SettingsPayload(BaseModel):
    stake: float = Field(..., gt=0)
    take_profit: float = Field(..., gt=0)
    stop_loss: float


@app.post("/update-settings")
def update_settings(payload: SettingsPayload) -> dict:
    settings = bot.update_settings(
        stake=payload.stake,
        take_profit=payload.take_profit,
        stop_loss=payload.stop_loss,
    )
    return {"success": True, "settings": settings}


class StrategyPayload(BaseModel):
    type: str
    condition: str
    action: str
    rules: dict


@app.post("/save-strategy")
def save_strategy(payload: StrategyPayload) -> dict:
    strategy = bot.save_strategy(payload.model_dump())
    return {"success": True, "strategy": strategy}


@app.get("/load-strategy")
def load_strategy() -> dict:
    return bot.load_strategy()


@app.post("/strategy-confluence")
def update_strategy_confluence(updates: dict[str, Any] = Body(default_factory=dict)) -> dict:
    """Merge partial confluence settings into strategy.json (validated)."""
    with bot.lock:
        strat = dict(bot.strategy)
    defaults = dict(strategy_engine.DEFAULT_CONFLUENCE)
    conf = dict(strat.get("confluence") or {})
    for key, val in updates.items():
        if key not in defaults:
            continue
        sample = defaults[key]
        if isinstance(sample, bool):
            conf[key] = bool(val)
        elif isinstance(sample, int):
            conf[key] = int(val)
        elif isinstance(sample, float):
            conf[key] = float(val)
        else:
            conf[key] = val
    strat["confluence"] = conf
    merged = bot.save_strategy(strat)
    return {"success": True, "confluence": merged.get("confluence")}


class ManualTradePayload(BaseModel):
    contract_type: str = Field(..., description="DIGITOVER or DIGITUNDER")
    barrier: int = Field(..., ge=0, le=9)
    stake: float = Field(..., gt=0)
    symbol: str = "R_100"


@app.post("/manual-quote")
def manual_quote(request: Request, payload: ManualTradePayload) -> dict:
    _require_deriv_session(request)
    ct = payload.contract_type.upper()
    if ct not in {"DIGITOVER", "DIGITUNDER"}:
        raise HTTPException(status_code=400, detail="contract_type must be DIGITOVER or DIGITUNDER")
    result = bot.manual_quote(ct, payload.barrier, payload.stake, payload.symbol)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "quote failed"))
    return result


@app.post("/manual-trade")
def manual_trade(request: Request, payload: ManualTradePayload) -> dict:
    _require_deriv_session(request)
    ct = payload.contract_type.upper()
    if ct not in {"DIGITOVER", "DIGITUNDER"}:
        raise HTTPException(status_code=400, detail="contract_type must be DIGITOVER or DIGITUNDER")
    result = bot.manual_trade(ct, payload.barrier, payload.stake, payload.symbol)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "manual trade failed"))
    return result


class CopyFollowPayload(BaseModel):
    follower_id: str = Field(default="default_follower")


@app.post("/copy-follow")
def copy_follow(payload: CopyFollowPayload) -> dict:
    out = copy_trading.follow(payload.follower_id)
    log.info("Copy follow: %s", out)
    return {"success": True, **out}


class CopyMasterPayload(BaseModel):
    master_id: str = Field(default="platform_master")


@app.post("/copy-master")
def copy_master(payload: CopyMasterPayload) -> dict:
    out = copy_trading.set_master(payload.master_id)
    return {"success": True, **out}


class CopyUnfollowPayload(BaseModel):
    follower_id: str


@app.post("/copy-unfollow")
def copy_unfollow(payload: CopyUnfollowPayload) -> dict:
    return {"success": True, **copy_trading.unfollow(payload.follower_id)}


@app.get("/copy-status")
def copy_status() -> dict:
    return copy_trading.snapshot()


@app.get("/market-data")
def market_data_endpoint(request: Request, symbol: str = "R_100", timeframe: str = "tick") -> dict:
    try:
        _require_deriv_session(request)
        with bot.lock:
            token = bot.api_token
        data = market_data.build_market_payload(token, symbol, timeframe)
        return {"success": True, "data": data}
    except Exception as exc:
        log.exception("market-data error")
        return {"success": False, "error": str(exc), "data": {}}


@app.get("/diagnostics")
def diagnostics(request: Request) -> dict:
    oauth_client = str(getattr(app_config, "DERIV_OAUTH_CLIENT_ID", "") or "").strip()
    ws_app_id = str(getattr(app_config, "DERIV_WS_APP_ID", "1089") or "1089").strip()
    session_account = request.session.get("deriv_account") or {}
    logged_in = bool(session_account)
    market_ok = False
    market_error = ""
    if not logged_in:
        market_error = "Login required (authorized Deriv token mode)."
    else:
        try:
            with bot.lock:
                token = bot.api_token
            sample = market_data.fetch_ticks_history(token, "R_100", count=12)
            market_ok = bool(sample)
        except Exception as exc:
            market_error = str(exc)
    return {
        "success": True,
        "oauth_client_configured": bool(oauth_client),
        "oauth_client_preview": f"{oauth_client[:6]}..." if oauth_client else "",
        "ws_app_id": ws_app_id,
        "ws_app_id_numeric": ws_app_id.isdigit(),
        "logged_in": logged_in,
        "active_account": _account_public(session_account) if logged_in else None,
        "market_data_ok": market_ok,
        "market_data_error": market_error,
    }
