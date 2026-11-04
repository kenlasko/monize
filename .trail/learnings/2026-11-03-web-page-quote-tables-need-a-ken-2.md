---
title: "Web-page quote tables need a streaming or time-boxed parse, not a tag-depth pre-scan (PR 1995 review)"
author: Ken
date: 2026-11-03
branch: main
id: l-6d5ae0e8
scope: repo
status: active
replaces: l-12866be0
src: agent
touches:
  - AGENTS.md
  - CONTRIBUTING.md
  - backend/src/common/instruction-files.spec.ts
  - docs/agent-instructions.md
  - scripts/check-docs-manifests.mjs
  - backend/src/email-receipts/imap/html-lines.util.ts
  - backend/src/provider-health/provider-call.guard.spec.ts
---

## Decided
The second review of PR #1995 (html_table quote provider) found that the parser's guard against hostile pages, a regex pre-scan that counts tag depth before htmlparser2 runs, cannot bound the parse cost. The fix suggested to the author is to drop the pre-scan: read the table with htmlparser2's streaming Parser callbacks (the way the email-receipt HTML reader does), or parse in a worker with a time limit.

## Tried and ruled out
Patching the pre-scan to match htmlparser2 more closely. The scan and the real tree builder disagree in too many places: htmlparser2 does not close a repeated <thead>/<tfoot>, it ignores stray close tags that the scan counts as closes, and the scan's own regex is quadratic on "<a" with no ">". Each gap alone lets a page of a few hundred KB freeze the event loop for seconds, and a 5 MB page for minutes or more.

## Watch out
Don't flag the html_table entry in the outbound-call guard's exemption list as a guard-widening violation. The maintainer's first review on this PR asked for exactly that named, asserted exemption instead of an import alias that slipped past the guard. Flag the per-origin back-off it relies on instead, which blocks a site for every user for 10 minutes after one failure.

Two automated findings were wrong and were not posted: that "preço\b" can never match (the word ends in "o", a word character, so the boundary exists), and that the provider's public-only undici Agent duplicates the AI one (the AI one has no timeouts on purpose; this one has 20 s).

In the code: backend/src/securities/html-table-quote.parser.ts (exceedsNestingLimit, IMPLIED_CLOSE_TAGS, MAX_NESTING_DEPTH 500); backend/src/email-receipts/imap/html-lines.util.ts uses the streaming Parser; backend/src/provider-health/provider-call.guard.spec.ts holds the exemption; ai/providers/long-running-fetch.ts holds the other Agent.
