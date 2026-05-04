"""In-memory copy trading: master, followers, replicated trade log."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_lock = threading.RLock()
_master_id: Optional[str] = None
_followers: set[str] = set()
_copied_trades: List[Dict[str, Any]] = []
_master_stats: Dict[str, Any] = {
    "trades": 0,
    "wins": 0,
    "profit": 0.0,
}


def set_master(master_id: str) -> Dict[str, Any]:
    global _master_id
    with _lock:
        _master_id = master_id.strip() or "default_master"
        logger.info("Copy master set: %s", _master_id)
        return {"master_id": _master_id}


def get_master() -> Optional[str]:
    with _lock:
        return _master_id


def follow(follower_id: str) -> Dict[str, Any]:
    with _lock:
        fid = follower_id.strip() or "follower"
        _followers.add(fid)
        logger.info("Follower added: %s", fid)
        return {"follower_id": fid, "followers": list(_followers)}


def unfollow(follower_id: str) -> Dict[str, Any]:
    with _lock:
        _followers.discard(follower_id.strip())
        return {"followers": list(_followers)}


def notify_master_trade(trade: Dict[str, Any]) -> None:
    """Call when the bot (acting as master) completes a trade."""
    global _copied_trades, _master_stats
    with _lock:
        _master_stats["trades"] += 1
        if trade.get("result") == "win":
            _master_stats["wins"] += 1
        _master_stats["profit"] = round(
            float(_master_stats["profit"]) + float(trade.get("profit", 0)), 2
        )
        entry = {
            "time": time.strftime("%H:%M:%S"),
            "source": "master",
            "trade": dict(trade),
        }
        for follower in list(_followers):
            entry_copy = {
                "time": time.strftime("%H:%M:%S"),
                "source": "copy",
                "follower": follower,
                "trade": dict(trade),
            }
            _copied_trades.append(entry_copy)
            logger.debug("Copied trade to %s", follower)
        _copied_trades.append(entry)
        _copied_trades = _copied_trades[-100:]


def snapshot() -> Dict[str, Any]:
    with _lock:
        return {
            "master_id": _master_id,
            "followers": list(_followers),
            "master_stats": dict(_master_stats),
            "recent_copies": list(_copied_trades[-30:]),
        }
