---
title: "Branch-built desktop installers all carry the same version, so check the build time before testing one"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-85d6e3eb
scope: repo
status: active
src: agent
touches:
  - desktop/README.md
  - desktop/build/installer.nsh
  - ".github/workflows/ci.yml"
---

## Decided
To know which commit a downloaded installer came from, read releaseDate in the latest.yml that comes with it and match it to the CI run's Windows job time. The file name (Monize-Setup-<version>.exe) does not change between branch builds because the version is not bumped.

## Tried and ruled out
Trusting "latest successful run": downloading while the new run is still going fetches the previous run's installer. Ken tested an old build this way and reported that a change "did not work" when it was not in the build at all.

## Watch out
Download a specific run by id once it has finished (gh run download <id> -n monize-windows-installer), into a folder named after the commit, instead of re-using one folder.

In the code:
- CI job "Desktop Windows Installer" in .github/workflows/ci.yml uploads the monize-windows-installer artifact (kept 7 days)
- check: grep releaseDate <folder>/latest.yml
