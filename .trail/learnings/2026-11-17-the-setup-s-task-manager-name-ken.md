---
title: "The setup's Task Manager name comes from the package description, and the backend's compiled tests and declarations no longer ship"
author: Ken
date: 2026-11-17
branch: main
cost: { minutes: 9, tokens: 116485 }
id: l-5543b82e
scope: repo
status: active
src: agent
touches:
  - desktop/electron-builder.yml
  - desktop/build/installer.nsh
  - desktop/src/packaging.spec.ts
  - desktop/scripts/installer-harness.nsi
  - desktop/staging-manifest.json
---

## Decided
- Task Manager shows the running installer under its FileDescription, which electron-builder fills from the package description (the long "Monize for Windows: the Electron shell..." text). electron-builder.yml now sets extraMetadata.description to "Monize Setup". Monize.exe is unaffected: its FileDescription is productName. The uninstaller gets the same name, because electron-builder uses one description for both.
- The template also uses that description for the shortcuts' comment and the "Installed apps" comment, so build/installer.nsh undefines APP_DESCRIPTION and redefines it as "Monize" (electron-builder passes it with -D, so the include can override it).
- The desktop's backend/dist copy now also leaves out *.d.ts, *.spec.js and tsconfig.tsbuildinfo. In beta 1.21.1-beta.4780 that was 3,029 declarations and 1,300 compiled unit tests out of 6,248 dist files (35,008 files in the whole payload). The Docker image still ships them; only the desktop excludes them, like the node_modules prune.

## Tried and ruled out
- A second VIAddVersionKey FileDescription in installer.nsh: makensis fails with "already defined!", so the name cannot be overridden from the include.

## Watch out
- What is left: backend/node_modules 18,076 files, frontend/.next 6,513 (4,103 of them server chunks), frontend/node_modules 1,664, postgres/share 1,368. The two big levers not yet tried: packing backend/node_modules into an asar archive (the backend runs as Monize.exe with ELECTRON_RUN_AS_NODE, whose fs reads asar; the one native module, @napi-rs/canvas, would have to stay unpacked), and replacing the NSIS template's extract-to-temp-then-CopyFiles step, which writes every file twice.
- Payload listing: download the beta exe, `7zz x <exe> '$PLUGINSDIR/app-64.7z'`, then `7zz l -slt` it.

In the code:
- desktop/electron-builder.yml (extraMetadata), desktop/build/installer.nsh (APP_DESCRIPTION), desktop/staging-manifest.json (backend/dist exclude)
- app-builder-lib 26.18.0 out/targets/nsis/NsisTarget.js computeVersionKey
