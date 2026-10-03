# CSV source profiles

Design for per-source CSV import profiles: a saved description of one bank's
export (encoding, positional columns, `Label: value` columns, a mapping per
operation type, a duplicate key, transfer and split rules) so that a bank
statement imports correctly without a personal script. The task list is
[`csv-source-profiles-tasks.md`](./csv-source-profiles-tasks.md).

Status: **proposal**. It needs its own discussion with the
`approved-to-build` label before any task starts (`CONTRIBUTING.md`). It is a
financial feature (it decides transfers and splits), so sections 4 to 7 are
the specification `docs/financial-calculation-contract.md` section 9 asks
for.

## 1. Where this comes from

Discussion #991 describes a 1200-line script that imports PKO BP statements
through the REST API. What it does, and what Monize lacks, is general to
banks that export "a few fixed columns plus labelled fragments":

- the file is WINDOWS-1250, not UTF-8;
- the first columns are positional (date, value date, operation type,
  amount, currency, balance), the rest are `Label: value` fragments whose
  set depends on the operation type;
- there is no payee column: the payee comes from `Nazwa odbiorcy` for an
  outgoing transfer, `Nazwa nadawcy` for an incoming one, the merchant and
  `Lokalizacja` for a card payment, a synthetic name for an ATM or a fee;
- duplicates are found by the bank reference, or by a stable hash of date,
  amount, type and title when there is none;
- payments to the user's own IKE/IKZE accounts must become transfers,
  recognised by the recipient name;
- a mortgage instalment carries `KAPITAŁ: x ODSETKI: y` in its title and
  must become a split: a transfer of the capital to the loan account (no
  category) and the interest as an expense;
- a cut-off date keeps a re-import from touching history that was already
  reconciled by hand.

Transaction rules (`transaction-rules.md`) run after a row exists and never
change its account, amount, date or status (INV-RULE-001; a rule's `convert_to_transfer` and `split` actions restructure a row, see `docs/specs/transaction-rules-structural-actions.md`). Everything above
that changes what a row **is** belongs here, before the row is written.
Categorisation and tagging stay with the rules; with phase 2 of the rules
(`transaction-rules.md` section 10) they also set the payee and the
description from captured text.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| Saved CSV mappings | `import_column_mappings` (`database/schema.sql`), `ImportColumnMapping` (`backend/src/import/entities/import-column-mapping.entity.ts`) | `column_mappings` and `transfer_rules` JSONB per named mapping. A profile is this row with more content, not a second table. |
| CSV parsing | `parseCsv` (`backend/src/import/csv-parser.ts`) | Receives the file as text from the wizard. |
| Transfer rules | `CsvTransferRule` (`backend/src/import/csv-parser.ts`), `CsvTransferRules.tsx` (`frontend/src/components/import/CsvTransferRules.tsx`) | Payee or category pattern to an account. Extended here with conditions on labels and title. |
| Reading the file | `useImportWizard` (`frontend/src/hooks/useImportWizard.ts`) | Reads with `File.text()`, which is always UTF-8. |
| Import and savepoints | `ImportService.importParsedTransactions` (`backend/src/import/import.service.ts`) | One transaction per file, one savepoint per row; transfers and splits already have processors. |
| Glob with captures | transaction rules phase 2, task X1 | One matcher for both features; no regex anywhere. |
| Rule effects in the preview | transaction rules phase 2, task X4 | The profile preview shows them too. |

## 3. Product decisions

1. **A profile is a saved mapping with more content.** The wizard's "saved
   mapping" list becomes a list of profiles; an old mapping is a profile with
   no operation types, and imports exactly as today.
2. **Decode in the browser.** The wizard decodes the bytes with
   `TextDecoder(encoding)` from an allowlist (`utf-8`, `windows-1250`,
   `windows-1252`, `iso-8859-2`, `utf-16le`) before it sends text. No new
   dependency; the server keeps receiving text. A file that does not decode
   cleanly (replacement characters) is flagged in the preview.
3. **Operation types drive the mapping.** The profile names the column that
   holds the operation type, and for each type value (or glob of values) says
   where the payee, the description and the reference come from: a
   positional column, a label, a template over labels, or a fixed text.
   Rows whose type has no mapping use the profile's default mapping and are
   counted in the preview.
4. **Structural rules are import rules, not transaction rules.** Two kinds,
   evaluated in order before the row is written:
   - *transfer*: when a condition on labels or text holds, the row becomes a
     transfer to a named account (the existing `CsvTransferRule`, extended);
   - *split*: when a template with captures matches (for example
     `*KAPITAŁ: {capital} ODSETKI: {interest}*`), the row becomes a split
     whose lines take their amounts from the captures, each line either a
     category or a transfer to a named account.
5. **Nothing is written before the preview is accepted.** The preview lists
   every row with what the profile made of it (payee, description, transfer
   or split, duplicate or new, skipped by the cut-off) and what the
   transaction rules will do (rules phase 2, X4).

## 4. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| P1 | A split built from captured amounts sums to the row's amount, or the row is not imported | Server-side check with scaled integers in the split processor; the preview marks the row and names the difference; no rounding line is invented |
| P2 | A duplicate is never imported twice | The duplicate key (reference, else a hash of the profile's chosen fields) is stored on the row and checked inside the import transaction; the preview and the commit use the same key function |
| P3 | The preview shows what the commit will do | One parse and one mapping function for both; the commit re-parses the same text and refuses when the plan changed (the fingerprint pattern of the rules' manual run) |
| P4 | A row before the cut-off date is never written | The filter runs in the parser; the preview counts the rows it dropped |
| P5 | A transfer made by a profile rule obeys the transfer invariants | It goes through the existing import transfer processor (INV-TRANSFER-001, INV-BALANCE-001) |

## 5. Missing data

- A label named by the mapping is absent in a row: the field is empty, the
  preview says which label was missing, and the row still imports unless a
  structural rule needed it.
- A capture of a split template does not parse as an amount: the row is not
  imported and the preview names the capture and the text.
- The bank reference is absent: the hash key is used, and the preview says
  so.

## 6. Numerical example

Row: amount `-2345.67 PLN`, title `RATA KREDYTU KAPITAŁ: 1834,12 ODSETKI:
511,55`. Split template `*KAPITAŁ: {capital} ODSETKI: {interest}*`, lines:
`{capital}` as a transfer to "Kredyt hipoteczny", `{interest}` as category
"Odsetki". Captures parse with the profile's decimal separator (`,`) to
`1834.12` and `511.55`; scaled sum `18341200 + 5115500 = 23456700`, which
equals the scaled absolute amount, so P1 holds and the row imports as a
split with a transfer leg of `-1834.12` and an expense of `-511.55`. With
`ODSETKI: 511,50` the sum differs by `0.05`; the row is refused and the
preview says "0.05 PLN not assigned".

## 7. Test matrix

| Area | Cases |
|---|---|
| Decoding | WINDOWS-1250 Polish letters; a UTF-8 file declared as 1250 flagged; BOM handling |
| Parsing | positional plus labelled columns; a label missing; a label repeated; a value containing a colon |
| Mapping | each operation type to payee, description, reference; default mapping; fixed text |
| Duplicates | same reference twice in one file and across files; hash key; the key survives a transfer |
| Cut-off | rows before, on and after the date |
| Transfer rules | recognised by recipient name regardless of type; target account missing refused |
| Split rules | example of section 6 both ways; decimal separator; a capture that is not a number |
| Preview vs commit | identical plan; a changed file refused by the fingerprint |
| Compatibility | an existing saved mapping imports exactly as before |
| Integration | a PKO-shaped fixture (synthetic data only) end to end on real PostgreSQL |

## 8. Open questions

- **C1.** Should Monize ship a built-in PKO BP profile, or only let a user
  build one? This plan says only user profiles, with a documented example in
  `docs/`, because a bank changes its export without notice.
- **C2.** Where is the duplicate key stored: `reference_number` when the bank
  gives one, and a new nullable `import_key` column otherwise? This plan says
  a new column, so the user's own reference numbers stay untouched.
- **C3.** Are fixtures from a real statement acceptable in the repository?
  No: synthetic data only.
