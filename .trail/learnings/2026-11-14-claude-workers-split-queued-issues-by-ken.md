---
title: "Claude workers split queued issues by issue number, so an idle worker will not take another worker's issue"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-55173d08
scope: repo
status: active
src: agent
---

## Decided
Each claude-worker pod only polls issues whose number modulo the worker count equals its own ordinal. With 3 workers, issue N goes only to claude-worker-(N % 3). There is no work stealing: if that worker is busy (or sitting on a question/PR it resumes first), the issue waits even while the other workers are idle.

## Tried and ruled out
Restarting the idle worker pods does nothing for a queued issue on another shard; they come back up, log "Idle", and skip it. Labels and assignee were all correct (claude + assigned to kenlasko), so checking those is not the answer when an issue sits unclaimed.

## Watch out
"Why isn't issue X being picked up?" -> compute X % 3 first and check that worker's log. Issue #2186 (Nov 14 2026) waited on claude-worker-2, which was busy with #2141, while workers 0 and 1 sat idle.

In the code:
- Lives outside this repo: configmap worker-script-* in namespace claude-workers, worker.sh main loop: `gh issue list --label "${TRIGGER_LABEL}" --assignee "${ASSIGNEE}" ... select(.number % ${WORKER_COUNT} == ${ORDINAL})`
- Worker logs: `kubectl -n claude-workers logs claude-worker-<n> -c claude-worker | grep '"event":"claim"'`
