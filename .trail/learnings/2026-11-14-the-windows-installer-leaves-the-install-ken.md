---
title: "The Windows installer leaves the install folder empty for most of its run, because it unpacks to a temp folder first"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-3955e2dd
scope: repo
status: active
src: agent
touches:
  - desktop/electron-builder.yml
  - desktop/scripts/stage.mjs
---

## Decided
- Nothing changed yet. When someone reports the installer "stalled" with an empty install folder, it is usually still working: electron-builder's NSIS template extracts the whole app archive into the installer's temp folder and copies it into the install folder only at the end.

## Watch out
- The payload is about 56,800 files (about 47,000 in the backend's production node_modules). The silent install took 5 min 15 s on the GitHub Windows runner; a home PC with Defender scanning each file is slower. Every file is written twice (temp, then install folder), so Defender scans it twice.
- To check progress: the newest `%LOCALAPPDATA%\Temp\ns*.tmp\7z-out` folder grows, and the installer and "Antimalware Service Executable" both use CPU.
- Levers, not yet tried: prune tests, docs, type declarations and maps from the staged backend node_modules; extract straight into the install folder by overriding the template's extract macro. Packing node_modules into an archive or bundling the backend would make the desktop build differ from the containers.

In the code:
- desktop/node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh (`extractUsing7za`: `Nsis7z::Extract` into `$PLUGINSDIR\7z-out`, then `CopyFiles` to `$OUTDIR`)
- desktop/electron-builder.yml, desktop/scripts/stage.mjs
