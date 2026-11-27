---
title: "Release signing approvals are waited on inline with longer timeouts, not split into separate signing jobs"
author: Ken
date: 2026-11-26
branch: ci/signpath-longer-wait
cost: { minutes: 6, tokens: 67420 }
id: l-23a73b8d
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
  - desktop/README.md
---

## Decided
- SignPath Foundation confirmed (Nov 26) that every request under the production certificate needs a manual approval in the SignPath UI. The Windows job keeps signing inline and waits up to 60 minutes for each of its two requests. Ken watches each release and approves both requests as they arrive.

## Tried and ruled out
- Splitting signing into separate jobs: Windows build, then a Linux job that waits on the exe request, then Windows repackage, then a Linux job that waits on the installer request, then Windows finalize and smoke test. It would allow waits of hours and keep a Windows runner from sitting idle. Ken chose not to: he watches releases anyway, and the split adds five jobs of artifact wiring (the whole win-unpacked folder, a few hundred MB), repeated checkout and npm ci, and an unverified question about whether SignPath's origin check accepts an artifact uploaded by a different job of the same run.

## Watch out
- Two approvals per release are unavoidable either way: the exe must be signed before the installer is built around it (NSIS is not a SignPath container).
- If a release fails on a timed-out approval, the whole desktop-windows job has to run again, rebuild included. Revisit the split if releases start going out unattended, or if betas are moved onto the release certificate.

In the code:
- .github/workflows/ci.yml desktop-windows: wait-for-completion-timeout-in-seconds 3600 on both SignPath steps, timeout-minutes 160
- desktop/README.md "Code signing" switch-over note
