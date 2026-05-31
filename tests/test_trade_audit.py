"""Trade audit persistence."""

from modules.trade_audit import TradeAudit


def test_trade_audit_record_and_update():
    audit = TradeAudit(":memory:")
    aid = audit.record_decision(
        {
            "timestamp": 1.0,
            "signal_digits": [0, 0, 0],
            "repeated_digit": 0,
            "side": "OVER",
            "barrier": 0,
            "contract_type": "DIGITOVER",
            "probability_gate_passed": True,
            "search_passed": True,
            "executed": False,
            "skip_reason": "",
        }
    )
    assert aid > 0
    audit.update_outcome(aid, result="win", profit_loss=1.5, executed=True)
    rows = audit.all_rows()
    assert len(rows) == 1
    assert rows[0]["result"] == "win"
    assert rows[0]["profit_loss"] == 1.5
