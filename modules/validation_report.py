"""Strategy validation report from trade_audit and backtest data."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
from collections import defaultdict
from pathlib import Path
from typing import Any, DefaultDict, Dict, List

from modules.backtest_engine import run_pipeline_backtest
from modules.strategy_engine import load_strategy


def _bucket_stats(rows: List[Dict[str, Any]], key_fn) -> Dict[str, Dict[str, Any]]:
    buckets: DefaultDict[str, Dict[str, Any]] = defaultdict(
        lambda: {"trades": 0, "wins": 0, "losses": 0, "net_pnl": 0.0, "total_stake": 0.0}
    )
    for r in rows:
        if r.get("result") in ("skip", "pending", None):
            continue
        if not r.get("executed") and r.get("result") not in ("win", "loss"):
            continue
        k = str(key_fn(r))
        b = buckets[k]
        b["trades"] += 1
        won = str(r.get("result")).lower() == "win"
        if won:
            b["wins"] += 1
        else:
            b["losses"] += 1
        pl = float(r.get("profit_loss") or 0.0)
        b["net_pnl"] += pl
        b["total_stake"] += float(r.get("stake") or 1.0)
    out: Dict[str, Dict[str, Any]] = {}
    for k, b in buckets.items():
        t = b["trades"]
        wr = b["wins"] / t if t else 0.0
        avg_stake = b["total_stake"] / t if t else 1.0
        ev = b["net_pnl"] / t if t else 0.0
        out[k] = {
            "trades": t,
            "wins": b["wins"],
            "losses": b["losses"],
            "win_rate": round(wr, 4),
            "net_pnl": round(b["net_pnl"], 2),
            "expectancy": round(ev, 4),
            "expectancy_pct_stake": round(ev / avg_stake * 100, 2) if avg_stake else 0.0,
        }
    return out


def generate_validation_report(
    audit_db_path: str | Path,
    *,
    digits: List[int] | None = None,
    backtest_stake: float = 1.0,
) -> Dict[str, Any]:
    """Build full validation report from audit DB + optional backtest on digit stream."""
    path = Path(audit_db_path)
    audit_rows: List[Dict[str, Any]] = []
    signal_freq: DefaultDict[str, int] = defaultdict(int)

    if path.exists():
        con = sqlite3.connect(str(path))
        try:
            cur = con.execute(
                """
                SELECT timestamp, trigger_digits, repeated_digit, side, barrier,
                       contract_type, probability_score, confluence_score, payout_ratio,
                       stake, result, profit_loss, reason_skipped, executed,
                       probability_gate_passed, search_passed, confluence_passed, risk_passed
                FROM trade_audit ORDER BY id
                """
            )
            for r in cur.fetchall():
                row = {
                    "timestamp": r[0],
                    "trigger_digits": json.loads(r[1] or "[]"),
                    "repeated_digit": r[2],
                    "side": r[3],
                    "barrier": r[4],
                    "contract_type": r[5],
                    "probability_score": r[6],
                    "confluence_score": r[7],
                    "payout_ratio": r[8],
                    "stake": r[9],
                    "result": r[10],
                    "profit_loss": r[11],
                    "reason_skipped": r[12],
                    "executed": bool(r[13]),
                    "probability_gate_passed": bool(r[14]),
                    "search_passed": bool(r[15]),
                    "confluence_passed": bool(r[16]),
                    "risk_passed": bool(r[17]),
                }
                audit_rows.append(row)
                if row["repeated_digit"] is not None:
                    signal_freq[str(row["repeated_digit"])] += 1
        finally:
            con.close()

    executed = [r for r in audit_rows if r.get("executed") and r.get("result") in ("win", "loss")]
    skipped = [r for r in audit_rows if r.get("reason_skipped")]

    by_digit = _bucket_stats(executed, lambda r: r.get("repeated_digit"))
    by_barrier = _bucket_stats(executed, lambda r: r.get("barrier"))
    by_side = _bucket_stats(executed, lambda r: r.get("side"))

    setups = [
        {
            "key": f"digit={d}|barrier={r.get('barrier')}|side={r.get('side')}",
            **{k: r.get(k) for k in ("repeated_digit", "barrier", "side", "result", "profit_loss")},
        }
        for r in executed
        for d in [r.get("repeated_digit")]
    ]
    setup_buckets = _bucket_stats(
        executed,
        lambda r: f"d{r.get('repeated_digit')}_{r.get('side')}_b{r.get('barrier')}",
    )
    ranked = sorted(setup_buckets.items(), key=lambda kv: kv[1]["expectancy"], reverse=True)

    report: Dict[str, Any] = {
        "audit_summary": {
            "total_decisions": len(audit_rows),
            "executed_trades": len(executed),
            "skipped_signals": len(skipped),
            "signal_frequency_by_digit": dict(signal_freq),
        },
        "win_rate_by_repeated_digit": by_digit,
        "win_rate_by_barrier": by_barrier,
        "win_rate_by_side": by_side,
        "expected_value_by_setup": setup_buckets,
        "top_performing_setups": [{"setup": k, **v} for k, v in ranked[:10] if v["trades"] >= 1],
        "worst_performing_setups": [{"setup": k, **v} for k, v in ranked[-10:] if v["trades"] >= 1],
    }

    if digits:
        strategy = load_strategy()
        bt = run_pipeline_backtest(digits, strategy, stake=backtest_stake, skip_confluence=True)
        report["backtest"] = bt.to_dict()

    return report


def format_console_report(report: Dict[str, Any]) -> str:
    lines = ["=" * 60, "STRATEGY VALIDATION REPORT", "=" * 60]
    summ = report.get("audit_summary") or {}
    lines.append(f"Total decisions logged: {summ.get('total_decisions', 0)}")
    lines.append(f"Executed trades: {summ.get('executed_trades', 0)}")
    lines.append(f"Skipped signals: {summ.get('skipped_signals', 0)}")
    lines.append("")
    lines.append("Signal frequency by digit:")
    for d, c in sorted((summ.get("signal_frequency_by_digit") or {}).items(), key=lambda x: int(x[0])):
        lines.append(f"  digit {d}: {c}")
    lines.append("")
    for title, key in (
        ("Win rate by repeated digit", "win_rate_by_repeated_digit"),
        ("Win rate by barrier", "win_rate_by_barrier"),
        ("Win rate by side", "win_rate_by_side"),
    ):
        lines.append(title + ":")
        for k, v in sorted((report.get(key) or {}).items()):
            lines.append(f"  {k}: {v['trades']} trades, WR={v['win_rate']:.1%}, EV={v['expectancy']:.4f}")
        lines.append("")
    lines.append("Top setups:")
    for s in report.get("top_performing_setups") or []:
        lines.append(f"  {s.get('setup')}: EV={s.get('expectancy')} WR={s.get('win_rate')}")
    lines.append("")
    lines.append("Worst setups:")
    for s in report.get("worst_performing_setups") or []:
        lines.append(f"  {s.get('setup')}: EV={s.get('expectancy')} WR={s.get('win_rate')}")
    if report.get("backtest"):
        lines.append("")
        lines.append("Backtest (production pipeline, next-tick):")
        for k, v in report["backtest"].items():
            lines.append(f"  {k}: {v}")
    lines.append("=" * 60)
    return "\n".join(lines)


def export_report_csv(report: Dict[str, Any]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["section", "key", "trades", "wins", "losses", "win_rate", "expectancy", "net_pnl"])
    for section in ("win_rate_by_repeated_digit", "win_rate_by_barrier", "win_rate_by_side", "expected_value_by_setup"):
        for k, v in (report.get(section) or {}).items():
            w.writerow([section, k, v.get("trades"), v.get("wins"), v.get("losses"), v.get("win_rate"), v.get("expectancy"), v.get("net_pnl")])
    return buf.getvalue()


def save_report_tables(report: Dict[str, Any], db_path: str | Path) -> None:
    """Persist aggregated validation metrics to validation_metrics table."""
    path = Path(db_path)
    con = sqlite3.connect(str(path))
    try:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS validation_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                section TEXT NOT NULL,
                key TEXT NOT NULL,
                trades INTEGER,
                wins INTEGER,
                losses INTEGER,
                win_rate REAL,
                expectancy REAL,
                net_pnl REAL,
                payload_json TEXT
            )
            """
        )
        con.execute("DELETE FROM validation_metrics")
        for section in ("win_rate_by_repeated_digit", "win_rate_by_barrier", "win_rate_by_side", "expected_value_by_setup"):
            for k, v in (report.get(section) or {}).items():
                con.execute(
                    """
                    INSERT INTO validation_metrics
                    (section, key, trades, wins, losses, win_rate, expectancy, net_pnl, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        section,
                        k,
                        v.get("trades"),
                        v.get("wins"),
                        v.get("losses"),
                        v.get("win_rate"),
                        v.get("expectancy"),
                        v.get("net_pnl"),
                        json.dumps(v),
                    ),
                )
        con.commit()
    finally:
        con.close()
