---
title: "Docs screenshots can run beside a running dev stack by moving the capture stack to other ports, origins included"
author: Ken
date: 2026-11-07
branch: feat/visual-quick-wins
id: l-870dd1c0
scope: repo
status: active
src: agent
touches:
  - backend/src/net-worth/net-worth.service.spec.ts
  - backend/src/net-worth/net-worth.service.ts
  - docs/frontend/screens-and-dialogs.md
  - docs/frontend/theming.md
  - docs/frontend/ui-conventions.md
  - e2e/docs-screenshots/dashboard.spec.ts
  - e2e/readme/02-desktop.spec.ts
  - frontend/CLAUDE.md
  - frontend/src/app/dashboard/page.test.tsx
  - frontend/src/app/dashboard/page.tsx
---

## Decided
- When the dev stack already holds ports 3000/3001, run the documented docs-capture stack (project `monize-docs`) on 13000-13002 through a compose override instead of stopping the dev stack, and point Playwright at BASE_URL=http://localhost:13001.

## Tried and ruled out
- A plain `ports:` entry in the override file: compose merges port lists, so the base file's 3000/3001 bindings stay and the stack fails to start. Use `ports: !override [...]`.

## Watch out
- The e2e compose file also hard-codes the origin as http://localhost:3001 (`PUBLIC_APP_URL` and `CORS_ORIGIN` on the backend, `PUBLIC_APP_URL` on the frontend). Move those to the new port too, or sign-in fails on CORS.
- Keep `DEMO_MODE: "false"` on the backend and `DISABLE_HTTPS_HEADERS: "true"` on the frontend from website/README.md "Screenshots".

In the code: docker-compose.e2e.yml (ports at backend 3000, api-lb 3002, frontend 3001), website/README.md "Screenshots", e2e/playwright.docs.config.ts. Override used:
services: backend: ports: !override ["13000:3000"], environment: DEMO_MODE "false", PUBLIC_APP_URL/CORS_ORIGIN http://localhost:13001; api-lb: ports: !override ["13002:80"]; frontend: ports: !override ["13001:3000"], environment: DISABLE_HTTPS_HEADERS "true", PUBLIC_APP_URL http://localhost:13001.
Command: docker compose -p monize-docs -f docker-compose.e2e.yml -f <override> up -d --build --wait
