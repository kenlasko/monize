---
title: "Web-page quote tables need a streaming or time-boxed parse, not a tag-depth pre-scan (PR 1995 review)"
author: Ken
date: 2026-11-03
branch: main
id: l-12866be0
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - CONTRIBUTING.md
  - backend/src/common/instruction-files.spec.ts
  - docs/agent-instructions.md
  - scripts/check-docs-manifests.mjs
  - backend/src/email-receipts/imap/html-lines.util.ts
---

## Decided
The second review of PR #1995 (html_table quote provider) found that the parser's guard against hostile pages, a regex pre-scan that counts tag depth before htmlparser2 runs, cannot bound the parse cost. The fix suggested to the author is to drop the pre-scan: read the table with htmlparser2's streaming Parser callbacks (the way the email-receipt HTML reader does), or parse in a worker with a time limit.

## Tried and ruled out
Patching the pre-scan to match htmlparser2 more closely. The scan and the real tree builder disagree in too many places: htmlparser2 does not close a repeated <thead>/<tfoot>, it ignores stray close tags that the scan counts as closes, and the scan's own regex is quadratic on "<a" with no ">". Each gap alone lets a page of a few hundred KB freeze the event loop for seconds, and a 5 MB page for minutes or more.

## Watch out
A reviewer flagged that "preço\b" can never match because "ç" is not a word character for \b. That is wrong: the word ends in "o", so the boundary falls after a word character and the pattern matches. It was dropped from the review.

In the code: backend/src/securities/html-table-quote.parser.ts (exceedsNestingLimit, IMPLIED_CLOSE_TAGS, MAX_NESTING_DEPTH 500); backend/src/email-receipts/imap/html-lines.util.ts uses the streaming Parser.
