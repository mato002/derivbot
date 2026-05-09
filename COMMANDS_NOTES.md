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

Open in browser:

```text
http://127.0.0.1:8000
```

## Token login fallback (when OAuth is blocked)

Open:

```text
http://127.0.0.1:8000/auth/deriv/manual
```

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
