# Source profiles: agent task list

> Companion to [`source-profiles.md`](./source-profiles.md). One task per
> session and per PR, in dependency order. No task starts before SP1, except
> SP2, which the bank sync branch already carries.

## How to use this list

- **The governing invariants apply to every task**: S1 (a profile never
  changes the duplicate key), S2 (a shared profile carries no personal data),
  S3 (preview equals commit), S4 (structure through the existing processors).
- **Definition of done**: the layer gates of `AGENTS.md`; strings in every
  locale; the PR body per `.github/pull_request_template.md`.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| SP1 | Discussion approved; D1 to D4 answered; this plan merged | -- | none | [ ] |
| SP2 | Bank sync: the operation-code table moves to a built-in profile file for PKO BP, chosen by institution; other banks get the default profile | -- | inert | [x] |
| SP3 | Profile schema, validator (S2), loader for built-in profiles; operation location and labels | SP1 | inert | [ ] |
| SP4 | Payee and description per type, with the named cleanup steps; preview shows the profile's effect | SP3, unified preview U3 | additive | [ ] |
| SP5 | User profiles: per-user override, editor in the preview, export and import as JSON | SP4 | additive | [ ] |
| SP6 | Structure per type: own-account transfer (bank sync BS14), split by captures (BS21, CSV P5) | SP4 | additive | [ ] |
| SP7 | CSV profiles on the same engine (csv-source-profiles P2 to P5) | SP4 | additive | [ ] |
| SP8 | Optional: converter for Firefly III CSV configurations (decision D2) | SP7 | none | [ ] |

## Notes per task

- **SP2 (done in the bank sync branch).** Format decisions SP3 inherits:
  `operation.location` is an ordered array (`remittance_line`,
  `bank_transaction_code`), validated but not yet read; every type has an
  explicit `key` (the tag family); `byDirection` names other types' keys;
  labels are keys of `common.bankSync.operationTypes`, refused when missing
  from the English catalogue; `match` takes `exact`, or `prefix` and/or
  `suffix`, on the upper-cased code. Profiles are JSON modules
  (`resolveJsonModule`), registered in `BUILT_IN_FILES`; a spec fails for an
  unregistered file. They load at module init, so a broken profile stops the
  boot. The first S2 validator refuses digit runs of 8 or more, IBAN-like
  strings, amounts and `@`, and never echoes the value. The PKO profile
  matches the institution name "PKO Bank Polski" (Enable Banking's Poland
  market page); confirm it against a live `GET /aspsps` answer.
- **S3 is still open**: the profile version is not yet part of the plan
  fingerprint.
