---
title: "Windows installer signing goes through SignPath in two rounds, because SignPath cannot open an NSIS installer and signing invalidates the updater's checksum"
author: Ken
date: 2026-11-16
branch: feat/desktop-c3-signpath-signing
cost: { minutes: 21, tokens: 21583 }
id: l-feeb156e
scope: repo
status: active
replaces: l-04b32889
src: agent
touches:
  - ".github/workflows/ci.yml"
  - desktop/README.md
  - desktop/electron-builder.yml
  - desktop/package.json
  - desktop/scripts/lib/pe.mjs
  - desktop/scripts/lib/update-info.mjs
  - desktop/scripts/signed-update-info.mjs
  - desktop/scripts/update-info.test.mjs
  - desktop/signpath/monize-exe.xml
  - desktop/signpath/monize-installer.xml
---

## Decided
- SignPath, with the Foundation's test certificate until the release one is granted. SignPath signs only files it fetches from the run's own GitHub artifacts, so electron-builder signs nothing itself. The job signs Monize.exe from release/win-unpacked, rebuilds the installer around it with `electron-builder --prepackaged`, then signs the installer.
- After signing, the blockmap and latest.yml/beta.yml are regenerated. Signing appends to the .exe, so electron-updater would refuse the sha512 electron-builder recorded.
- Submissions come from a SignPath CI user's API token. With trusted build system verification on (required for OSS), interactive users cannot be Submitters, so a personal token is refused.
- No publisherName in app-update.yml while the test certificate is in use: Windows does not trust it, so the updater's Authenticode check would fail every update.

## Tried and ruled out
- `electron-builder --dir` for the first pass: it does not write resources/app-update.yml, and `--prepackaged` never writes it either, so the app would never update.
- Deep-signing the installer in one request: NSIS is not a SignPath container format.
- An electron-builder sign hook calling SignPath: origin verification needs a GitHub artifact id, and `run:` steps can't upload artifacts.

## Watch out
- Get-AuthenticodeSignature reports `UnknownError` for both files under the test certificate. That is the untrusted root, not a bad signature; it should read Valid on the release certificate.
- The first signed run (2026-11-16, run 43911191183) passed end to end. The job took 31 min against about 22 unsigned; each SignPath request finished in seconds.
- The uninstaller stays unsigned. Release-signing policies may need a manual approval for each request (each wait is capped at 20 min), which betas would hit on every push to main.

In the code:
- .github/workflows/ci.yml desktop-windows signing steps; desktop/signpath/*.xml; desktop/scripts/signed-update-info.mjs
- secret SIGNPATH_API_TOKEN; variables SIGNPATH_ORGANIZATION_ID, SIGNPATH_PROJECT_SLUG (monize), SIGNPATH_SIGNING_POLICY_SLUG (test-signing)
