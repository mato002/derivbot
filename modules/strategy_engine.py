"""Strategy JSON persistence and validation (Blockly / API)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict

logger = logging.getLogger(__name__)

STRATEGY_PATH = Path(__file__).resolve().parent.parent / "strategy.json"

DEFAULT_CONFLUENCE: Dict[str, Any] = {
    "enabled": True,
    # When false, confluence is advisory only (Over/Under base signal still trades).
    "enforce_confluence": False,
    "min_score": 5,
    "min_confirmations": 2,
    "use_trend": True,
    "use_sr": True,
    "use_rsi": True,
    "use_candles": True,
    "use_range": True,
    "ticks_per_candle": 28,
    "sr_lookback": 90,
    "sr_tolerance_pct": 0.22,
    "history_ticks": 900,
}

DEFAULT_ACTION_RULES: Dict[str, Dict[str, Any]] = {
    "over_under": {
        "if_digit_greater_equal": 5,
        "trade": "UNDER",
        "else_trade": "OVER",
    },
    "rise_fall": {
        "if_digit_greater_equal": 5,
        "trade": "RISE",
        "else_trade": "FALL",
    },
}

DEFAULT_STRATEGY: Dict[str, Any] = {
    "type": "digit_strategy",
    "condition": "repeat_3",
    # Backward-compatible mirror of active_action.
    "action": "over_under",
    "active_action": "over_under",
    "actions": {
        "over_under": {"enabled": True, "rules": dict(DEFAULT_ACTION_RULES["over_under"])},
        "rise_fall": {"enabled": False, "rules": dict(DEFAULT_ACTION_RULES["rise_fall"])},
    },
    "model": {
        "min_win_probability": 0.53,
    },
    "portfolio": {
        "enabled": True,
        "regime_action_map": {
            "volatile": "rise_fall",
            "range": "over_under",
            "mixed": "over_under",
        },
    },
    "execution": {
        "min_payout_to_stake": 1.75,
        "max_proposal_latency_ms": 1500,
    },
    "confluence": dict(DEFAULT_CONFLUENCE),
}


def validate_strategy(strategy: Dict[str, Any]) -> Dict[str, Any]:
    strategy = strategy if isinstance(strategy, dict) else {}
    active_action = str(strategy.get("active_action") or strategy.get("action") or "over_under").strip().lower()
    if active_action not in {"over_under", "rise_fall"}:
        active_action = "over_under"

    # Backward compatibility: old payload had top-level rules for over_under only.
    incoming_actions = strategy.get("actions") if isinstance(strategy.get("actions"), dict) else {}
    legacy_rules = strategy.get("rules") if isinstance(strategy.get("rules"), dict) else {}
    if isinstance(incoming_actions, dict) and incoming_actions:
        over_under_src = incoming_actions.get("over_under") or {}
        rise_fall_src = incoming_actions.get("rise_fall") or {}
    else:
        over_under_src = {"enabled": active_action == "over_under", "rules": legacy_rules}
        rise_fall_src = {"enabled": active_action == "rise_fall", "rules": {}}

    def _sanitize_rules(action_name: str, source: Dict[str, Any]) -> Dict[str, Any]:
        default_rules = dict(DEFAULT_ACTION_RULES[action_name])
        raw_rules = source.get("rules") if isinstance(source.get("rules"), dict) else {}
        if not raw_rules and isinstance(source, dict):
            # Allow flat source fallback.
            raw_rules = {k: source.get(k) for k in ("if_digit_greater_equal", "trade", "else_trade")}
        raw_threshold = raw_rules.get("if_digit_greater_equal")
        if raw_threshold is None:
            raw_threshold = default_rules["if_digit_greater_equal"]
        threshold = int(raw_threshold)
        threshold = min(max(threshold, 0), 9)
        trade = str(raw_rules.get("trade", default_rules["trade"])).upper()
        else_trade = str(raw_rules.get("else_trade", default_rules["else_trade"])).upper()
        allowed = {"over_under": {"UNDER", "OVER"}, "rise_fall": {"RISE", "FALL"}}[action_name]
        if trade not in allowed:
            trade = default_rules["trade"]
        if else_trade not in allowed:
            else_trade = default_rules["else_trade"]
        return {
            "if_digit_greater_equal": threshold,
            "trade": trade,
            "else_trade": else_trade,
        }

    over_under_enabled = bool(over_under_src.get("enabled", active_action == "over_under"))
    rise_fall_enabled = bool(rise_fall_src.get("enabled", active_action == "rise_fall"))
    actions = {
        "over_under": {
            "enabled": over_under_enabled,
            "rules": _sanitize_rules("over_under", over_under_src if isinstance(over_under_src, dict) else {}),
        },
        "rise_fall": {
            "enabled": rise_fall_enabled,
            "rules": _sanitize_rules("rise_fall", rise_fall_src if isinstance(rise_fall_src, dict) else {}),
        },
    }

    # Ensure only the selected action is active by default (independent / no collision).
    for name, payload in actions.items():
        payload["enabled"] = name == active_action

    raw_conf = strategy.get("confluence") if isinstance(strategy, dict) else {}
    conf: Dict[str, Any] = dict(DEFAULT_CONFLUENCE)
    if isinstance(raw_conf, dict):
        for k, v in raw_conf.items():
            if k in DEFAULT_CONFLUENCE:
                if isinstance(DEFAULT_CONFLUENCE[k], bool):
                    conf[k] = bool(v)
                elif isinstance(DEFAULT_CONFLUENCE[k], int):
                    conf[k] = int(v)
                elif isinstance(DEFAULT_CONFLUENCE[k], float):
                    conf[k] = float(v)
                else:
                    conf[k] = v
    return {
        "type": "digit_strategy",
        "condition": "repeat_3",
        "action": active_action,
        "active_action": active_action,
        "actions": actions,
        # Backward compatibility for existing UI/consumers expecting top-level rules.
        "rules": dict(actions[active_action]["rules"]),
        "model": {
            "min_win_probability": max(
                0.5, min(0.75, float((strategy.get("model") or {}).get("min_win_probability", 0.53)))
            )
        },
        "portfolio": {
            "enabled": bool((strategy.get("portfolio") or {}).get("enabled", True)),
            "regime_action_map": {
                "volatile": str(
                    ((strategy.get("portfolio") or {}).get("regime_action_map") or {}).get("volatile", "rise_fall")
                ).lower(),
                "range": str(
                    ((strategy.get("portfolio") or {}).get("regime_action_map") or {}).get("range", "over_under")
                ).lower(),
                "mixed": str(
                    ((strategy.get("portfolio") or {}).get("regime_action_map") or {}).get("mixed", "over_under")
                ).lower(),
            },
        },
        "execution": {
            "min_payout_to_stake": max(
                1.01, min(10.0, float((strategy.get("execution") or {}).get("min_payout_to_stake", 1.75)))
            ),
            "max_proposal_latency_ms": max(
                50, min(5000, int((strategy.get("execution") or {}).get("max_proposal_latency_ms", 1500)))
            ),
        },
        "confluence": conf,
    }


def load_strategy() -> Dict[str, Any]:
    if not STRATEGY_PATH.exists():
        STRATEGY_PATH.write_text(json.dumps(DEFAULT_STRATEGY, indent=2), encoding="utf-8")
        logger.info("Created default strategy file")
        return dict(DEFAULT_STRATEGY)
    try:
        data = json.loads(STRATEGY_PATH.read_text(encoding="utf-8"))
        return validate_strategy(data)
    except Exception as exc:
        logger.warning("Failed to load strategy, using default: %s", exc)
        return dict(DEFAULT_STRATEGY)


def save_strategy(strategy: Dict[str, Any]) -> Dict[str, Any]:
    validated = validate_strategy(strategy)
    STRATEGY_PATH.write_text(json.dumps(validated, indent=2), encoding="utf-8")
    logger.info("Strategy saved to %s", STRATEGY_PATH)
    return validated
