# Plan: bundle the user guide into the release (in-app help, plan 1)

Part of `docs/future-plans/in-app-help.md`; read its shared decisions first.
This plan delivers the help API and its frontend client. It adds no UI; plan 2
is the first consumer. One PR.

## Assumptions (verified against the tree, 2026-11)

- `backend/Dockerfile` copies `docs/release-notes` into `./release-notes` in
  both the development and builder stages, and the production stage copies it on
  from the builder. `ReleaseNotesService.resolveDirectory()` looks in the image
  location first and then the source-tree locations, so the same code works in
  the image, in `start:dev` and in Jest.
- `ReleaseNotesController` is deliberately public (the login screen opens What's
  New), takes no user input and is a safe GET. The global `ThrottlerGuard`
  (`backend/src/app.module.ts`) still applies to it.
- `website/docs/search-index.json` already holds every h2/h3 section of every
  page in document order: `u` (`/docs/<page>#<anchor>`), `p`, `h`, `x`. A page's
  table of contents is its entries in order, so the backend need not parse
  headings itself.
- The landing page is `website/docs/index.md`; its slug in `docs-links.ts` is
  `''`.

## Design

### Packaging

`backend/Dockerfile` gains, beside each release-notes copy:

```dockerfile
# Copy the user guide so in-app help works without network access (no images)
COPY website/docs/*.md website/docs/nav.json website/docs/search-index.json ./help/
```

and the production stage copies `./help` on from the builder. This is a change on
the release path, so it is agreed in the PR discussion before it lands
(`AGENTS.md`, "Ask first"). No image is copied: the guide is text only in the app.

### Backend: a `help` module

New module `backend/src/help/` (`help.module.ts`, `help.service.ts`,
`help.controller.ts`, specs beside them), registered in `app.module.ts`. No
database access, so no `withScopedDb` and no RLS surface.

`HelpService`:

- Resolves the directory with the same multi-candidate search as
  `ReleaseNotesService` (image `./help`, then the repository's `website/docs`
  relative to the working directory and to `__dirname`). Not configurable.
- Loads once, lazily, and caches: `nav.json`, the search index, and each page's
  Markdown on first request. The bundle never changes while the process runs.
- `getManifest()`: the running version, the groups and pages from `nav.json`
  (slug, title, summary, group) and `available: boolean`. A missing directory
  logs one warning and answers `available: false` with no pages. It does not throw.
- `getPage(slug)`: looks the slug up in the set `nav.json` defines (plus
  `index`). An unknown slug is `null`, never a file read. Answers
  `{ slug, title, group, markdown, toc: [{ depth, id, heading }], onlineUrl }`.
  `toc` comes from the page's search-index entries (depth from the Markdown
  heading level of that anchor, found once at load). `onlineUrl` is the page's
  monize.net URL, built from one base-URL constant in the help module (the
  backend's counterpart of the frontend's `DOCS_BASE_URL`).
- The Markdown is served as written. Turning `name.md#anchor` links into panel
  navigation and images into captions is the renderer's job (plan 2), so the
  website and the app keep one source.

`HelpController` (`@Controller("help")`, public like the release notes, no user
data, safe GETs):

- `GET /help` returns the manifest.
- `GET /help/pages/:slug` returns the page or 404. The slug is validated by a
  pipe or a `^[a-z0-9-]+$` check before the lookup, and the lookup is the
  authority.
- Search is plan 3's `GET /help/search`. It is not part of this PR.

Exception messages go through `tr(...)`. Response types live in
`backend/src/help/dto/`.

### Frontend: the client

`frontend/src/lib/help.ts`: `helpApi.getManifest()` and `helpApi.getPage(slug)`
through the existing API client, cached with `dedupe` (`docs/frontend/api-and-cache.md`).
A failed request is an error state, never an empty page. Add
`helpTarget(link: DocsLink)` to `docs-links.ts` (or beside it), returning
`{ page, section }` so consumers navigate by key and never parse `docsUrl`.

### Why not a frontend bundle

The frontend's Docker context is `./frontend`, so a frontend bundle would be a
second committed, generated copy of the guide inside `frontend/`, kept in step by
another `docs:check` rule. The assistant (plan 6) needs the guide on the backend
anyway. One copy, served once, is the smaller system.

## Tests

- `help.service.spec.ts`: an unknown slug is `null` and causes no filesystem
  read outside the resolved directory; `../` and encoded variants are refused; a
  missing directory gives `available: false`; the toc of a fixture page matches
  its headings in order; the cache reads each file once.
- A spec that loads the real `website/docs` (the source-tree candidate) and
  checks that every `nav.json` page is served and every toc anchor exists in that
  page's generated HTML. This is the backend twin of `docs-links.test.ts`, and it
  fails when the bundle and the website disagree.
- Every `DOCS_LINKS` key resolves through `helpTarget` to a page the manifest
  lists (frontend unit test against the committed `nav.json`).
- `help.controller.spec.ts`: 404 on an unknown or malformed slug, no auth
  required, the response shape.
- `helpApi` tests: dedupe, error propagation.
- A guard or a comment in `website/README.md`, "Documentation", noting that the
  guide ships in the backend image, so a new top-level file the app needs has to
  be added to the Dockerfile's copy line.

## What to run

- `backend/`: lint, `npx tsc --noEmit`, `npm run typecheck`, `npm run test:changed`.
- `frontend/`: lint, type-check, i18n:check, `npm run test:changed`, build.
- `docker compose -f docker-compose.dev.yml build backend`, then
  `curl localhost:<port>/api/v1/help` and `/api/v1/help/pages/accounts`: the
  image serves the guide with the network off.
- `node scripts/check-docs-manifests.mjs` (this plan names paths).

## Observable when done

`GET /api/v1/help/pages/budgets` on a container with no network returns the
Budgets page Markdown and its table of contents. `GET /api/v1/help/pages/../etc`
returns 404.
