"""Persistent trade audit trail — every signal decision reconstructable."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List


class TradeAudit:
    """SQLite audit log for signal → execution outcomes."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        return self._conn

    def _ensure_schema(self) -> None:
        con = self._connect()
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS trade_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                trigger_digits TEXT,
                repeated_digit INTEGER,
                side TEXT,
                barrier INTEGER,
                contract_type TEXT,
                probability_score REAL,
                confluence_score REAL,
                payout_ratio REAL,
                stake REAL,
                result TEXT,
                profit_loss REAL,
                reason_skipped TEXT,
                probability_gate_passed INTEGER,
                search_passed INTEGER,
                confluence_passed INTEGER,
                risk_passed INTEGER,
                executed INTEGER,
                research_mode INTEGER,
                payload_json TEXT
            )
            """
        )
        con.commit()

    def record_decision(self, row: Dict[str, Any]) -> int:
        ts = float(row.get("timestamp") or row.get("ts") or time.time())
        payload = dict(row.get("payload") or {})
        con = self._connect()
        cur = con.execute(
            """
            INSERT INTO trade_audit (
                timestamp, trigger_digits, repeated_digit, side, barrier,
                contract_type, probability_score, confluence_score, payout_ratio,
                stake, result, profit_loss, reason_skipped,
                probability_gate_passed, search_passed, confluence_passed,
                risk_passed, executed, research_mode, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ts,
                json.dumps(row.get("trigger_digits") or row.get("signal_digits") or []),
                row.get("repeated_digit") if row.get("repeated_digit") is not None else row.get("repeat_digit"),
                row.get("side") or row.get("direction"),
                row.get("barrier"),
                row.get("contract_type"),
                row.get("probability_score") if row.get("probability_score") is not None else row.get("picked_prob"),
                row.get("confluence_score"),
                row.get("payout_ratio"),
                float(row.get("stake") or 0.0),
                str(row.get("result") or ("executed" if row.get("executed") else "pending")),
                float(row.get("profit_loss") if row.get("profit_loss") is not None else row.get("profit") or 0.0),
                row.get("reason_skipped") or row.get("skip_reason") or "",
                1 if row.get("probability_gate_passed") else 0,
                1 if row.get("search_passed") else 0,
                1 if row.get("confluence_passed") else 0,
                1 if row.get("risk_passed") else 0,
                1 if row.get("executed") else 0,
                1 if row.get("research_mode") else 0,
                json.dumps(payload),
            ),
        )
        con.commit()
        return int(cur.lastrowid or 0)

    def update_outcome(
        self,
        audit_id: int,
        *,
        result: str,
        profit_loss: float,
        executed: bool = True,
    ) -> None:
        con = self._connect()
        con.execute(
            """
            UPDATE trade_audit
            SET result = ?, profit_loss = ?, executed = ?
            WHERE id = ?
            """,
            (result, float(profit_loss), 1 if executed else 0, int(audit_id)),
        )
        con.commit()

    def all_rows(self, limit: int = 5000) -> List[Dict[str, Any]]:
        con = self._connect()
        cur = con.execute(
            """
            SELECT id, timestamp, trigger_digits, repeated_digit, side, barrier,
                   contract_type, probability_score, confluence_score, payout_ratio,
                   stake, result, profit_loss, reason_skipped,
                   probability_gate_passed, search_passed, confluence_passed,
                   risk_passed, executed, research_mode, payload_json
            FROM trade_audit
            ORDER BY id DESC
            LIMIT ?
            """,
            (max(1, int(limit)),),
        )
        rows = cur.fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            out.append(
                {
                    "id": r[0],
                    "timestamp": r[1],
                    "trigger_digits": json.loads(r[2] or "[]"),
                    "repeated_digit": r[3],
                    "side": r[4],
                    "barrier": r[5],
                    "contract_type": r[6],
                    "probability_score": r[7],
                    "confluence_score": r[8],
                    "payout_ratio": r[9],
                    "stake": r[10],
                    "result": r[11],
                    "profit_loss": r[12],
                    "reason_skipped": r[13],
                    "probability_gate_passed": bool(r[14]),
                    "search_passed": bool(r[15]),
                    "confluence_passed": bool(r[16]),
                    "risk_passed": bool(r[17]),
                    "executed": bool(r[18]),
                    "research_mode": bool(r[19]),
                    "payload": json.loads(r[20] or "{}"),
                }
            )
        return out

    def export_csv(self, limit: int = 5000) -> str:
        rows = self.all_rows(limit=limit)
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
