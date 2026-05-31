"""Session risk controls: drawdown, loss streaks, trade limits, volatility lockout."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence


DEFAULT_RISK_CFG: Dict[str, Any] = {
    "max_consecutive_losses": 2,
    "max_session_drawdown_pct": 10.0,
    "max_trades_per_session": 50,
    "loss_cluster_window": 8,
    "loss_cluster_limit": 6,
    "volatility_lockout_regime": "volatile",
    "volatility_lockout_enabled": True,
    "session_stop_loss_usd": None,
}


@dataclass
class RiskCheckResult:
    allowed: bool
    log_lines: List[str]
    reason: str = ""
    paused: bool = False


class SessionRiskEngine:
    """Configurable session risk gate (strategy.risk + legacy quant limits)."""

    def __init__(self, risk_cfg: Dict[str, Any] | None = None) -> None:
        self.configure(risk_cfg)
        self.session_start_equity = 0.0
        self._paused = False
        self._pause_reason = ""

    def configure(self, risk_cfg: Dict[str, Any] | None = None) -> None:
        cfg = {**DEFAULT_RISK_CFG, **(risk_cfg or {})}
        self.max_consecutive_losses = int(cfg["max_consecutive_losses"])
        self.max_session_drawdown_pct = float(cfg["max_session_drawdown_pct"])
        self.max_trades_per_session = int(cfg["max_trades_per_session"])
        self.loss_cluster_window = int(cfg["loss_cluster_window"])
        self.loss_cluster_limit = int(cfg["loss_cluster_limit"])
        self.volatility_lockout_regime = str(cfg["volatility_lockout_regime"]).strip().lower()
        self.volatility_lockout_enabled = bool(cfg["volatility_lockout_enabled"])
        raw_sl = cfg.get("session_stop_loss_usd")
        self.session_stop_loss_usd = float(raw_sl) if raw_sl is not None else None

    def start_session(self, starting_balance: float) -> None:
        self.session_start_equity = max(0.0, float(starting_balance))
        self._paused = False
        self._pause_reason = ""

    def suggested_stake(self, balance: float, base_stake: float, fractional_risk: float = 0.01) -> float:
        bal = max(0.0, float(balance))
        frac_size = bal * fractional_risk
        if frac_size <= 0:
            return round(max(0.35, float(base_stake)), 2)
        return round(max(0.35, min(float(base_stake), frac_size)), 2)

    @property
    def paused(self) -> bool:
        return self._paused

    @property
    def pause_reason(self) -> str:
        return self._pause_reason

    def session_drawdown_pct(self, session_pnl: float) -> float:
        if self.session_start_equity <= 0:
            return 0.0
        return round(max(0.0, -float(session_pnl)) / self.session_start_equity * 100.0, 2)

    def check(
        self,
        *,
        trades_count: int,
        loss_streak: int,
        session_pnl: float,
        outcomes: Sequence[str],
        stats_regime: str,
        take_profit: float | None = None,
        stop_loss: float | None = None,
    ) -> RiskCheckResult:
        if self._paused:
            return RiskCheckResult(
                allowed=False,
                log_lines=["[Risk]", f"PAUSED: {self._pause_reason}"],
                reason=self._pause_reason,
                paused=True,
            )

        dd_pct = self.session_drawdown_pct(session_pnl)
        lines = [
            "[Risk]",
            f"SessionDrawdown={dd_pct:.1f}%",
            f"ConsecutiveLosses={loss_streak}",
            f"Trades={trades_count}/{self.max_trades_per_session}",
        ]

        if int(trades_count) >= self.max_trades_per_session:
            reason = "max trades per session reached"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason, paused=True)

        if int(loss_streak) >= self.max_consecutive_losses:
            reason = "consecutive losses exceeded"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason, paused=True)

        if self.session_start_equity > 0 and dd_pct >= self.max_session_drawdown_pct:
            reason = f"session drawdown {dd_pct:.1f}% >= {self.max_session_drawdown_pct:.1f}%"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason, paused=True)

        if self.session_stop_loss_usd is not None and session_pnl <= -abs(self.session_stop_loss_usd):
            reason = "session stop-loss USD reached"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason, paused=True)

        if stop_loss is not None and session_pnl <= float(stop_loss):
            reason = "dashboard stop-loss reached"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason, paused=True)

        if take_profit is not None and session_pnl >= float(take_profit):
            reason = "take-profit reached"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason, paused=True)

        recent = list(outcomes)[-self.loss_cluster_window :]
        if recent and sum(1 for x in recent if x == "loss") >= self.loss_cluster_limit:
            reason = "loss clustering detected"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason, paused=True)

        if self.volatility_lockout_enabled and stats_regime == self.volatility_lockout_regime:
            reason = f"volatility lockout ({stats_regime})"
            lines.append(f"BLOCKED: {reason}")
            return RiskCheckResult(allowed=False, log_lines=lines, reason=reason)

        lines.append("PASSED")
        return RiskCheckResult(allowed=True, log_lines=lines)

    def mark_paused(self, reason: str) -> None:
        self._paused = True
        self._pause_reason = reason

    def snapshot(self) -> Dict[str, Any]:
        return {
            "paused": self._paused,
            "pause_reason": self._pause_reason,
            "max_consecutive_losses": self.max_consecutive_losses,
            "max_session_drawdown_pct": self.max_session_drawdown_pct,
            "max_trades_per_session": self.max_trades_per_session,
            "loss_cluster_window": self.loss_cluster_window,
            "loss_cluster_limit": self.loss_cluster_limit,
            "volatility_lockout_regime": self.volatility_lockout_regime,
            "volatility_lockout_enabled": self.volatility_lockout_enabled,
            "session_start_equity": round(self.session_start_equity, 2),
        }
