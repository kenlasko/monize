---
title: "The first desktop start after installing can take the backend over two minutes to begin, so the 120 s ready deadline fails a fresh install that a retry then pa…"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-e6366d80
scope: repo
status: active
src: agent
touches:
  - desktop/build/installer.nsh
  - desktop/scripts/installer-harness.nsi
  - desktop/src/packaging.spec.ts
  - desktop/src/supervisor/types.ts
  - desktop/src/supervisor/boot.ts
  - desktop/src/health.ts
---

## Decided
- Nothing changed yet. Diagnosis from Ken's first launch of the Nov 14 installer on his own PC: "Starting the server... (not done within 120000 ms; last attempt: ECONNREFUSED)", and Retry worked straight away.
- The error view's 50-line log tail held only db-migrate output (ending "Applied 271 migration(s)"). So `dist/main.js` printed nothing in 120 s, not even Nest's "Starting Nest application". It was alive (an exit ends the wait at once) and still loading its module graph.
- On the GitHub Windows runner the same build gets from "Supervisor status: backend" to NestFactory in about 3 s and to listening in about 5 s. The gap is the cold first load on a real PC: tens of thousands of freshly installed files, opened for the first time, with Defender's real-time scan on each one. A retry finds them cached. Defender is the likely cause, not a measured one.

## Watch out
- CI cannot catch this: the runner's cold start is about 5 s. A home PC right after install is the case that fails.
- The frontend's deadline is only 60 s, and the first run never got that far, so it may have the same problem.
- Levers, not yet tried: a much longer first-start deadline (an exit already ends the wait immediately, so a long deadline costs only on a real hang), a splash line saying the first start can take minutes, and periodic "still starting" lines in main.log. NODE_COMPILE_CACHE would help compile time but not scanning, and changes the child environment that the boot-contract guard compares.

In the code:
- desktop/src/supervisor/types.ts DEFAULT_BOOT_OPTIONS (backendReadyDeadlineMs 120_000, frontendReadyDeadlineMs 60_000, logTailLines 50)
- desktop/src/supervisor/boot.ts waitHealthy, desktop/src/health.ts
