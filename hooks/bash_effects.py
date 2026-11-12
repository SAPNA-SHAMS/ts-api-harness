#!/usr/bin/env python3
"""PostToolUse gate for Bash: judge the command by what it changed, not by how it was spelled.

problem_gate.py snapshots every dirty file before each Bash call. Here we diff against that
snapshot. Any protected path the command changed is checked with the same rules as an Edit:
  harness-owned files (hooks/, checks/, settings, ./item)  -> always put back
  records (items/, .harness/) and contracts               -> put back unless the command was ./item
  source and test files                                   -> put back if the problem-statement,
                                                             human-yes or red-before-green gate
                                                             would have refused the edit
Reads, redirects to /dev/null, node/python one-liners and commit messages are never refused,
because they change nothing. `git checkout <branch> -- <path>` is caught, because it does."""
from __future__ import annotations

import json
import shutil
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
import _lib as L  # noqa: E402
from problem_gate import is_item_cmd, source_problem  # noqa: E402


def main() -> None:
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return
    tool_id = data.get("tool_use_id")
    if not tool_id or not (L.SNAPS / tool_id / "snap.json").exists():
        return
    cmd = (data.get("tool_input") or {}).get("command", "")
    item = is_item_cmd(cmd)
    changed, snap = L.changes_since(tool_id)
    problems = []
    for p in changed:
        if L.matches(p, L.CONFIG["harnessOwnedGlobs"]):
            problems.append((p, "harness-owned; the agent cannot change the gates that govern it"))
        elif L.matches(p, L.CONFIG["recordGlobs"]) or p.startswith("docs/contracts/"):
            if not item:
                problems.append((p, "records and contracts change only through ./item or the Edit tool"))
        elif not item:
            reason = source_problem(p, data.get("transcript_path"))
            if reason:
                problems.append((p, reason))
    for p, _ in problems:
        L.restore(tool_id, p, snap)
    shutil.rmtree(L.SNAPS / tool_id, ignore_errors=True)
    if problems:
        lines = "\n".join(f"  {p}: {why}" for p, why in problems)
        print(json.dumps({"decision": "block", "reason": f"REFUSED by effect: this command changed protected files; they were put back.\n{lines}"}))


if __name__ == "__main__":
    main()
