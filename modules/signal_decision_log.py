"""Structured signal decision logging (console, file, analytics)."""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
_LOG_FILE = _LOG_DIR / "signal_decisions.log"


def _ensure_log_dir() -> None:
    _LOG_DIR.mkdir(parents=True, exist_ok=True)


def build_decision_record(
    *,
    repeat_digit: int,
    signal_digits: list[int],
    side: str,
    contract_type: str,
    barrier: int | None,
    p_over: float | None = None,
    p_under: float | None = None,
    probability_gate_passed: bool = False,
    search_passed: bool = False,
    confluence_passed: bool = False,
    risk_passed: bool = False,
    executed: bool = False,
    skip_reason: str = "",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "timestamp": time.time(),
        "repeat_digit": repeat_digit,
        "signal_digits": list(signal_digits),
        "side": side,
        "contract_type": contract_type,
        "barrier": barrier,
        "p_over": p_over,
        "p_under": p_under,
        "probability_gate_passed": probability_gate_passed,
        "search_passed": search_passed,
        "confluence_passed": confluence_passed,
        "risk_passed": risk_passed,
        "executed": executed,
        "skip_reason": skip_reason,
        **(extra or {}),
    }


def log_signal_decision(record: Dict[str, Any]) -> None:
    """Write decision to logger, JSON log file, and return record for DB persistence."""
    _ensure_log_dir()
    line = json.dumps(record, default=str)
    logger.info("[SignalDecision] %s", line)
    try:
        with _LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError as exc:
        logger.warning("Could not write signal log file: %s", exc)


def read_recent(limit: int = 40) -> list[Dict[str, Any]]:
    """Return the most recent signal decision records (newest first)."""
    if not _LOG_FILE.is_file():
        return []
    cap = max(1, min(int(limit), 200))
    try:
        lines = _LOG_FILE.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        logger.warning("Could not read signal log file: %s", exc)
        return []
    out: list[Dict[str, Any]] = []
    for line in reversed(lines[-cap * 2 :]):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
        if len(out) >= cap:
            break
    return out
