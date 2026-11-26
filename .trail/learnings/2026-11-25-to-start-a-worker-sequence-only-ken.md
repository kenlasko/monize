---
title: "To start a worker sequence only after an open PR merges, make that PR's issue sub-issue 1 of the tracker"
author: Ken
date: 2026-11-25
branch: main
cost: { minutes: 1, tokens: 1811 }
id: l-c813ece4
scope: repo
status: active
src: agent
---

## Decided
The claude-worker runs a tracker's sub-issues one at a time, and each one branches from `main`. When follow-up work depends on a PR that has not merged, add the PR's own issue as the tracker's first sub-issue. That issue carries `claude-pr`, so `queue_sub` treats it as already in progress and the sequence waits. The PR watcher relabels it `claude-done` on merge, and `check_parent` then queues the next sub-issue, which starts from the merged work. First used for the report-rounding follow-ups (tracker #2406, gated on #2384 and its PR #2405).

## Tried and ruled out
- Re-labelling the in-PR issue `claude` so it becomes the parent itself: `start_task` calls `cleanup` first, which drops that issue's PR watch.
- Labelling the tracker before its sub-issues are linked: with no sub-issues, `start_task` runs Claude on the tracker as an ordinary issue. Link every sub-issue (GraphQL `addSubIssue`) first, then add `claude` and the assignee last.

## Watch out
- A PR that says "Part of #N" never closes #N, so the gate is the `claude-done` label, not the issue state. If that PR is closed without merging, the sequence posts "needs attention" and waits.
- The gating issue stays open after the sequence finishes, so the last sub-issue's PR should say `Closes #N`.
- The tracker is claimed by the worker whose ordinal is its number modulo WORKER_COUNT (configmap env-vars); read the current count rather than assuming one.

In the code:
- Lives outside this repo: configmap worker-script-* in namespace claude-workers, worker.sh `start_task`, `queue_sub` (SUB_ACTIVE labels), `check_parent` (done = CLOSED or `claude-done`).
