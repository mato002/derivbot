"""Deriv multi-module trading platform — FastAPI entry."""

from __future__ import annotations

import base64
import asyncio
import html
import json
import hashlib
import logging
import secrets
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request as UrlRequest, urlopen

from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
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
from modules.quant_engine import run_digit_backtest

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


@app.get("/trading-bots", response_class=HTMLResponse)
def trading_bots_page(request: Request) -> HTMLResponse:
    return _page(request, "trading_bots.html")


@app.get("/copy-trading", response_class=HTMLResponse)
def copy_trading_page(request: Request) -> HTMLResponse:
    return _page(request, "copy.html")


@app.get("/manual-trader", response_class=HTMLResponse)
def manual_trader_page(request: Request) -> HTMLResponse:
    return _page(request, "manual_trader.html")


@app.get("/matches", response_class=HTMLResponse)
def matches_page(request: Request) -> HTMLResponse:
    return _page(request, "matches.html")


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
        # Local dev safety: if app is opened on localhost/127.0.0.1, prefer the current
        # request callback host over a stale tunnel URL configured in settings.
        req_host = str(getattr(request.url, "hostname", "") or "").strip().lower()
        exp_host = (urlparse(explicit).hostname or "").strip().lower()
        req_is_local = req_host in {"127.0.0.1", "localhost", "::1"}
        exp_is_local = exp_host in {"127.0.0.1", "localhost", "::1"}
        if not (req_is_local and not exp_is_local):
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
    tok = str(token or "").strip()
    if not tok:
        raise HTTPException(status_code=400, detail="Token is required.")
    bot.set_api_token(tok)
    if tok.startswith("pat_"):
        pat_accounts = list_pat_accounts(tok, force_refresh=True)
        if not pat_accounts:
            raise HTTPException(status_code=401, detail="No options accounts found for this PAT token.")
        for row in pat_accounts:
            row["token"] = tok
        selected = next((a for a in pat_accounts if str(a.get("kind")) == "demo"), pat_accounts[0])
        request.session["deriv_accounts"] = pat_accounts
        request.session["deriv_account"] = selected
        request.session["deriv_manual_logout"] = False
        bot.set_account_context(str(selected.get("account_id") or selected.get("account") or ""))
        log.info("Deriv token login: logged in with PAT as %s", selected.get("account"))
        return RedirectResponse(url="/")
    snapshot = bot.fetch_authorized_balance()
    selected = {
        "account": snapshot.get("account") or "ACCOUNT",
        "token": tok,
        "currency": snapshot.get("currency") or "USD",
    }
    request.session["deriv_accounts"] = [selected]
    request.session["deriv_account"] = selected
    request.session["deriv_manual_logout"] = False
    bot.set_account_context(str(selected.get("account_id") or selected.get("account") or ""))
    log.info("Deriv token login: logged in as %s", selected.get("account"))
    return RedirectResponse(url="/")


@app.get("/auth/deriv/manual", response_class=HTMLResponse)
def deriv_manual_token_login_page() -> HTMLResponse:
    return HTMLResponse(
        content="""
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Deriv token login</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 16px;
    background:#fff; color:#1a2634; }
  h1 { font-size: 1.25rem; margin-bottom: 8px; }
  p { line-height: 1.45; }
  input, button { font: inherit; }
  input { width: 100%; box-sizing: border-box; border:1px solid #d7dbe4; border-radius:10px; padding:12px; }
  button { margin-top: 10px; border:0; border-radius:10px; background:#1149d8; color:#fff; padding:10px 14px;
    font-weight: 700; cursor: pointer; }
  .hint { color:#4a5568; font-size:.95rem; }
  .err { color:#9b1c1c; margin-top: 10px; }
</style></head><body>
  <h1>Login with Deriv API token</h1>
  <p>Use this when OAuth login is blocked. Paste your Deriv token or PAT token below.</p>
  <form id="tokenForm">
    <input id="tokenInput" type="password" autocomplete="off" placeholder="Paste token (e.g. pat_...)" required />
    <button type="submit">Login</button>
  </form>
  <p class="hint">Your token is sent only to this local app session.</p>
  <p id="errorBox" class="err" hidden></p>
  <p><a href="/">Home</a></p>
  <script>
    const form = document.getElementById("tokenForm");
    const input = document.getElementById("tokenInput");
    const errorBox = document.getElementById("errorBox");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      errorBox.hidden = true;
      const token = (input.value || "").trim();
      if (!token) return;
      const res = await fetch("/auth/deriv/login-token", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({token}),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      let msg = "Token login failed.";
      try {
        const data = await res.json();
        msg = data.detail || msg;
      } catch (e) {}
      errorBox.textContent = msg;
      errorBox.hidden = false;
    });
  </script>
</body></html>
"""
    )


class DerivTokenLoginPayload(BaseModel):
    token: str = Field(..., description="Deriv API token or PAT token")


@app.post("/auth/deriv/login-token")
def deriv_login_token(request: Request, payload: DerivTokenLoginPayload) -> RedirectResponse:
    token = str(payload.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token is required.")
    try:
        return _login_with_token(request, token)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Token login failed: {exc}") from exc


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
                    "<p>Fallback: <a href=\"/auth/deriv/manual\">Login with API token</a>.</p>"
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
    body += (
        "<p><a href=\"/auth/deriv/login\">Try Login with Deriv again</a> &nbsp;·&nbsp; "
        "<a href=\"/auth/deriv/manual\">Login with API token</a> &nbsp;·&nbsp; "
        "<a href=\"/\">Home</a></p></body></html>"
    )
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


def _refresh_pat_accounts_if_available(request: Request, *, force: bool = False) -> None:
    """Refresh PAT account list in session so Demo/Real switching stays available."""
    if bool(request.session.get("deriv_manual_logout")):
        return
    current = request.session.get("deriv_account") or {}
    token = str(current.get("token") or "").strip()
    if not token:
        token = CONFIG_API_TOKEN
    if not str(token).startswith("pat_"):
        return
    if not force:
        last_ok = float(request.session.get("_pat_accounts_list_refresh_ok_ts") or 0.0)
        if time.time() - last_ok < 120.0:
            return
        last_fail = float(request.session.get("_pat_accounts_list_refresh_fail_ts") or 0.0)
        fail_backoff_sec = float(request.session.get("_pat_accounts_list_refresh_fail_backoff_sec") or 0.0)
        if fail_backoff_sec > 0 and (time.time() - last_fail) < fail_backoff_sec:
            return
    try:
        pat_accounts = list_pat_accounts(token, force_refresh=force)
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
        request.session["_pat_accounts_list_refresh_ok_ts"] = time.time()
        request.session["_pat_accounts_list_refresh_fail_ts"] = 0.0
        request.session["_pat_accounts_list_refresh_fail_backoff_sec"] = 0.0
    except Exception as exc:
        now = time.time()
        prev_backoff = float(request.session.get("_pat_accounts_list_refresh_fail_backoff_sec") or 0.0)
        if "(429)" in str(exc) or "429" in str(exc) or "rate-limit" in str(exc).lower():
            next_backoff = min(300.0, max(30.0, (prev_backoff * 2.0) if prev_backoff else 30.0))
            request.session["_pat_accounts_list_refresh_fail_backoff_sec"] = next_backoff
            request.session["_pat_accounts_list_refresh_fail_ts"] = now
            log.warning("PAT account refresh rate-limited; backing off %.0fs: %s", next_backoff, exc)
            return
        request.session["_pat_accounts_list_refresh_fail_backoff_sec"] = min(
            120.0, max(10.0, (prev_backoff * 1.5) if prev_backoff else 10.0)
        )
        request.session["_pat_accounts_list_refresh_fail_ts"] = now
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
    _refresh_pat_accounts_if_available(request, force=True)
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
    if token:
        bot.set_api_token(token)
    bot.set_account_context(selected_id)
    try:
        snapshot = bot.fetch_authorized_balance()
    except Exception as exc:
        msg = str(exc)
        if "rate-limited" in msg.lower() or "cooldown" in msg.lower() or "429" in msg:
            selected = request.session.get("deriv_account") or {}
            cached_balance = selected.get("balance")
            if cached_balance is None:
                with bot.lock:
                    cached_balance = bot.balance
            return {
                "success": True,
                "stale": True,
                "rate_limited": True,
                "balance": {
                    "account": selected.get("account") or selected_id or "ACCOUNT",
                    "currency": selected.get("currency") or "USD",
                    "balance": round(float(cached_balance or 0.0), 2),
                },
                "warning": f"Deriv temporarily rate-limited WS handshake: {msg}",
            }
        raise HTTPException(status_code=502, detail=f"Unable to fetch balance: {exc}") from exc
    # PAT: avoid list_pat_accounts (GET /options/accounts) here — it rate-limits quickly; WS
    # balance is authoritative and keeps the session copy in sync for the account switcher.
    if token.startswith("pat_") and selected_id:
        bal = snapshot.get("balance")
        cur = str(snapshot.get("currency") or "USD").strip() or "USD"
        raw_list = list(request.session.get("deriv_accounts") or [])
        for row in raw_list:
            row_id = str(row.get("account_id") or row.get("account") or "").strip()
            if row_id == selected_id:
                row["balance"] = bal
                row["currency"] = cur
                break
        request.session["deriv_accounts"] = raw_list
        selected = dict(request.session.get("deriv_account") or {})
        sel_id = str(selected.get("account_id") or selected.get("account") or "").strip()
        if selected and sel_id == selected_id:
            selected["balance"] = bal
            selected["currency"] = cur
            request.session["deriv_account"] = selected
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


@app.get("/stats")
def bot_stats() -> dict:
    return {
        "success": True,
        "stats": bot.stats_engine.snapshot(),
        "risk": bot.risk_engine.snapshot(),
        "last_model_decision": bot.status().get("last_model_decision"),
    }


@app.get("/journal")
def trade_journal(limit: int = 100) -> dict:
    return {"success": True, "rows": bot.journal.recent(limit=max(1, min(limit, 500)))}


@app.get("/events")
def bot_events(since_seq: int = 0, limit: int = 120) -> dict:
    payload = bot.events_since(seq=since_seq, limit=limit)
    return {"success": True, **payload}


@app.get("/events/stream")
async def bot_events_stream(since_seq: int = 0, max_seconds: int = 30):
    start = time.time()
    cursor = int(since_seq)
    window = max(5, min(int(max_seconds), 120))

    async def _gen():
        nonlocal cursor
        # Initial comment line keeps some proxies from buffering forever.
        yield ": connected\n\n"
        while (time.time() - start) < window:
            chunk = bot.events_since(seq=cursor, limit=200)
            rows = chunk.get("events") or []
            if rows:
                for row in rows:
                    cursor = max(cursor, int(row.get("seq") or 0))
                    yield f"data: {json.dumps(row)}\n\n"
            else:
                yield ": heartbeat\n\n"
            await asyncio.sleep(0.75)

    return StreamingResponse(_gen(), media_type="text/event-stream")


class SettingsPayload(BaseModel):
    stake: float = Field(..., gt=0)
    take_profit: float = Field(..., gt=0)
    stop_loss: float


class BacktestPayload(BaseModel):
    symbol: str = "R_100"
    count: int = Field(default=2000, ge=300, le=20000)
    barrier: int = Field(default=5, ge=0, le=9)
    stake: float = Field(default=1.0, gt=0)


@app.post("/update-settings")
def update_settings(payload: SettingsPayload) -> dict:
    settings = bot.update_settings(
        stake=payload.stake,
        take_profit=payload.take_profit,
        stop_loss=payload.stop_loss,
    )
    return {"success": True, "settings": settings}


@app.post("/backtest")
def backtest(request: Request, payload: BacktestPayload) -> dict:
    account = _require_deriv_session(request)
    token = str(account.get("token") or "").strip() or CONFIG_API_TOKEN
    if token:
        bot.set_api_token(token)
    aid = str(account.get("account_id") or account.get("account") or "").strip() or None
    ticks = market_data.fetch_ticks_history(token, payload.symbol, count=payload.count, account_id=aid)
    digits = [int(f"{float(x['price']):.5f}"[-1]) for x in ticks]
    results = run_digit_backtest(digits, barrier=payload.barrier, stake=payload.stake)
    return {"success": True, "results": results, "sample_size": len(digits)}


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
    contract_type: str = Field(..., description="DIGITOVER, DIGITUNDER, or DIGITMATCH")
    barrier: int = Field(..., ge=0, le=9)
    stake: float = Field(..., gt=0)
    symbol: str = "R_100"
    duration_ticks: int = Field(default=1, ge=1, le=10, description="Tick duration (DIGITMATCH); Over/Under forced to 1")


def _manual_duration_ticks(contract_upper: str, requested: int) -> int:
    if contract_upper in {"DIGITOVER", "DIGITUNDER"}:
        return 1
    return max(1, min(10, int(requested)))


@app.post("/manual-quote")
def manual_quote(request: Request, payload: ManualTradePayload) -> dict:
    _require_deriv_session(request)
    ct = payload.contract_type.upper()
    if ct not in {"DIGITOVER", "DIGITUNDER", "DIGITMATCH"}:
        raise HTTPException(
            status_code=400, detail="contract_type must be DIGITOVER, DIGITUNDER, or DIGITMATCH"
        )
    ticks = _manual_duration_ticks(ct, payload.duration_ticks)
    try:
        result = bot.manual_quote(ct, payload.barrier, payload.stake, payload.symbol, duration_ticks=ticks)
    except Exception as exc:
        msg = str(exc)
        if "rate-limited" in msg.lower() or "cooldown" in msg.lower() or "429" in msg:
            raise HTTPException(
                status_code=429,
                detail=f"Manual quote temporarily unavailable due to Deriv rate limiting: {msg}",
            ) from exc
        raise HTTPException(status_code=502, detail=f"manual quote failed: {msg}") from exc
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "quote failed"))
    return result


@app.post("/manual-trade")
def manual_trade(request: Request, payload: ManualTradePayload) -> dict:
    _require_deriv_session(request)
    ct = payload.contract_type.upper()
    if ct not in {"DIGITOVER", "DIGITUNDER", "DIGITMATCH"}:
        raise HTTPException(
            status_code=400, detail="contract_type must be DIGITOVER, DIGITUNDER, or DIGITMATCH"
        )
    ticks = _manual_duration_ticks(ct, payload.duration_ticks)
    result = bot.manual_trade(ct, payload.barrier, payload.stake, payload.symbol, duration_ticks=ticks)
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
        sess = _require_deriv_session(request)
        aid = str(sess.get("account_id") or sess.get("account") or "").strip() or None
        with bot.lock:
            token = bot.api_token
        data = market_data.build_market_payload(token, symbol, timeframe, account_id=aid)
        return {"success": True, "data": data}
    except Exception as exc:
        msg = str(exc)
        if "429" in msg or "rate-limit" in msg.lower() or "cooldown" in msg.lower():
            log.warning("market-data rate-limited: %s", msg)
            cached = market_data.get_cached_market_payload(symbol, timeframe, account_id=aid)
            if cached:
                return {
                    "success": True,
                    "stale": True,
                    "rate_limited": True,
                    "warning": msg,
                    "data": cached,
                }
        else:
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
            aid = str(session_account.get("account_id") or session_account.get("account") or "").strip() or None
            sample = market_data.fetch_ticks_history(token, "R_100", count=12, account_id=aid)
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
