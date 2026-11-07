---
title: "Issue #2051 CI round 3: header 1280px overflow regression, e2e Docker progress"
author: Node
date: 2026-11-07
branch: claude/issue-2051
cost: { minutes: 10, tokens: 82684 }
touches:
  - frontend/src/components/layout/AppHeader.tsx
  - docs/future-plans/in-app-help-extras-tasks.md
  - frontend/src/components/layout/HelpMenu.test.tsx
  - frontend/src/lib/docs-links.ts
  - frontend/src/app/reconcile/page.tsx
  - e2e/helpers/auth.ts
  - docker-compose.e2e.yml
---

## Decided
The E2E auth/settings/security failures on this branch (logout button
"outside of the viewport", timing out across multiple specs that all
call e2e/helpers/auth.ts's shared logout()/login() flow) were the Help
menu regression the plan's own "watch out" warned about: Playwright's
default viewport is 1280x720 (devices['Desktop Chrome']), exactly the
width where AppHeader's nav links (xl:flex) and the right-hand icon
cluster already competed for room, and the new Help-menu icon (~50px)
tipped it over. SwipeShell's root div has overflow-x-clip, so the
overflow is never scrollable -- the Logout button is genuinely
unclickable, not just requiring a scroll.

Fixed by hiding the Settings button's name specifically in that xl
band (`hidden sm:inline xl:hidden 2xl:inline`): shown below xl (nav is
behind the hamburger there, room exists), hidden at xl where nav
competes, shown again at 2xl+ where there's plenty of room. No e2e
spec asserts on that span's visibility (grepped first). Confirmed via
AppHeader.test.tsx (jsdom doesn't enforce real CSS layout, so this is
reasoning-based, not a real-browser-verified fix -- see below).

## Tried and ruled out
- The backend e2e container's earlier `nest build`-on-boot OOM (see
  the prior "e2e docker OOMs here" learning on this same issue) is
  actually fixable: overriding `NODE_OPTIONS: --max-old-space-size=4096`
  on the backend service in a compose override file (not the tracked
  docker-compose.e2e.yml) made the full e2e stack boot cleanly this
  time (postgres+backend+frontend all healthy). So the OOM was a V8
  default-heap misdetection, not a hard 6Gi ceiling -- worth trying
  this override first next time instead of giving up on Docker.
- Running the actual Playwright spec against that now-healthy stack
  to visually confirm the header fix: blocked by a genuinely different,
  unrelated problem -- the cached `chrome-headless-shell` binary is
  missing `libglib-2.0.so.0`, and `npx playwright install-deps` needs
  root (`su: Authentication failure` in this sandbox). No cached full
  `chromium` binary either. This is a sandbox-missing-system-library
  limitation, not something fixable from inside the worktree. So: the
  Docker stack itself now works, but there is still no way to actually
  run a browser against it in this environment.

## Watch out
- Any future header-width change on this branch/area should be
  double-checked against this fix: the `xl:hidden 2xl:inline` span is
  load-bearing for the E2E suite, not just cosmetic. If more width is
  added to the header's right cluster, re-derive the margin rather than
  assuming today's numbers still fit.
- `trail check`'s false-positive pattern (whole-file lexical overlap,
  not diff-aware) continues to apply to this branch's prose-heavy files
  (page-help.guard.test.ts, the future-plans docs) -- same as the two
  prior learnings on this issue; don't re-investigate it as new.
