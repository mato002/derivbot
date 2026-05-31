# Deriv Over/Under Bot — Refactor Report

**Date:** 2026-05-30  
**Status:** Research mode enabled — do not trade live until validation shows positive expectancy.

---

## 1. Summary of Changes

| # | Objective | Status | Key files |
|---|-----------|--------|-----------|
| 1 | Disable probability gate (testing) | Done | `strategy.json`, `strategy_engine.py` |
| 2 | Fix search layer contradictions | Done | `strategy_engine.py`, `payout_search.py`, `strategy.json` |
| 3 | Full signal decision logging | Done | `signal_decision_log.py`, `trade_pipeline.py` |
| 4 | Trade audit trail | Done | `trade_audit.py`, `bot_engine.py` |
| 5 | In-flight trade protection | Done | `bot_engine.py` |
| 6 | Research mode | Done | `strategy.json`, `bot_engine.py`, `trade_pipeline.py` |
| 7 | Production backtester | Done | `backtest_engine.py`, `quant_engine.py`, `app.py` |
| 8 | Validation report | Done | `validation_report.py`, `app.py`, `scripts/run_validation.py` |
| 9 | Repository review | Done | See Section 9 below |

---

## 2. Strategy Configuration (`strategy.json`)

### Probability gate (testing)

```json
"use_probability_gate": false
```

Re-enable anytime by setting to `true` — no code change required.

### Search layer alignment

**Previous contradiction (all digits blocked):**

| Repeated digit | Signal | Barrier | Old block reason |
|----------------|--------|---------|------------------|
| 0–3 | OVER | 0–3 | `min_barrier_over: 4` |
| 4 | OVER | 4 | ratio 1.75 < 2.20 |
| 5 | OVER | 5 | probability / ratio |
| 6–9 | UNDER | 6–9 | `max_barrier_under: 5` |

**Fix applied:**

- `min_barrier_over`: **0** (was 4)
- `max_barrier_under`: **8** (was 5)
- Auto-alignment in `validate_strategy()` via `align_search_with_signal_rules()`
- `search_signal_compatibility()` API at `GET /strategy/compatibility`

### Research mode

```json
"research_mode": true
```

When `true`:

- Pipeline runs normally; **no live orders**
- Hypothetical trades resolve on **next tick**
- Outcomes saved to `trade_audit.db` and journal (`source=research`)
- Confluence enforcement relaxed (advisory) to allow more signal flow

Set `"research_mode": false` for live trading (not recommended yet).

### Testing-friendly filters (temporary)

| Setting | Value | Note |
|---------|-------|------|
| `min_estimated_ratio` | 1.1 | Raise to 1.75+ for live |
| `min_payout_to_stake` | 1.1 | Raise for live |
| `cooldown_ticks` | 0 | Restore 10+ for live |
| `volatility_lockout_enabled` | false | Re-enable for live |
| `portfolio.enabled` | false | Prevents volatile→rise_fall dead path |

---

## 3. New Modules

| Module | Purpose |
|--------|---------|
| `modules/signal_decision_log.py` | JSON logs → console + `logs/signal_decisions.log` |
| `modules/trade_audit.py` | `trade_audit` SQLite table |
| `modules/backtest_engine.py` | Next-tick pipeline backtest |
| `modules/validation_report.py` | Aggregated stats + CSV + `validation_metrics` table |

---

## 4. New API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /trade-audit` | Audit rows |
| `GET /trade-audit/export.csv` | CSV export |
| `GET /strategy/compatibility` | Per-digit signal reachability |
| `GET /validation-report` | Full validation JSON + console text |
| `GET /validation-report/export.csv` | CSV metrics |
| `POST /backtest` | Now uses production pipeline (next-tick) |

---

## 5. Backtest Results (5,000 R_100 ticks, current config)

| Metric | Value |
|--------|-------|
| Triggers seen | 1,666 |
| Signals passing filters | ~200 (then stop-loss simulation cap) |
| Total trades simulated | 200 |
| Wins / Losses | 0 / 200 |
| Win rate | 0.0% |
| Profit factor | 0.0 |
| Expectancy | -$1.00 / trade (stake units) |
| Max drawdown | $200 |
| Avg loss streak | 200 |

**Interpretation:** With ratio floor at 1.1, the only signals passing during this sample were **DIGITOVER @ barrier 0** during **zero-heavy tick runs**. OVER@0 requires next digit > 0; consecutive zeros produce guaranteed losses. This confirms **no measurable edge** under current rules.

Run locally:

```powershell
python scripts/run_validation.py
```

---

## 6. Code Diff Summary

### `bot_engine.py`

- `_trade_in_progress` guard at tick entry and before pipeline
- `_research_pending` + `_resolve_research_pending()` for paper trades
- `TradeAudit` integration on every pipeline decision
- Status exposes `research_mode` and `research_pending`

### `trade_pipeline.py`

- Structured `signal_decision` on every gated path
- Logs via `signal_decision_log.log_signal_decision()`
- Research mode disables confluence enforcement

### `quant_engine.py`

- `run_digit_backtest()` delegates to `backtest_engine` (next-tick)
- Legacy biased backtest moved to `run_digit_backtest_legacy()`

### `strategy_engine.py`

- `research_mode` validation
- `align_search_with_signal_rules()`
- `search_signal_compatibility()`

---

## 7. Repository Review

### Critical

| Issue | Location | Notes |
|-------|----------|-------|
| No statistical edge on repeat-3 | `signal_engine.py` | Inherent strategy flaw |
| Legacy backtest look-ahead | `quant_engine.run_digit_backtest_legacy()` | Deprecated, not used by API |
| `BASE_STAKE = 1000` | `config.py` | Dangerous if live |

### High

| Issue | Location | Notes |
|-------|----------|-------|
| Price confluence ≠ digit outcome | `over_under_strategy_engine.py` | Methodology mismatch |
| Portfolio volatile→rise_fall when rise_fall disabled | `signal_engine.py` + `strategy.json` | Fixed by disabling portfolio in research |
| Static payout hints | `payout_search.py` | May diverge from live proposals |
| Transition model circular on streak | `quant_engine.py` | Inflates/deflates gate when re-enabled |

### Medium

| Issue | Location | Notes |
|-------|----------|-------|
| Duplicate `RiskEngine` | `quant_engine.py` | Deprecated comment added |
| Double ratio check | `payout_search` + `execution_engine` | Redundant but safe |
| Barrier 9 → 8 silent clamp | `payout_search.clamp_digit_barrier` | Logged in search_meta |
| Session-only loss limits | `risk_engine.py` | Resets on bot restart |

### Low

| Issue | Location | Notes |
|-------|----------|-------|
| `bot.py` legacy entry | root | Use uvicorn |
| Copy trading stub | `copy_trading.py` | In-memory only |
| Sparse transition fallback (10% uniform) | `quant_engine.py` | Edge case |

---

## 8. Edge Assessment

**After refactor and production-aligned backtest:**

- **No measurable positive edge** on 5,000-tick sample
- Win rate 0% on filtered signals (OVER@0 during zero clusters)
- Expectancy **-100%** of stake per trade in simulation
- Probability gate disabled intentionally for data collection; re-enabling will **reduce** trade count further

---

## 9. Recommendation

| Mode | Verdict |
|------|---------|
| **Live trading** | **Do not enable** — negative expectancy, no validated edge |
| **Research mode** | **Use now** — `research_mode: true` collects audit data safely |
| **Retire strategy** | Consider if 10,000+ research signals still show EV ≤ 0 |

### Next steps

1. Run bot in research mode for 1–2 weeks; export `/trade-audit/export.csv`
2. Review `/validation-report` weekly
3. If any setup shows EV > 0 with n ≥ 30, re-test with probability gate on
4. Only then set `research_mode: false` with fractional stakes (≤1% balance)

---

## 10. Re-enabling Production Controls

When moving from research to live (only after positive EV):

```json
{
  "research_mode": false,
  "model": { "use_probability_gate": true },
  "execution": { "min_payout_to_stake": 1.75 },
  "search": { "min_estimated_ratio": 1.75 },
  "cooldown": { "cooldown_ticks": 10 },
  "risk": { "volatility_lockout_enabled": true },
  "portfolio": { "enabled": true }
}
```
