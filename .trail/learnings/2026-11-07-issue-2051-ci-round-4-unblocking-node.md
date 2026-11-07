---
title: "Issue #2051 CI round 4: unblocking real-browser E2E in this sandbox, and the actual header fix"
author: Node
date: 2026-11-07
branch: claude/issue-2051
cost: { minutes: 14, tokens: 93512 }
touches:
  - frontend/src/components/layout/AppHeader.tsx
---

## Decided
Got a real Chromium render working in this sandbox for the first time
across this issue's multiple rounds, which let me actually measure the
header overflow instead of guessing. Recipe (repeatable, no root
needed): the cached `chrome-headless-shell` binary is missing system
libraries (libglib-2.0, libnss3, libatk, libx11, libgbm, etc. -- a
whole desktop stack, not just one lib) and `playwright install-deps`
needs root, which this sandbox doesn't have. Worked around it with a
fully user-local apt download:
  mkdir -p /tmp/apt-root/{etc/apt,var/lib/apt/lists/partial,var/cache/apt/archives/partial,var/lib/dpkg}
  touch /tmp/apt-root/var/lib/dpkg/status
  # one-line-format sources.list (NOT the deb822 .sources format -- that
  # needs Dir::Etc::sourceparts pointing at a directory, sourcelist wants
  # the old one-line format) pointing at deb.debian.org bookworm + bookworm-updates + bookworm-security
  cat > /tmp/apt.conf <<EOF2
  Dir::Etc::sourcelist "/tmp/apt-root/etc/apt/sources.list";
  Dir::Etc::sourceparts "/dev/null";
  Dir::State::lists "/tmp/apt-root/var/lib/apt/lists";
  Dir::Cache::archives "/tmp/apt-root/var/cache/apt/archives";
  Dir::State::status "/tmp/apt-root/var/lib/dpkg/status";
  APT::Architecture "amd64";
  Debug::NoLocking "true";
  EOF2
  APT_CONFIG=/tmp/apt.conf apt-get update
  APT_CONFIG=/tmp/apt.conf apt-get install --download-only --reinstall -y \
    libglib2.0-0 libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 \
    libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
    libgbm1 libxcb1 libxkbcommon0 libasound2 libatspi2.0-0
  for f in /tmp/apt-root/var/cache/apt/archives/*.deb; do dpkg-deb -x "$f" /tmp/libfix/root; done
  # then run playwright with:
  LD_LIBRARY_PATH="/tmp/libfix/root/usr/lib/x86_64-linux-gnu:/tmp/libfix/root/lib/x86_64-linux-gnu" \
    BASE_URL=http://localhost:3001 npx playwright test ...
This, combined with the earlier-discovered `NODE_OPTIONS=--max-old-space-size=4096`
override on the e2e backend service (see the round-3 learning on this
issue), gets a fully working, real-browser e2e loop in this sandbox.

With real measurements (`page.evaluate(() => el.getBoundingClientRect())`
on the header's right-hand cluster and its children), the actual
overflow at 1280px with the Help menu added was 48px (cluster content
988-1328, viewport ends 1280; Logout button sat entirely at x
1282-1328, invisible). The round-3 fix (hiding the Settings button's
name at `xl`) only cut it from ~85px to 48px -- not enough. The real
fix was ALSO tightening the cluster's `space-x-4` (16px) gap to
`space-x-1` (4px) in the same `xl` band, restored at `2xl`: this
brought the Logout button's right edge to 1268px, a working margin.
Re-ran the actual previously-failing specs (auth.spec.ts,
settings.spec.ts, security.spec.ts) against the real stack: all pass.

## Tried and ruled out
- Reasoning-only fixes without a real render (round 3's name-hiding
  alone): insufficient by 48px. Don't trust CSS-budget arithmetic for
  a dense header without measuring; get a real browser instead, now
  that it's known to be possible here.
- `help-panel.spec.ts`'s two "the Budgets ? opens the guide" /
  "a key that names a section opens the panel" failures reported by
  CI as "flaky" (not "failed"): reproduced sometimes when run as part
  of the full spec file (11 tests, one worker, sequential), but passed
  every time run alone or as a 2-test subset. This is pre-existing
  dev-server/Turbopack cold-compile timing flakiness (saw multi-second
  "[Fast Refresh] done in 9864ms" in the console log during a cold
  route visit), not a regression from this PR's header change. Did not
  chase further since CI itself doesn't block on "flaky".

## Watch out
- The `/tmp/apt-root` + `/tmp/libfix` setup does not survive a fresh
  session/worktree; this is a recipe to redo, not a cached asset.
- Don't forget to `docker compose -p issue-2051 ... down -v` after
  using this -- it's easy to leave the stack running when iterating on
  rebuild-and-remeasure cycles (I rebuilt the frontend container
  in-place with `up -d --build frontend --wait` between a code change
  and the next measurement; backend/postgres don't need rebuilding for
  a frontend-only change).
