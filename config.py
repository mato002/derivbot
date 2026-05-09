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

BASE_STAKE = 1000
TAKE_PROFIT = 500
STOP_LOSS = 200
# Deriv OAuth2 client id from developers.deriv.com Registered Apps.
DERIV_OAUTH_CLIENT_ID = "337lYj6ng9qb4b4aeWcuq"
# WebSocket app_id for ws.derivws.com endpoint (keep numeric default unless Deriv gives you another).
DERIV_WS_APP_ID = "1089"
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
# Optional override if url_for() builds the wrong host (e.g. behind a proxy). Otherwise leave "".
DERIV_OAUTH_REDIRECT_URI = "https://duke-nonvolcanic-constrainedly.ngrok-free.dev/auth/deriv/callback"
# OAuth2 scopes requested during Login with Deriv (space separated).
DERIV_OAUTH_SCOPE = "trade account_manage"
# Auth flow for "Login with Deriv":
# - "legacy": oauth.deriv.com returns acct1/token1 usable for WebSocket authorize
# - "oauth2": auth.deriv.com code+PKCE flow (required for OAuth client_id values like 337lYj...)
DERIV_AUTH_FLOW = "legacy"
# Prompt mode for legacy flow:
# - "consent": prefer consent page ("Allow access") when user is already logged in
# - "login": force login form first
# - "" / None: let Deriv decide (recommended when your Deriv session is already active)
DERIV_AUTH_PROMPT = "none"
# Legacy login base URL (home.deriv.com path tends to show the same login/consent journey as Deriv UI).
DERIV_LEGACY_LOGIN_BASE = "https://oauth.deriv.com/oauth2/authorize"
# If REDIRECT_URI is empty and you deploy behind a known public URL, set e.g. https://yourdomain.com
DERIV_PUBLIC_URL = ""
