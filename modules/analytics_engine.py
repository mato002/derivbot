"""Expectancy tracking, structured trade records, CSV/JSON export."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, DefaultDict, Dict, List, Optional


def _bucket_key(parts: Dict[str, Any]) -> str:
    return "|".join(f"{k}={parts[k]}" for k in sorted(parts.keys()))


@dataclass
class ExpectancyBucket:
    wins: int = 0
    losses: int = 0
    total_profit: float = 0.0
    total_win_profit: float = 0.0
    total_loss_profit: float = 0.0

    @property
    def trades(self) -> int:
        return self.wins + self.losses

    @property
    def win_rate(self) -> float:
        return self.wins / self.trades if self.trades else 0.0

    @property
    def avg_win(self) -> float:
        return self.total_win_profit / self.wins if self.wins else 0.0

    @property
    def avg_loss(self) -> float:
        return abs(self.total_loss_profit) / self.losses if self.losses else 0.0

    @property
    def expectancy(self) -> float:
        wr = self.win_rate
        lr = 1.0 - wr
        return (wr * self.avg_win) - (lr * self.avg_loss)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "trades": self.trades,
            "wins": self.wins,
            "losses": self.losses,
            "win_rate": round(self.win_rate, 4),
            "avg_win": round(self.avg_win, 4),
            "avg_loss": round(self.avg_loss, 4),
            "expectancy": round(self.expectancy, 4),
            "total_profit": round(self.total_profit, 2),
        }


class ExpectancyTracker:
    """Rolling expectancy by barrier, digit, contract, regime."""

    def __init__(self) -> None:
        self._global = ExpectancyBucket()
        self._by_barrier: DefaultDict[str, ExpectancyBucket] = defaultdict(ExpectancyBucket)
        self._by_digit: DefaultDict[str, ExpectancyBucket] = defaultdict(ExpectancyBucket)
        self._by_contract: DefaultDict[str, ExpectancyBucket] = defaultdict(ExpectancyBucket)
        self._by_regime: DefaultDict[str, ExpectancyBucket] = defaultdict(ExpectancyBucket)

    def _update(self, bucket: ExpectancyBucket, profit: float, won: bool) -> None:
        bucket.total_profit += profit
        if won:
            bucket.wins += 1
            bucket.total_win_profit += profit
        else:
            bucket.losses += 1
            bucket.total_loss_profit += profit

    def record(self, *, profit: float, won: bool, meta: Dict[str, Any]) -> None:
        self._update(self._global, profit, won)
        barrier = meta.get("barrier")
        if barrier is not None:
            self._update(self._by_barrier[str(barrier)], profit, won)
        digit = meta.get("repeated_digit")
        if digit is not None:
            self._update(self._by_digit[str(digit)], profit, won)
        ct = meta.get("contract_type")
        if ct:
            self._update(self._by_contract[str(ct)], profit, won)
        regime = meta.get("regime")
        if regime:
            self._update(self._by_regime[str(regime)], profit, won)

    def snapshot(self) -> Dict[str, Any]:
        def top(buckets: DefaultDict[str, ExpectancyBucket], n: int = 5) -> List[Dict[str, Any]]:
            ranked = sorted(buckets.items(), key=lambda kv: kv[1].expectancy, reverse=True)
            return [{"key": k, **v.to_dict()} for k, v in ranked[:n]]

        return {
            "session": self._global.to_dict(),
            "by_barrier": {k: v.to_dict() for k, v in self._by_barrier.items()},
            "by_digit": {k: v.to_dict() for k, v in self._by_digit.items()},
            "by_contract": {k: v.to_dict() for k, v in self._by_contract.items()},
            "by_regime": {k: v.to_dict() for k, v in self._by_regime.items()},
            "best_setups": top(self._by_barrier),
        }


class TradeAnalytics:
    """SQLite-backed structured trade log with export helpers."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self.expectancy = ExpectancyTracker()
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path)

    def _ensure_schema(self) -> None:
        with self._connect() as con:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS trade_analytics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL,
                    source TEXT NOT NULL,
                    trigger_digits TEXT,
                    direction TEXT,
                    contract_type TEXT,
                    barrier INTEGER,
                    repeated_digit INTEGER,
                    stake REAL,
                    payout REAL,
                    profit REAL,
                    result TEXT,
                    payout_ratio REAL,
                    p_over REAL,
                    p_under REAL,
                    confluence_passed INTEGER,
                    proposal_latency_ms INTEGER,
                    duration_sec REAL,
                    regime TEXT,
                    skip_reason TEXT,
                    payload_json TEXT
                )
                """
            )
            con.commit()

    def record_trade(self, row: Dict[str, Any]) -> None:
        self._ensure_schema()
        won = str(row.get("result")) == "win"
        profit = float(row.get("profit") or 0.0)
        self.expectancy.record(
            profit=profit,
            won=won,
            meta={
                "barrier": row.get("barrier"),
                "repeated_digit": row.get("repeated_digit"),
                "contract_type": row.get("contract_type"),
                "regime": row.get("regime"),
            },
        )
        with self._connect() as con:
            con.execute(
                """
                INSERT INTO trade_analytics (
                    ts, source, trigger_digits, direction, contract_type, barrier,
                    repeated_digit, stake, payout, profit, result, payout_ratio,
                    p_over, p_under, confluence_passed, proposal_latency_ms,
                    duration_sec, regime, skip_reason, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    float(row.get("ts") or time.time()),
                    str(row.get("source") or "bot"),
                    json.dumps(row.get("trigger_digits") or []),
                    row.get("direction"),
                    row.get("contract_type"),
                    row.get("barrier"),
                    row.get("repeated_digit"),
                    float(row.get("stake") or 0.0),
                    float(row.get("payout") or 0.0),
                    profit,
                    str(row.get("result") or "unknown"),
                    row.get("payout_ratio"),
                    row.get("p_over"),
                    row.get("p_under"),
                    1 if row.get("confluence_passed") else 0,
                    row.get("proposal_latency_ms"),
                    row.get("duration_sec"),
                    row.get("regime"),
                    row.get("skip_reason"),
                    json.dumps(row.get("payload") or {}),
                ),
            )
            con.commit()

    def record_skip(self, row: Dict[str, Any]) -> None:
        payload = dict(row.get("payload") or {})
        payload["skipped"] = True
        self.record_trade(
            {
                **row,
                "result": "skip",
                "profit": 0.0,
                "payout": 0.0,
                "stake": 0.0,
                "payload": payload,
            }
        )

    def recent(self, limit: int = 100) -> List[Dict[str, Any]]:
        self._ensure_schema()
        with self._connect() as con:
            cur = con.execute(
                """
                SELECT ts, source, trigger_digits, direction, contract_type, barrier,
                       repeated_digit, stake, payout, profit, result, payout_ratio,
                       p_over, p_under, confluence_passed, proposal_latency_ms,
                       duration_sec, regime, skip_reason, payload_json
                FROM trade_analytics
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
                    "trigger_digits": json.loads(row[2] or "[]"),
                    "direction": row[3],
                    "contract_type": row[4],
                    "barrier": row[5],
                    "repeated_digit": row[6],
                    "stake": row[7],
                    "payout": row[8],
                    "profit": row[9],
                    "result": row[10],
                    "payout_ratio": row[11],
                    "p_over": row[12],
                    "p_under": row[13],
                    "confluence_passed": bool(row[14]),
                    "proposal_latency_ms": row[15],
                    "duration_sec": row[16],
                    "regime": row[17],
                    "skip_reason": row[18],
                    "payload": json.loads(row[19] or "{}"),
                }
            )
        return out

    def export_json(self, limit: int = 500) -> str:
        return json.dumps(self.recent(limit=limit), indent=2)

    def export_csv(self, limit: int = 500) -> str:
        rows = self.recent(limit=limit)
        if not rows:
            return ""
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            flat = dict(r)
            flat["trigger_digits"] = json.dumps(flat.get("trigger_digits"))
            flat["payload"] = json.dumps(flat.get("payload"))
            writer.writerow(flat)
        return buf.getvalue()
