---
title: "The Windows backend's dependencies ship as one archive the backend reads through a resolve preload"
author: Ken
date: 2026-11-17
branch: feat/desktop-installer-size
cost: { minutes: 1, tokens: 4142 }
id: l-112ef376
scope: repo
status: active
src: agent
touches:
  - desktop/scripts/lib/stage.mjs
  - desktop/src/supervisor/boot-contract.guard.spec.ts
  - desktop/src/staging-manifest.spec.ts
---

## Decided
- Staging installs, prunes and checks the backend's production node_modules outside staging/, then packs it with @electron/asar into backend/node_modules.asar, whose root holds a `node_modules` directory. Native addons (*.node, such as @napi-rs/canvas) stay in node_modules.asar.unpacked/, because Windows loads a DLL only from a real file. Why: the installer writes every loose file twice and Defender scans each write; about 18,000 dependency files become one.
- The backend runs on Monize.exe with ELECTRON_RUN_AS_NODE, whose fs reads inside an .asar. A desktop-owned preload, shell/backend-deps.cjs, is loaded with a second --require into db-init, db-migrate and the server only. It retries a bare specifier that failed the ordinary lookup: require() through require.resolve with the archive as search root, import() through the default ESM resolver with a parentURL inside the archive. Ken approved the second preload, the boot-contract guard naming it as BACKEND_ONLY_PREFIX, and @electron/asar as a direct devDependency (2026-11-17).
- Checked on Linux with Electron 44.7.2 (nixpkgs has no 45): db-init, the migrations and the server booted from the archive against PostgreSQL 18 and answered /api/v1/health/ready; web-push (ESM-only), @napi-rs/canvas, import("pdfjs-dist/...") and import("oidc-provider") loaded.

## Tried and ruled out
- NODE_PATH alone: ESM resolution ignores it, and the compiled backend uses dynamic import() of pdfjs-dist and oidc-provider.
- Pushing onto Module.globalPaths: it is a copy; the resolver never reads it.
- A registerHooks resolve hook that only swaps parentURL: the CommonJS default step ignores the changed parent, so require() still fails.
- Packing the whole backend (dist, help, migrations) into the archive: help, release notes and db-migrate look files up relative to process.cwd(), and the spawned commands would no longer match the container's `node dist/main.js`.
- Patching Module._nodeModulePaths to add the archive up front: under 0.1 s off the module load, within noise; not worth a private API.

## Watch out
- Warm-cache module load on Linux was about 0.3-0.4 s slower from the archive (median 3.55 s vs 3.14 s for the backend's app module). The gain is the Windows install and cold first start, where loose files are written and Defender-scanned.
- Likely, not verified: the installer's 7z is non-solid with a blockmap, so with loose files an unchanged dependency is an unchanged block. One archive shifts everything after a changed dependency, so an update that changes backend dependencies probably downloads most of the archive.
- Plain Node cannot read the archive: scripts/dev-boot.mjs re-launches itself on Electron's binary, so it needs the binary `npm ci` downloads.
- Electron 45 on Windows is only exercised by a real build: CI's smoke-install.ps1 boots the installed app.

In the code:
- desktop/scripts/lib/pack-deps.mjs (BACKEND_DEPS_ARCHIVE, packArchive), desktop/scripts/lib/stage.mjs (backend-deps branch, --skip-backend-deps keep)
- desktop/resources/backend-deps.cjs, desktop/src/supervisor/backend-deps.ts, ChildSpec.preloads in child.ts, LayerRuntime.preloads in backend.ts
- desktop/src/supervisor/boot-contract.guard.spec.ts BACKEND_ONLY_PREFIX; desktop/src/staging-manifest.spec.ts accounts() takes `<dest>.asar`
