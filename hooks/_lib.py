"""Shared helpers for the Assignment 02 gates.

Records live in two places, both written only by harness code (hooks/, checks/, scripts/item.py):
  .harness/state.json          which backlog item is active
  items/<slug>/ledger.jsonl    append-only events: start, signed, red, green, shipped, metric, closed
The agent may write a contract (docs/contracts/<slug>.md) but never its Signed line or metric values.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(os.environ.get("A02_ROOT") or Path(__file__).resolve().parent.parent).resolve()
CONFIG = json.loads((ROOT / "harness.a02.json").read_text())
STATE = ROOT / ".harness" / "state.json"
CONTRACTS = ROOT / "docs" / "contracts"
ITEMS = ROOT / "items"

PLACEHOLDER = re.compile(r"<[^>]*>|____")
AFFIRM = re.compile(r"\b(yes|yep|yeah|approved?|go ahead|ship it|lgtm|agreed?|sounds good|confirmed?|ok(ay)?)\b", re.I)
NEGATE = re.compile(r"\b(no|not|don'?t|wait|hold|change|but|instead|reject)\b", re.I)


# ---------- state and ledger ----------
def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def active_slug() -> str | None:
    try:
        return json.loads(STATE.read_text()).get("active")
    except (OSError, ValueError):
        return None


def set_active(slug: str | None) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({"active": slug}) + "\n")


def ledger(slug: str) -> list[dict]:
    p = ITEMS / slug / "ledger.jsonl"
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


def append(slug: str, event: str, **data) -> dict:
    p = ITEMS / slug / "ledger.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    rec = {"ts": now(), "event": event, **data}
    with p.open("a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def last(slug: str, event: str, **match) -> dict | None:
    for rec in reversed(ledger(slug)):
        if rec["event"] == event and all(rec.get(k) == v for k, v in match.items()):
            return rec
    return None


# ---------- contracts ----------
def contract_path(slug: str) -> Path:
    return CONTRACTS / f"{slug}.md"


def parse_contract(text: str) -> dict:
    """Field -> value. Scenario collects every WHEN/THEN line; Not included collects bullets under it."""
    out: dict = {"Scenario": [], "Not included": []}
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        m = re.match(r"^(Problem|Owner|Stakeholder|Metric|Read|Repo|Test|Scenario|Not included|Signed)\s*:\s*(.*)$", line, re.I)
        if m:
            key = next(k for k in ("Problem", "Owner", "Stakeholder", "Metric", "Read", "Repo", "Test", "Scenario", "Not included", "Signed") if k.lower() == m.group(1).lower())
            current, val = key, m.group(2).strip()
            if key in ("Scenario", "Not included"):
                if val:
                    out[key].append(val)
            else:
                out[key] = val
        elif current in ("Scenario", "Not included") and line.startswith(("-", "*")):
            out[current].append(line.lstrip("-* ").strip())
        elif not line:
            current = None
    return out


def metric_values(fields: dict) -> tuple[str, str]:
    m = fields.get("Metric", "")
    b = re.search(r"before:\s*([^\s]*)", m)
    a = re.search(r"after:\s*([^\s]*)", m)
    return (b.group(1) if b else "", a.group(1) if a else "")


def missing_fields(slug: str) -> list[str]:
    p = contract_path(slug)
    if not p.exists():
        return [f"docs/contracts/{slug}.md (file does not exist)"]
    f = parse_contract(p.read_text())
    bad = []
    for key in ("Problem", "Owner", "Stakeholder", "Read"):
        v = f.get(key, "")
        if not v or PLACEHOLDER.search(v):
            bad.append(key)
    m = f.get("Metric", "")
    name = re.split(r"before:", m)[0].strip(" ,")
    if not name or PLACEHOLDER.search(name) or "," not in name or "before:" not in m or "after:" not in m:
        bad.append("Metric (needs '<name>, <window>  before: ____  after: ____')")
    if not any(re.search(r"\bWHEN\b.+\bTHEN\b", s) and not PLACEHOLDER.search(s) for s in f["Scenario"]):
        bad.append("Scenario (at least one 'WHEN <condition> THEN <observable result>')")
    if not [x for x in f["Not included"] if x and not PLACEHOLDER.search(x)]:
        bad.append("Not included")
    return bad


def proposal_hash(slug: str) -> str:
    """Hash of the contract minus the parts the harness fills in later (Signed, metric values)."""
    text = contract_path(slug).read_text()
    text = "\n".join(l for l in text.splitlines() if not re.match(r"^\s*Signed\s*:", l, re.I))
    text = re.sub(r"(before|after):\s*[^\s]*", r"\1:", text)
    return hashlib.sha256(text.strip().encode()).hexdigest()[:12]


def proposal_marker(slug: str) -> str:
    return f"CONTRACT PROPOSAL {slug} {proposal_hash(slug)}"


def set_field(slug: str, key: str, value: str) -> None:
    p = contract_path(slug)
    lines = p.read_text().splitlines()
    for i, l in enumerate(lines):
        if re.match(rf"^\s*{key}\s*:", l, re.I):
            lines[i] = f"{key}: {value}"
            break
    else:
        lines.append(f"{key}: {value}")
    p.write_text("\n".join(lines) + "\n")


def set_metric_value(slug: str, phase: str, value: str) -> None:
    p = contract_path(slug)
    text = p.read_text()
    text = re.sub(rf"({phase}:\s*)([^\s]*)", lambda m: m.group(1) + value, text, count=1)
    p.write_text(text)


def signed(slug: str) -> dict | None:
    rec = last(slug, "signed")
    if rec and contract_path(slug).exists() and rec.get("hash") == proposal_hash(slug):
        return rec
    return None


# ---------- transcript ----------
def _entries(transcript_path: str | None) -> list[dict]:
    if not transcript_path or not os.path.exists(transcript_path):
        return []
    out = []
    for l in open(transcript_path, encoding="utf-8"):
        try:
            e = json.loads(l)
        except ValueError:
            continue
        if e.get("type") in ("user", "assistant"):
            out.append(e)
    return out


def _blocks(e: dict) -> list[dict]:
    c = (e.get("message") or {}).get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return c if isinstance(c, list) else []


def _text(e: dict) -> str:
    return "\n".join(b.get("text", "") for b in _blocks(e) if b.get("type") == "text")


SYSTEMISH = ("<command-", "<local-command", "<bash-", "<system-reminder>", "Caveat:", "[Request interrupted")


def typed_human_text(e: dict) -> str | None:
    """Text a person typed, or None. Tool results, hook output, slash-command echoes and meta never count."""
    if e.get("type") != "user" or e.get("isMeta") or e.get("isCompactSummary") or "toolUseResult" in e:
        return None
    blocks = _blocks(e)
    if any(b.get("type") == "tool_result" for b in blocks):
        return None
    parts = []
    for b in blocks:
        if b.get("type") != "text":
            continue
        t = re.sub(r"<system-reminder>.*?</system-reminder>", "", b.get("text", ""), flags=re.S)
        t = re.sub(r"<ide_\w+>.*?</ide_\w+>", "", t, flags=re.S).strip()
        if t and not t.startswith(SYSTEMISH):
            parts.append(t)
    return "\n".join(parts) or None


def is_yes(text: str) -> bool:
    return bool(AFFIRM.search(text)) and not NEGATE.search(text)


def scan(slug: str, transcript_path: str | None) -> dict:
    """Where the latest proposal of the *current* contract is, and what came after it."""
    marker = proposal_marker(slug)
    es = _entries(transcript_path)
    p_idx = max((i for i, e in enumerate(es) if e["type"] == "assistant" and marker in _text(e)), default=-1)
    res = {"marker": marker, "proposed": p_idx >= 0, "yes": None, "tool_yes": None, "tool_after": False}
    if p_idx < 0:
        return res
    for e in es[p_idx + 1:]:
        if any(b.get("type") in ("tool_use", "tool_result") for b in _blocks(e)):
            res["tool_after"] = True
            if e["type"] == "user":
                for b in _blocks(e):
                    c = b.get("content")
                    s = c if isinstance(c, str) else json.dumps(c)
                    if b.get("type") == "tool_result" and AFFIRM.search(s or ""):
                        res["tool_yes"] = (s or "")[:80]
        t = typed_human_text(e)
        if t is not None and res["yes"] is None and is_yes(t):
            res["yes"] = {"uuid": e.get("uuid"), "session": e.get("sessionId"), "at": e.get("timestamp"), "words": t[:300]}
    return res


def try_record_yes(slug: str, transcript_path: str | None) -> dict | None:
    """If the transcript holds a typed yes after the current proposal, write it to ledger + Signed line."""
    if signed(slug):
        return signed(slug)
    if missing_fields(slug):
        return None
    s = scan(slug, transcript_path)
    if not s["yes"]:
        return None
    stakeholder = parse_contract(contract_path(slug).read_text()).get("Stakeholder", "?")
    y = s["yes"]
    rec = append(slug, "signed", hash=proposal_hash(slug), stakeholder=stakeholder, **y)
    quote = y["words"].replace("\n", " ")[:120]
    set_field(slug, "Signed", f'{stakeholder}, {(y["at"] or now())[:10]} — "{quote}" (transcript {y["session"]}/{y["uuid"]}; recorded by hooks/contract_gate.py)')
    return rec


# ---------- paths ----------
def rel(path: str, cwd: str | None = None) -> str:
    p = Path(path)
    if not p.is_absolute():
        p = Path(cwd or os.getcwd()) / p
    try:
        return str(p.resolve().relative_to(ROOT))
    except ValueError:
        return str(p.resolve())


def matches(path: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, g) for g in globs)


def git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
