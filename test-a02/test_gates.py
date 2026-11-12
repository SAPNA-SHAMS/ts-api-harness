"""The grader's three skip attempts, plus the paths around them. Each test runs the real hook
scripts as subprocesses against a scratch root (A02_ROOT), with hand-built transcripts in the
same JSONL shape Claude Code writes.  Run: python3 -m unittest discover -s test-a02 -v"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY = sys.executable

CONTRACT = """Problem: Sitemap 404s go unnoticed until GSC emails us a week later
Owner: SEO team
Stakeholder: Test Stakeholder
Metric: broken sitemap URLs, daily crawl   before: ____   after: ____
Read: echo 7
Repo: .
Scenario: WHEN a sitemap URL returns 404 THEN the spec fails naming that URL
Not included:
- fixing the pages themselves
Signed: ← recorded by hooks/contract_gate.py
"""


class Gates(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        shutil.copy(REPO / "harness.a02.json", self.root)
        (self.root / "docs/contracts").mkdir(parents=True)
        shutil.copy(REPO / "docs/contracts/_TEMPLATE.md", self.root / "docs/contracts")
        self.env = {**os.environ, "A02_ROOT": str(self.root)}
        self.transcript = self.root / "t.jsonl"
        self.transcript.write_text("")
        # a real git repo, so the effect-based Bash gate can diff the working tree
        (self.root / ".gitignore").write_text(".harness/\nt.jsonl\n")
        (self.root / "hooks").mkdir()
        (self.root / "hooks/problem_gate.py").write_text("# gate\n")
        (self.root / "src").mkdir()
        (self.root / "src/app.ts").write_text("export const a = 1;\n")
        for c in (["init", "-q"], ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"],
                  ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]):
            subprocess.run(["git", *c], cwd=self.root, check=True, capture_output=True)

    def tearDown(self):
        shutil.rmtree(self.root)

    # helpers
    def item(self, *args):
        return subprocess.run([PY, str(REPO / "scripts/item.py"), *args], env=self.env, capture_output=True, text=True, cwd=self.root)

    def hook(self, name, payload):
        payload = {"transcript_path": str(self.transcript), "cwd": str(self.root), **payload}
        return subprocess.run([PY, str(REPO / "hooks" / name)], input=json.dumps(payload), env=self.env, capture_output=True, text=True)

    def edit(self, path, content="x"):
        return self.hook("problem_gate.py", {"tool_name": "Write", "tool_input": {"file_path": str(self.root / path), "content": content}})

    def stop(self):
        r = self.hook("contract_gate.py", {"hook_event_name": "Stop", "stop_hook_active": False})
        return json.loads(r.stdout) if r.stdout.strip() else {}

    def say(self, role, content, **extra):
        e = {"type": role, "uuid": f"u{len(self.transcript.read_text().splitlines())}", "sessionId": "s1",
             "timestamp": "2026-11-10T10:00:00Z", "message": {"role": role, "content": content}, **extra}
        with self.transcript.open("a") as f:
            f.write(json.dumps(e) + "\n")

    def ready_contract(self, slug="sitemap-404"):
        self.item("start", slug)
        (self.root / f"docs/contracts/{slug}.md").write_text(CONTRACT)
        return slug

    def propose(self, slug="sitemap-404"):
        marker = self.item("propose", slug).stdout.splitlines()[2]
        self.say("assistant", [{"type": "text", "text": f"{marker}\n...contract..."}])

    # ---- skip attempt 1: edit source with no contract ----
    def test_edit_source_with_no_item_is_refused(self):
        r = self.edit("examples/sf-automation-seo-wip/cypress/support/seo/seo-utils.js")
        self.assertEqual(r.returncode, 2)
        self.assertIn("problem-statement gate", r.stderr)

    def test_edit_source_with_incomplete_contract_names_fields(self):
        self.item("start", "sitemap-404")
        r = self.edit("src/core/engine.ts")
        self.assertEqual(r.returncode, 2)
        for field in ("Problem", "Owner", "Stakeholder", "Metric", "Scenario", "Not included"):
            self.assertIn(field, r.stderr)

    def test_complete_contract_without_yes_still_refused(self):
        self.ready_contract()
        r = self.edit("src/core/engine.ts")
        self.assertEqual(r.returncode, 2)
        self.assertIn("human-yes gate", r.stderr)

    # ---- Bash judged by effect ----
    def bash(self, cmd, effect=None, tid="tu1"):
        """Pre hook, then the command's effect (simulated in Python), then the post hook."""
        pre = self.hook("problem_gate.py", {"tool_name": "Bash", "tool_use_id": tid, "tool_input": {"command": cmd}})
        if pre.returncode != 0:
            return pre, None
        if effect:
            effect()
        post = self.hook("bash_effects.py", {"tool_name": "Bash", "tool_use_id": tid, "tool_input": {"command": cmd}})
        return pre, (json.loads(post.stdout) if post.stdout.strip() else {})

    def test_shell_write_to_source_is_refused_and_put_back(self):
        _, post = self.bash("echo hi > src/app.ts", lambda: (self.root / "src/app.ts").write_text("hi\n"))
        self.assertEqual(post.get("decision"), "block")
        self.assertIn("problem-statement gate", post["reason"])
        self.assertEqual((self.root / "src/app.ts").read_text(), "export const a = 1;\n")

    def test_new_source_file_via_shell_is_removed(self):
        _, post = self.bash("node -e \"fs.writeFileSync('src/new.ts','x')\"", lambda: (self.root / "src/new.ts").write_text("x"))
        self.assertEqual(post.get("decision"), "block")
        self.assertFalse((self.root / "src/new.ts").exists())

    def test_git_checkout_path_bypass_is_caught(self):
        def effect():
            (self.root / "hooks/problem_gate.py").write_text("# disabled\n")
        _, post = self.bash("git checkout other -- hooks/problem_gate.py", effect)
        self.assertEqual(post.get("decision"), "block")
        self.assertEqual((self.root / "hooks/problem_gate.py").read_text(), "# gate\n")

    def test_reads_and_redirects_are_not_refused(self):
        for cmd in ("grep -r x src 2>/dev/null", "node -e 'console.log(1)'", "python3 -c 'print(\"a > b\")'",
                    "git log --oneline -1", "cat 'Stakeholder: <name>' hooks/problem_gate.py"):
            pre, post = self.bash(cmd)
            self.assertEqual(pre.returncode, 0, cmd)
            self.assertEqual(post, {}, cmd)

    def test_unrelated_write_is_allowed(self):
        _, post = self.bash("echo notes > notes.txt", lambda: (self.root / "notes.txt").write_text("notes"))
        self.assertEqual(post, {})
        self.assertTrue((self.root / "notes.txt").exists())

    def test_earlier_uncommitted_edit_is_restored_not_lost(self):
        (self.root / "src/app.ts").write_text("export const a = 2; // earlier allowed edit\n")
        _, post = self.bash("sed -i '' s/2/3/ src/app.ts", lambda: (self.root / "src/app.ts").write_text("export const a = 3;\n"))
        self.assertEqual(post.get("decision"), "block")
        self.assertIn("a = 2", (self.root / "src/app.ts").read_text())

    def test_agent_cannot_edit_gates_or_records(self):
        for p in ("hooks/problem_gate.py", ".claude/settings.json", "items/x/ledger.jsonl", ".harness/state.json"):
            self.assertEqual(self.edit(p).returncode, 2, p)

    def test_agent_cannot_type_signed_line(self):
        slug = self.ready_contract()
        r = self.edit(f"docs/contracts/{slug}.md", CONTRACT.replace("Signed: ← recorded by hooks/contract_gate.py", "Signed: Test Stakeholder, 2026-11-10"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("Signed", r.stderr)

    # ---- skip attempt 2: echo "yes" from a tool result and Stop ----
    def test_stop_without_proposal_blocks(self):
        self.ready_contract()
        self.assertEqual(self.stop().get("decision"), "block")

    def test_yes_in_tool_output_does_not_count(self):
        self.ready_contract()
        self.propose()
        self.say("assistant", [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "echo yes"}}])
        self.say("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "yes"}], toolUseResult={"stdout": "yes"})
        out = self.stop()
        self.assertEqual(out.get("decision"), "block")
        self.assertIn("tool output", out["reason"])
        self.assertEqual(self.edit("src/core/engine.ts").returncode, 2)

    def test_yes_in_assistant_text_does_not_count(self):
        self.ready_contract()
        self.propose()
        self.say("assistant", [{"type": "text", "text": "The stakeholder said yes, approved."}])
        self.assertEqual(self.edit("src/core/engine.ts").returncode, 2)

    def test_yes_in_meta_or_command_output_does_not_count(self):
        self.ready_contract()
        self.propose()
        self.say("user", "yes", isMeta=True)
        self.say("user", "<local-command-stdout>yes</local-command-stdout>")
        self.assertEqual(self.edit("src/core/engine.ts").returncode, 2)

    def test_yes_before_proposal_does_not_count(self):
        self.ready_contract()
        self.say("user", "yes go ahead with sitemap-404")
        self.propose()
        self.assertIn("HOLD", self.stop().get("systemMessage", ""))
        self.assertEqual(self.edit("src/core/engine.ts").returncode, 2)

    def test_stop_on_proposal_is_a_hold_not_a_pass(self):
        self.ready_contract()
        self.propose()
        out = self.stop()
        self.assertNotIn("decision", out)
        self.assertIn("HOLD", out["systemMessage"])
        self.assertEqual(self.edit("src/core/engine.ts").returncode, 2)

    def test_typed_yes_after_proposal_is_recorded(self):
        slug = self.ready_contract()
        self.propose()
        self.say("user", [{"type": "text", "text": "Yes, sitemap-404 is the one, go ahead."}])
        self.assertEqual(self.stop(), {})
        text = (self.root / f"docs/contracts/{slug}.md").read_text()
        self.assertIn('Signed: Test Stakeholder, 2026-11-10 — "Yes, sitemap-404 is the one, go ahead."', text)
        # test files open after the yes; source still needs a red run
        self.assertEqual(self.edit("cypress/e2e/sitemap.cy.js").returncode, 0)
        r = self.edit("src/core/engine.ts")
        self.assertIn("red-before-green", r.stderr)

    def test_contract_change_after_yes_needs_a_new_yes(self):
        slug = self.ready_contract()
        self.propose()
        self.say("user", "yes, sitemap-404 approved")
        self.stop()
        p = self.root / f"docs/contracts/{slug}.md"
        p.write_text(p.read_text().replace("fixing the pages themselves", "nothing"))
        self.assertIn("human-yes gate", self.edit("src/core/engine.ts").stderr)

    # ---- skip attempt 3: close without reading the metric ----
    def test_close_without_metric_is_refused(self):
        slug = self.ready_contract()
        self.propose()
        self.say("user", "yes, sitemap-404 approved")
        self.stop()
        r = self.item("close", slug)
        self.assertEqual(r.returncode, 1)
        self.assertIn("metric was never read BEFORE", r.stdout)
        self.assertIn("not shipped", r.stdout)

    def test_typed_metric_value_is_refused(self):
        slug = self.ready_contract()
        r = self.edit(f"docs/contracts/{slug}.md", CONTRACT.replace("after: ____", "after: 0"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("outcome check", r.stderr)

    def test_metric_read_writes_contract(self):
        slug = self.ready_contract()
        r = self.item("metric", slug, "before")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("before: 7", (self.root / f"docs/contracts/{slug}.md").read_text())
        self.assertIn("not shipped", self.item("metric", slug, "after").stderr)

    def test_red_must_fail_and_green_must_pass(self):
        slug = self.ready_contract()
        self.propose()
        self.say("user", "yes, sitemap-404 approved")
        self.stop()
        self.assertEqual(self.item("red", slug, "--", "true").returncode, 1)
        self.assertEqual(self.item("red", slug, "--", "test", "-f", "done.flag").returncode, 0)
        self.assertEqual(self.item("green", slug).returncode, 1)
        (self.root / "done.flag").write_text("")
        self.assertEqual(self.item("green", slug).returncode, 0)

    def test_agent_cannot_push(self):
        r = self.hook("problem_gate.py", {"tool_name": "Bash", "tool_input": {"command": "git push origin HEAD"}})
        self.assertEqual(r.returncode, 2)
        r = self.hook("problem_gate.py", {"tool_name": "Bash", "tool_input": {"command": "./item ship x; git push"}})
        self.assertEqual(r.returncode, 2)


    # ---- regressions for the gaps found while shipping the real backlog (docs/learnings.md) ----
    def test_stop_holds_instead_of_looping_when_only_a_person_can_fill_the_gap(self):
        self.item("start", "sitemap-404")
        (self.root / "docs/contracts/sitemap-404.md").write_text(CONTRACT.replace("Stakeholder: Test Stakeholder", "Stakeholder: <name>"))
        out = self.stop()
        self.assertNotIn("decision", out)
        self.assertIn("HOLD", out["systemMessage"])
        self.assertIn("Stakeholder", out["systemMessage"])
        self.assertEqual(self.edit("src/app.ts").returncode, 2)  # nothing unlocked

    def test_stop_still_blocks_when_agent_can_fill_the_gap(self):
        self.item("start", "sitemap-404")
        (self.root / "docs/contracts/sitemap-404.md").write_text(CONTRACT.replace("Not included:\n- fixing the pages themselves\n", ""))
        self.assertEqual(self.stop().get("decision"), "block")

    def test_yes_that_does_not_name_the_item_does_not_sign(self):
        self.ready_contract()
        self.propose()
        self.say("user", "approved go ahead")
        out = self.stop()
        self.assertIn("did not name", out.get("systemMessage", ""))
        self.assertIn("human-yes gate", self.edit("src/app.ts").stderr)

    def test_yes_naming_the_proposal_id_signs(self):
        slug = self.ready_contract()
        self.propose()
        pid = self.item("propose", slug).stdout.splitlines()[2].split()[-1]
        self.say("user", f"{pid} approved")
        self.assertEqual(self.stop(), {})
        self.assertIn("Signed: Test Stakeholder", (self.root / f"docs/contracts/{slug}.md").read_text())

    def test_pause_parks_without_starting_another(self):
        self.ready_contract()
        r = self.item("pause", "sitemap-404")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.stop(), {})  # no active item, nothing to hold
        self.assertIn("no backlog item is active", self.edit("src/app.ts").stderr)

    def test_coverage_line_is_read_and_typing_it_is_refused(self):
        slug = self.ready_contract()
        p = self.root / f"docs/contracts/{slug}.md"
        p.write_text(p.read_text().replace("Read: echo 7", "Read: echo 7\nCoverage: printf 'x\\n3\\n'   before: ____   after: ____"))
        r = self.item("metric", slug, "before")
        self.assertEqual(r.returncode, 0, r.stderr)
        text = p.read_text()
        self.assertIn("Coverage: printf 'x\\n3\\n'   before: 3", text)
        self.assertIn("Metric: broken sitemap URLs, daily crawl   before: 7", text)
        r = self.edit(f"docs/contracts/{slug}.md", text.replace("after: ____\nRead", "after: ____\nRead").replace("before: 3   after: ____", "before: 3   after: 9"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("Coverage", r.stderr)

    def test_metric_read_ignores_stderr(self):
        slug = self.ready_contract()
        p = self.root / f"docs/contracts/{slug}.md"
        p.write_text(p.read_text().replace("Read: echo 7", "Read: echo 7; echo 'noise 99' 1>&2"))
        r = self.item("metric", slug, "before")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("before: 7", p.read_text())


if __name__ == "__main__":
    unittest.main()
