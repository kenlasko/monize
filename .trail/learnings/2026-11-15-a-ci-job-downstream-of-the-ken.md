---
title: "A CI job downstream of the Windows installer must check its needs' results explicitly, or a skipped job further up skips it"
author: Ken
date: 2026-11-15
branch: fix/windows-beta-publish
cost: { minutes: 4, tokens: 102232 }
id: l-e08b8006
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
  - frontend/src/i18n/messages/de/help.json
  - frontend/src/i18n/messages/es/help.json
  - frontend/src/i18n/messages/fr/help.json
  - frontend/src/i18n/messages/hi/help.json
  - frontend/src/i18n/messages/id/help.json
  - frontend/src/i18n/messages/it/help.json
  - frontend/src/i18n/messages/ja/help.json
  - frontend/src/i18n/messages/ko/help.json
  - frontend/src/i18n/messages/nl/help.json
---

## Decided
Publish Windows Beta was skipped on every push to main although both of its direct needs (Prepare Preview, Desktop Windows Installer) succeeded, so no beta prerelease was ever created. The cause is GitHub's implicit `success()`: it also looks past the direct needs, and Desktop Windows Installer needs Prepare Release, which is skipped on every push. The beta job now runs under `!cancelled()` and checks each need's `result == 'success'` itself, the pattern the installer job already used.

## Tried and ruled out
Nothing else was tried. A pull request's CI cannot show the fix: the beta job only runs on a push to main, so the first push after merge is the test.

## Watch out
- The release job (Commit Version & Release) needs the installer job too and has no `if:` at all. On a release dispatch Prepare Preview is skipped, so by the same mechanism the release job is likely to be skipped. Unverified as of 2026-11-15: no release has run since the installer job joined its needs.
- Any new job that needs the installer job, or anything below a job that is skipped on some events, needs the same explicit condition.
- Every beta-job skip looked like a healthy run: the overall run was green.

In the code:
- .github/workflows/ci.yml: jobs desktop-windows (needs desktop, prepare-release, prepare-preview), windows-beta, release (needs prepare-release, build-and-push, desktop-windows)
- check: gh run view <id> --json jobs -q '.jobs[]|select(.name=="Publish Windows Beta")|.conclusion'
