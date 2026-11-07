---
title: "In-app help API is public, and the help panel shares the right edge with the assistant"
author: Ken
date: 2026-11-06
branch: feat/help-api
id: l-756d3a58
scope: repo
status: active
src: agent
touches:
  - docs/future-plans/in-app-help.md
---

## Decided
- The help API (manifest and page endpoints) is public, like the release notes, so help can be used on the login and 2FA screens. It is read-only, serves only the bundled guide (no user data), and the global ThrottlerGuard still applies.
- Bundling the guide into the backend image (a release-path change) was approved by the owner for plan 1.
- The help panel docks on the right, in the same spot as the assistant sheet; opening one collapses the other. Phones get a bottom sheet.
- Plans 1 and 2 are built on two stacked local branches (help API first, the panel on top of it), one PR each once reviewed.

## Tried and ruled out
- Putting the help API behind JWT: it would block help on the login and 2FA screens and protects nothing, since the content is the public user guide.
- Docking the help panel on the left on wide screens so both panels can be open at once: more layout work for little gain; it reuses AiChatBubble's sheet behaviour as-is instead.

## Watch out
- Being public does not loosen slug handling: a slug is looked up in nav.json and never joined into a file path.

In the code:
- backend/src/help/help.controller.ts (no AuthGuard, by decision)
- backend/Dockerfile copies website/docs into ./help beside the release-notes copy
- docs/future-plans/in-app-help.md "Open decisions": the public/JWT question is now settled
- frontend/src/components/help/HelpPanel.tsx is mounted beside AiChatBubble in SwipeShell
