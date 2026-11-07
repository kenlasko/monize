# Plan: screenshots in the help panel (in-app help, plan 7)

Part of `docs/future-plans/in-app-help.md`; read its shared decisions first.
This plan replaces shared decision 2 ("Text only"): the help panel shows the
guide's screenshots, in the theme the app is in, from the backend image. One PR
(issue #2057), after plans 1 and 2.

## Assumptions (verified against the tree, 2026-11)

- `website/docs/images/` holds every screenshot as PNG, 541 files and 31.4 MB:
  `<name>.png` is the dark picture and `<name>.light.png` the light one. A page
  names only `images/<name>.png`; a picture with no `.light.png` shows in both
  themes on the website (`frontend/scripts/website-docs/markdown.mjs`, `image`).
  `npm run docs:check` fails a picture no page references.
- The website renderer reads each PNG's IHDR for `width` and `height` and marks
  every picture `loading="lazy"` and `decoding="async"`.
- `backend/Dockerfile` copies `website/docs/*.md`, `nav.json` and
  `search-index.json` into `./help` in the development and builder stages, and
  the production stage copies `./help` on from the builder and then runs
  `chown -R` over it. The root `.dockerignore` re-includes exactly those files.
- The builder and deps stages are `node:24-slim`, the development and
  production stages `node:24-alpine`, both pinned by digest. CI builds the
  published image for `linux/amd64,linux/arm64` with QEMU, so a stage on the
  target platform runs emulated on the other one.
- The dev stack (`docker-compose.dev.yml`) mounts `./website/docs:/app/help:ro`,
  which has PNG and no WebP. The e2e stack (`docker-compose.e2e.yml`) mounts
  nothing and runs the development image's own `./help`.
- `HelpService` (`backend/src/help/help.service.ts`) reads the whole guide once,
  when the bundle loads, by the slugs `nav.json` names; a request only looks its
  slug up in memory. Its two Map fields are allowlisted in
  `backend/src/common/process-local-state.guard.spec.ts`. Its page read carries
  two Bearer fingerprints in `.github/workflows/ci.yml`.
- `HelpMarkdown` (`frontend/src/components/help/HelpMarkdown.tsx`) renders an
  image as its caption plus a "View screenshot on monize.net" link and never an
  `<img>`. `remark-help.ts` tags each image with the section it sits in.
- The app's CSP is `img-src 'self' data: blob:` and the frontend proxies
  `/api/*` to the backend, so `/api/v1/...` is the app's own origin. The current
  theme is `useTheme().resolvedTheme` (`frontend/src/contexts/ThemeContext.tsx`).
- The global `ThrottlerGuard` counts per route and client (100 a minute by
  default). The dashboard page references 28 pictures.

## Decisions (owner, issue #2057)

- Both themes ship; the panel shows the one matching the app's theme, and a
  picture with no `.light` twin shows in both, as on the website.
- Compressed WebP in the backend image, converted at build time from
  `website/docs/images`; no second, generated copy is committed.

## Design

### Packaging

A new stage converts the PNGs once:

```dockerfile
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/node:24-alpine@sha256:<the pinned digest> AS help-images
RUN apk add --no-cache libwebp-tools
COPY backend/scripts/convert-help-images.sh /usr/local/bin/convert-help-images
COPY website/docs/images/*.png /src/
RUN convert-help-images /src /images
```

- **Its own stage, on the build platform.** A picture is the same bytes on
  every architecture, so the stage runs natively once for both platforms
  instead of a second time under QEMU, where `cwebp` is several times slower.
  It is a build stage like the builder and contributes only its output.
- **The tool is `cwebp` from Alpine's `libwebp-tools`**, in the node:24-alpine
  base the file already pins, so no new base image and no npm dependency.
  Alpine packages are not version-pinned (`.hadolint.yaml`, DL3018).
- **The settings are `-near_lossless 40 -z 6 -metadata none`**, measured over
  the whole folder (4 cores, cwebp 1.6.0):

  | Settings | Size | Time |
  |---|---|---|
  | PNG as committed | 31.4 MB | |
  | `-q 80 -m 6` (lossy) | 16.6 MB | 20 s |
  | `-q 75 -m 6` (lossy) | 14.6 MB | 18 s |
  | `-lossless -z 6` | 16.4 MB | 21 s |
  | `-near_lossless 40 -z 6` | 13.4 MB | 32 s |
  | `-lossless -z 9` | 14.8 MB | 361 s |

  Near-lossless keeps full chroma, so small coloured text does not smear the
  way 4:2:0 lossy does, and it is the smallest of the fast settings.
- `backend/scripts/convert-help-images.sh SRC OUT` converts every `*.png` in
  parallel and fails the build when any conversion fails or the count of WebP
  files differs from the count of PNGs.
- The development stage copies the WebP into `./help/images`, so the e2e stack
  serves the format production does. The production stage copies them after its
  `chown -R` step with `COPY --chown`, so the pictures are one layer, not two.
  The builder stage does not need them.
- The root `.dockerignore` re-includes `website/docs/images/*.png` and nothing
  else under `images/`.

### Backend

`backend/src/help/help-images.ts` holds the image bundle, so the existing reads
in `help.service.ts` keep their Bearer fingerprints:

- `readImageBundle(directory)`: lists `<directory>/images` once and keeps every
  file named `^[a-z0-9-]+(\.light)?\.(webp|png)$`, keyed by its name without the
  extension (`accounts-list`, `accounts-list.light`). A WebP wins over a PNG of
  the same name; a PNG alone is the fallback (the dev stack's mount). Each
  entry holds its path, its content type, its width and height, read from the
  file's header (PNG `IHDR`; WebP `VP8 `, `VP8L` or `VP8X`), and a revision
  from the file's size and modification time. A file whose
  header does not parse is logged and left out. No `images` directory is an
  empty bundle, not an error: pages still load, with captions.
- `imageSize(header)`: the header parser, a pure function with its own tests.
- `readBundledImage(entry)`: reads the bytes of an entry and the file's
  revision as it is now. Its path comes from the listing, never from a request.

`HelpService`:

- Loads the image bundle with the pages, into a new `images` Map field (an
  allowlist entry with its reason, like `#pages` and `#loaded`).
- Each page gains `images`: for every `images/<name>.png` its Markdown names
  (the regex the website build uses), `{ dark, light }` where each variant is
  `{ name, width, height, revision }` and `light` is `null` when there is no
  twin. A picture the bundle lacks is left out, and the renderer falls back to
  the caption. `revision` is the cache key: the running version and the file's
  own revision, so it changes with every release and whenever the file does (a
  screenshot retaken under the dev stack's mount, or an image built from `main`
  between releases, where the version does not move). The revision a request
  is answered with is the file's as read then, so a file changed after the
  listing stops matching its page's stale key and is revalidated, not pinned.
- `getImage(name)`: `null` unless the name matches
  `HELP_IMAGE_NAME_RE` (`^[a-z0-9-]+(?:\.light)?$`) and is in the Map; else the
  entry's bytes and content type. The name is looked up, never joined into a
  path, so `../`, `%2e%2e` and every other variant is `null` with no fs call.

`HelpController`: `GET /help/images/:name`, public and read-only like the rest
of the help API:

- 404 through `tr("errors.help.imageNotFound", ...)` for anything `getImage`
  refuses.
- `Content-Type` from the entry (`image/webp`, or `image/png` in the dev stack).
- `Cache-Control: public, max-age=31536000, immutable` when the request's `v`
  is the picture's current `revision` (the app always sends it), else
  `public, max-age=0, must-revalidate`. A new release or a changed file changes
  `v`, so a browser never shows an older picture. `res.send` adds an ETag.
- Its own throttle, 300 a minute: a page of pictures is one request each, and
  immutable caching makes a second visit free.

Bearer: the read in `readBundledImage` and anything else in the new file that
Bearer reports as a non-literal path gets a fingerprint in the CI exclude list,
with its reason and a review-by date three months out, like the page read. No
inline suppression.

### Frontend

- `frontend/src/lib/help.ts`: `HelpImage`, `HelpImageVariant`, the page's
  `images`, and `helpImageUrl(variant)` returning
  `/api/v1/help/images/<name>?v=<revision>` (the shape of `institutionLogoUrl`).
- `HelpMarkdown` takes `images` (optional: a backend older than the frontend
  sends none, and every picture is then its caption). For `images/<name>.png` in the
  page's `images` it renders an `<img>` of the variant for `resolvedTheme` (the
  light twin when there is one and the theme is light, else the dark picture),
  with the bundle's `width` and `height`, `loading="lazy"`,
  `decoding="async"` and the alt text, then the alt text as a caption (hidden
  from a screen reader, which has just read it as the alt text), then the
  "View screenshot on monize.net" link. A theme change re-renders it with the
  other picture. A name not in `images`, or a picture whose request fails (a
  throttled request, a replica without it), keeps today's caption and link
  rather than a broken image.
- `HelpPanel` passes the page's `images` through.

## Tests

- `help-images.spec.ts`: PNG and each WebP header kind give the right size; a
  truncated or foreign header is `null`; the listing prefers WebP and falls
  back to PNG; a name outside the pattern is skipped; a missing directory is
  empty; a changed file gets a new revision.
- `help.service.spec.ts`: a page's `images` holds the dark and light variant,
  `light: null` without a twin, and leaves out a picture the bundle lacks;
  `getImage` returns the bytes and type; traversal and encoded names
  (`../secret`, `..%2Fx`, `%2e%2e`, `x.webp`, `x.light.light`, `X`, `x\0`) are
  `null` with no fs call.
- `help.controller.spec.ts`: the content type, the two cache headers, the 404
  for a refused name with no lookup, no auth guard.
- `help.real-docs.spec.ts`: every picture a guide page references is in the
  bundle, with its light twin wherever the folder has one.
- `HelpMarkdown.test.tsx`: the test asserting no `<img>` becomes one asserting
  the picture: `src`, `width`, `height`, `loading`, `decoding`, caption and
  link; the light theme picks the twin; a picture without a twin shows the dark
  one in the light theme; switching the theme swaps the picture; a name the
  bundle lacks keeps the caption and link.
- `e2e/tests/help-panel.spec.ts`: a picture in the Budgets page loads in the
  panel (`naturalWidth > 0`) and is `image/webp`.

## Docs

- `docs/future-plans/in-app-help.md`: decision 2 and the open decision on
  screenshots, settled by this plan.
- `website/README.md`, "The guide also ships in the backend image": the
  pictures ship too, converted at build time, so a new or renamed picture needs
  no extra step.
- `website/docs/getting-started.md`, "Getting Help in the App": screenshots show
  in the panel. `npm run docs:build` after editing it.

## What to run

- `backend/`: lint, `npx tsc --noEmit`, `npm run typecheck`, `npm run test:changed`.
- `frontend/`: lint, type-check, i18n:check, `npm run test:changed`, build,
  `npm run docs:check`.
- `node scripts/check-docs-manifests.mjs`, `node scripts/check-bearer-exceptions.mjs`.
- `docker compose -f docker-compose.dev.yml build backend`; run the image with
  `--network none` and fetch `/api/v1/help/images/budgets-page` from inside it
  (`image/webp`); in the dev stack (PNG mount) the same request is `image/png`.
- Build the production target and record the size of its pictures layer.
- `e2e/tests/help-panel.spec.ts` on Chromium and Firefox.

## Observable when done

Opening Budgets help in the panel shows the Budgets screenshots in the app's
theme, and switching the theme swaps them. `GET /api/v1/help/images/budgets-page`
on a container with no network answers `image/webp`;
`GET /api/v1/help/images/..%2Fnav` answers 404.
