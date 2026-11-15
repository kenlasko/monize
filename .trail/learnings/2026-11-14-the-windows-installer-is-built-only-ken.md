---
title: "The Windows installer is built only for betas, releases and manual runs, and a beta is one rolling GitHub prerelease"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-b9108029
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/ci.yml"
  - README.md
  - desktop/README.md
  - desktop/scripts/Backup-Monize.ps1
  - docs/backup-restore-contract.md
  - docs/future-plans/windows-installer-tasks.md
  - website/assets/js/app.js
  - website/docs/accounts.html
  - website/docs/ai.html
  - website/docs/ai.md
---

## Decided
Ken chose (2026-11-14) not to build the Windows installer on PRs or branch pushes: it takes about 40 minutes. It is built for a push to main (a beta), a release dispatch, and a manual dispatch of any other branch (artifact only, kept 7 days). A beta is published as a GitHub prerelease tagged v<next patch>-beta.<run number>, and every older Windows beta prerelease is deleted after the new one is up, so there is only ever one. The run number is there so each beta sorts after the last, which is what lets an installed beta update to the next one.

For backups, Ken chose a full-folder copy script over anything pg_dump-based. A full copy restores only under the same Windows account, because config.json's database passwords are DPAPI-encrypted for that account. A new PC recovers from per-user in-app backups, which are portable.

## Tried and ruled out
- pg_dump for full backups: the bundled @embedded-postgres/windows-x64 package ships only initdb, pg_ctl and postgres. The database password is also only unlockable by the app.
- Keeping desktop-windows as a prepare-release need: the installer must carry the release version, which prepare-release resolves, so the Windows job runs after it and the release job needs it instead.
- Linking the docs to workflow artifacts: they need a GitHub login and expire in 7 days.

## Watch out
- electron-updater on a beta reads beta.yml from the newest feed entry and falls back to latest.yml. A stable install uses /releases/latest, which never returns a prerelease.
- The recovery key alone does not reopen a full copy elsewhere: config.json also holds the two database passwords and the JWT secret, all DPAPI-bound.

In the code:
- .github/workflows/ci.yml: desktop-windows (needs desktop, prepare-release, prepare-preview; if !cancelled()), release (needs desktop-windows, attaches the three files), windows-beta
- desktop/scripts/Backup-Monize.ps1; website/docs/windows.md "Backups and Disaster Recovery"
