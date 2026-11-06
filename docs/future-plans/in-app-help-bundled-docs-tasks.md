# Tasks: bundle the user guide into the release

Task list for `docs/future-plans/in-app-help-bundled-docs.md`. Check a box only
when its gate passes and is quoted in the commit or PR.

## Agreement

- [ ] Owner agrees to the `backend/Dockerfile` copy line (release path) and to
      the help API being public.

## Backend

- [ ] Dockerfile: copy the guide's Markdown, `nav.json` and `search-index.json`
      into `./help` in the development and builder stages; carry it into the
      production stage.
- [ ] `HelpService`: directory resolution mirroring `ReleaseNotesService`, lazy
      cached load, `getManifest()`, `getPage(slug)` by lookup only, toc from the
      search index.
- [ ] `HelpController`: public `GET /help`, `GET /help/pages/:slug`; 404 via
      `tr(...)` for an unknown slug; slug format checked before the lookup.
- [ ] Response DTOs in `backend/src/help/dto/`; module registered in `app.module.ts`.

## Backend tests

- [ ] Service spec: unknown and traversal slugs, missing directory, toc order,
      single read per file.
- [ ] Real-bundle spec: every `nav.json` page served; every toc anchor present in
      the generated HTML.
- [ ] Controller spec: unauthenticated access, 404 shape.

## Frontend

- [ ] `frontend/src/lib/help.ts`: `helpApi.getManifest` / `getPage` through
      `dedupe`; failure is an error, not an empty page.
- [ ] `helpTarget(link)` beside `docsUrl`; unit test that every `DOCS_LINKS` key
      maps to a page in `nav.json`.

## Docs

- [ ] `website/README.md`, "Documentation": the guide also ships in the backend
      image (text only), and what that means for a new file.
- [ ] `docs/backend/` entry for the help module if a rule emerges (slug lookup,
      public endpoint).

## Verification

- [ ] Backend and frontend layer gates green, quoted.
- [ ] Dev image built; both endpoints answer with the network disabled.
