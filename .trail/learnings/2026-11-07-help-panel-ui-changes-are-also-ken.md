---
title: "Help panel UI changes are also asserted in E2E, and failing E2E output can be read before the run finishes"
author: Ken
date: 2026-11-07
branch: fix/help-ui-tweaks
id: l-ca1aceb0
scope: repo
status: active
src: agent
touches:
  - e2e/tests/help-panel.spec.ts
---

## Decided
When changing what the in-app help panel renders (screenshots, links, captions), update the Playwright help-panel spec as well as the vitest specs. The unit specs passing locally did not cover it, and CI's E2E shard 2 failed on all three retries.

## Watch out
`gh run view <run> --job <job> --log-failed` refuses with "still in progress" while any other job in the run (e.g. the cluster E2E shard) is pending, and the raw job-logs API returns terminal escapes that gh will not print. The check-run annotations already carry the Playwright failure, the locator and the code frame.

In the code:
- e2e/tests/help-panel.spec.ts — "a screenshot loads in the panel from the backend, as WebP" asserts on the panel's screenshot markup
- `gh api repos/kenlasko/monize/check-runs/<job-id>/annotations --jq '.[] | "\(.path):\(.start_line) \(.message)"'`
