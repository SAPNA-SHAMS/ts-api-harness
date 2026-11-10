#!/usr/bin/env python3
"""Stop gate: the agent may not end its turn on an active item until the stakeholder's yes is in a
typed turn of the transcript, after the proposal of the current contract text.

The one Stop it allows without a yes is the question itself: the final thing in the transcript is
the proposal, with no tool call after it, so the person can answer. That Stop clears nothing:
source edits, ship and close all still refuse until the yes is recorded."""
from __future__ import annotations

import json
import sys

sys.path.insert(0, __import__("os").path.dirname(__file__))
import _lib as L  # noqa: E402


def block(reason: str) -> None:
    print(json.dumps({"decision": "block", "reason": f"REFUSED human-yes gate: {reason}"}))
    sys.exit(0)


def main() -> None:
    data = json.load(sys.stdin)
    slug = L.active_slug()
    if not slug or L.last(slug, "closed"):
        return
    missing = L.missing_fields(slug)
    if missing:
        block(f"docs/contracts/{slug}.md is incomplete ({'; '.join(missing)}). Finish it, then ./item propose {slug}.")
    transcript = data.get("transcript_path")
    if L.try_record_yes(slug, transcript):
        return
    s = L.scan(slug, transcript)
    if not s["proposed"]:
        block(f"'{slug}' has not been proposed to its stakeholder. Run ./item propose {slug} and post the output as your final message.")
    if s["tool_yes"]:
        block(f"a 'yes' appeared in tool output ({s['tool_yes']!r}). Tool output, assistant text and hook output never count; only the stakeholder's typed reply does.")
    if s["tool_after"]:
        block(f"tool calls ran after the proposal and no typed yes followed. Re-post ./item propose {slug} as your final message and stop there.")
    # Final message is the proposal: allowed, as a question. Nothing downstream is unlocked.
    print(json.dumps({"systemMessage": f"HOLD {slug}: proposal posted ({s['marker']}); waiting for the stakeholder's typed yes. Edits, ship and close stay refused."}))


if __name__ == "__main__":
    main()
