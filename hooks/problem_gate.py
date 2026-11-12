#!/usr/bin/env python3
"""PreToolUse gate: no source edit until the active item has a complete contract, a recorded
stakeholder yes and (for non-test files) a red run. Harness records are never hand-written.
Exit 2 = refuse; the reason on stderr goes back to the agent."""
from __future__ import annotations

import json
import re
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
import _lib as L  # noqa: E402


def refuse(msg: str) -> None:
    print(f"REFUSED {msg}", file=sys.stderr)
    sys.exit(2)


def source_problem(path: str, transcript: str | None) -> str | None:
    """Why an edit to this source/test path is not allowed yet, or None."""
    slug = L.active_slug()
    if not slug:
        return f"problem-statement gate: {path} is source and no backlog item is active. Run ./item start <slug> and write docs/contracts/<slug>.md first."
    missing = L.missing_fields(slug)
    if missing:
        return f"problem-statement gate: docs/contracts/{slug}.md is missing: {'; '.join(missing)}. No source edit until it is complete."
    if not L.try_record_yes(slug, transcript):
        return (f"human-yes gate: no stakeholder yes recorded for '{slug}'. Run ./item propose {slug}, post it, end your turn "
                f"and wait for a typed reply that names '{slug}' or its proposal id.")
    if L.matches(path, L.CONFIG["testGlobs"]):
        return None
    if not L.last(slug, "red"):
        return f"red-before-green: no failing run recorded for '{slug}'. Write the test, then ./item red {slug} -- <test command>."
    return None


def check_source(path: str, transcript: str | None) -> None:
    reason = source_problem(path, transcript)
    if reason:
        refuse(reason)


def check_contract_edit(path: str, new_text: str | None) -> None:
    """Agents may draft a contract but not sign it or type metric values."""
    if new_text is None:
        return
    slug = path.rsplit("/", 1)[-1][:-3]
    cur = L.contract_path(slug).read_text() if L.contract_path(slug).exists() else ""
    old_f, new_f = L.parse_contract(cur), L.parse_contract(new_text)
    if (old_f.get("Signed") or "") != (new_f.get("Signed") or ""):
        refuse("contract gate: the Signed line is recorded by the harness from the stakeholder's typed yes, never written by hand.")
    for key in ("Metric", "Coverage"):
        if L.metric_values(old_f, key) != L.metric_values(new_f, key):
            refuse(f"outcome check: {key} before/after values are written by ./item metric from a real read, never typed.")


def resulting_text(tool: str, ti: dict, path: str) -> str | None:
    if tool == "Write":
        return ti.get("content", "")
    p = L.ROOT / path
    cur = p.read_text() if p.exists() else ""
    edits = ti.get("edits") if tool == "MultiEdit" else [ti]
    for e in edits or []:
        old, new = e.get("old_string", ""), e.get("new_string", "")
        cur = cur.replace(old, new) if e.get("replace_all") else cur.replace(old, new, 1)
    return cur


def is_item_cmd(cmd: str) -> bool:
    s = cmd.strip()
    return bool(re.match(r"^(\./item|python3?\s+scripts/item\.py)\b", s)) and not re.search(r"[;&|`\n]|\$\(", s)


# Only what cannot be undone is refused up front. Every other Bash command runs, and
# hooks/bash_effects.py (PostToolUse) judges it by what it actually changed on disk.
IRREVERSIBLE = re.compile(r"\bgit\s+(push|reset\s+--hard|clean\s+-\w*f)\b|\bgh\s+pr\s+(create|merge)\b")


def check_bash(cmd: str, tool_id: str | None) -> None:
    if IRREVERSIBLE.search(cmd) and not is_item_cmd(cmd):
        refuse("the agent never pushes, tags, opens/merges PRs or discards work. ./item ship <slug> pushes after every gate is clear; a human merges.")
    if tool_id:
        L.snapshot(tool_id)


def main() -> None:
    data = json.load(sys.stdin)
    tool, ti = data.get("tool_name", ""), data.get("tool_input") or {}
    transcript, cwd = data.get("transcript_path"), data.get("cwd")
    if tool == "Bash":
        check_bash(ti.get("command", ""), data.get("tool_use_id"))
        return
    if tool not in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        return
    path = L.rel(ti.get("file_path") or ti.get("notebook_path") or "", cwd)
    if L.matches(path, L.CONFIG["harnessOwnedGlobs"]):
        refuse(f"{path} is harness-owned (a gate, check or its wiring). The agent cannot edit the gates that govern it; a human changes these by hand.")
    if L.matches(path, L.CONFIG["recordGlobs"]):
        refuse(f"{path} is a harness record. It is written only by ./item and the hooks.")
    if re.match(r"^docs/contracts/[^/]+\.md$", path) and not path.endswith("_TEMPLATE.md"):
        check_contract_edit(path, resulting_text(tool, ti, path) if tool != "NotebookEdit" else None)
        return
    if L.matches(path, L.CONFIG["sourceGlobs"]) or L.matches(path, L.CONFIG["testGlobs"]):
        check_source(path, transcript)


if __name__ == "__main__":
    main()
