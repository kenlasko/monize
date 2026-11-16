---
title: "Windows installer signing goes through SignPath in two rounds, because SignPath cannot open an NSIS installer and signing invalidates the updater's checksum"
author: Ken
date: 2026-11-16
branch: feat/desktop-c3-signpath-signing
id: l-04b32889
scope: repo
status: active
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
- Code signing (task C3) uses SignPath with a self-signed test certificate until SignPath Foundation grants the release one. SignPath signs only files it downloads from the run's own GitHub artifacts, so electron-builder signs nothing itself and the job does upload, sign, copy back, twice.
- Round 1 signs Monize.exe from release/win-unpacked; the installer is then rebuilt around it with `electron-builder --prepackaged`. Round 2 signs the installer. Two artifact configurations (monize-exe, monize-installer), each a zip root holding one exe with a product-name="Monize" restriction.
- The first pass is a full `npm run dist`, not `--dir`, even though its installer is thrown away.
- After signing, the blockmap and latest.yml/beta.yml are regenerated: signing appends to the .exe, so the sha512 and size electron-builder recorded no longer match, and electron-updater would refuse the download.
- No publisherName in app-update.yml while the test certificate is in use: Windows does not trust it, so the updater's Authenticode check would fail every update.

## Tried and ruled out
- `electron-builder --dir` for the first pass: it does not write resources/app-update.yml (PublishManager writes it in afterPack only for nsis targets), and `--prepackaged` skips packing, so the installed app would never look for updates.
- Deep-signing the NSIS installer in one request: NSIS is not a SignPath container format, so the Monize.exe inside it can't be reached.
- An electron-builder custom sign hook calling SignPath: origin verification needs a GitHub artifact id, and `run:` steps can't upload artifacts.

## Watch out
- The uninstaller stays unsigned: electron-builder builds and signs it inside the NSIS step, and only through a signer it runs itself.
- Moving to release-signing: Foundation release policies may need a manual approval for each request (each wait is capped at 20 min), and betas would then need one on every push to main.
- No signed CI run has happened yet. The first one proves the SignPath slugs, the product-name restriction and the prepackaged rebuild.

In the code:
- .github/workflows/ci.yml desktop-windows: "Check the SignPath settings", "Sign Monize.exe", "Rebuild the installer around the signed Monize.exe", "Sign the installer", "Put the signed installer in place"
- desktop/signpath/*.xml, desktop/scripts/signed-update-info.mjs, desktop/scripts/lib/update-info.mjs, peHasSignature in desktop/scripts/lib/pe.mjs
- settings: secret SIGNPATH_API_TOKEN; variables SIGNPATH_ORGANIZATION_ID, SIGNPATH_PROJECT_SLUG, SIGNPATH_SIGNING_POLICY_SLUG
