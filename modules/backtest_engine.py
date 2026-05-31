"""Production-accurate backtester — next-tick resolution, same pipeline as live."""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Sequence

from modules import payout_search
from modules.quant_engine import DigitStatsEngine
from modules.risk_engine import SessionRiskEngine
from modules.trade_pipeline import PipelineContext, TradePipeline


@dataclass
class BacktestTrade:
    trigger_index: int
    resolve_index: int
    repeated_digit: int
    side: str
    barrier: int
    contract_type: str
    won: bool
    stake: float
    payout_ratio: float
    profit: float


@dataclass
class BacktestResult:
    trades: List[BacktestTrade] = field(default_factory=list)
    skipped: int = 0
    triggers: int = 0

    @property
    def total_trades(self) -> int:
        return len(self.trades)

    @property
    def wins(self) -> int:
        return sum(1 for t in self.trades if t.won)

    @property
    def losses(self) -> int:
        return self.total_trades - self.wins

    @property
    def win_rate(self) -> float:
        return self.wins / self.total_trades if self.total_trades else 0.0

    @property
    def net_pnl(self) -> float:
        return sum(t.profit for t in self.trades)

    @property
    def profit_factor(self) -> float | None:
        gross_win = sum(t.profit for t in self.trades if t.won)
        gross_loss = abs(sum(t.profit for t in self.trades if not t.won))
        if gross_loss <= 0:
            return None if gross_win <= 0 else float("inf")
        return gross_win / gross_loss

    @property
    def expectancy(self) -> float:
        return self.net_pnl / self.total_trades if self.total_trades else 0.0

    def max_drawdown(self) -> float:
        eq = 0.0
        peak = 0.0
        max_dd = 0.0
        for t in self.trades:
            eq += t.profit
            peak = max(peak, eq)
            max_dd = max(max_dd, peak - eq)
        return max_dd

    def streak_stats(self) -> Dict[str, float]:
        if not self.trades:
            return {"avg_win_streak": 0.0, "avg_loss_streak": 0.0, "max_loss_streak": 0}
        win_streaks: List[int] = []
        loss_streaks: List[int] = []
        cur_w = cur_l = 0
        for t in self.trades:
            if t.won:
                if cur_l:
                    loss_streaks.append(cur_l)
                    cur_l = 0
                cur_w += 1
            else:
                if cur_w:
                    win_streaks.append(cur_w)
                    cur_w = 0
                cur_l += 1
        if cur_w:
            win_streaks.append(cur_w)
        if cur_l:
            loss_streaks.append(cur_l)
        return {
            "avg_win_streak": round(sum(win_streaks) / len(win_streaks), 2) if win_streaks else 0.0,
            "avg_loss_streak": round(sum(loss_streaks) / len(loss_streaks), 2) if loss_streaks else 0.0,
            "max_loss_streak": max(loss_streaks) if loss_streaks else 0,
        }

    def to_dict(self) -> Dict[str, Any]:
        pf = self.profit_factor
        streaks = self.streak_stats()
        return {
            "total_trades": self.total_trades,
            "wins": self.wins,
            "losses": self.losses,
            "win_rate": round(self.win_rate, 4),
            "profit_factor": round(pf, 4) if pf is not None and pf != float("inf") else pf,
            "expectancy": round(self.expectancy, 4),
            "net_pnl": round(self.net_pnl, 2),
            "max_drawdown": round(self.max_drawdown(), 2),
            "triggers_seen": self.triggers,
            "signals_skipped": self.skipped,
            **streaks,
        }


def _resolve_win(side: str, barrier: int, next_digit: int) -> bool:
    if side == "UNDER":
        return next_digit < barrier
    return next_digit > barrier


def run_pipeline_backtest(
    digits: Sequence[int],
    strategy: Dict[str, Any],
    *,
    stake: float = 1.0,
    skip_confluence: bool = True,
    starting_balance: float = 1000.0,
    take_profit: float = 500.0,
    stop_loss: float = -200.0,
) -> BacktestResult:
    """
    Replay digit stream through TradePipeline.
    Signal on tick i; outcome evaluated on tick i+1 (next-tick resolution).
    """
    pipeline = TradePipeline()
    stats = DigitStatsEngine()
    risk_cfg = dict(strategy.get("risk") or {})
    # Simulation should not permanently pause after consecutive losses.
    risk_cfg["max_consecutive_losses"] = max(int(risk_cfg.get("max_consecutive_losses", 2)), 999)
    risk_cfg["max_trades_per_session"] = max(int(risk_cfg.get("max_trades_per_session", 50)), 99999)
    risk_cfg["loss_cluster_limit"] = max(int(risk_cfg.get("loss_cluster_limit", 6)), 99999)
    risk_cfg["max_session_drawdown_pct"] = 100.0
    risk_cfg["volatility_lockout_enabled"] = False
    risk = SessionRiskEngine(risk_cfg)
    risk.start_session(starting_balance)

    result = BacktestResult()
    last_digits: Deque[int] = deque(maxlen=3)
    cooldown_ticks = int((strategy.get("cooldown") or {}).get("cooldown_ticks", 10))
    ticks_since_last = 9999
    session_pnl = 0.0
    trades_count = 0
    loss_streak = 0
    outcomes: List[str] = []

    pending: Optional[Dict[str, Any]] = None

    strat = dict(strategy)
    if skip_confluence:
        conf = dict(strat.get("confluence") or {})
        conf["enabled"] = False
        strat["confluence"] = conf

    for i, raw in enumerate(digits):
        d = int(raw)
        if d < 0 or d > 9:
            continue

        if pending is not None:
            side = pending["side"]
            barrier = int(pending["barrier"])
            won = _resolve_win(side, barrier, d)
            ratio = float(pending.get("payout_ratio") or 2.0)
            profit = stake * (ratio - 1.0) if won else -stake
            result.trades.append(
                BacktestTrade(
                    trigger_index=pending["trigger_index"],
                    resolve_index=i,
                    repeated_digit=pending["repeated_digit"],
                    side=side,
                    barrier=barrier,
                    contract_type=pending["contract_type"],
                    won=won,
                    stake=stake,
                    payout_ratio=ratio,
                    profit=round(profit, 4),
                )
            )
            session_pnl += profit
            trades_count += 1
            if won:
                loss_streak = 0
                outcomes.append("win")
            else:
                loss_streak += 1
                outcomes.append("loss")
            ticks_since_last = 0
            pending = None
            last_digits.clear()
            stats.update(d)
            last_digits.append(d)
            continue

        stats.update(d)
        ticks_since_last += 1
        last_digits.append(d)

        if len(last_digits) < 3 or len(set(last_digits)) != 1:
            continue

        result.triggers += 1
        ctx = PipelineContext(
            strategy=strat,
            stats=stats,
            risk=risk,
            last_digits=list(last_digits),
            api_token="",
            symbol="R_100",
            account_id=None,
            session_pnl=session_pnl,
            trades_count=trades_count,
            loss_streak=loss_streak,
            outcomes=list(outcomes),
            take_profit=take_profit,
            stop_loss=stop_loss,
            ticks_since_last_trade=ticks_since_last,
            cooldown_ticks=cooldown_ticks,
        )
        eval_result = pipeline.evaluate(ctx)

        if not eval_result.approved or not eval_result.decision:
            result.skipped += 1
            last_digits.clear()
            continue

        decision = eval_result.decision
        barrier = int(decision.get("barrier") or last_digits[-1])
        meta = decision.get("search_meta") if isinstance(decision.get("search_meta"), dict) else {}
        ratio = float(meta.get("estimated_payout_ratio") or payout_search.estimate_payout_ratio(
            str(decision.get("contract_type")), barrier
        ))
        pending = {
            "trigger_index": i,
            "repeated_digit": last_digits[-1],
            "side": eval_result.signal.side if eval_result.signal else "OVER",
            "barrier": barrier,
            "contract_type": str(decision.get("contract_type")),
            "payout_ratio": ratio,
        }

    return result
