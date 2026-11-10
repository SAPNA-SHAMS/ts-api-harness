#!/usr/bin/env python3
"""./item — drives one backlog item through: contract -> yes -> red -> green -> ship -> metric -> close.
Every step writes items/<slug>/ledger.jsonl. Nothing here takes a value on anyone's word.

  ./item start <slug>                 make <slug> the active item (copies the contract template)
  ./item check <slug>                 list missing contract fields
  ./item propose <slug>               print the proposal block to post to the stakeholder
  ./item status [<slug>]              ledger summary
  ./item red <slug> -- <test cmd>     run the test; must FAIL; recorded
  ./item green <slug>                 rerun the recorded command; must PASS; recorded as proof
  ./item metric <slug> before|after   run the contract's Read: command; record + write the value
  ./item ship <slug>                  branch item/<slug>, commit, push, open PR (gates first)
  ./item close <slug>                 run checks/check_outcome.py; close only if it passes
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "hooks"))
import _lib as L  # noqa: E402

LOGS = L.ROOT / "items"


def die(msg: str) -> None:
    print(f"REFUSED {msg}", file=sys.stderr)
    sys.exit(1)


def need_signed(slug: str) -> None:
    if L.missing_fields(slug):
        die(f"contract incomplete: {'; '.join(L.missing_fields(slug))}")
    if not L.signed(slug):
        die(f"no recorded stakeholder yes for '{slug}' (current contract {L.proposal_hash(slug)})")


def repo_of(slug: str) -> Path:
    r = L.parse_contract(L.contract_path(slug).read_text()).get("Repo") or "."
    return (L.ROOT / Path(r).expanduser()).resolve()


def run(cmd: str, cwd: Path, log: Path) -> int:
    p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(f"$ {cmd}\n(cwd {cwd})\nexit {p.returncode}\n\n{p.stdout}\n{p.stderr}")
    return p.returncode


def cmd_start(slug: str) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,60}", slug):
        die("slug must be lowercase-kebab")
    if not L.contract_path(slug).exists():
        shutil.copy(L.CONTRACTS / "_TEMPLATE.md", L.contract_path(slug))
    L.set_active(slug)
    L.append(slug, "start")
    print(f"active item: {slug}\ncontract: docs/contracts/{slug}.md")
    cmd_check(slug)


def cmd_check(slug: str) -> None:
    m = L.missing_fields(slug)
    print("contract complete" if not m else "missing: " + "; ".join(m))
    sys.exit(1 if m else 0)


def cmd_propose(slug: str) -> None:
    if L.missing_fields(slug):
        die(f"contract incomplete: {'; '.join(L.missing_fields(slug))}")
    body = "\n".join(l for l in L.contract_path(slug).read_text().splitlines() if not l.startswith("Signed"))
    f = L.parse_contract(body)
    print(f"Post this as your final message, verbatim, then stop.\n\n{L.proposal_marker(slug)}\n"
          f"To: {f['Stakeholder']}\n\n{body}\n\nReply in your own words if this is what you want built.")


def cmd_red(slug: str, cmd: str) -> None:
    need_signed(slug)
    n = len([r for r in L.ledger(slug) if r["event"] == "red"]) + 1
    log = LOGS / slug / f"red-{n}.log"
    code = run(cmd, repo_of(slug), log)
    if code == 0:
        die(f"'{cmd}' PASSED. A red run must fail before the fix; log {log.relative_to(L.ROOT)}")
    L.append(slug, "red", cmd=cmd, exit=code, log=str(log.relative_to(L.ROOT)))
    print(f"red recorded (exit {code}); log {log.relative_to(L.ROOT)}")


def cmd_green(slug: str) -> None:
    need_signed(slug)
    red = L.last(slug, "red") or die("no red run recorded; nothing to prove green")
    n = len([r for r in L.ledger(slug) if r["event"] == "green"]) + 1
    log = LOGS / slug / f"green-{n}.log"
    code = run(red["cmd"], repo_of(slug), log)
    if code != 0:
        die(f"still red (exit {code}); log {log.relative_to(L.ROOT)}")
    L.append(slug, "green", cmd=red["cmd"], exit=0, log=str(log.relative_to(L.ROOT)))
    print(f"proof recorded: '{red['cmd']}' passes; log {log.relative_to(L.ROOT)}")


def cmd_metric(slug: str, phase: str) -> None:
    if phase not in ("before", "after"):
        die("phase is before|after")
    if L.missing_fields(slug):
        die(f"contract incomplete: {'; '.join(L.missing_fields(slug))}")
    if phase == "after":
        ship = L.last(slug, "shipped") or die("not shipped; the after-read happens after the merge")
        import json as _j
        st = subprocess.run(["gh", "pr", "view", ship["pr"], "--json", "state"], capture_output=True, text=True)
        if st.returncode != 0 or _j.loads(st.stdout).get("state") != "MERGED":
            die(f"PR {ship['pr']} is not merged yet; read the metric after a human merges")
    read = L.parse_contract(L.contract_path(slug).read_text())["Read"]
    log = LOGS / slug / f"metric-{phase}.log"
    code = run(read, repo_of(slug), log)
    out = log.read_text().split("\n\n", 1)[-1]
    nums = re.findall(r"-?\d+(?:\.\d+)?%?", out.strip().splitlines()[-1] if out.strip() else "")
    if code != 0 or not nums:
        die(f"UNPROVEN: metric read failed (exit {code}) or printed no number on its last line; log {log.relative_to(L.ROOT)}")
    value = nums[-1]
    L.append(slug, "metric", phase=phase, value=value, cmd=read, log=str(log.relative_to(L.ROOT)))
    L.set_metric_value(slug, phase, value)
    print(f"metric {phase}: {value} (from '{read}')")


def cmd_ship(slug: str) -> None:
    need_signed(slug)
    red, green = L.last(slug, "red"), L.last(slug, "green")
    if not red or not green or green["ts"] < red["ts"]:
        die("needs a red run followed by a green proof run")
    if not L.last(slug, "metric", phase="before"):
        die("read the metric before shipping: ./item metric <slug> before")
    repo = repo_of(slug)
    branch = L.CONFIG["branchPrefix"] + slug
    for pat in L.CONFIG["protectedBranches"]:
        if L.matches(branch, [pat]):
            die(f"{branch} is protected")
    steps = [["checkout", "-B", branch], ["add", "-A"], ["commit", "-m", f"{slug}: {L.parse_contract(L.contract_path(slug).read_text())['Problem'][:60]}\n\nContract: docs/contracts/{slug}.md\nShipped by ./item ship after contract, yes, red and green gates."],
             ["push", "-u", "origin", branch]]
    for s in steps:
        r = L.git(s, repo)
        if r.returncode != 0 and not (s[0] == "commit" and "nothing to commit" in r.stdout):
            die(f"git {' '.join(s[:2])} failed: {(r.stderr or r.stdout).strip()[:300]}")
    f = L.parse_contract(L.contract_path(slug).read_text())
    body = (f"**Problem:** {f['Problem']}\n\n**Owner:** {f['Owner']} · **Stakeholder:** {f['Stakeholder']}\n\n"
            f"**Scenarios:**\n" + "\n".join(f"- {s}" for s in f["Scenario"]) +
            f"\n\n**Not included:**\n" + "\n".join(f"- {s}" for s in f["Not included"]) +
            f"\n\n**Signed:** {f.get('Signed')}\n\n**Red:** `{red['cmd']}` exit {red['exit']} · **Green:** exit 0\n\n"
            f"Opened by `./item ship`. A human merges; then `./item metric {slug} after` and `./item close {slug}`.\n\n"
            "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
    pr = subprocess.run(["gh", "pr", "create", "--head", branch, "--title", f"{slug}", "--body", body], cwd=repo, capture_output=True, text=True)
    if pr.returncode != 0 and "already exists" not in pr.stderr:
        die(f"gh pr create failed: {pr.stderr.strip()[:300]}")
    url = (pr.stdout.strip().splitlines() or [""])[-1] or re.search(r"https://\S+", pr.stderr).group(0)
    L.append(slug, "shipped", branch=branch, pr=url, commit=L.git(["rev-parse", "HEAD"], repo).stdout.strip())
    print(f"PR opened: {url}\nA human merges it. Then: ./item metric {slug} after && ./item close {slug}")


def cmd_close(slug: str) -> None:
    r = subprocess.run([sys.executable, str(Path(__file__).resolve().parent.parent / "checks" / "check_outcome.py"), slug], capture_output=True, text=True)
    print(r.stdout, end="")
    if r.returncode != 0:
        sys.exit(1)
    L.append(slug, "closed")
    if L.active_slug() == slug:
        L.set_active(None)
    print(f"closed '{slug}'")


def cmd_status(slug: str | None) -> None:
    slug = slug or L.active_slug()
    if not slug:
        print("no active item")
        return
    print(f"{slug}  (active: {L.active_slug()})")
    for r in L.ledger(slug):
        extra = {k: v for k, v in r.items() if k not in ("ts", "event", "words")}
        print(f"  {r['ts']}  {r['event']:<8} {extra}")


def main(argv: list[str]) -> None:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    c, rest = argv[0], argv[1:]
    if c == "red":
        if "--" not in rest or len(rest) < 3:
            die("usage: ./item red <slug> -- <test command>")
        i = rest.index("--")
        cmd_red(rest[0], " ".join(rest[i + 1:]))
    elif c == "metric":
        cmd_metric(rest[0], rest[1])
    elif c == "status":
        cmd_status(rest[0] if rest else None)
    elif c in ("start", "check", "propose", "green", "ship", "close"):
        globals()[f"cmd_{c}"](rest[0])
    else:
        die(f"unknown command {c}")


if __name__ == "__main__":
    main(sys.argv[1:])
