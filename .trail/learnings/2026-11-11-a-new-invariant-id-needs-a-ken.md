---
title: "A new invariant ID needs a verification-matrix row in the same change, or backend CI fails"
author: Ken
date: 2026-11-11
branch: feature/portfolio-twr-chart
id: l-1f459fdc
scope: repo
status: active
src: agent
touches:
  - docs/system-invariants.md
  - backend/src/common/invariant-catalog-parity.spec.ts
  - docs/verification-contract.md
---

## Decided
Whenever an invariant is added to the catalogue's Index table, add its row to the verification matrix in the same commit, naming which test kinds hold it. INV-PORTTWR-001 got Unit **required**, PG integration and E2E optional, because only unit and service specs cover it.

## Watch out
Running only the specs of the changed files never runs this guard, because it reads the two docs, not the code. The first sign was the full Backend Unit Tests job failing in CI. After touching docs/system-invariants.md, run the parity spec by name.

In the code:
- backend/src/common/invariant-catalog-parity.spec.ts: every `| INV-...` row in docs/system-invariants.md must have a `| INV-...` row in docs/verification-contract.md (the table under "| Invariant | Unit | Source scan | ...")
- `npm run test:unit -- invariant-catalog-parity` from backend/
