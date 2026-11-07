# Tasks: screenshots in the help panel

Task list for `docs/future-plans/in-app-help-screenshots.md`. Needs plans 1 and
2 merged. Check a box only when its gate passes and is quoted in the commit or PR.

## Agreement

- [x] Owner chooses both themes as compressed WebP in the backend image, and
      approves the build-time tool and the image growth in principle (issue #2057).

## Packaging

- [x] `backend/scripts/convert-help-images.sh`: parallel `cwebp`, fails on any
      failed conversion or a count mismatch.
- [x] `backend/Dockerfile`: `help-images` stage on `$BUILDPLATFORM` with
      `libwebp-tools`; WebP into the development stage's `./help/images` and,
      after the `chown -R`, the production stage's.
- [x] Root `.dockerignore` re-includes `website/docs/images/*.png` only.

## Backend

- [x] `help-images.ts`: listing, WebP-over-PNG preference, header sizes, byte read.
- [x] `HelpService`: `images` Map field (allowlisted with its reason), page
      `images` with a per-picture cache key, `getImage(name)` by lookup only.
- [x] `HelpController`: public `GET /help/images/:name`, content type, cache
      headers tied to the version and the file, 404 via `tr(...)`, its own throttle.
- [x] `errors.help.imageNotFound` in English; the pseudo-locale regenerated.
- [x] Bearer fingerprints for what it reports in `help-images.ts`, with reasons
      and review-by dates; `scripts/check-bearer-exceptions.mjs` green.

## Backend tests

- [x] Header parser and listing spec.
- [x] Service spec: page images, light twin and its absence, `getImage`,
      traversal and encoded names with no fs call.
- [x] Controller spec: content type, cache headers, 404, no auth.
- [x] Real-bundle spec: every referenced picture is in the bundle.

## Frontend

- [x] `lib/help.ts`: image types, page `images`, `helpImageUrl`.
- [x] `HelpMarkdown`: `<img>` of the theme's variant with size, lazy and async
      decoding, caption and online link; caption fallback for a missing picture.
- [x] `HelpPanel` passes `images`.
- [x] Renderer tests: picture attributes, light pick, no-twin fallback, theme
      swap, missing picture; the "no `<img>`" test replaced.

## E2E

- [x] `help-panel.spec.ts`: a Budgets picture loads in the panel as WebP;
      Chromium and Firefox.

## Docs

- [x] Overview decision 2 and open decisions updated.
- [x] `website/README.md` and `website/docs/getting-started.md`; `npm run docs:build`.

## Verification

- [x] Backend and frontend layer gates green, quoted.
- [x] Dev image built; a picture fetched with `--network none` (WebP) and from
      the dev stack's PNG mount (PNG).
- [x] Production image's pictures layer measured and reported in the PR.
- [x] Every locale translated, as the last commit.
