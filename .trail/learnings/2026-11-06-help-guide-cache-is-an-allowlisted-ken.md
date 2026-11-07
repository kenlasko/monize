---
title: "Help guide cache is an allowlisted class field, and the dev stack mounts the guide in"
author: Ken
date: 2026-11-06
branch: feat/help-panel
id: l-a4bac49b
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - backend/src/help/help.service.ts
  - docker-compose.dev.yml
---

## Decided
- The help service's per-process cache of the bundled guide is an ordinary class field with an entry in the process-local-state guard's allowlist, giving the reason: it is an immutable, per-replica copy of text that ships in the image, so replicas cannot disagree.
- The dev compose stack mounts the guide read-only into the backend container, the same way release notes are mounted.

## Tried and ruled out
- Hiding the cache inside a lazily built object so the guard's pattern does not match it: it passed the guard but routed around it, which AGENTS.md forbids; the owner chose the allowlist entry with a reason.
- Leaving the dev compose file alone: the backend bind mount hides the image's bundled guide, help reports unavailable, and every help icon falls back to monize.net in development.

## Watch out
- Anything the backend image bakes in next to /app is hidden in the dev stack by the ./backend:/app bind mount; it needs its own mount there.

In the code:
- backend/src/help/help.service.ts (cache field)
- the process-local-state guard spec's allowlist under backend/src (entry with reason)
- docker-compose.dev.yml: ./website/docs:/app/help:ro beside ./docs/release-notes:/app/release-notes:ro
