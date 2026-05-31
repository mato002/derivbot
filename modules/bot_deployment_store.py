"""SQLite persistence for bot deployments, logs, and registry analytics."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

_DB_PATH = Path(__file__).resolve().parent.parent / "bot_deployments.db"


def _now() -> float:
    return time.time()


def _init_db(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS bot_deployments (
            id TEXT PRIMARY KEY,
            strategy_id TEXT NOT NULL,
            strategy_name TEXT NOT NULL,
            strategy_version INTEGER NOT NULL DEFAULT 1,
            market TEXT NOT NULL DEFAULT 'R_100',
            contract_type TEXT NOT NULL DEFAULT 'DIGITUNDER',
            account TEXT NOT NULL DEFAULT 'demo',
            status TEXT NOT NULL DEFAULT 'stopped',
            profit REAL NOT NULL DEFAULT 0,
            trades_count INTEGER NOT NULL DEFAULT 0,
            started_at REAL,
            stopped_at REAL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bot_deployment_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            deployment_id TEXT,
            strategy_id TEXT,
            ts REAL NOT NULL,
            event TEXT NOT NULL,
            result TEXT,
            extra_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_deployments_status
            ON bot_deployments(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_deployments_strategy
            ON bot_deployments(strategy_id);
        CREATE INDEX IF NOT EXISTS idx_deployment_logs_deployment
            ON bot_deployment_logs(deployment_id, ts DESC);
        """
    )
    con.commit()


class BotDeploymentStore:
    def __init__(self, db_path: Path | str | None = None) -> None:
        self.db_path = Path(db_path) if db_path else _DB_PATH
        con = sqlite3.connect(str(self.db_path), check_same_thread=False)
        try:
            _init_db(con)
        finally:
            con.close()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.db_path), check_same_thread=False)
        con.row_factory = sqlite3.Row
        return con

    def list_deployments(
        self,
        *,
        status: str | None = None,
        strategy_id: str | None = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM bot_deployments WHERE 1=1"
        params: List[Any] = []
        if status:
            sql += " AND status = ?"
            params.append(status)
        if strategy_id:
            sql += " AND strategy_id = ?"
            params.append(strategy_id)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        params.append(max(1, min(limit, 200)))
        with self._connect() as con:
            rows = con.execute(sql, params).fetchall()
        return [self._enrich(dict(r)) for r in rows]

    def get_deployment(self, deployment_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as con:
            row = con.execute(
                "SELECT * FROM bot_deployments WHERE id = ?", (deployment_id,)
            ).fetchone()
        if not row:
            return None
        return self._enrich(dict(row))

    def create_deployment(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        deployment_id = str(payload.get("id") or "").strip() or str(uuid.uuid4())
        now = _now()
        row = {
            "id": deployment_id,
            "strategy_id": str(payload["strategy_id"]),
            "strategy_name": str(payload.get("strategy_name") or "Bot"),
            "strategy_version": int(payload.get("strategy_version") or 1),
            "market": str(payload.get("market") or "R_100"),
            "contract_type": str(payload.get("contract_type") or "DIGITUNDER"),
            "account": str(payload.get("account") or "demo"),
            "status": "running",
            "profit": 0.0,
            "trades_count": 0,
            "started_at": now,
            "stopped_at": None,
            "created_at": now,
            "updated_at": now,
        }
        with self._connect() as con:
            con.execute(
                """
                UPDATE bot_deployments SET status='stopped', stopped_at=?, updated_at=?
                WHERE status='running'
                """,
                (now, now),
            )
            con.execute(
                """
                INSERT INTO bot_deployments (
                    id, strategy_id, strategy_name, strategy_version, market, contract_type,
                    account, status, profit, trades_count, started_at, stopped_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"],
                    row["strategy_id"],
                    row["strategy_name"],
                    row["strategy_version"],
                    row["market"],
                    row["contract_type"],
                    row["account"],
                    row["status"],
                    row["profit"],
                    row["trades_count"],
                    row["started_at"],
                    row["stopped_at"],
                    row["created_at"],
                    row["updated_at"],
                ),
            )
            con.commit()
        self.append_log(
            deployment_id,
            row["strategy_id"],
            "deployed",
            "OK",
            {"version": row["strategy_version"], "market": row["market"]},
        )
        saved = self.get_deployment(deployment_id)
        if not saved:
            raise RuntimeError("Failed to create deployment")
        return saved

    def set_status(self, deployment_id: str, status: str) -> Optional[Dict[str, Any]]:
        now = _now()
        with self._connect() as con:
            row = con.execute(
                "SELECT * FROM bot_deployments WHERE id = ?", (deployment_id,)
            ).fetchone()
            if not row:
                return None
            updates: Dict[str, Any] = {"status": status, "updated_at": now}
            if status == "running":
                updates["started_at"] = now
                updates["stopped_at"] = None
                con.execute(
                    """
                    UPDATE bot_deployments SET status='stopped', stopped_at=?, updated_at=?
                    WHERE status='running' AND id != ?
                    """,
                    (now, now, deployment_id),
                )
            elif status in ("paused", "stopped"):
                updates["stopped_at"] = now
            con.execute(
                """
                UPDATE bot_deployments SET status=?, updated_at=?, started_at=COALESCE(?, started_at),
                stopped_at=?
                WHERE id=?
                """,
                (
                    status,
                    now,
                    updates.get("started_at"),
                    updates.get("stopped_at"),
                    deployment_id,
                ),
            )
            con.commit()
        self.append_log(
            deployment_id,
            row["strategy_id"],
            f"status_{status}",
            "OK",
        )
        return self.get_deployment(deployment_id)

    def sync_runtime(
        self,
        *,
        profit: float,
        trades_count: int,
        running: bool,
        active_strategy_id: str | None = None,
    ) -> None:
        """Update the active running deployment from bot engine status."""
        with self._connect() as con:
            row = con.execute(
                """
                SELECT * FROM bot_deployments
                WHERE status IN ('running', 'paused')
                ORDER BY updated_at DESC LIMIT 1
                """
            ).fetchone()
            if not row and active_strategy_id:
                row = con.execute(
                    """
                    SELECT * FROM bot_deployments
                    WHERE strategy_id = ?
                    ORDER BY updated_at DESC LIMIT 1
                    """,
                    (active_strategy_id,),
                ).fetchone()
            if not row:
                return
            status = "running" if running else row["status"]
            if row["status"] == "paused" and running:
                status = "paused"
            con.execute(
                """
                UPDATE bot_deployments SET profit=?, trades_count=?, status=?, updated_at=?
                WHERE id=?
                """,
                (round(float(profit), 2), int(trades_count), status, _now(), row["id"]),
            )
            con.commit()

    def append_log(
        self,
        deployment_id: str | None,
        strategy_id: str | None,
        event: str,
        result: str | None = None,
        extra: Dict[str, Any] | None = None,
    ) -> None:
        with self._connect() as con:
            con.execute(
                """
                INSERT INTO bot_deployment_logs (deployment_id, strategy_id, ts, event, result, extra_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    deployment_id,
                    strategy_id,
                    _now(),
                    event,
                    result,
                    json.dumps(extra) if extra else None,
                ),
            )
            con.commit()

    def list_logs(
        self,
        *,
        deployment_id: str | None = None,
        strategy_id: str | None = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM bot_deployment_logs WHERE 1=1"
        params: List[Any] = []
        if deployment_id:
            sql += " AND deployment_id = ?"
            params.append(deployment_id)
        if strategy_id:
            sql += " AND strategy_id = ?"
            params.append(strategy_id)
        sql += " ORDER BY ts DESC LIMIT ?"
        params.append(max(1, min(limit, 500)))
        with self._connect() as con:
            rows = con.execute(sql, params).fetchall()
        out = []
        for r in rows:
            item = dict(r)
            if item.get("extra_json"):
                try:
                    item["extra"] = json.loads(item["extra_json"])
                except json.JSONDecodeError:
                    item["extra"] = {}
            item.pop("extra_json", None)
            out.append(item)
        return out

    def analytics_summary(self) -> Dict[str, Any]:
        with self._connect() as con:
            total = con.execute("SELECT COUNT(*) AS c FROM bot_deployments").fetchone()
            active = con.execute(
                "SELECT COUNT(*) AS c FROM bot_deployments WHERE status='running'"
            ).fetchone()
            profit_row = con.execute(
                "SELECT COALESCE(SUM(profit), 0) AS p, COALESCE(SUM(trades_count), 0) AS t FROM bot_deployments"
            ).fetchone()
        return {
            "total_deployments": int(total["c"] if total else 0),
            "active_deployments": int(active["c"] if active else 0),
            "total_profit": round(float(profit_row["p"] if profit_row else 0), 2),
            "total_trades": int(profit_row["t"] if profit_row else 0),
        }

    @staticmethod
    def _enrich(row: Dict[str, Any]) -> Dict[str, Any]:
        started = row.get("started_at")
        stopped = row.get("stopped_at")
        now = _now()
        if row.get("status") == "running" and started:
            row["uptime_seconds"] = max(0, int(now - float(started)))
        elif started and stopped:
            row["uptime_seconds"] = max(0, int(float(stopped) - float(started)))
        else:
            row["uptime_seconds"] = 0
        return row


_store: BotDeploymentStore | None = None


def get_bot_deployment_store() -> BotDeploymentStore:
    global _store
    if _store is None:
        _store = BotDeploymentStore()
    return _store
