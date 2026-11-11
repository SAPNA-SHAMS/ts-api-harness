# docs/contracts/<slug>.md

Problem: <what breaks, in the stakeholder's words, with evidence>
Owner: <team or person who pays for this>
Stakeholder: <the person whose typed yes is required>
Metric: <name>, <window>   before: ____   after: ____
Read: <shell command that prints the metric as the last number on its last line>
Repo: <path to the repo the change lives in; . for this one>
Scenario: WHEN <condition> THEN <observable result>
Not included:
- <what you are deliberately not building>
Signed: ← recorded by hooks/contract_gate.py from the stakeholder's typed yes, never typed by hand
