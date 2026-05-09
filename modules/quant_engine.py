"""Statistical, risk, journal, and backtest helpers for Deriv digit trading."""

from __future__ import annotations

import math
import sqlite3
import time
from collections import Counter, deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Sequence


class DigitStatsEngine:
    """Rolling digit distribution, transition probabilities, and simple regimes."""

    def __init__(self, window: int = 500, transition_window: int = 1200) -> None:
        self.window = max(100, int(window))
        self.transition_window = max(200, int(transition_window))
        self._digits: Deque[int] = deque(maxlen=self.window)
        self._transitions: Deque[tuple[int, int]] = deque(maxlen=self.transition_window)
        self._last_digit: int | None = None

    def update(self, digit: int) -> None:
        d = int(digit)
        if d < 0 or d > 9:
            return
        if self._last_digit is not None:
            self._transitions.append((self._last_digit, d))
        self._digits.append(d)
        self._last_digit = d

    def ready(self, min_samples: int = 150) -> bool:
        return len(self._digits) >= int(min_samples)

    def digit_probabilities(self) -> Dict[int, float]:
        total = len(self._digits) or 1
        counts = Counter(self._digits)
        return {d: counts.get(d, 0) / total for d in range(10)}

    def zscores(self) -> Dict[int, float]:
        probs = self.digit_probabilities()
        n = len(self._digits)
        expected = n * 0.1
        # Binomial std dev for p=0.1.
        std = math.sqrt(max(n * 0.1 * 0.9, 1e-9))
        return {d: ((probs[d] * n) - expected) / std for d in range(10)}

    def transition_probabilities(self, current_digit: int) -> Dict[int, float]:
        cur = int(current_digit)
        row = [pair for pair in self._transitions if pair[0] == cur]
        if not row:
            return {d: 0.1 for d in range(10)}
        counts = Counter(nxt for _, nxt in row)
        total = len(row)
        return {d: counts.get(d, 0) / total for d in range(10)}

    def realized_volatility(self, lookback: int = 120) -> float:
        if len(self._digits) < 5:
            return 0.0
        vals = list(self._digits)[-max(5, int(lookback)) :]
        mean = sum(vals) / len(vals)
        var = sum((x - mean) ** 2 for x in vals) / max(1, len(vals) - 1)
        return math.sqrt(var)

    def regime(self) -> str:
        vol = self.realized_volatility()
        if vol > 3.0:
            return "volatile"
        if vol < 2.2:
            return "range"
        return "mixed"

    def snapshot(self) -> Dict[str, Any]:
        probs = self.digit_probabilities()
        zs = self.zscores()
        return {
            "window_size": len(self._digits),
            "probabilities": {str(k): round(v, 4) for k, v in probs.items()},
            "z_scores": {str(k): round(v, 3) for k, v in zs.items()},
            "regime": self.regime(),
            "volatility": round(self.realized_volatility(), 4),
        }


class RiskEngine:
    """Session-level risk gating and simple dynamic stake sizing."""

    def __init__(self) -> None:
        self.max_trades_session = 120
        self.max_consecutive_losses = 4
        self.max_drawdown = 0.2
        self.fixed_fractional_risk = 0.01
        self.loss_cluster_window = 8
        self.loss_cluster_limit = 6
        self.session_start_equity = 0.0

    def start_session(self, starting_balance: float) -> None:
        self.session_start_equity = max(0.0, float(starting_balance))

    def suggested_stake(self, balance: float, base_stake: float) -> float:
        bal = max(0.0, float(balance))
        frac_size = bal * self.fixed_fractional_risk
        if frac_size <= 0:
            return max(0.35, float(base_stake))
        return round(max(0.35, min(float(base_stake), frac_size)), 2)

    def allow_trade(self, trades_count: int, loss_streak: int, pnl: float, outcomes: Sequence[str]) -> tuple[bool, str]:
        if int(trades_count) >= self.max_trades_session:
            return False, "max trades/session reached"
        if int(loss_streak) >= self.max_consecutive_losses:
            return False, "max consecutive losses reached"
        if self.session_start_equity > 0:
            dd = max(0.0, -float(pnl)) / self.session_start_equity
            if dd >= self.max_drawdown:
                return False, "max drawdown reached"
        recent = list(outcomes)[-self.loss_cluster_window :]
        if recent and sum(1 for x in recent if x == "loss") >= self.loss_cluster_limit:
            return False, "loss clustering detected"
        return True, ""

    def snapshot(self) -> Dict[str, Any]:
        return {
            "max_trades_session": self.max_trades_session,
            "max_consecutive_losses": self.max_consecutive_losses,
            "max_drawdown": self.max_drawdown,
            "fixed_fractional_risk": self.fixed_fractional_risk,
            "loss_cluster_window": self.loss_cluster_window,
            "loss_cluster_limit": self.loss_cluster_limit,
            "session_start_equity": round(self.session_start_equity, 2),
        }


class TradeJournal:
    """SQLite-backed journal for strategy/debug/learning data."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path)

    def _ensure_schema(self) -> None:
        with self._connect() as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS trades (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL,
                    source TEXT NOT NULL,
                    contract_type TEXT,
                    barrier INTEGER,
                    stake REAL NOT NULL,
                    payout REAL NOT NULL,
                    profit REAL NOT NULL,
                    result TEXT NOT NULL,
                    digit INTEGER,
                    duration_sec REAL,
                    signal_json TEXT,
                    stats_json TEXT
                )
                """
            )
            con.commit()

    def log_trade(self, payload: Dict[str, Any]) -> None:
        self._ensure_schema()
        with self._connect() as con:
            con.execute(
                """
                INSERT INTO trades (
                    ts, source, contract_type, barrier, stake, payout, profit,
                    result, digit, duration_sec, signal_json, stats_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    float(payload.get("ts") or time.time()),
                    str(payload.get("source") or "bot"),
                    payload.get("contract_type"),
                    payload.get("barrier"),
                    float(payload.get("stake") or 0.0),
                    float(payload.get("payout") or 0.0),
                    float(payload.get("profit") or 0.0),
                    str(payload.get("result") or "unknown"),
                    payload.get("digit"),
                    payload.get("duration_sec"),
                    str(payload.get("signal_json") or "{}"),
                    str(payload.get("stats_json") or "{}"),
                ),
            )
            con.commit()

    def recent(self, limit: int = 100) -> List[Dict[str, Any]]:
        self._ensure_schema()
        with self._connect() as con:
            cur = con.execute(
                """
                SELECT ts, source, contract_type, barrier, stake, payout, profit,
                       result, digit, duration_sec, signal_json, stats_json
                FROM trades
                ORDER BY id DESC
                LIMIT ?
                """,
                (max(1, int(limit)),),
            )
            rows = cur.fetchall()
        out: List[Dict[str, Any]] = []
        for row in rows:
            out.append(
                {
                    "ts": row[0],
                    "source": row[1],
                    "contract_type": row[2],
                    "barrier": row[3],
                    "stake": row[4],
                    "payout": row[5],
                    "profit": row[6],
                    "result": row[7],
                    "digit": row[8],
                    "duration_sec": row[9],
                    "signal_json": row[10],
                    "stats_json": row[11],
                }
            )
        return out


def run_digit_backtest(digits: Sequence[int], barrier: int = 5, stake: float = 1.0) -> Dict[str, Any]:
    """
    Replay naive mean-reversion over/under:
    - Trigger on 3 repeated digits.
    - If repeated digit is statistically over-represented (z>1), fade it with UNDER; else OVER.
    """
    stats = DigitStatsEngine(window=500, transition_window=1200)
    trades = 0
    wins = 0
    pnl = 0.0
    eq_curve: List[float] = [0.0]
    streak: Deque[int] = deque(maxlen=3)
    for d in digits:
        d = int(d)
        if d < 0 or d > 9:
            continue
        stats.update(d)
        streak.append(d)
        if len(streak) < 3 or len(set(streak)) != 1 or not stats.ready(120):
            continue
        repeated = streak[-1]
        z = stats.zscores().get(repeated, 0.0)
        side = "UNDER" if z > 1.0 else "OVER"
        trades += 1
        win = (d < barrier) if side == "UNDER" else (d > barrier)
        if win:
            wins += 1
            pnl += float(stake) * 0.9
        else:
            pnl -= float(stake)
        eq_curve.append(pnl)
        streak.clear()
    win_rate = (wins / trades) if trades else 0.0
    expectancy = (pnl / trades) if trades else 0.0
    peak = 0.0
    max_dd = 0.0
    for x in eq_curve:
        peak = max(peak, x)
        max_dd = max(max_dd, peak - x)
    returns = [eq_curve[i] - eq_curve[i - 1] for i in range(1, len(eq_curve))]
    if returns:
        mu = sum(returns) / len(returns)
        var = sum((r - mu) ** 2 for r in returns) / max(1, len(returns) - 1)
        std = math.sqrt(var)
        sharpe = (mu / std) if std > 1e-12 else 0.0
    else:
        sharpe = 0.0
    return {
        "trades": trades,
        "wins": wins,
        "win_rate": round(win_rate, 4),
        "expectancy": round(expectancy, 4),
        "pnl": round(pnl, 2),
        "max_drawdown": round(max_dd, 2),
        "sharpe_like": round(sharpe, 4),
    }
