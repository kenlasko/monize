---
title: Bundling the user guide into the backend image needed a .dockerignore exception
author: Ken
date: 2026-11-06
branch: feat/help-api
id: l-27a3a2ef
scope: repo
status: active
src: agent
touches:
  - backend/Dockerfile
  - ".dockerignore"
  - backend/src/help/help.service.ts
  - backend/src/help/help.service.spec.ts
---

## Decided
- The backend image gets the guide's Markdown, nav.json and search-index.json at /app/help. The root .dockerignore excluded all of website/, so the Dockerfile COPY alone would have failed; website/docs/*.md, nav.json and search-index.json are re-included there and nothing else (no images, no HTML).
- HelpService keeps its page cache inside the lazily loaded bundle object, not as a class-scope Map: process-local-state.guard.spec.ts fails a private Map field, and the cache is immutable file content so N replicas agree. The guard's ALLOWED list was left alone.

## Tried and ruled out
- Spying on fs with import * as fs in a spec: Cannot redefine property readFileSync. Use import fs from 'fs' as db-migrate.spec.ts does.
- docker compose -f docker-compose.dev.yml build backend without env: it needs JWT_SECRET set (any value) just to interpolate.

## Watch out
- The service finds its directory by requiring nav.json, and a missing-bundle test must stub fs.existsSync, because the repository's website/docs is also a candidate and would be found.
- backend test:changed fails two loan-payment-frequency guards outside TZ=UTC; CI runs UTC.

In the code:
- backend/Dockerfile and .dockerignore carry the guide into the image
- backend/src/help/help.service.ts (cache in the bundle, directory resolution)
