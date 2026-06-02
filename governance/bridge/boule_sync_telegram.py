#!/usr/bin/env python3
"""Bounded outbound bridge: push pending Boule escalations to Telegram (sync-once).

Reads pending escalations from the TS sidecar (the read-only `pending_escalations`
MCP command via bridge/boule-mcp.mjs — NO markdown parsing here), builds a
NormalizedEvent, and pipes it into the existing Telegram sink. Idempotent: each
blocked-event id is sent at most once (sent-marker file). Bounded by --limit; no
daemon, no poll loop (INVARIANT #5). This script imports NO network client — the
sink (~/.claude/hooks/cmux_notify_telegram.py) owns the only network call (#3).

Usage:
  BOULE_WORKSPACE=/path/to/workspace python3 boule_sync_telegram.py [--limit N] [--dry-run]
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import pathlib
import subprocess
import sys
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
MCP_CLIENT = HERE / "boule-mcp.mjs"
DEFAULT_SINK = pathlib.Path.home() / ".claude" / "hooks" / "cmux_notify_telegram.py"
SINK = pathlib.Path(os.environ.get("BOULE_TELEGRAM_SINK", str(DEFAULT_SINK)))


def _utc() -> str:
    return _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _workspace() -> pathlib.Path:
    ws = os.environ.get("BOULE_WORKSPACE")
    if not ws:
        raise SystemExit("BOULE_WORKSPACE is required (must match the escalate/choose workspace)")
    return pathlib.Path(ws)


def marker_path(workspace: pathlib.Path) -> pathlib.Path:
    return workspace / ".bridge" / "telegram-sent.json"


def load_sent(path: pathlib.Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_sent(path: pathlib.Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def fetch_pending(workspace: pathlib.Path) -> list[dict[str, Any]]:
    """Call the read-only TS reader; never parse markdown here."""
    cp = subprocess.run(
        ["node", str(MCP_CLIENT), "pending_escalations", "{}"],
        text=True, capture_output=True, timeout=30,
        env={**os.environ, "BOULE_WORKSPACE": str(workspace)},
    )
    if cp.returncode != 0:
        raise SystemExit(f"pending_escalations failed: {cp.stderr.strip()}")
    out = cp.stdout.strip()
    return json.loads(out) if out else []


def select_unsent(pending: list[dict[str, Any]], sent: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
    fresh = [e for e in pending if e.get("blockedEventId") not in sent]
    return fresh[: max(0, limit)]


def _render_detail(esc: dict[str, Any]) -> str:
    lines = [esc.get("question", ""), "", "고른 항목의 코드만 그대로 답장하세요:"]
    for o in esc.get("options", []):
        lines.append("")
        lines.append(f"[{o.get('token')}] {o.get('label')}")
        lines.append(o.get("reply", ""))
    rec = esc.get("agentRecommendation")
    if rec:
        lines += ["", f"(추천: {rec})"]
    return "\n".join(lines)


def build_normalized_event(esc: dict[str, Any]) -> dict[str, Any]:
    """A NormalizedEvent (the SSOT shape cmux_notify_telegram.py consumes). Routing/title/
    detail decided here; the sink only does topic-create + render + send."""
    session_id = esc.get("sessionId")
    question = esc.get("question", "")
    if session_id:
        key = f"session:{session_id}"
        workspace_title = ""  # the sink inherits the last-known workspace name for this key
        pane_name = ""
    else:
        key = f"boule:{esc.get('decisionId')}"
        workspace_title = "Boule"
        pane_name = question[:80]
    return {
        "routable": True,
        "key": key,
        "title": f"🟣 DECISION NEEDED — {question}"[:200],
        "detail": _render_detail(esc),
        "workspace_title": workspace_title,
        "pane_name": pane_name,
        "session_id": session_id or "",
        "surface": "",
        "cwd": "",
        "event": "BouleEscalation",
    }


def post_to_sink(ne: dict[str, Any], *, dry_run: bool) -> bool:
    argv = ["python3", str(SINK)] + (["--dry-run"] if dry_run else [])
    cp = subprocess.run(argv, input=json.dumps(ne, ensure_ascii=False),
                        text=True, capture_output=True, timeout=30)
    if dry_run and cp.stdout:
        sys.stdout.write(cp.stdout)
    return cp.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    workspace = _workspace()
    sent_file = marker_path(workspace)
    sent = load_sent(sent_file)
    batch = select_unsent(fetch_pending(workspace), sent, limit=a.limit)
    if not batch:
        print("nothing to send")
        return 0
    for esc in batch:
        ne = build_normalized_event(esc)
        if post_to_sink(ne, dry_run=a.dry_run):
            if not a.dry_run:  # dry-run never records markers → repeatable
                sent[esc["blockedEventId"]] = {"sent_at": _utc(), "topic_key": ne["key"]}
        else:
            print(f"WARN: sink rejected escalation {esc.get('blockedEventId')}", file=sys.stderr)
    if not a.dry_run:
        save_sent(sent_file, sent)
    print(f"processed {len(batch)} escalation(s){' (dry-run)' if a.dry_run else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
