# Unified import preview: agent task list

> Companion to [`unified-import-preview.md`](./unified-import-preview.md).
> One task per session and per PR, in dependency order. No task starts
> before U1.

## How to use this list

- **The governing invariants apply to every task**: P1 (preview equals
  commit), P2 (at most once per key), P3 (rejection before write), P4 (rules
  never move money).
- **An existing import imports exactly as before** until its own task
  switches it to the shared preview; every task keeps that test green.
- **Definition of done**: the layer gates of `AGENTS.md`; migrations with
  `migration:lint`, `scripts/verify-schema.sh` and
  `node scripts/check-migration-prefixes.mjs`; strings in every locale; the
  PR body per `.github/pull_request_template.md`.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| U1 | Discussion approved; D1 to D4 answered; this plan merged | -- | none | [ ] |
| U2 | Backend `import-preview` module: payee report, rule traces, fingerprint, selection check; bank sync switched to it with no behaviour change | U1, bank sync BS20 | inert | [ ] |
| U3 | Frontend `ImportPreviewTable` and `ImportPreviewSummary`; bank sync preview switched to them | U2 | inert | [ ] |
| U4 | Exceptions per account and source (decision D1), migration | U1 | neutral | [ ] |
| U5 | CSV: duplicate key and cut-off (csv-source-profiles P3), preview step, commit by fingerprint (P6) | U3, U4 | additive | [ ] |
| U6 | QIF and OFX: FITID kept by the OFX parser, content hash for QIF, preview step | U5 | additive | [ ] |
| U7 | MNY: preview of the staged rows in the review step (decision D3) | U5 | additive | [ ] |
