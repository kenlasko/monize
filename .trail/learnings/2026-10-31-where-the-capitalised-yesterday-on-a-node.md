---
title: "Where the capitalised '(Yesterday)' on a refresh button came from (#1970)"
author: Node
date: 2026-10-31
branch: claude/issue-1970
cost: { minutes: 1, tokens: 6065 }
touches:
  - frontend/src/components/investments/RefreshPricesButton.tsx
  - frontend/src/lib/format.ts
---

## Decided
- The "(Yesterday)" vs "(yesterday)" casing reported in Discussion #1955 came from an old build (f8ee718), where one refresh button still used the English-only formatRelativeTime in frontend/src/lib/format.ts (it returns "Yesterday", "Just now", "3h ago"). That helper was removed in 88c5e2b77; every relative age now goes through useRelativeTime (Intl.RelativeTimeFormat, lowercase "yesterday" in English), and both refresh buttons draw it through RefreshButtonLabel. No casing fix is needed on current code.

## Watch out
- A UI report naming wording the current code cannot produce is worth checking against the build the reporter ran: `git show <sha>:<file>` on the helper often explains it.
