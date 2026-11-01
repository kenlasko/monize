---
title: The issue worker only hands Claude security alerts the issue body names
author: Node
date: 2026-11-01
branch: claude/issue-1982
cost: { minutes: 8, tokens: 19199 }
---

## Decided
- The claude-workers worker (configmap worker-script-*, worker.sh linked_alerts) fetches Dependabot/code scanning alerts with its PAT only when the issue text references them: an alert URL (github.com/<repo>/security/dependabot/N), "Dependabot alert #N" / "code scanning alert N", a GHSA/CVE ID, or a line "Alerts: dependabot, code-scanning" (or "Alerts: all").
- They are injected only into the fresh-start prompt and the review phase, not into a resumed answer.

## Tried and ruled out
- Granting the PAT alert scopes alone: an issue that says "the two recent alerts" with none of those references still yields no alert data.

## Watch out
- If a security issue arrives with no alerts in the prompt, ask for an "Alerts: all" line in the body and a restart, rather than guessing from npm audit.
