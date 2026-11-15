---
title: "A CI job downstream of the Windows installer must check its needs' results explicitly, or a skipped job further up skips it"
author: Ken
date: 2026-11-15
branch: fix/windows-beta-publish
cost: { minutes: 2, tokens: 21972 }
id: l-b3aefcd2
scope: repo
status: active
replaces: l-e08b8006
src: agent
touches:
  - ".github/workflows/ci.yml"
  - desktop/README.md
---

## Decided
Publish Windows Beta was skipped on every push to main although both of its direct needs (Prepare Preview, Desktop Windows Installer) succeeded, so no beta prerelease was ever created. The cause is GitHub's implicit `success()`: it also looks past the direct needs, and Desktop Windows Installer needs both Prepare Release and Prepare Preview, one of which is skipped on every run. Commit Version & Release had the same exposure on a release dispatch (Prepare Preview skipped) and had no `if:` at all. Both jobs now run under `!cancelled()` with each need's `result == 'success'` written out, the pattern the installer job already used; a failed or skipped need still stops them.

## Tried and ruled out
Nothing else was tried. A pull request's CI cannot show either fix: the beta job only runs on a push to main and the release job only on a release dispatch, so the first such run after merge is the test.

## Watch out
- Any new job that needs the installer job, or that sits below any job skipped on some events, needs the same explicit condition.
- Every skip looked like a healthy run: the overall run was green.
- The release path had never run with the installer job in its needs before this fix (added 2026-11-14, after v1.21.0).

In the code:
- .github/workflows/ci.yml: jobs desktop-windows (needs desktop, prepare-release, prepare-preview), windows-beta, release (needs prepare-release, build-and-push, desktop-windows)
- desktop/README.md, CI section: the paragraph after `windows-beta`
- check: gh run view <id> --json jobs -q '.jobs[]|select(.name=="Publish Windows Beta" or .name=="Commit Version & Release")|.name+"="+.conclusion'
