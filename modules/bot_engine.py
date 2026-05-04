"""Deriv bot runtime: WebSocket session, digit strategy, hybrid manual override, copy hooks."""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Dict, List, Optional

import websocket

from config import API_TOKEN, BASE_STAKE, DERIV_WS_APP_ID, STOP_LOSS, TAKE_PROFIT

from modules.deriv_auth import get_legacy_ws_url, open_ws_for_token
from modules import copy_trading, over_under_strategy_engine, strategy_engine

logger = logging.getLogger(__name__)


def _deriv_ws_url() -> str:
    _ = DERIV_WS_APP_ID  # keep config import explicit for diagnostics/UI
    return get_legacy_ws_url()


class DerivBot:
    """Thread-safe Deriv digit strategy bot with dashboard, hybrid pause, and copy-trading hooks."""

    WS_URL = _deriv_ws_url()

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.running = False
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
        self.hybrid_suppress_until = 0.0
        self._trade_alert_seq = 0
        self._last_trade_alert: Optional[Dict[str, object]] = None
        self._last_confluence: Optional[Dict[str, object]] = None

        self.loss_streak = 0
        self.martingale_step = 0
        self.max_martingale_steps = 2

        self.strategy = strategy_engine.load_strategy()

        # Warm WebSocket for manual quote/trade (avoids TCP+authorize on every click).
        self._manual_ws_lock = threading.Lock()
        self._manual_ws: Optional[websocket.WebSocket] = None
        self._manual_ws_token: Optional[str] = None
        self._manual_ws_requires_authorize = True

    def start(self) -> bool:
        with self.lock:
            if self.running:
                return False
            self.running = True
            self._reset_runtime_state()
            self.thread = threading.Thread(target=self._run_loop, daemon=True)
            self.thread.start()
            logger.info("Bot thread started")
            return True

    def stop(self) -> bool:
        with self.lock:
            if not self.running:
                return False
            self.running = False
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

    def status(self) -> Dict[str, object]:
        with self.lock:
            active: List[Dict[str, object]] = []
            if self._trade_in_progress:
                active.append({"type": "digit", "state": "executing"})
            paused = time.time() < self.hybrid_suppress_until
            return {
                "running": self.running,
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
                "last_trade_alert": dict(self._last_trade_alert) if self._last_trade_alert else None,
                "confluence": dict(self._last_confluence) if self._last_confluence else None,
            }

    def history(self) -> List[Dict[str, object]]:
        with self.lock:
            return list(self.trade_history[-20:])

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

    def save_strategy(self, strategy: Dict[str, object]) -> Dict[str, object]:
        validated = strategy_engine.save_strategy(strategy)
        with self.lock:
            self.strategy = validated
            self._add_event("Strategy updated from builder")
        return validated

    def load_strategy(self) -> Dict[str, object]:
        with self.lock:
            return dict(self.strategy)

    def reload_strategy_from_disk(self) -> None:
        with self.lock:
            self.strategy = strategy_engine.load_strategy()
            self._add_event("Strategy reloaded from disk")

    def manual_trade(
        self, contract_type: str, barrier: int, stake: float, symbol: str = "R_100"
    ) -> Dict[str, object]:
        """One-off digit trade via a reused WebSocket when possible (faster than new TCP per click). Hybrid pause applies."""
        token = self.api_token
        with self.lock:
            token = self.api_token
        self._add_event(f"Manual trade requested: {contract_type} barrier={barrier} stake={stake}")
        try:
            payout, won, executed, duration_sec, err = self._place_trade_standalone(
                token, contract_type, barrier, float(stake), symbol
            )
        except Exception as exc:
            logger.exception("Manual trade failed")
            return {"success": False, "error": str(exc)}
        if not executed:
            self._invalidate_manual_trading_socket()
            # A brief retry helps in transient pricing/proposal races.
            try:
                payout, won, executed, duration_sec, err_retry = self._place_trade_standalone(
                    token, contract_type, barrier, float(stake), symbol
                )
                if not executed:
                    return {"success": False, "error": err_retry or err or "Trade not executed"}
            except Exception:
                return {"success": False, "error": err or "Trade not executed"}
        digit = int(barrier)
        self._apply_trade_result(
            stake=float(stake),
            payout=payout,
            won=won,
            digit=digit,
            source="manual",
            contract_type=contract_type,
            duration_sec=duration_sec,
        )
        with self.lock:
            self.hybrid_suppress_until = time.time() + 45.0
        self._add_event("Hybrid: auto-bot signals paused ~45s after manual trade")
        return {
            "success": True,
            "won": won,
            "payout": round(payout, 2),
            "profit_delta": round((payout - float(stake)) if won else -float(stake), 2),
            "duration_sec": round(float(duration_sec), 2),
        }

    def manual_quote(
        self, contract_type: str, barrier: int, stake: float, symbol: str = "R_100"
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
                    "duration": 1,
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
        self._trade_alert_seq = 0
        self._last_trade_alert = None
        self._last_confluence = None
        self._add_event("Bot started")

    def _run_loop(self) -> None:
        while self._is_running():
            try:
                self._run_session()
            except Exception as exc:
                msg = str(exc)
                self._add_event(f"Session error: {msg}")
                logger.exception("Session error")
                # Disabled/invalid accounts should not spin in reconnect loops.
                if "Account is disabled" in msg or "Authorization failed" in msg:
                    with self.lock:
                        self.running = False
                    self._add_event("Bot stopped: authorization failed. Switch Demo/Real account or update API token.")
                    break
            if self._is_running():
                self._add_event("Reconnecting...")
                time.sleep(2)

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
            raise RuntimeError(f"Authorization failed: {response['error'].get('message', 'unknown')}")
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
            self.last_digits.append(digit)
            self.last_digits = self.last_digits[-3:]
            trigger = len(self.last_digits) == 3 and len(set(self.last_digits)) == 1

        if not trigger:
            return

        if time.time() < self.hybrid_suppress_until:
            self._add_event("Hybrid: skipping auto trade (cooldown after manual)")
            with self.lock:
                self.last_digits = []
            return

        with self.lock:
            repeated_digit = self.last_digits[-1]
            stake = self.current_stake
            signal_digits = list(self.last_digits)

        decision = self._build_trade_decision(repeated_digit)
        if not decision:
            self._add_event("Strategy conditions not met; no trade")
            with self.lock:
                self.last_digits = []
                self.last_result = "no_trade"
            return

        contract_type = decision["contract_type"]
        barrier = decision.get("barrier")
        decision_label = f"{contract_type} barrier {barrier}" if barrier is not None else f"{contract_type}"
        self._add_event(f"Signal {signal_digits} -> {decision_label} stake {stake}")

        side = "OVER" if contract_type == "DIGITOVER" else "UNDER"
        with self.lock:
            conf_cfg = dict(self.strategy.get("confluence") or {})
        if contract_type in {"DIGITOVER", "DIGITUNDER"}:
            enforce_confluence = bool(conf_cfg.get("enforce_confluence", False))
            try:
                cres = over_under_strategy_engine.run_confluence(self.api_token, "R_100", side, conf_cfg)
            except Exception as exc:
                logger.exception("Confluence evaluation failed")
                cres = {
                    "confluence_enabled": True,
                    "entry_allowed": False,
                    "signal": "NONE",
                    "confidence": 0.0,
                    "reasons": [f"Engine error: {exc}"],
                    "marketMode": "CHOP",
                    "over_score": 0.0,
                    "under_score": 0.0,
                    "confirmations": 0,
                }
            snap: Dict[str, object] = {
                "signal": cres.get("signal"),
                "confidence": cres.get("confidence"),
                "marketMode": cres.get("marketMode"),
                "entry_allowed": cres.get("entry_allowed"),
                "base_side": side,
                "over_score": cres.get("over_score"),
                "under_score": cres.get("under_score"),
                "confirmations": cres.get("confirmations"),
                "enabled": cres.get("confluence_enabled"),
                "reasons": list(cres.get("reasons") or [])[-24:],
            }
            with self.lock:
                self._last_confluence = snap
            for line in (cres.get("reasons") or [])[-8:]:
                self._add_event(line)
            if cres.get("confluence_enabled") and not cres.get("entry_allowed"):
                if enforce_confluence:
                    self._add_event("Confluence: entry not allowed — skipping trade")
                    with self.lock:
                        self.last_digits = []
                        self.last_result = "no_trade"
                    return
                self._add_event("Confluence advisory: not allowed, but trading base Over/Under signal")
        else:
            # Rise/Fall and other non-digit contracts are independent from Over/Under confluence filters.
            with self.lock:
                self._last_confluence = {
                    "enabled": False,
                    "entry_allowed": True,
                    "signal": "N/A",
                    "confidence": 0.0,
                    "marketMode": "N/A",
                    "base_side": "N/A",
                    "reasons": ["Confluence applies to Over/Under only."],
                }

        with self.lock:
            self._trade_in_progress = True
        try:
            payout, won, executed, duration_sec, err = self._place_trade(ws, contract_type, barrier, stake)
        finally:
            with self.lock:
                self._trade_in_progress = False

        if executed:
            self._apply_trade_result(
                stake=stake,
                payout=payout,
                won=won,
                digit=repeated_digit,
                source="bot",
                contract_type=contract_type,
                duration_sec=duration_sec,
            )
            self._check_limits_and_stop_if_needed()
        else:
            with self.lock:
                self.last_result = "no_trade"
            self._add_event(f"No trade executed ({err or 'proposal/buy issue'})")

        with self.lock:
            self.last_digits = []

    def _place_trade(
        self, ws: websocket.WebSocket, contract_type: str, barrier: int | None, stake: float
    ) -> tuple[float, bool, bool, float, str]:
        return self._place_trade_on_socket(
            ws,
            contract_type,
            barrier,
            stake,
            "R_100",
            include_symbol=self._ws_requires_authorize,
        )

    def _place_trade_standalone(
        self, api_token: str, contract_type: str, barrier: int | None, stake: float, symbol: str
    ) -> tuple[float, bool, bool, float, str]:
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
                )
            except websocket.WebSocketException:
                self._invalidate_manual_trading_socket_unlocked()
                return 0.0, False, False, 0.0, "WebSocket disconnected"

    def _place_trade_on_socket(
        self,
        ws: websocket.WebSocket,
        contract_type: str,
        barrier: int | None,
        stake: float,
        symbol: str,
        *,
        include_symbol: bool = True,
    ) -> tuple[float, bool, bool, float, str]:
        started_at = time.time()
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
            "duration": 1,
            "duration_unit": "t",
        }
        if include_symbol:
            proposal_payload["symbol"] = symbol
        else:
            proposal_payload["underlying_symbol"] = symbol
        if barrier is not None:
            proposal_payload["barrier"] = str(int(barrier))
        ws.send(json.dumps(proposal_payload))
        proposal_resp = _recv_until("proposal")
        if "error" in proposal_resp:
            msg = proposal_resp["error"].get("message", "proposal failed")
            self._add_event(f"Proposal error: {msg}")
            return 0.0, False, False, 0.0, msg
        proposal = proposal_resp.get("proposal", {})
        proposal_id = proposal.get("id")
        if not proposal_id:
            return 0.0, False, False, 0.0, "No proposal id returned"

        ws.send(json.dumps({"buy": proposal_id, "price": round(stake, 2)}))
        buy_resp = _recv_until("buy")
        if "error" in buy_resp:
            msg = buy_resp["error"].get("message", "buy failed")
            self._add_event(f"Buy error: {msg}")
            return 0.0, False, False, 0.0, msg
        buy = buy_resp.get("buy", {})
        contract_id = buy.get("contract_id")
        if not contract_id:
            return 0.0, False, False, 0.0, "No contract id returned"

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
            return payout, won, True, duration_sec, ""

    def _apply_trade_result(
        self,
        stake: float,
        payout: float,
        won: bool,
        digit: int,
        source: str = "bot",
        contract_type: str | None = None,
        duration_sec: float | None = None,
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
            if won:
                self.loss_streak = 0
                self.martingale_step = 0
                self.current_stake = self.base_stake
            else:
                self.loss_streak += 1
                if self.martingale_step < self.max_martingale_steps:
                    self.martingale_step += 1
                    self.current_stake = round(self.base_stake * (2**self.martingale_step), 2)

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

    def _check_limits_and_stop_if_needed(self) -> None:
        with self.lock:
            stop_due_to_losses = self.loss_streak >= 2
            stop_due_to_profit = self.profit >= self.take_profit
            stop_due_to_drawdown = self.profit <= self.stop_loss
        if stop_due_to_losses or stop_due_to_profit or stop_due_to_drawdown:
            self._add_event("Risk limit reached")
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

    def _build_trade_decision(self, repeated_digit: int) -> Optional[Dict[str, object]]:
        with self.lock:
            strategy = self.strategy
        if strategy.get("type") != "digit_strategy":
            return None
        if strategy.get("condition") != "repeat_3":
            return None
        active_action = str(strategy.get("active_action") or strategy.get("action") or "over_under").strip().lower()
        if active_action not in {"over_under", "rise_fall"}:
            return None
        actions = strategy.get("actions") if isinstance(strategy.get("actions"), dict) else {}
        action_cfg = actions.get(active_action) if isinstance(actions, dict) else None
        if not isinstance(action_cfg, dict):
            # Backward compatibility with older strategy shape.
            action_cfg = {"enabled": True, "rules": strategy.get("rules", {})}
        if not bool(action_cfg.get("enabled", True)):
            return None
        rules = action_cfg.get("rules", {})
        if not isinstance(rules, dict):
            rules = {}
        threshold = int(rules.get("if_digit_greater_equal", 5))
        defaults = {"over_under": ("UNDER", "OVER"), "rise_fall": ("RISE", "FALL")}
        default_trade, default_else_trade = defaults[active_action]
        high_trade = str(rules.get("trade", default_trade)).upper()
        low_trade = str(rules.get("else_trade", default_else_trade)).upper()
        selected = high_trade if repeated_digit >= threshold else low_trade
        if active_action == "over_under":
            if selected not in {"UNDER", "OVER"}:
                return None
            return {
                "contract_type": "DIGITUNDER" if selected == "UNDER" else "DIGITOVER",
                "barrier": repeated_digit,
            }
        if selected not in {"RISE", "FALL"}:
            return None
        return {
            "contract_type": "CALL" if selected == "RISE" else "PUT",
            "barrier": None,
        }
