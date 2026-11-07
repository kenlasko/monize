# Tasks: bundle the user guide into the release

Task list for `docs/future-plans/in-app-help-bundled-docs.md`. Check a box only
when its gate passes and is quoted in the commit or PR.

## Agreement

- [x] Owner agrees to the `backend/Dockerfile` copy line (release path) and to
      the help API being public.

## Backend

- [x] Dockerfile: copy the guide's Markdown, `nav.json` and `search-index.json`
      into `./help` in the development and builder stages; carry it into the
      production stage.
- [x] `HelpService`: directory resolution mirroring `ReleaseNotesService`, lazy
      cached load, `getManifest()`, `getPage(slug)` by lookup only, toc from the
      search index.
- [x] `HelpController`: public `GET /help`, `GET /help/pages/:slug`; 404 via
      `tr(...)` for an unknown slug; slug format checked before the lookup.
- [x] Response DTOs in `backend/src/help/dto/`; module registered in `app.module.ts`.

## Backend tests

- [x] Service spec: unknown and traversal slugs, missing directory, toc order,
      single read per file.
- [x] Real-bundle spec: every `nav.json` page served; every toc anchor present in
      the generated HTML.
- [x] Controller spec: unauthenticated access, 404 shape.

## Frontend

- [x] `frontend/src/lib/help.ts`: `helpApi.getManifest` / `getPage` through
      `dedupe`; failure is an error, not an empty page.
- [x] `helpTarget(link)` beside `docsUrl`; unit test that every `DOCS_LINKS` key
      maps to a page in `nav.json`.

## Docs

- [x] `website/README.md`, "Documentation": the guide also ships in the backend
      image (text only), and what that means for a new file.
- [ ] `docs/backend/` entry for the help module if a rule emerges (slug lookup,
      public endpoint).

## Verification

- [x] Backend and frontend layer gates green, quoted.
- [x] Dev image built; both endpoints answer with the network disabled.
