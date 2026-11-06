---
title: Payee merge must move every FK to payees(id); PAYEE_REFERENCE_MOVES is the one list
author: Node
date: 2026-11-06
branch: claude/issue-2026
cost: { minutes: 19, tokens: 185788 }
touches:
  - backend/src/payees/payee-auto-merge.service.spec.ts
  - backend/src/payees/payee-auto-merge.service.ts
  - backend/src/payees/payee-references.spec.ts
  - backend/src/payees/payee-references.ts
  - backend/src/payees/payees.service.spec.ts
  - backend/src/payees/payees.service.ts
  - backend/test/integration/payee-merge-references.integration.spec.ts
  - docs/backend/ai-and-payees.md
  - docs/system-invariants.md
  - docs/verification-contract.md
---

## Decided
- Both payee merges (PayeesService.mergePayees, PayeeAutoMergeService.applyAutoMerge) call reassignPayeeReferences (backend/src/payees/payee-references.ts) before `m.remove(Payee, source)`. PAYEE_REFERENCE_MOVES is keyed `table.column` and payee-references.spec.ts parses database/schema.sql (inline REFERENCES, FOREIGN KEY clause, ALTER TABLE ADD CONSTRAINT) for parity in both directions. INV-PAYEE-003.
- shared_postings.payee_id is moved too: its stored input_fingerprint is personalFingerprint(effect), which excludes the payee, so moving it does not flag review.
- email_receipt_parsers moves bump `revision` (CAS counter) so a stale editor gets a 409 instead of writing the deleted payee id back.

## Tried and ruled out
- Mock-only proof: the FK SET NULL is what clears a missed reference, so a real-DB test (test/integration/payee-merge-references.integration.spec.ts, enforced RLS harness) was added; it fails on the old code.

## Watch out
- Integration DB tables come from entity synchronize plus RLS migrations; shared_people/shared_postings have no entities but exist via the shared-expenses migration applied by applyRlsPolicies.
- Local run: docker postgres:16-alpine on another port, then DATABASE_PORT=... DATABASE_USER=monize_test DATABASE_PASSWORD=test_password npx jest --config ./test/jest-integration.json --runInBand <file>.
- backend `npx tsc --noEmit` OOMs at the default heap; use NODE_OPTIONS=--max-old-space-size=4096.
