"""SQLite persistence for Bot Builder strategies (separate from active bot strategy.json)."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from modules import strategy_engine

logger = logging.getLogger(__name__)

_DB_PATH = Path(__file__).resolve().parent.parent / "builder_strategies.db"

ALLOWED_BLOCK_TYPES = frozenset(
    {
        "repeat_3_condition",
        "digit_threshold",
        "buy_under_action",
        "buy_over_action",
        "analysis_trend",
        "analysis_rsi",
        "logic_gate",
        "stake_config",
        "loss_limit",
        "profit_limit",
        "restart_condition",
    }
)

ALLOWED_CONTRACT_TYPES = frozenset({"DIGITUNDER", "DIGITOVER", ""})


def _now() -> float:
    return time.time()


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def _init_db(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS builder_strategies (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            market TEXT NOT NULL DEFAULT 'R_100',
            contract_type TEXT NOT NULL DEFAULT 'DIGITUNDER',
            stake REAL NOT NULL DEFAULT 1.0,
            risk_level TEXT NOT NULL DEFAULT 'Medium',
            status TEXT NOT NULL DEFAULT 'saved',
            strategy_json TEXT NOT NULL,
            blockly_xml TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS builder_strategy_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            name TEXT NOT NULL,
            market TEXT NOT NULL,
            contract_type TEXT NOT NULL,
            stake REAL NOT NULL,
            risk_level TEXT NOT NULL,
            strategy_json TEXT NOT NULL,
            blockly_xml TEXT,
            created_at REAL NOT NULL,
            FOREIGN KEY (strategy_id) REFERENCES builder_strategies(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS builder_recent (
            strategy_id TEXT PRIMARY KEY,
            opened_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_builder_strategies_updated
            ON builder_strategies(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_builder_versions_strategy
            ON builder_strategy_versions(strategy_id, version DESC);
        """
    )
    con.commit()


class BuilderStrategyStore:
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

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
        data = dict(row)
        if data.get("strategy_json"):
            try:
                data["strategy"] = json.loads(data["strategy_json"])
            except json.JSONDecodeError:
                data["strategy"] = {}
        data.pop("strategy_json", None)
        return data

    def list_strategies(
        self,
        *,
        status: str | None = None,
        query: str | None = None,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT id, name, market, contract_type, stake, risk_level, status, version, created_at, updated_at FROM builder_strategies WHERE 1=1"
        params: List[Any] = []
        if status:
            sql += " AND status = ?"
            params.append(status)
        if query:
            sql += " AND (LOWER(name) LIKE ? OR LOWER(market) LIKE ? OR LOWER(contract_type) LIKE ?)"
            q = f"%{query.lower()}%"
            params.extend([q, q, q])
        sql += " ORDER BY updated_at DESC LIMIT ?"
        params.append(max(1, min(limit, 500)))
        with self._connect() as con:
            rows = con.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def get_strategy(self, strategy_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as con:
            row = con.execute(
                "SELECT * FROM builder_strategies WHERE id = ?", (strategy_id,)
            ).fetchone()
        if not row:
            return None
        return self._row_to_dict(row)

    def save_strategy(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        strategy_id = str(payload.get("id") or "").strip() or str(uuid.uuid4())
        name = str(payload.get("name") or "Untitled strategy").strip()[:120]
        market = str(payload.get("market") or "R_100").strip()[:32]
        contract_type = str(payload.get("contract_type") or "DIGITUNDER").strip().upper()[:24]
        if contract_type not in ALLOWED_CONTRACT_TYPES:
            raise ValueError(f"Unsupported contract type: {contract_type}")
        stake = float(payload.get("stake") or 1.0)
        risk_level = str(payload.get("risk_level") or "Medium").strip()[:24]
        status = str(payload.get("status") or "saved").strip().lower()[:24]
        strategy = payload.get("strategy")
        if not isinstance(strategy, dict):
            raise ValueError("strategy object is required")
        validated = strategy_engine.validate_strategy(strategy)
        blockly_xml = payload.get("blockly_xml")
        if blockly_xml is not None:
            blockly_xml = str(blockly_xml)
            validate_blockly_xml(blockly_xml)

        now = _now()
        with self._connect() as con:
            existing = con.execute(
                "SELECT version FROM builder_strategies WHERE id = ?", (strategy_id,)
            ).fetchone()
            if existing:
                version = int(existing["version"]) + 1
                con.execute(
                    """
                    UPDATE builder_strategies SET
                        name=?, market=?, contract_type=?, stake=?, risk_level=?, status=?,
                        strategy_json=?, blockly_xml=?, version=?, updated_at=?
                    WHERE id=?
                    """,
                    (
                        name,
                        market,
                        contract_type,
                        stake,
                        risk_level,
                        status,
                        json.dumps(validated),
                        blockly_xml,
                        version,
                        now,
                        strategy_id,
                    ),
                )
            else:
                version = 1
                con.execute(
                    """
                    INSERT INTO builder_strategies (
                        id, name, market, contract_type, stake, risk_level, status,
                        strategy_json, blockly_xml, version, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        strategy_id,
                        name,
                        market,
                        contract_type,
                        stake,
                        risk_level,
                        status,
                        json.dumps(validated),
                        blockly_xml,
                        version,
                        now,
                        now,
                    ),
                )
            con.execute(
                """
                INSERT INTO builder_strategy_versions (
                    strategy_id, version, name, market, contract_type, stake, risk_level,
                    strategy_json, blockly_xml, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    strategy_id,
                    version,
                    name,
                    market,
                    contract_type,
                    stake,
                    risk_level,
                    json.dumps(validated),
                    blockly_xml,
                    now,
                ),
            )
            con.commit()
        saved = self.get_strategy(strategy_id)
        if not saved:
            raise RuntimeError("Failed to persist strategy")
        return saved

    def delete_strategy(self, strategy_id: str) -> bool:
        with self._connect() as con:
            cur = con.execute("DELETE FROM builder_strategies WHERE id = ?", (strategy_id,))
            con.execute("DELETE FROM builder_recent WHERE strategy_id = ?", (strategy_id,))
            con.commit()
            return cur.rowcount > 0

    def list_versions(self, strategy_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT id, strategy_id, version, name, market, contract_type, stake,
                       risk_level, created_at
                FROM builder_strategy_versions
                WHERE strategy_id = ?
                ORDER BY version DESC
                LIMIT ?
                """,
                (strategy_id, max(1, min(limit, 100))),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_version(self, strategy_id: str, version: int) -> Optional[Dict[str, Any]]:
        with self._connect() as con:
            row = con.execute(
                """
                SELECT * FROM builder_strategy_versions
                WHERE strategy_id = ? AND version = ?
                """,
                (strategy_id, version),
            ).fetchone()
        if not row:
            return None
        data = dict(row)
        data["strategy"] = json.loads(data.pop("strategy_json") or "{}")
        return data

    def restore_version(self, strategy_id: str, version: int) -> Dict[str, Any]:
        snap = self.get_version(strategy_id, version)
        if not snap:
            raise ValueError("Version not found")
        return self.save_strategy(
            {
                "id": strategy_id,
                "name": snap["name"],
                "market": snap["market"],
                "contract_type": snap["contract_type"],
                "stake": snap["stake"],
                "risk_level": snap["risk_level"],
                "status": "saved",
                "strategy": snap["strategy"],
                "blockly_xml": snap.get("blockly_xml"),
            }
        )

    def touch_recent(self, strategy_id: str) -> None:
        now = _now()
        with self._connect() as con:
            con.execute(
                """
                INSERT INTO builder_recent (strategy_id, opened_at) VALUES (?, ?)
                ON CONFLICT(strategy_id) DO UPDATE SET opened_at=excluded.opened_at
                """,
                (strategy_id, now),
            )
            con.commit()

    def list_recent(self, limit: int = 12) -> List[Dict[str, Any]]:
        with self._connect() as con:
            rows = con.execute(
                """
                SELECT s.id, s.name, s.market, s.contract_type, s.stake, s.risk_level,
                       s.status, s.version, s.updated_at, r.opened_at
                FROM builder_recent r
                JOIN builder_strategies s ON s.id = r.strategy_id
                ORDER BY r.opened_at DESC
                LIMIT ?
                """,
                (max(1, min(limit, 50)),),
            ).fetchall()
        return [dict(r) for r in rows]

    def validate_import(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Validate import bundle; does not persist."""
        errors: List[str] = []
        strategy = payload.get("strategy")
        blockly_xml = payload.get("blockly_xml") or payload.get("workspace_xml")
        if isinstance(payload.get("workspace"), dict):
            strategy = strategy or payload.get("workspace")
        if not strategy and not blockly_xml:
            errors.append("Import must include strategy JSON and/or Blockly XML")
        validated: Dict[str, Any] | None = None
        if strategy is not None:
            if not isinstance(strategy, dict):
                errors.append("strategy must be an object")
            else:
                try:
                    validated = strategy_engine.validate_strategy(strategy)
                except Exception as exc:
                    errors.append(f"Invalid strategy schema: {exc}")
        if blockly_xml:
            try:
                validate_blockly_xml(str(blockly_xml))
            except ValueError as exc:
                errors.append(str(exc))
        contract = str(
            payload.get("contract_type")
            or (validated or {}).get("quick_meta", {}).get("contract_type")
            or "DIGITUNDER"
        ).upper()
        if contract and contract not in ALLOWED_CONTRACT_TYPES:
            errors.append(f"Unsupported contract type: {contract}")
        return {
            "valid": not errors,
            "errors": errors,
            "strategy": validated,
            "blockly_xml": str(blockly_xml) if blockly_xml else None,
            "name": str(payload.get("name") or "Imported strategy").strip()[:120],
            "market": str(payload.get("market") or "R_100").strip()[:32],
            "contract_type": contract or "DIGITUNDER",
            "stake": float(payload.get("stake") or 1.0),
            "risk_level": str(payload.get("risk_level") or "Medium"),
        }


def validate_blockly_xml(xml_text: str) -> None:
    """Reject unknown Blockly block types (lightweight string check)."""
    import re

    text = str(xml_text or "")
    if not text.strip():
        raise ValueError("Blockly XML is empty")
    for match in re.finditer(r'type="([^"]+)"', text):
        block_type = match.group(1)
        if block_type not in ALLOWED_BLOCK_TYPES:
            raise ValueError(f"Unsupported block type in import: {block_type}")


_store: BuilderStrategyStore | None = None


def get_builder_strategy_store() -> BuilderStrategyStore:
    global _store
    if _store is None:
        _store = BuilderStrategyStore()
    return _store
