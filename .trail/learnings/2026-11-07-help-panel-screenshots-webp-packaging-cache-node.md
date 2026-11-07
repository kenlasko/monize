---
title: "Help panel screenshots: WebP packaging, cache key and the scanner results"
author: Node
date: 2026-11-07
branch: claude/issue-2057
cost: { minutes: 75, tokens: 445743 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
  - backend/src/i18n/locales/pl/errors.json
---

## Decided
- The guide's screenshots ship in the backend image as WebP, converted at build time in a dedicated `help-images` Dockerfile stage on `--platform=$BUILDPLATFORM` (one native run for both platforms; cwebp under QEMU would be several times slower). Tool: Alpine `libwebp-tools` in the already-pinned node:24-alpine, so no apt pin (DL3008) and no npm dependency. Settings `-near_lossless 40 -z 6`: 31.4 MB of PNG becomes 13.4 MB in about 30 s on 4 cores; the production layer is 14.5 MB (about 13.3 MB gzipped).
- Production copies the pictures after its `chown -R` with `COPY --chown`, so they are one layer; copying them before the chown would have duplicated every file into a second layer.
- The development stage carries the WebP too, so the e2e stack serves the shipped format; the dev stack mounts PNG over ./help and the listing falls back to the PNG.
- A picture's cache key is the running version plus the file's size and mtime, not the version alone: between releases package.json does not move, so a version-only key pinned retaken screenshots as immutable. The revision a request is answered with is re-read from the file, so a changed file stops matching the page's stale key.
- HelpMarkdown keeps the set of failed pictures in its own state: ReactMarkdown's `components` are new on every render, so state inside the `img` renderer's child is lost on any re-render.

## Tried and ruled out
- Lossy `-q 80`: 16.6 MB and 4:2:0 chroma smears small coloured text. `-lossless -z 9`: 14.8 MB but 6 minutes.
- Measuring Bearer by reasoning: run it. `docker run --rm -v <dir>:/tmp/scan bearer/bearer:latest scan /tmp/scan --format json` on a copy of the module without specs reproduced CI's two existing help fingerprints exactly; it flagged only the header `openSync` (new fingerprint cc8be0f09d430af908c2fcbbd4b6de11_0), not the per-request `fs.promises.open` of the listed path.

## Watch out
- The e2e stack's backend `nest build` OOMs on the default heap on this sandbox; a throwaway compose override with NODE_OPTIONS=--max-old-space-size=4096 gets it up. Playwright in scripts/e2e-playwright.sh cannot write e2e/test-results under rootless Docker; pass `--output=/tmp/pw-results`.
- `npx prettier` in e2e/ has no config and rewrites the file to double quotes; the e2e specs are single-quoted, so do not run it there.
- "Offline" verification: postgres with `--network none` and the backend on `--network container:<pg>` gives both only loopback.
