import os

# -----------------------------------------------------------------------------
# API credentials — Deriv retired the old app.deriv.com token UI. Use instead:
#   https://developers.deriv.com/ → Dashboard → register PAT or OAuth app → API tokens (PAT).
#   Guide: https://developers.deriv.com/docs/workflows
# Paste a PAT (often pat_…) below or via DERIVBOT_API_TOKEN, or use browser "Login with Deriv".
#
# Prefer an environment variable so secrets are not committed:
#   PowerShell: $env:DERIVBOT_API_TOKEN="your_token"
#   Persist:    setx DERIVBOT_API_TOKEN "your_token"
# Optional local fallback (never commit real tokens to git):
# -----------------------------------------------------------------------------
_LOCAL_API_TOKEN = ""
API_TOKEN = (os.environ.get("DERIVBOT_API_TOKEN") or _LOCAL_API_TOKEN).strip()

# Defaults until you save Stake / TP / SL on the dashboard (Control Panel → Save Settings).
BASE_STAKE = 1000
TAKE_PROFIT = 500
STOP_LOSS = 200
# If False, each auto trade uses the stake you saved in the UI (current_stake).
# If True, stake is capped at min(saved_stake, 1% of balance) — e.g. ~31 on a 3166 balance.
FRACTIONAL_STAKE_SIZING = False
# Never stake more than this fraction of live balance (0.95 = leave ~5% buffer).
STAKE_MAX_BALANCE_FRACTION = 0.95
# If False, every trade uses the same saved stake (Deriv default — no doubling after losses).
# If True, stake doubles after each loss (martingale), up to max steps in bot_engine.
MARTINGALE_ON_LOSS = False
# OAuth2 "App ID" from developers.deriv.com → Registered Apps (copy exactly; case-sensitive).
DERIV_OAUTH_CLIENT_ID = "337lYj6ng9qb4b4aeWcuq"
# WebSocket app_id for ws.derivws.com endpoint (keep numeric default unless Deriv gives you another).
DERIV_WS_APP_ID = "1089"
# Optional: override ``Deriv-App-ID`` for api.derivws.com (PAT / OTP REST). Env: DERIV_TRADING_API_APP_ID
DERIV_TRADING_API_APP_ID = os.environ.get("DERIV_TRADING_API_APP_ID", "").strip()
# Legacy OAuth app_id for Deriv authorize URL (must allow your callback URL in Deriv app settings).
# Use your own numeric app_id here; falling back to WS app_id keeps local dev working.
DERIV_LEGACY_OAUTH_APP_ID = DERIV_WS_APP_ID
# Random signing key for browser sessions (rotate if leaked; not from Deriv).
SESSION_SECRET = "vs991lf7rf1tNpS687DtQlmXfo34ZFlGUonx_QV-UFt0rmafL-bRAqA0DLYLv9td"

# OAuth: after you tap "Continue" on Deriv, the browser must return to this path on YOUR origin.
# In Deriv → Applications → your app → OAuth redirect URL, register the SAME URL (host + port + https):
#   e.g. http://127.0.0.1:8000/auth/deriv/callback
# Open the app with that same host (localhost vs 127.0.0.1 must match what you registered).
DERIV_OAUTH_APPEND_REDIRECT_URI = True
# OAuth redirect must match exactly what is registered on your Deriv app.
# Local dev default: ngrok tunnel (see COMMANDS_NOTES.md). Production: set env DERIV_OAUTH_REDIRECT_URI.
_NGROK_LOCAL_CALLBACK = "https://duke-nonvolcanic-constrainedly.ngrok-free.dev/auth/deriv/callback"
DERIV_OAUTH_REDIRECT_URI = (
    os.environ.get("DERIV_OAUTH_REDIRECT_URI", "").strip()
    or _NGROK_LOCAL_CALLBACK
)
# OAuth2 scopes requested during Login with Deriv (space separated).
DERIV_OAUTH_SCOPE = "trade account_manage"
# Auth flow for "Login with Deriv":
# - "legacy": numeric app_id + acct1/token1 callback (old binary-style apps)
# - "oauth2": required when Registered Apps shows Type: OAuth (auth.deriv.com + PKCE)
DERIV_AUTH_FLOW = "oauth2"
# Prompt mode for legacy flow:
# - "consent": prefer consent page ("Allow access") when user is already logged in
# - "login": force login form first
# - "" / None: let Deriv decide (recommended when your Deriv session is already active)
DERIV_AUTH_PROMPT = "none"
# Legacy login base URL (home.deriv.com path tends to show the same login/consent journey as Deriv UI).
DERIV_LEGACY_LOGIN_BASE = "https://oauth.deriv.com/oauth2/authorize"
# Public base URL when behind ngrok or a reverse proxy (optional; env overrides).
# Example: https://duke-nonvolcanic-constrainedly.ngrok-free.dev
DERIV_PUBLIC_URL = os.environ.get("DERIV_PUBLIC_URL", "").strip()
