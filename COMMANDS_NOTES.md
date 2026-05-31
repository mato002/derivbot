# DerivBot Commands Notes

Quick reference for commands we run often in this project.

## Start bot (main command)

```powershell
cd C:\derivbot
python -m uvicorn app:app --reload
```

## Alternative start command (legacy script)

```powershell
cd C:\derivbot
python bot.py
```

## Start the app

```powershell
python -m uvicorn app:app --reload
```

Open in browser (pick one for your workflow):

```text
http://127.0.0.1:8000          # PAT token login only (localhost callback)
https://YOUR-SUBDOMAIN.ngrok-free.dev   # OAuth "Login with Deriv" (use ngrok URL)
```

## Local test with ngrok (OAuth + PAT)

1. Start the app:

```powershell
cd C:\derivbot
python -m uvicorn app:app --reload
```

2. In another terminal, start ngrok:

```powershell
ngrok http 8000
```

3. Copy the **https** forwarding URL (e.g. `https://duke-nonvolcanic-constrainedly.ngrok-free.dev`).

4. Register on Deriv → Dashboard → your app → **OAuth redirect URL**:

```text
https://YOUR-SUBDOMAIN.ngrok-free.dev/auth/deriv/callback
```

5. Update `config.py` if your ngrok subdomain changed:

```python
_NGROK_LOCAL_CALLBACK = "https://YOUR-SUBDOMAIN.ngrok-free.dev/auth/deriv/callback"
```

Or set for this session only:

```powershell
$env:DERIV_OAUTH_REDIRECT_URI = "https://YOUR-SUBDOMAIN.ngrok-free.dev/auth/deriv/callback"
```

6. Open the bot **via the ngrok URL** (not localhost) when using **Login with Deriv**.

Default in `config.py` is restored to:

```text
https://duke-nonvolcanic-constrainedly.ngrok-free.dev/auth/deriv/callback
```

If that tunnel is offline, replace it with your current ngrok URL.

## Deriv tokens (after `app.deriv.com` changes)

Official place: **`https://developers.deriv.com/`** → sign in → **Dashboard** → register a **PAT** or **OAuth** app → create a PAT under **API tokens** ([workflows guide](https://developers.deriv.com/docs/workflows)).

Set the PAT for the bot (environment preferred):

```powershell
setx DERIVBOT_API_TOKEN "paste_pat_token_here"
```

Restart the terminal, then start uvicorn. Or paste into `config.py` as `_LOCAL_API_TOKEN` locally (never commit secrets).

Alternatively use **Login with Deriv** (OAuth) in the app UI so you don’t manage a PAT.

Use **API Token** in the header (modal) or open the manual login page:

```text
http://127.0.0.1:8000/auth/deriv/manual
```

## Deploy (Render) — OAuth redirect URL

Register this on your Deriv OAuth application:

```text
https://derivbot-438o.onrender.com/auth/deriv/callback
```

Set Render env `DERIV_OAUTH_REDIRECT_URI` to that URL (overrides ngrok default in `config.py`).

## Verify app is responding

```powershell
python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000', timeout=5).status)"
```

## Check routes from OpenAPI

```powershell
python -c "import urllib.request, json; data=json.load(urllib.request.urlopen('http://127.0.0.1:8000/openapi.json', timeout=8)); print([p for p in data.get('paths', {}) if p.startswith('/auth/deriv')])"
```

## Syntax checks

```powershell
python -m py_compile app.py
python -m py_compile modules/bot_engine.py app.py
```

## Find duplicate uvicorn processes

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'uvicorn app:app' } | Select-Object ProcessId, CommandLine | Format-List
```

## Stop duplicate uvicorn reloaders

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'python' -and $_.CommandLine -match 'uvicorn app:app --reload' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Useful troubleshooting notes

- `404` on new route after code changes can mean an old server process is still serving.
- PAT cooldown errors are expected sometimes; bot now delays reconnect during cooldown.
- If Deriv OAuth shows "Access Denied", use token login fallback page above.
