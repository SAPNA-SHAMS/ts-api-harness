#!/usr/bin/env python3
"""PreToolUse gate: no source edit until the active item has a complete contract, a recorded
stakeholder yes and (for non-test files) a red run. Harness records are never hand-written.
Exit 2 = refuse; the reason on stderr goes back to the agent."""
from __future__ import annotations

import json
import re
import shlex
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
import _lib as L  # noqa: E402


def refuse(msg: str) -> None:
    print(f"REFUSED {msg}", file=sys.stderr)
    sys.exit(2)


def check_source(path: str, transcript: str | None) -> None:
    slug = L.active_slug()
    if not slug:
        refuse(f"problem-statement gate: {path} is source and no backlog item is active. Run ./item start <slug> and write docs/contracts/<slug>.md first.")
    missing = L.missing_fields(slug)
    if missing:
        refuse(f"problem-statement gate: docs/contracts/{slug}.md is missing: {'; '.join(missing)}. No source edit until it is complete.")
    if not L.try_record_yes(slug, transcript):
        refuse(f"human-yes gate: no stakeholder yes recorded for '{slug}'. Run ./item propose {slug}, paste it to the stakeholder, end your turn and wait for their typed reply.")
    if L.matches(path, L.CONFIG["testGlobs"]):
        return
    if not L.last(slug, "red"):
        refuse(f"red-before-green: no failing run recorded for '{slug}'. Write the test, then ./item red {slug} -- <test command>.")


def check_contract_edit(path: str, new_text: str | None) -> None:
    """Agents may draft a contract but not sign it or type metric values."""
    if new_text is None:
        return
    slug = path.rsplit("/", 1)[-1][:-3]
    cur = L.contract_path(slug).read_text() if L.contract_path(slug).exists() else ""
    old_f, new_f = L.parse_contract(cur), L.parse_contract(new_text)
    if (old_f.get("Signed") or "") != (new_f.get("Signed") or ""):
        refuse("contract gate: the Signed line is recorded by the harness from the stakeholder's typed yes, never written by hand.")
    if L.metric_values(old_f) != L.metric_values(new_f):
        refuse("outcome check: metric before/after values are written by ./item metric from a real read, never typed.")


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


WRITE_OPS = re.compile(r"(>>?|\btee\b|\bsed\s+-i|\bcp\b|\bmv\b|\brm\b|\btouch\b|\bpython3?\b|\bnode\b|\bperl\b|\bdd\b|\btruncate\b)")


def check_bash(cmd: str, transcript: str | None, cwd: str | None) -> None:
    stripped = cmd.strip()
    is_item = re.match(r"^(\./item|python3?\s+scripts/item\.py)\b", stripped) and not re.search(r"[;&|`]|\$\(", stripped)
    if re.search(r"\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b", cmd) and not is_item:
        refuse("the agent never pushes or opens/merges PRs. ./item ship <slug> does it after every gate is clear; a human merges.")
    if is_item:
        return
    if re.search(r"\.harness/|(^|[\s'\"/])items/", cmd) and WRITE_OPS.search(cmd):
        refuse("records under .harness/ and items/ are written only by ./item and the hooks.")
    if WRITE_OPS.search(cmd) and any(L.matches(L.rel(w.lstrip(">"), cwd), L.CONFIG["harnessOwnedGlobs"]) for w in cmd.split() if "/" in w or "." in w):
        refuse("harness-owned files (hooks/, checks/, settings) cannot be changed by the agent.")
    if re.search(r"docs/contracts/", cmd) and WRITE_OPS.search(cmd):
        refuse("edit contracts with the Edit/Write tools so the contract gate can see the change, not via shell.")
    if WRITE_OPS.search(cmd):
        try:
            words = shlex.split(cmd)
        except ValueError:
            words = cmd.split()
        for w in words:
            w = w.lstrip(">")
            if "/" in w or "." in w:
                r = L.rel(w, cwd)
                if L.matches(r, L.CONFIG["sourceGlobs"]) or L.matches(r, L.CONFIG["testGlobs"]):
                    check_source(r, transcript)


def main() -> None:
    data = json.load(sys.stdin)
    tool, ti = data.get("tool_name", ""), data.get("tool_input") or {}
    transcript, cwd = data.get("transcript_path"), data.get("cwd")
    if tool == "Bash":
        check_bash(ti.get("command", ""), transcript, cwd)
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
