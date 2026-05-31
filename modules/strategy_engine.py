"""Strategy JSON persistence and validation (Blockly / API)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

STRATEGY_PATH = Path(__file__).resolve().parent.parent / "strategy.json"

DEFAULT_CONFLUENCE: Dict[str, Any] = {
    "enabled": True,
    "enforce_confluence": True,
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
        "use_probability_gate": False,
        "min_win_probability": 0.60,
        "min_samples": 120,
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
        "min_payout_to_stake": 2.2,
        "max_proposal_latency_ms": 1500,
    },
    "cooldown": {
        "cooldown_ticks": 10,
        "min_ticks_between_trades": 10,
    },
    "risk": {
        "max_consecutive_losses": 2,
        "max_session_drawdown_pct": 10.0,
        "max_trades_per_session": 50,
        "loss_cluster_window": 8,
        "loss_cluster_limit": 6,
        "volatility_lockout_enabled": True,
        "volatility_lockout_regime": "volatile",
    },
    "research_mode": False,
    "search": {
        "enabled": True,
        "barrier_policy": "signal",
        "min_estimated_ratio": 1.75,
        "avoid_extreme_barriers": True,
        "min_barrier_over": 0,
        "max_barrier_under": 8,
        "adaptive_ratio": False,
        "adaptive_ratio_tiers": [
            {"min_confidence": 0.90, "min_ratio": 1.15},
            {"min_confidence": 0.75, "min_ratio": 1.40},
        ],
    },
    "confluence": dict(DEFAULT_CONFLUENCE),
}

# One-click risk profiles: merges search + execution (strategy rules unchanged).
STRATEGY_PRESETS: Dict[str, Dict[str, Any]] = {
    "scalp_safe": {
        "label": "Scalp (safe)",
        "description": "Higher frequency, smaller edge; adaptive ratio for very confident signals.",
        "execution": {
            "min_payout_to_stake": 1.12,
            "max_proposal_latency_ms": 1200,
        },
        "search": {
            "enabled": True,
            "barrier_policy": "efficiency",
            "min_estimated_ratio": 1.12,
            "avoid_extreme_barriers": True,
            "min_barrier_over": 2,
            "max_barrier_under": 7,
            "adaptive_ratio": True,
            "adaptive_ratio_tiers": [
                {"min_confidence": 0.90, "min_ratio": 1.10},
                {"min_confidence": 0.80, "min_ratio": 1.20},
            ],
        },
    },
    "balanced": {
        "label": "Balanced",
        "description": "Default professional profile: mid barriers, ~1.75× minimum reward.",
    "execution": {
        "min_payout_to_stake": 1.75,
        "max_proposal_latency_ms": 1500,
        "enforce_on_manual": False,
    },
        "search": {
            "enabled": True,
            "barrier_policy": "efficiency",
            "min_estimated_ratio": 1.75,
            "avoid_extreme_barriers": True,
            "min_barrier_over": 4,
            "max_barrier_under": 5,
            "adaptive_ratio": False,
            "adaptive_ratio_tiers": [
                {"min_confidence": 0.90, "min_ratio": 1.15},
                {"min_confidence": 0.75, "min_ratio": 1.40},
            ],
        },
    },
    "sniper": {
        "label": "Sniper",
        "description": "Fewer trades, high payout ratio target; extreme barriers only.",
        "execution": {
            "min_payout_to_stake": 2.50,
            "max_proposal_latency_ms": 2000,
        },
        "search": {
            "enabled": True,
            "barrier_policy": "efficiency",
            "min_estimated_ratio": 2.50,
            "avoid_extreme_barriers": True,
            "min_barrier_over": 6,
            "max_barrier_under": 4,
            "adaptive_ratio": False,
            "adaptive_ratio_tiers": [
                {"min_confidence": 0.90, "min_ratio": 2.00},
                {"min_confidence": 0.75, "min_ratio": 2.30},
            ],
        },
    },
}


def list_strategy_presets() -> list[Dict[str, str]]:
    return [
        {
            "id": key,
            "label": str(meta.get("label", key)),
            "description": str(meta.get("description", "")),
        }
        for key, meta in STRATEGY_PRESETS.items()
    ]


def apply_strategy_preset(strategy: Dict[str, Any], preset_id: str) -> Dict[str, Any]:
    pid = str(preset_id or "").strip().lower()
    if pid not in STRATEGY_PRESETS:
        raise ValueError(f"Unknown preset: {preset_id}")
    preset = STRATEGY_PRESETS[pid]
    merged = dict(strategy)
    merged["profile"] = pid
    merged["execution"] = {**(merged.get("execution") or {}), **dict(preset.get("execution") or {})}
    merged["search"] = {**(merged.get("search") or {}), **dict(preset.get("search") or {})}
    return validate_strategy(merged)


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

    raw_model = strategy.get("model") if isinstance(strategy.get("model"), dict) else {}
    prob_gate = bool(raw_model.get("use_probability_gate", DEFAULT_STRATEGY["model"]["use_probability_gate"]))
    min_wp_raw = raw_model.get("min_win_probability", None)
    if min_wp_raw is None:
        min_wp = float(DEFAULT_STRATEGY["model"]["min_win_probability"])
    else:
        min_wp = max(0.0, min(0.95, float(min_wp_raw)))
    min_samples = int(raw_model.get("min_samples", DEFAULT_STRATEGY["model"].get("min_samples", 120)))
    min_samples = max(50, min(2000, min_samples))
    validated: Dict[str, Any] = {
        "type": "digit_strategy",
        "condition": "repeat_3",
        "action": active_action,
        "active_action": active_action,
        "actions": actions,
        # Backward compatibility for existing UI/consumers expecting top-level rules.
        "rules": dict(actions[active_action]["rules"]),
        "model": {
            "use_probability_gate": prob_gate,
            "min_win_probability": min_wp,
            "min_samples": min_samples,
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
            "enforce_on_manual": bool((strategy.get("execution") or {}).get("enforce_on_manual", False)),
        },
        "search": _validate_search(strategy.get("search") if isinstance(strategy.get("search"), dict) else {}),
        "confluence": conf,
        "cooldown": _validate_cooldown(strategy.get("cooldown") if isinstance(strategy.get("cooldown"), dict) else {}),
        "risk": _validate_risk(strategy.get("risk") if isinstance(strategy.get("risk"), dict) else {}),
        "profile": _validate_profile(strategy.get("profile")),
        "research_mode": bool(strategy.get("research_mode", DEFAULT_STRATEGY.get("research_mode", False))),
    }
    validated["search"] = align_search_with_signal_rules(
        validated["search"],
        validated["actions"]["over_under"]["rules"],
    )
    return validated


def _validate_profile(raw: Any) -> str:
    pid = str(raw or "").strip().lower()
    return pid if pid in STRATEGY_PRESETS else ""


def _validate_cooldown(raw: Dict[str, Any]) -> Dict[str, Any]:
    defaults = dict(DEFAULT_STRATEGY["cooldown"])
    ticks = int(raw.get("cooldown_ticks", raw.get("min_ticks_between_trades", defaults["cooldown_ticks"])))
    ticks = max(0, min(500, ticks))
    return {"cooldown_ticks": ticks, "min_ticks_between_trades": ticks}


def _validate_risk(raw: Dict[str, Any]) -> Dict[str, Any]:
    defaults = dict(DEFAULT_STRATEGY["risk"])
    src = raw if isinstance(raw, dict) else {}
    return {
        "max_consecutive_losses": max(1, min(20, int(src.get("max_consecutive_losses", defaults["max_consecutive_losses"])))),
        "max_session_drawdown_pct": max(
            1.0, min(100.0, float(src.get("max_session_drawdown_pct", defaults["max_session_drawdown_pct"])))
        ),
        "max_trades_per_session": max(1, min(500, int(src.get("max_trades_per_session", defaults["max_trades_per_session"])))),
        "loss_cluster_window": max(3, min(50, int(src.get("loss_cluster_window", defaults["loss_cluster_window"])))),
        "loss_cluster_limit": max(2, min(50, int(src.get("loss_cluster_limit", defaults["loss_cluster_limit"])))),
        "volatility_lockout_enabled": bool(src.get("volatility_lockout_enabled", defaults["volatility_lockout_enabled"])),
        "volatility_lockout_regime": str(src.get("volatility_lockout_regime", defaults["volatility_lockout_regime"])),
    }


def align_search_with_signal_rules(
    search: Dict[str, Any],
    over_under_rules: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Ensure search-layer barrier bounds do not block signal-engine output.
    Signal: digits < threshold → OVER @ repeated_digit; digits >= threshold → UNDER @ repeated_digit.
    """
    threshold = int(over_under_rules.get("if_digit_greater_equal", 5))
    threshold = min(max(threshold, 0), 9)
    out = dict(search)
    if not bool(out.get("avoid_extreme_barriers", True)):
        return out
    # OVER signals use barriers 0 .. threshold-1
    out["min_barrier_over"] = 0
    # UNDER signals use barriers threshold .. 8 (9 clamps to 8 on Deriv)
    out["max_barrier_under"] = 8
    if threshold <= 0:
        out["max_barrier_under"] = 8
    return out


def search_signal_compatibility(strategy: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return per-digit signal paths and whether search filters would block them."""
    from modules import payout_search, signal_engine

    issues: List[Dict[str, Any]] = []
    rules = ((strategy.get("actions") or {}).get("over_under") or {}).get("rules") or strategy.get("rules") or {}
    search = dict(strategy.get("search") or {})
    for rep in range(10):
        sig = signal_engine.build_signal(
            strategy=strategy,
            signal_digits=[rep, rep, rep],
            repeated_digit=rep,
            regime="mixed",
        )
        if not sig or sig.active_action != "over_under":
            continue
        dec = {"contract_type": sig.contract_type, "barrier": sig.barrier, "side": sig.side}
        refined, skip = payout_search.refine_digit_decision(
            dec,
            strategy=strategy,
            repeated_digit=rep,
            transition_probs=None,
            confidence=0.5,
        )
        issues.append(
            {
                "repeated_digit": rep,
                "side": sig.side,
                "barrier": sig.barrier,
                "reachable": refined is not None,
                "block_reason": skip or "",
            }
        )
    return issues


def _validate_search(raw: Dict[str, Any]) -> Dict[str, Any]:
    defaults = dict(DEFAULT_STRATEGY["search"])
    src = raw if isinstance(raw, dict) else {}
    policy = str(src.get("barrier_policy", defaults["barrier_policy"])).strip().lower()
    if policy in {"efficient", "adaptive"}:
        policy = "efficiency"
    if policy not in {"signal", "efficiency"}:
        policy = "signal"
    tiers_in = src.get("adaptive_ratio_tiers")
    tiers: list[Dict[str, Any]] = []
    if isinstance(tiers_in, list):
        for t in tiers_in:
            if not isinstance(t, dict):
                continue
            tiers.append(
                {
                    "min_confidence": max(0.0, min(1.0, float(t.get("min_confidence", 0)))),
                    "min_ratio": max(1.01, min(10.0, float(t.get("min_ratio", 1.75)))),
                }
            )
    if not tiers:
        tiers = [dict(x) for x in defaults["adaptive_ratio_tiers"]]
    return {
        "enabled": bool(src.get("enabled", defaults["enabled"])),
        "barrier_policy": policy,
        "min_estimated_ratio": max(
            1.01, min(10.0, float(src.get("min_estimated_ratio", defaults["min_estimated_ratio"])))
        ),
        "avoid_extreme_barriers": bool(src.get("avoid_extreme_barriers", defaults["avoid_extreme_barriers"])),
        "min_barrier_over": max(0, min(8, int(src.get("min_barrier_over", defaults["min_barrier_over"])))),
        "max_barrier_under": max(0, min(8, int(src.get("max_barrier_under", defaults["max_barrier_under"])))),
        "adaptive_ratio": bool(src.get("adaptive_ratio", defaults["adaptive_ratio"])),
        "adaptive_ratio_tiers": tiers,
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
