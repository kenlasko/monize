---
title: A test backdating updated_at needs withPreserveTimestamps (the trigger re-stamps it)
author: Node
date: 2026-11-06
branch: claude/issue-2026
cost: { minutes: 11, tokens: 43107 }
touches:
  - backend/test/integration/bond-prices.integration.spec.ts
---

## Decided
- bond-prices.integration.spec.ts backdates accounts.updated_at under withUserContext + withPreserveTimestamps + withScopedDb, the pattern manual-price-snapshot-recovery.integration.spec.ts already used.
## Watch out
- update_updated_at_column() stamps CURRENT_TIMESTAMP (transaction start) unless app.preserve_timestamps is 'on', so a plain `UPDATE ... SET updated_at = NOW() - INTERVAL ...` in a test is silently ignored.
- A strict `after > before` check on two such stamps can then flake: the next transaction can start within the same millisecond, and JS Date truncates microseconds.
