"""Run validation report and backtest for deliverable stats."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from modules.backtest_engine import run_pipeline_backtest
from modules.market_data import fetch_ticks_history_public
from modules.strategy_engine import load_strategy
from modules.validation_report import format_console_report, generate_validation_report, save_report_tables

digits = [int(f"{t['price']:.5f}"[-1]) for t in fetch_ticks_history_public("R_100", 5000)]
strat = load_strategy()
bt = run_pipeline_backtest(digits, strat, stake=1.0, skip_confluence=True)
print("BACKTEST", bt.to_dict())
report = generate_validation_report(Path("trade_audit.db"), digits=digits)
save_report_tables(report, Path("trade_audit.db"))
print(format_console_report(report))
