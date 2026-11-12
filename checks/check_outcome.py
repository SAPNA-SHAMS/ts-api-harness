#!/usr/bin/env python3
"""Outcome check: an item closes only when the metric in its contract was read by the harness
before the change and again after a human merged the PR, and both values sit in the contract.
Usage: python3 checks/check_outcome.py <slug>   (exit 0 = may close, 1 = refused with reasons)"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hooks"))
import _lib as L  # noqa: E402


def pr_state(url: str) -> dict:
    r = subprocess.run(["gh", "pr", "view", url, "--json", "state,mergedAt,mergedBy"], capture_output=True, text=True)
    if r.returncode != 0:
        return {"error": (r.stderr or r.stdout).strip()[:200]}
    return json.loads(r.stdout)


def problems(slug: str) -> list[str]:
    out = []
    if L.missing_fields(slug):
        return [f"contract incomplete: {'; '.join(L.missing_fields(slug))}"]
    if not L.signed(slug):
        out.append("no recorded stakeholder yes for the current contract text")
    if not L.last(slug, "red") or not L.last(slug, "green"):
        out.append("no red run followed by a green proof run")
    ship = L.last(slug, "shipped")
    before, after = L.last(slug, "metric", phase="before"), L.last(slug, "metric", phase="after")
    if not before:
        out.append("metric was never read BEFORE the change (./item metric <slug> before)")
    if not ship:
        out.append("not shipped: no harness-opened PR (./item ship <slug>)")
    else:
        st = pr_state(ship["pr"])
        if "error" in st:
            out.append(f"UNPROVEN: could not read PR state ({st['error']})")
        elif st.get("state") != "MERGED":
            out.append(f"PR {ship['pr']} is {st.get('state')}, not merged by a human")
        else:
            login = (st.get("mergedBy") or {}).get("login", "")
            if login.endswith("[bot]") or not login:
                out.append(f"PR merged by '{login or '?'}', not a human")
            if not after:
                out.append("metric was not read AFTER the merge (./item metric <slug> after)")
            elif after["ts"] <= st["mergedAt"].replace(".000", ""):
                out.append(f"after-read at {after['ts']} predates the merge at {st['mergedAt']}")
    fields = L.parse_contract(L.contract_path(slug).read_text())
    if before and after:
        b, a = L.metric_values(fields)
        if b != str(before["value"]) or a != str(after["value"]):
            out.append(f"contract shows before:{b} after:{a} but the harness read {before['value']} and {after['value']}")
    # Optional Coverage: line separates "the work exists" from "the site passes". When present,
    # the item closes only if coverage was read before and after the merge and went up.
    if L.coverage_cmd(fields):
        cb, ca = L.last(slug, "coverage", phase="before"), L.last(slug, "coverage", phase="after")
        if not cb or not ca:
            out.append("Coverage was not read both before and after the merge (./item metric reads it with the metric)")
        else:
            if float(ca["value"]) <= float(cb["value"]):
                out.append(f"coverage did not go up ({cb['value']} -> {ca['value']}); the work did not land")
            b, a = L.metric_values(fields, "Coverage")
            if b != str(cb["value"]) or a != str(ca["value"]):
                out.append(f"contract Coverage shows before:{b} after:{a} but the harness read {cb['value']} and {ca['value']}")
    return out


def main() -> None:
    slug = sys.argv[1]
    p = problems(slug)
    if p:
        print(f"REFUSED outcome check for '{slug}':", *[f"  - {x}" for x in p], sep="\n")
        sys.exit(1)
    print(f"outcome check passed for '{slug}'")


if __name__ == "__main__":
    main()
