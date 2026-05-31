"""Deriv bot runtime: WebSocket session, digit strategy, hybrid manual override, copy hooks."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import websocket

import config as app_config
from config import API_TOKEN, BASE_STAKE, DERIV_WS_APP_ID, STOP_LOSS, TAKE_PROFIT

from modules.analytics_engine import TradeAnalytics
from modules.deriv_auth import get_legacy_ws_url, is_pat_token, list_pat_accounts, open_ws_for_token
from modules import copy_trading, execution_engine, payout_search, signal_engine, strategy_engine
from modules.quant_engine import DigitStatsEngine, TradeJournal
from modules.risk_engine import SessionRiskEngine
from modules.trade_audit import TradeAudit
from modules.trade_pipeline import PipelineContext, TradePipeline

logger = logging.getLogger(__name__)


def _deriv_ws_url() -> str:
    _ = DERIV_WS_APP_ID  # keep config import explicit for diagnostics/UI
    return get_legacy_ws_url()


def _cooldown_wait_seconds(message: str) -> int | None:
    """Extract cooldown seconds from Deriv auth/WS errors."""
    msg = str(message or "")
    m = re.search(r"\((\d+)\s*s?\s*remaining\)", msg, flags=re.IGNORECASE)
    if m:
        try:
            return max(1, int(m.group(1)))
        except Exception:
            return None
    m = re.search(r"(\d+)\s*s?\s*remaining", msg, flags=re.IGNORECASE)
    if m:
        try:
            return max(1, int(m.group(1)))
        except Exception:
            return None
    return None


class DerivBot:
    """Thread-safe Deriv digit strategy bot with dashboard, hybrid pause, and copy-trading hooks."""

    WS_URL = _deriv_ws_url()

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.running = False
        self.user_paused = False
        self.thread: Optional[threading.Thread] = None
        self.ws: Optional[websocket.WebSocket] = None
        self._ws_requires_authorize = True
        self._session_account_hint: Optional[str] = None
        self.active_account_id: Optional[str] = None

        self.api_token = API_TOKEN
        self.base_stake = abs(float(BASE_STAKE))
        self.take_profit = abs(float(TAKE_PROFIT))
        self.stop_loss = -abs(float(STOP_LOSS))

        self.balance = 0.0
        self.profit = 0.0
        self.current_stake = self.base_stake
        self.last_digits: List[int] = []
        self.last_result = "-"
        self.events: List[str] = []
        self.trade_history: List[Dict[str, object]] = []
        self.trades_count = 0
        self._trade_in_progress = False
        self._research_pending: Optional[Dict[str, object]] = None
        self.hybrid_suppress_until = 0.0
        self._trade_alert_seq = 0
        self._last_trade_alert: Optional[Dict[str, object]] = None
        self._last_confluence: Optional[Dict[str, object]] = None
        self._events_seq = 0
        self._event_rows: List[Dict[str, object]] = []

        self.loss_streak = 0
        self.martingale_step = 0
        self.max_martingale_steps = 2

        self.strategy = strategy_engine.load_strategy()
        self.stats_engine = DigitStatsEngine()
        self.risk_engine = SessionRiskEngine(dict(self.strategy.get("risk") or {}))
        self.pipeline = TradePipeline()
        _base = Path(__file__).resolve().parent.parent
        self.journal = TradeJournal(_base / "trade_journal.db")
        self.analytics = TradeAnalytics(_base / "trade_analytics.db")
        self.trade_audit = TradeAudit(_base / "trade_audit.db")
        self._recent_outcomes: List[str] = []
        self._last_model_decision: Optional[Dict[str, object]] = None
        self._last_pipeline: Optional[Dict[str, object]] = None
        self._ticks_since_last_trade = 9999
        self._tick_counter = 0

        # Warm WebSocket for manual quote/trade (avoids TCP+authorize on every click).
        self._manual_ws_lock = threading.Lock()
        self._manual_ws: Optional[websocket.WebSocket] = None
        self._manual_ws_token: Optional[str] = None
        self._manual_ws_requires_authorize = True
        self._reconnect_not_before = 0.0

    def start(self) -> bool:
        with self.lock:
            if self.running:
                return False
            self.running = True
            self._reset_runtime_state()
            self.user_paused = False
            self.thread = threading.Thread(target=self._run_loop, daemon=True)
            self.thread.start()
            logger.info("Bot thread started")
            return True

    def stop(self) -> bool:
        with self.lock:
            if not self.running:
                return False
            self.running = False
            self.user_paused = False
            ws = self.ws
            self._add_event("Bot stopped")
        if ws:
            try:
                ws.close()
            except Exception:
                pass
        self._invalidate_manual_trading_socket()
        logger.info("Bot stopped")
        return True

    def pause(self) -> bool:
        with self.lock:
            if not self.running:
                return False
            if self.user_paused:
                return False
            self.user_paused = True
            self._add_event("Bot paused by operator")
            logger.info("Bot paused by operator")
            return True

    def resume(self) -> bool:
        with self.lock:
            if not self.running:
                return False
            if not self.user_paused:
                return False
            self.user_paused = False
            self._add_event("Bot resumed by operator")
            logger.info("Bot resumed by operator")
            return True

    def status(self) -> Dict[str, object]:
        with self.lock:
            active: List[Dict[str, object]] = []
            if self._trade_in_progress:
                active.append({"type": "digit", "state": "executing"})
            paused = time.time() < self.hybrid_suppress_until
            risk_paused = bool(self.risk_engine.paused)
            operator_paused = bool(self.user_paused)
            session_paused = paused or risk_paused or operator_paused
            if not self.running:
                bot_state = "stopped"
            elif session_paused:
                bot_state = "paused"
            else:
                bot_state = "running"
            return {
                "running": self.running,
                "user_paused": operator_paused,
                "bot_state": bot_state,
                "session_paused": session_paused,
                "profit": round(self.profit, 2),
                "balance": round(self.balance, 2),
                "stake": round(self.current_stake, 2),
                "last_digits": list(self.last_digits),
                "last_result": self.last_result,
                "trades_count": self.trades_count,
                "active_trades": active,
                "hybrid_paused": paused,
                "hybrid_resume_at": round(self.hybrid_suppress_until, 3) if paused else None,
                "settings": {
                    "stake": round(self.base_stake, 2),
                    "take_profit": round(self.take_profit, 2),
                    "stop_loss": round(self.stop_loss, 2),
                },
                "events": list(self.events[-12:]),
                "strategy": self.strategy,
                "research_mode": bool(self.strategy.get("research_mode")),
                "research_pending": self._research_pending is not None,
                "last_trade_alert": dict(self._last_trade_alert) if self._last_trade_alert else None,
                "confluence": dict(self._last_confluence) if self._last_confluence else None,
                "stats": self.stats_engine.snapshot(),
                "risk": self.risk_engine.snapshot(),
                "expectancy": self.analytics.expectancy.snapshot(),
                "last_model_decision": dict(self._last_model_decision) if self._last_model_decision else None,
                "last_pipeline": dict(self._last_pipeline) if self._last_pipeline else None,
            }

    def history(self) -> List[Dict[str, object]]:
        with self.lock:
            return list(self.trade_history[-20:])

    def events_since(self, seq: int = 0, limit: int = 120) -> Dict[str, object]:
        with self.lock:
            since = int(seq)
            rows = [x for x in self._event_rows if int(x.get("seq", 0)) > since]
            rows = rows[-max(1, min(int(limit), 500)) :]
            return {
                "events": rows,
                "latest_seq": int(self._events_seq),
            }

    def update_settings(self, stake: float, take_profit: float, stop_loss: float) -> Dict[str, float]:
        with self.lock:
            self.base_stake = max(0.01, abs(float(stake)))
            self.take_profit = max(0.01, abs(float(take_profit)))
            self.stop_loss = -abs(float(stop_loss))
            self.current_stake = self.base_stake
            self.martingale_step = 0
            self._add_event(
                f"Settings updated: stake={self.base_stake}, TP={self.take_profit}, SL={self.stop_loss}"
            )
            return {
                "stake": round(self.base_stake, 2),
                "take_profit": round(self.take_profit, 2),
                "stop_loss": round(self.stop_loss, 2),
            }

    def set_api_token(self, token: str) -> None:
        self._invalidate_manual_trading_socket()
        with self.lock:
            self.api_token = token
            self._add_event("API token updated from Deriv login")

    def set_account_context(self, account_id: str | None) -> None:
        self._invalidate_manual_trading_socket()
        with self.lock:
            self.active_account_id = (account_id or "").strip() or None
            if self.active_account_id:
                self._add_event(f"Account context set: {self.active_account_id}")

    def apply_balance_snapshot(self, balance: float) -> None:
        with self.lock:
            self.balance = round(float(balance), 2)

    def refresh_balance_from_deriv(self, *, fallback: float | None = None) -> float:
        """Pull live balance from Deriv; use fallback (e.g. session cache) if the call fails."""
        try:
            snap = self.fetch_authorized_balance()
            bal = round(float(snap.get("balance", 0.0)), 2)
            with self.lock:
                self.balance = bal
            return bal
        except Exception as exc:
            logger.warning("Live balance refresh failed: %s", exc)
            if fallback is not None:
                try:
                    fb = round(float(fallback), 2)
                except (TypeError, ValueError):
                    fb = None
                if fb is not None and fb >= 0:
                    with self.lock:
                        self.balance = fb
                    return fb
            with self.lock:
                return float(self.balance)

    def _invalidate_manual_trading_socket_unlocked(self) -> None:
        """Drop manual trading socket. Caller must hold ``_manual_ws_lock``."""
        if self._manual_ws:
            try:
                self._manual_ws.close()
            except Exception:
                pass
        self._manual_ws = None
        self._manual_ws_token = None

    def _invalidate_manual_trading_socket(self) -> None:
        with self._manual_ws_lock:
            self._invalidate_manual_trading_socket_unlocked()

    def _ensure_manual_trading_ws_unlocked(self, api_token: str) -> tuple[websocket.WebSocket, bool]:
        """Return an authorized (if required) socket for manual proposal/buy. Caller holds ``_manual_ws_lock``."""
        if not (api_token or "").strip():
            raise RuntimeError("No API token")
        if self._manual_ws and self._manual_ws_token == api_token:
            return self._manual_ws, self._manual_ws_requires_authorize
        self._invalidate_manual_trading_socket_unlocked()
        ws, requires_authorize, _account_hint = open_ws_for_token(
            api_token,
            timeout=30,
            account_id=self.active_account_id,
        )
        if requires_authorize:
            ws.send(json.dumps({"authorize": api_token}))
            auth = json.loads(ws.recv())
            if "error" in auth:
                try:
                    ws.close()
                except Exception:
                    pass
                raise RuntimeError(auth["error"].get("message", "authorize failed"))
        self._manual_ws = ws
        self._manual_ws_token = api_token
        self._manual_ws_requires_authorize = requires_authorize
        return ws, requires_authorize

    def fetch_authorized_balance(self) -> Dict[str, object]:
        tok = str(self.api_token or "").strip()
        if not tok:
            raise RuntimeError("No API token")
        # PAT: balance + account listing are on REST — opening a websocket here for every poll
        # consumes OTP connects and triggers Deriv PAT WebSocket cooldown (breaks trading).
        if is_pat_token(tok):
            acct_needed = str(self.active_account_id or "").strip()
            rows = list_pat_accounts(tok, force_refresh=False)
            if not rows:
                raise RuntimeError("No Deriv options accounts for PAT")
            pick = None
            if acct_needed:
                for r in rows:
                    rid = str(r.get("account_id") or r.get("account") or "").strip()
                    if rid == acct_needed:
                        pick = r
                        break
            if pick is None:
                pick = next((r for r in rows if str(r.get("kind")) == "demo"), rows[0])
            account_id = str(pick.get("account_id") or pick.get("account") or "").strip() or acct_needed
            return {
                "account": account_id or "ACCOUNT",
                "currency": str(pick.get("currency") or "USD").strip() or "USD",
                "balance": round(float(pick.get("balance", 0.0)), 2),
            }

        ws, requires_authorize, account_hint = open_ws_for_token(
            self.api_token,
            timeout=15,
            account_id=self.active_account_id,
        )
        try:
            auth_data: Dict[str, object] = {}
            if requires_authorize:
                ws.send(json.dumps({"authorize": self.api_token}))
                response = json.loads(ws.recv())
                if "error" in response:
                    raise RuntimeError(response["error"].get("message", "authorization failed"))
                auth_data = response.get("authorize", {})
            else:
                # PAT/OTP socket is pre-authenticated; query balance directly.
                ws.send(json.dumps({"balance": 1}))
                response = json.loads(ws.recv())
                if "error" in response:
                    raise RuntimeError(response["error"].get("message", "balance failed"))
                auth_data = response.get("balance", {}) or {}
            return {
                "account": auth_data.get("loginid") or account_hint,
                "currency": auth_data.get("currency", "USD"),
                "balance": round(float(auth_data.get("balance", 0.0)), 2),
            }
        finally:
            try:
                ws.close()
            except Exception:
                pass

    def _prime_pat_balance(self, ws: websocket.WebSocket) -> None:
        """PAT OTP sockets skip authorize(); pull balance once for risk/stake sizing."""
        try:
            ws.send(json.dumps({"balance": 1}))
            response = json.loads(ws.recv())
            if "error" in response:
                raise RuntimeError(response["error"].get("message", "balance failed"))
            bal_payload = response.get("balance") or {}
            with self.lock:
                self.balance = float(bal_payload.get("balance", self.balance))
        except Exception as exc:
            logger.warning("PAT balance priming failed (continuing ticks): %s", exc)

    def save_strategy(self, strategy: Dict[str, object]) -> Dict[str, object]:
        validated = strategy_engine.save_strategy(strategy)
        with self.lock:
            self.strategy = validated
            self._add_event("Strategy updated from builder")
        self.risk_engine.configure(dict(validated.get("risk") or {}))
        return validated

    def load_strategy(self) -> Dict[str, object]:
        with self.lock:
            return dict(self.strategy)

    def reload_strategy_from_disk(self) -> None:
        with self.lock:
            self.strategy = strategy_engine.load_strategy()
            self._add_event("Strategy reloaded from disk")

    def manual_trade(
        self,
        contract_type: str,
        barrier: int,
        stake: float,
        symbol: str = "R_100",
        *,
        duration_ticks: int = 1,
        balance_fallback: float | None = None,
    ) -> Dict[str, object]:
        """One-off digit trade via a reused WebSocket when possible. Hybrid pause applies to Over/Under only."""
        token = self.api_token
        with self.lock:
            token = self.api_token
        ct = contract_type.upper()
        trade_source = "matches" if ct == "DIGITMATCH" else "manual"
        stake_eff, stake_ok, stake_note = self._prepare_stake_for_trade(
            float(stake), balance_fallback=balance_fallback
        )
        if not stake_ok:
            return {"success": False, "error": stake_note}
        if stake_note:
            self._add_event(stake_note)
        self._add_event(
            f"Manual trade requested: {ct} barrier={barrier} stake={stake_eff} duration_ticks={int(duration_ticks)}"
        )
        try:
            payout, won, executed, duration_sec, err, _ratio, _lat = self._place_trade_standalone(
                token,
                contract_type,
                barrier,
                stake_eff,
                symbol,
                duration_ticks=int(duration_ticks),
                enforce_execution_filter=self._manual_enforces_execution_filter(),
            )
        except Exception as exc:
            logger.exception("Manual trade failed")
            return {"success": False, "error": str(exc)}
        if not executed:
            self._invalidate_manual_trading_socket()
            # A brief retry helps in transient pricing/proposal races.
            try:
                payout, won, executed, duration_sec, err_retry, _ratio, _lat = self._place_trade_standalone(
                    token,
                    contract_type,
                    barrier,
                    stake_eff,
                    symbol,
                    duration_ticks=int(duration_ticks),
                    enforce_execution_filter=self._manual_enforces_execution_filter(),
                )
                if not executed:
                    return {"success": False, "error": err_retry or err or "Trade not executed"}
            except Exception:
                return {"success": False, "error": err or "Trade not executed"}
        digit = int(barrier)
        self._apply_trade_result(
            stake=float(stake_eff),
            payout=payout,
            won=won,
            digit=digit,
            source=trade_source,
            contract_type=contract_type,
            duration_sec=duration_sec,
        )
        with self.lock:
            session_balance = round(self.balance, 2)
            session_profit = round(self.profit, 2)
        if ct not in {"DIGITMATCH"}:
            with self.lock:
                self.hybrid_suppress_until = time.time() + 45.0
            self._add_event("Hybrid: auto-bot signals paused ~45s after manual trade")
        return {
            "success": True,
            "won": won,
            "payout": round(payout, 2),
            "profit_delta": round((payout - float(stake_eff)) if won else -float(stake_eff), 2),
            "duration_sec": round(float(duration_sec), 2),
            "balance": session_balance,
            "session_profit": session_profit,
        }

    def manual_quote(
        self,
        contract_type: str,
        barrier: int,
        stake: float,
        symbol: str = "R_100",
        *,
        duration_ticks: int = 1,
    ) -> Dict[str, object]:
        """Get pre-trade proposal numbers without buying."""
        with self.lock:
            token = self.api_token
        try:
            with self._manual_ws_lock:
                ws, requires_authorize = self._ensure_manual_trading_ws_unlocked(token)
                payload = {
                    "proposal": 1,
                    "amount": round(float(stake), 2),
                    "basis": "stake",
                    "contract_type": contract_type,
                    "currency": "USD",
                    "duration": max(1, int(duration_ticks)),
                    "duration_unit": "t",
                    "barrier": str(int(barrier)),
                }
                if requires_authorize:
                    payload["symbol"] = symbol
                else:
                    payload["underlying_symbol"] = symbol
                ws.send(json.dumps(payload))
                resp = json.loads(ws.recv())
                if "error" in resp:
                    raise RuntimeError(resp["error"].get("message", "proposal failed"))
                proposal = resp.get("proposal", {})
                payout = float(proposal.get("payout", 0.0))
                ask = float(proposal.get("ask_price", stake))
                profit = payout - ask
                implied_prob = (ask / payout * 100.0) if payout > 0 else 0.0
                return {
                    "success": True,
                    "ask_price": round(ask, 2),
                    "payout": round(payout, 2),
                    "profit": round(profit, 2),
                    "implied_probability": round(implied_prob, 2),
                }
        except websocket.WebSocketException:
            self._invalidate_manual_trading_socket()
            raise

    def _manual_enforces_execution_filter(self) -> bool:
        with self.lock:
            execution_cfg = dict(self.strategy.get("execution") or {})
        return bool(execution_cfg.get("enforce_on_manual", False))

    def _prepare_stake_for_trade(
        self, requested: float, *, balance_fallback: float | None = None
    ) -> tuple[float, bool, str]:
        self.refresh_balance_from_deriv(fallback=balance_fallback)
        return self._cap_stake_to_balance(requested)

    def _cap_stake_to_balance(self, requested: float) -> tuple[float, bool, str]:
        min_stake = 0.35
        with self.lock:
            bal = float(self.balance)
        req = round(max(min_stake, float(requested)), 2)
        if bal < min_stake:
            return 0.0, False, f"Insufficient balance (${bal:.2f}) — need at least ${min_stake:.2f} to trade"
        frac = float(getattr(app_config, "STAKE_MAX_BALANCE_FRACTION", 0.95) or 0.95)
        frac = max(0.1, min(1.0, frac))
        max_allowed = round(max(min_stake, bal * frac), 2)
        effective = round(min(req, max_allowed), 2)
        if effective < req - 0.001:
            return effective, True, f"Stake capped ${req:.2f} → ${effective:.2f} (balance ${bal:.2f})"
        return effective, True, ""

    def _trade_stake_amount(self) -> tuple[float, bool, str]:
        with self.lock:
            base = float(self.current_stake)
            bal = float(self.balance)
        if bool(getattr(app_config, "FRACTIONAL_STAKE_SIZING", False)):
            requested = self.risk_engine.suggested_stake(bal, base)
        else:
            requested = round(max(0.35, base), 2)
        return self._cap_stake_to_balance(requested)

    def _reset_runtime_state(self) -> None:
        self.profit = 0.0
        self.last_digits = []
        self.last_result = "-"
        self.events = []
        self.trade_history = []
        self.trades_count = 0
        self.loss_streak = 0
        self.martingale_step = 0
        self.current_stake = self.base_stake
        self._trade_in_progress = False
        self._research_pending = None
        self._trade_alert_seq = 0
        self._last_trade_alert = None
        self._last_confluence = None
        self._events_seq = 0
        self._event_rows = []
        self._add_event("Bot started")
        self.risk_engine.configure(dict(self.strategy.get("risk") or {}))
        self.risk_engine.start_session(self.balance)
        self._recent_outcomes = []
        self._last_model_decision = None
        self._last_pipeline = None
        self._ticks_since_last_trade = 9999
        self._tick_counter = 0

    def _run_loop(self) -> None:
        while self._is_running():
            now = time.time()
            with self.lock:
                not_before = float(self._reconnect_not_before or 0.0)
            if not_before > now:
                time.sleep(min(5.0, not_before - now))
                continue
            reconnect_sleep = 2
            try:
                self._run_session()
            except Exception as exc:
                msg = str(exc)
                self._add_event(f"Session error: {msg}")
                logger.exception("Session error")
                wait_sec = _cooldown_wait_seconds(msg)
                is_pat_ws_cooldown = "PAT WebSocket connect cooldown" in msg
                is_cooldown_err = (
                    ("cooldown" in msg.lower()) or ("rate-limit" in msg.lower()) or ("429" in msg)
                )
                if wait_sec or is_cooldown_err:
                    if not wait_sec:
                        wait_sec = 120 if is_pat_ws_cooldown else 30
                    reconnect_sleep = min(max(30, wait_sec), 3600)
                    self._add_event(f"Backoff {reconnect_sleep}s (cooldown)")
                    with self.lock:
                        self._reconnect_not_before = time.time() + reconnect_sleep
                # Disabled/invalid accounts should not spin in reconnect loops.
                if "Account is disabled" in msg or "Authorization failed" in msg:
                    with self.lock:
                        self.running = False
                    self._add_event("Bot stopped: authorization failed. Switch Demo/Real account or update API token.")
                    break
            if self._is_running():
                self._add_event("Reconnecting...")
                time.sleep(reconnect_sleep)

    def _run_session(self) -> None:
        ws, requires_authorize, account_hint = open_ws_for_token(
            self.api_token,
            timeout=15,
            account_id=self.active_account_id,
        )
        with self.lock:
            self.ws = ws
            self._ws_requires_authorize = requires_authorize
            self._session_account_hint = account_hint
        try:
            self._authorize(ws)
            if not requires_authorize:
                self._prime_pat_balance(ws)
            self._subscribe_ticks(ws)
            while self._is_running():
                raw = ws.recv()
                if not raw:
                    continue
                message = json.loads(raw)
                if "error" in message:
                    self._add_event(f"Stream error: {message['error'].get('message', 'unknown')}")
                    continue
                if message.get("msg_type") == "tick":
                    self._handle_tick(ws, message)
        except websocket.WebSocketException:
            self._add_event("WebSocket disconnected")
        finally:
            try:
                ws.close()
            except Exception:
                pass
            with self.lock:
                if self.ws is ws:
                    self.ws = None

    def _authorize(self, ws: websocket.WebSocket) -> None:
        if not self._ws_requires_authorize:
            self._add_event("Connected with OTP-authenticated WebSocket")
            return
        ws.send(json.dumps({"authorize": self.api_token}))
        response = json.loads(ws.recv())
        if "error" in response:
            msg = str(response["error"].get("message", "unknown"))
            if "input validation failed" in msg.lower() and "authorize" in msg.lower():
                raise RuntimeError(
                    f"Authorization failed: {msg}. "
                    "Use a PAT from developers.deriv.com (pat_…) or legacy Login with Deriv (acct/token), "
                    "not OAuth2 access_token alone."
                )
            raise RuntimeError(f"Authorization failed: {msg}")
        auth_data = response.get("authorize", {})
        with self.lock:
            self.balance = float(auth_data.get("balance", self.balance))
        self._add_event("Authorized successfully")

    def _subscribe_ticks(self, ws: websocket.WebSocket) -> None:
        ws.send(json.dumps({"ticks": "R_100", "subscribe": 1}))
        response = json.loads(ws.recv())
        if "error" in response:
            raise RuntimeError(f"Tick subscription failed: {response['error'].get('message', 'unknown')}")
        self._add_event("Subscribed to R_100 ticks")

    def _handle_tick(self, ws: websocket.WebSocket, message: Dict[str, object]) -> None:
        tick = message.get("tick", {})
        quote = tick.get("quote")
        if quote is None:
            return

        digit = self._extract_last_digit(quote)

        with self.lock:
            if self._trade_in_progress:
                return

        # Resolve research-mode hypothetical trade on next tick
        self._resolve_research_pending(digit)

        self.stats_engine.update(digit)
        with self.lock:
            if self._trade_in_progress:
                return
            self._tick_counter += 1
            self._ticks_since_last_trade += 1
            self.last_digits.append(digit)
            self.last_digits = self.last_digits[-3:]

        if not signal_engine.repeat3_trigger(self.last_digits):
            return

        with self.lock:
            if self._trade_in_progress or self._research_pending is not None:
                return

        if time.time() < self.hybrid_suppress_until:
            self._add_event("Hybrid: skipping auto trade (cooldown after manual)")
            with self.lock:
                self.last_digits = []
            return

        with self.lock:
            if self.user_paused:
                return

        with self.lock:
            strategy_snapshot = dict(self.strategy)
            research_mode = bool(strategy_snapshot.get("research_mode"))
            cooldown_cfg = dict(strategy_snapshot.get("cooldown") or {})
            cooldown_ticks = int(cooldown_cfg.get("cooldown_ticks", 10))
            pipe_ctx = PipelineContext(
                strategy=strategy_snapshot,
                stats=self.stats_engine,
                risk=self.risk_engine,
                last_digits=list(self.last_digits),
                api_token=str(self.api_token or ""),
                symbol="R_100",
                account_id=(self.active_account_id or "").strip() or None,
                session_pnl=float(self.profit),
                trades_count=int(self.trades_count),
                loss_streak=int(self.loss_streak),
                outcomes=list(self._recent_outcomes),
                take_profit=float(self.take_profit),
                stop_loss=float(self.stop_loss),
                ticks_since_last_trade=int(self._ticks_since_last_trade),
                cooldown_ticks=cooldown_ticks,
            )

        result = self.pipeline.evaluate(pipe_ctx)
        for line in result.log_lines:
            self._add_event(line)

        with self.lock:
            self._last_pipeline = {
                "approved": result.approved,
                "skip_reason": result.skip_reason,
                "decision": dict(result.decision) if result.decision else None,
            }
            if result.confluence:
                self._last_confluence = dict(result.confluence.snapshot)
            if result.probability:
                self._last_model_decision = {
                    "p_over": result.probability.p_over,
                    "p_under": result.probability.p_under,
                    "picked_prob": result.probability.picked_prob,
                    "side": result.probability.side,
                    "gate_enabled": result.probability.gate_enabled,
                }

        repeated_digit = self.last_digits[-1]
        audit_id = self._persist_audit_from_pipeline(
            result,
            repeated_digit,
            research_mode=research_mode,
            stake=0.0,
            payout_ratio=0.0,
            confluence_score=(
                result.confluence.snapshot.get("confidence")
                if result.confluence and result.confluence.snapshot
                else None
            ),
        )

        if not result.approved or not result.decision:
            self._record_pipeline_skip(result, repeated_digit)
            with self.lock:
                self.last_digits = []
                self.last_result = "no_trade"
            if result.risk and getattr(result.risk, "paused", False):
                self._add_event("Risk limit reached — bot paused")
                self.stop()
            return

        decision = result.decision
        contract_type = str(decision["contract_type"])
        barrier = decision.get("barrier")
        if barrier is not None:
            barrier = int(barrier)

        stake, stake_ok, stake_note = self._trade_stake_amount()
        if not stake_ok:
            self._add_event(stake_note)
            with self.lock:
                self.last_digits = []
                self.last_result = "no_trade"
            return
        if stake_note:
            self._add_event(stake_note)

        search_meta = decision.get("search_meta") if isinstance(decision.get("search_meta"), dict) else {}
        payout_ratio_est = float(search_meta.get("estimated_payout_ratio") or 0.0)
        conf_score = None
        if result.confluence and result.confluence.snapshot:
            conf_score = result.confluence.snapshot.get("confidence")

        if research_mode:
            self._add_event(
                f"[Research] SIGNAL {contract_type} barrier={barrier} stake={stake:.2f} (no live order)"
            )
            with self.lock:
                self._research_pending = {
                    "audit_id": audit_id,
                    "side": result.signal.side if result.signal else "OVER",
                    "barrier": barrier,
                    "contract_type": contract_type,
                    "stake": stake,
                    "repeated_digit": repeated_digit,
                    "payout_ratio": payout_ratio_est,
                    "trigger_digits": list(self.last_digits),
                }
                self._ticks_since_last_trade = 0
                self.last_digits = []
            return

        self._add_event(f"[Trade] BUY {contract_type} barrier={barrier} stake={stake:.2f}")
        trade_meta = {
            "trigger_digits": list(self.last_digits),
            "direction": result.signal.side if result.signal else None,
            "p_over": result.probability.p_over if result.probability else None,
            "p_under": result.probability.p_under if result.probability else None,
            "confluence_passed": bool(result.confluence.passed) if result.confluence else None,
            "regime": self.stats_engine.regime(),
            "search_meta": decision.get("search_meta"),
        }

        with self.lock:
            self._trade_in_progress = True
        try:
            payout, won, executed, duration_sec, err, payout_ratio, latency_ms = self._place_trade(
                ws, contract_type, barrier, stake
            )
        finally:
            with self.lock:
                self._trade_in_progress = False

        if executed:
            with self.lock:
                self._ticks_since_last_trade = 0
            trade_profit = round((payout - stake) if won else -stake, 2)
            if audit_id:
                try:
                    self.trade_audit.update_outcome(
                        audit_id,
                        result="win" if won else "loss",
                        profit_loss=trade_profit,
                        executed=True,
                    )
                except Exception as exc:
                    logger.warning("audit outcome update failed: %s", exc)
            self._apply_trade_result(
                stake=stake,
                payout=payout,
                won=won,
                digit=repeated_digit,
                source="bot",
                contract_type=contract_type,
                duration_sec=duration_sec,
                barrier=barrier,
                trade_meta=trade_meta,
                payout_ratio=payout_ratio,
                proposal_latency_ms=latency_ms,
            )
            self._check_limits_and_stop_if_needed()
        else:
            with self.lock:
                self.last_result = "no_trade"
            self._add_event(f"[Trade] FAILED ({err or 'proposal/buy issue'})")

        with self.lock:
            self.last_digits = []

    def _persist_audit_from_pipeline(
        self,
        pipeline_result: Any,
        repeated_digit: int,
        *,
        research_mode: bool = False,
        stake: float = 0.0,
        payout_ratio: float = 0.0,
        confluence_score: float | None = None,
        executed: bool = False,
        outcome: str | None = None,
        profit_loss: float = 0.0,
    ) -> int:
        """Write structured audit row for every pipeline decision."""
        sig = pipeline_result.signal
        prob = pipeline_result.probability
        decision = pipeline_result.decision or {}
        row = {
            "timestamp": time.time(),
            "trigger_digits": list(sig.signal_digits) if sig else [],
            "repeated_digit": repeated_digit,
            "side": sig.side if sig else None,
            "barrier": decision.get("barrier") if decision else (sig.barrier if sig else None),
            "contract_type": decision.get("contract_type") if decision else (sig.contract_type if sig else None),
            "probability_score": prob.picked_prob if prob else None,
            "confluence_score": confluence_score,
            "payout_ratio": payout_ratio,
            "stake": stake,
            "result": outcome or ("skip" if pipeline_result.skip_reason else "pending"),
            "profit_loss": profit_loss,
            "reason_skipped": pipeline_result.skip_reason or "",
            "probability_gate_passed": bool(prob.passed) if prob else False,
            "search_passed": bool(pipeline_result.pre_execution.passed)
            if pipeline_result.pre_execution
            else bool(pipeline_result.approved),
            "confluence_passed": bool(pipeline_result.confluence.passed) if pipeline_result.confluence else False,
            "risk_passed": bool(pipeline_result.risk.allowed) if pipeline_result.risk else bool(pipeline_result.approved),
            "executed": executed,
            "research_mode": research_mode,
            "payload": pipeline_result.signal_decision or {},
        }
        try:
            return self.trade_audit.record_decision(row)
        except Exception as exc:
            logger.warning("trade audit record failed: %s", exc)
            return 0

    def _resolve_research_pending(self, next_digit: int) -> None:
        with self.lock:
            pending = dict(self._research_pending) if self._research_pending else None
        if not pending:
            return

        side = str(pending.get("side") or "OVER")
        barrier = int(pending.get("barrier") or 0)
        stake = float(pending.get("stake") or 1.0)
        ratio = float(pending.get("payout_ratio") or 2.0)
        won = (next_digit < barrier) if side == "UNDER" else (next_digit > barrier)
        profit = round(stake * (ratio - 1.0), 2) if won else round(-stake, 2)
        payout = stake + profit if won else 0.0

        audit_id = int(pending.get("audit_id") or 0)
        if audit_id:
            try:
                self.trade_audit.update_outcome(
                    audit_id,
                    result="win" if won else "loss",
                    profit_loss=profit,
                    executed=True,
                )
            except Exception as exc:
                logger.warning("research audit update failed: %s", exc)

        self._add_event(
            f"[Research] RESOLVED {'WIN' if won else 'LOSS'} digit={next_digit} P/L={profit:+.2f}"
        )
        self._apply_trade_result(
            stake=stake,
            payout=payout,
            won=won,
            digit=int(pending.get("repeated_digit") or next_digit),
            source="research",
            contract_type=str(pending.get("contract_type") or ""),
            duration_sec=0.0,
            barrier=barrier,
            trade_meta={
                "trigger_digits": pending.get("trigger_digits") or [],
                "direction": side,
                "regime": self.stats_engine.regime(),
                "research_mode": True,
            },
            payout_ratio=ratio,
        )
        with self.lock:
            self._research_pending = None
            self._ticks_since_last_trade = 0


    def _record_pipeline_skip(self, result: Any, repeated_digit: int) -> None:
        if not result.skip_reason:
            return
        try:
            self.analytics.record_skip(
                {
                    "ts": time.time(),
                    "source": "bot",
                    "trigger_digits": list(self.last_digits),
                    "direction": result.signal.side if result.signal else None,
                    "contract_type": (result.decision or {}).get("contract_type"),
                    "barrier": (result.decision or {}).get("barrier"),
                    "repeated_digit": repeated_digit,
                    "regime": self.stats_engine.regime(),
                    "skip_reason": result.skip_reason,
                    "p_over": result.probability.p_over if result.probability else None,
                    "p_under": result.probability.p_under if result.probability else None,
                    "confluence_passed": bool(result.confluence.passed) if result.confluence else False,
                    "payload": {"pipeline": True},
                }
            )
        except Exception as exc:
            logger.warning("analytics skip record failed: %s", exc)

    def _place_trade(
        self, ws: websocket.WebSocket, contract_type: str, barrier: int | None, stake: float
    ) -> tuple[float, bool, bool, float, str, float, int]:
        return self._place_trade_on_socket(
            ws,
            contract_type,
            barrier,
            stake,
            "R_100",
            include_symbol=self._ws_requires_authorize,
            duration_ticks=1,
            enforce_execution_filter=True,
        )

    def _place_trade_standalone(
        self,
        api_token: str,
        contract_type: str,
        barrier: int | None,
        stake: float,
        symbol: str,
        *,
        duration_ticks: int = 1,
        enforce_execution_filter: bool = False,
    ) -> tuple[float, bool, bool, float, str, float, int]:
        with self._manual_ws_lock:
            ws, requires_authorize = self._ensure_manual_trading_ws_unlocked(api_token)
            try:
                return self._place_trade_on_socket(
                    ws,
                    contract_type,
                    barrier,
                    stake,
                    symbol,
                    include_symbol=requires_authorize,
                    duration_ticks=int(duration_ticks),
                    enforce_execution_filter=enforce_execution_filter,
                )
            except websocket.WebSocketException:
                self._invalidate_manual_trading_socket_unlocked()
                return 0.0, False, False, 0.0, "WebSocket disconnected", 0.0, 0

    def _place_trade_on_socket(
        self,
        ws: websocket.WebSocket,
        contract_type: str,
        barrier: int | None,
        stake: float,
        symbol: str,
        *,
        include_symbol: bool = True,
        duration_ticks: int = 1,
        enforce_execution_filter: bool = True,
    ) -> tuple[float, bool, bool, float, str, float, int]:
        started_at = time.time()
        proposal_sent_at = time.time()
        def _recv_until(expected_msg_type: str, max_reads: int = 32) -> Dict[str, object]:
            last: Dict[str, object] = {}
            for _ in range(max_reads):
                raw = ws.recv()
                if not raw:
                    continue
                msg = json.loads(raw)
                if "error" in msg:
                    return msg
                if msg.get("msg_type") == expected_msg_type:
                    return msg
                last = msg
            return last

        proposal_payload = {
            "proposal": 1,
            "amount": round(stake, 2),
            "basis": "stake",
            "contract_type": contract_type,
            "currency": "USD",
            "duration": max(1, int(duration_ticks)),
            "duration_unit": "t",
        }
        if include_symbol:
            proposal_payload["symbol"] = symbol
        else:
            proposal_payload["underlying_symbol"] = symbol
        if barrier is not None:
            b = int(barrier)
            if contract_type in {"DIGITOVER", "DIGITUNDER", "DIGITMATCH"}:
                b = payout_search.clamp_digit_barrier(b)
            proposal_payload["barrier"] = str(b)
        ws.send(json.dumps(proposal_payload))
        proposal_resp = _recv_until("proposal")
        if "error" in proposal_resp:
            msg = proposal_resp["error"].get("message", "proposal failed")
            self._add_event(f"Proposal error: {msg}")
            return 0.0, False, False, 0.0, msg, 0.0, 0
        proposal = proposal_resp.get("proposal", {})
        proposal_id = proposal.get("id")
        if not proposal_id:
            return 0.0, False, False, 0.0, "No proposal id returned", 0.0, 0
        ask_price = float(proposal.get("ask_price", stake) or stake)
        payout_preview = float(proposal.get("payout", 0.0) or 0.0)
        proposal_latency_ms = int((time.time() - proposal_sent_at) * 1000)
        payout_ratio = (payout_preview / ask_price) if ask_price > 0 else 0.0
        if enforce_execution_filter:
            with self.lock:
                execution_cfg = dict((self.strategy.get("execution") or {}))
            validation = execution_engine.validate_live_proposal(
                proposal=proposal,
                stake=stake,
                execution_cfg=execution_cfg,
                proposal_latency_ms=proposal_latency_ms,
            )
            for line in validation.log_lines:
                self._add_event(line)
            if not validation.passed:
                return 0.0, False, False, 0.0, validation.skip_reason, validation.payout_ratio, proposal_latency_ms
            payout_ratio = validation.payout_ratio
        else:
            with self.lock:
                min_bot = float((self.strategy.get("execution") or {}).get("min_payout_to_stake", 1.75))
            self._add_event(
                f"Manual: payout ratio {payout_ratio:.2f} (bot filter skipped; auto-bot still uses min {min_bot:.2f})"
            )

        ws.send(json.dumps({"buy": proposal_id, "price": round(stake, 2)}))
        buy_resp = _recv_until("buy")
        if "error" in buy_resp:
            msg = buy_resp["error"].get("message", "buy failed")
            self._add_event(f"Buy error: {msg}")
            return 0.0, False, False, 0.0, msg, payout_ratio, proposal_latency_ms
        buy = buy_resp.get("buy", {})
        contract_id = buy.get("contract_id")
        if not contract_id:
            return 0.0, False, False, 0.0, "No contract id returned", payout_ratio, proposal_latency_ms

        self._push_trade_alert(
            "opened",
            "Contract purchased",
            (
                f"{contract_type} · {symbol} · stake {round(stake, 2)} USD · barrier {barrier}"
                if barrier is not None
                else f"{contract_type} · {symbol} · stake {round(stake, 2)} USD"
            ),
            contract_type=contract_type,
            symbol=symbol,
            stake=round(float(stake), 2),
            barrier=barrier,
        )

        ws.send(json.dumps({"proposal_open_contract": 1, "contract_id": contract_id, "subscribe": 1}))

        while True:
            update_raw = ws.recv()
            update = json.loads(update_raw)
            if update.get("msg_type") != "proposal_open_contract":
                continue
            contract = update.get("proposal_open_contract", {})
            if not contract.get("is_sold"):
                continue
            profit = float(contract.get("profit", 0.0))
            payout = float(contract.get("payout", 0.0))
            won = profit > 0
            if won and payout <= 0:
                payout = stake + profit
            self._add_event(f"Trade {'WIN' if won else 'LOSS'} | profit {round(profit, 2)}")
            duration_sec = max(0.0, time.time() - started_at)
            return payout, won, True, duration_sec, "", payout_ratio, proposal_latency_ms

    def _apply_trade_result(
        self,
        stake: float,
        payout: float,
        won: bool,
        digit: int,
        source: str = "bot",
        contract_type: str | None = None,
        duration_sec: float | None = None,
        barrier: int | None = None,
        trade_meta: Dict[str, object] | None = None,
        payout_ratio: float = 0.0,
        proposal_latency_ms: int = 0,
    ) -> None:
        trade_profit = round((payout - stake) if won else -stake, 2)
        with self.lock:
            self.profit = round(self.profit + trade_profit, 2)
            self.balance = round(self.balance + trade_profit, 2)
            self.last_result = "win" if won else "loss"
            self.trades_count += 1
            entry = {
                "digit": digit,
                "result": self.last_result,
                "profit": trade_profit,
                "stake": round(float(stake), 2),
                "contract_type": contract_type,
                "duration_sec": round(float(duration_sec), 2) if duration_sec is not None else None,
                "timestamp": time.strftime("%H:%M:%S"),
                "source": source,
            }
            self.trade_history.append(entry)
            self.trade_history = self.trade_history[-20:]
            self._recent_outcomes.append(self.last_result)
            self._recent_outcomes = self._recent_outcomes[-100:]
            if won:
                self.loss_streak = 0
            else:
                self.loss_streak += 1
            if bool(getattr(app_config, "MARTINGALE_ON_LOSS", False)):
                if won:
                    self.martingale_step = 0
                    self.current_stake = self.base_stake
                elif self.martingale_step < self.max_martingale_steps:
                    self.martingale_step += 1
                    self.current_stake = round(self.base_stake * (2**self.martingale_step), 2)
            else:
                self.martingale_step = 0
                self.current_stake = self.base_stake

        duration_text = f" in {float(duration_sec):.2f}s" if duration_sec is not None else ""
        profit_line = f"{trade_profit:+.2f} USD{duration_text}"
        self._push_trade_alert(
            "closed",
            "You won" if won else "You lost",
            profit_line,
            won=won,
            profit=trade_profit,
            duration_sec=round(float(duration_sec), 2) if duration_sec is not None else None,
            source=source,
        )

        if source == "bot":
            try:
                copy_trading.notify_master_trade(
                    {"digit": digit, "result": "win" if won else "loss", "profit": trade_profit}
                )
            except Exception as exc:
                logger.warning("copy_trading notify failed: %s", exc)
        meta = trade_meta or {}
        try:
            self.journal.log_trade(
                {
                    "ts": time.time(),
                    "source": source,
                    "contract_type": contract_type,
                    "barrier": barrier if barrier is not None else digit,
                    "stake": stake,
                    "payout": payout,
                    "profit": trade_profit,
                    "result": "win" if won else "loss",
                    "digit": digit,
                    "duration_sec": duration_sec,
                    "signal_json": json.dumps(self._last_model_decision or {}),
                    "stats_json": json.dumps(self.stats_engine.snapshot()),
                }
            )
        except Exception as exc:
            logger.warning("trade journal write failed: %s", exc)
        try:
            self.analytics.record_trade(
                {
                    "ts": time.time(),
                    "source": source,
                    "trigger_digits": meta.get("trigger_digits") or [],
                    "direction": meta.get("direction"),
                    "contract_type": contract_type,
                    "barrier": barrier,
                    "repeated_digit": digit,
                    "stake": stake,
                    "payout": payout,
                    "profit": trade_profit,
                    "result": "win" if won else "loss",
                    "payout_ratio": payout_ratio,
                    "p_over": meta.get("p_over"),
                    "p_under": meta.get("p_under"),
                    "confluence_passed": meta.get("confluence_passed"),
                    "proposal_latency_ms": proposal_latency_ms,
                    "duration_sec": duration_sec,
                    "regime": meta.get("regime"),
                    "payload": {"search_meta": meta.get("search_meta"), "model": self._last_model_decision},
                }
            )
        except Exception as exc:
            logger.warning("analytics record failed: %s", exc)

    def _check_limits_and_stop_if_needed(self) -> None:
        with self.lock:
            risk = self.risk_engine.check(
                trades_count=self.trades_count,
                loss_streak=self.loss_streak,
                session_pnl=self.profit,
                outcomes=self._recent_outcomes,
                stats_regime=self.stats_engine.regime(),
                take_profit=self.take_profit,
                stop_loss=self.stop_loss,
            )
        if not risk.allowed:
            for line in risk.log_lines:
                self._add_event(line)
            self._add_event("Risk limit reached — stopping bot")
            self.stop()

    @staticmethod
    def _extract_last_digit(quote: object) -> int:
        text = f"{float(quote):.5f}"
        return int(text[-1])

    def _is_running(self) -> bool:
        with self.lock:
            return self.running

    def _add_event(self, message: str) -> None:
        timestamp = time.strftime("%H:%M:%S")
        with self.lock:
            self.events.append(f"[{timestamp}] {message}")
            self.events = self.events[-80:]
            self._events_seq += 1
            self._event_rows.append({"seq": self._events_seq, "ts": timestamp, "message": message})
            self._event_rows = self._event_rows[-500:]
        logger.debug("%s", message)

    def _push_trade_alert(self, kind: str, title: str, body: str, **extra: object) -> None:
        with self.lock:
            self._trade_alert_seq += 1
            payload: Dict[str, object] = {
                "seq": self._trade_alert_seq,
                "kind": kind,
                "title": title,
                "body": body,
            }
            payload.update(extra)
            self._last_trade_alert = payload

