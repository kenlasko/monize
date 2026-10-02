# Source profiles (CSV and bank sync)

Plan for one profile concept that tells Monize how a given bank writes its
rows, for both a CSV export and a bank sync provider, editable by the user
and shareable as a reviewed file. The task list is
[`source-profiles-tasks.md`](./source-profiles-tasks.md).

Status: **proposal**. It is not approved. The discussion that carries it must
get the `approved-to-build` label before any task starts (`CONTRIBUTING.md`).
It extends [`csv-source-profiles.md`](./csv-source-profiles.md) to bank sync
and relies on [`unified-import-preview.md`](./unified-import-preview.md) for
the preview; the three can be approved together.

## 1. Goal

- A bank's quirks are data, not code. PKO BP writes the operation type as the
  second remittance line and glues the town to the merchant name; another
  bank sends `bank_transaction_code` and a clean counterparty. A profile says
  which, and the code stays the same for every bank.
- The user sees a profile's effect on every row in the preview before
  anything is written, and can change the profile there.
- A profile that works for one person can be shared with everyone using the
  same bank, through a reviewed file in the repository, with no personal data
  in it.

## 2. What exists

- **Bank sync** (`docs/specs/bank-sync.md` 6, 7b): a provider adapter turns a
  wire row into a neutral `BankTransaction`; one built-in table maps
  operation codes to tags. It is PKO BP's table today, for every bank.
- **CSV** (`csv-source-profiles.md`): a saved column mapping, with a planned
  per-operation-type mapping, transfer rules and split rules.
- **Firefly III** keeps 108 community CSV configurations in
  `firefly-iii/import-configurations`, laid out as
  `<country>/<bank>/default.json` and contributed by pull request with the rule
  "make sure that the JSON file contains no private data" (CC BY-SA 4.0). It
  has no profile for an API source: its Enable Banking importer is generic.

## 3. The profile

```text
SourceProfile
  id, version, source: csv | enable_banking | ...
  institution  { country, name }               which bank it is for
  operation    where the operation type is: a remittance line, a column,
               bank_transaction_code, or none
  types[]      per operation type (an exact code or a prefix, ordered):
                 label        tag label key or text
                 payee        counterparty name | remittance line N |
                              column X, then cleanup steps (strip a town
                              prefix, strip a country suffix, trim)
                 description  which lines or columns, without the code line
                 structure    none | transfer to the account whose number
                              is in field F | split by captures (P5)
  default      the same block for rows no type matches
```

Cleanup steps are named, closed operations (no free code, no regular
expression run on the server from a shared file beyond a bounded pattern
type), so a shared profile cannot do more than change how a row is labelled
or structured.

## 4. Three levels

1. **Default profile**, for any bank: `bank_transaction_code` when present,
   the counterparty name, the remittance lines as the description.
2. **Built-in profiles**, files in the repository
   (`backend/src/bank-sync/profiles/<country>/<bank>.json` for API sources,
   the CSV equivalent beside the CSV profiles), chosen by the institution's
   country and name. Contributed by pull request and reviewed.
3. **User profile**, a per-user copy that overrides a built-in one, edited in
   the UI, exported and imported as JSON so it can be given to someone or
   proposed as a built-in.

## 5. Invariants

- **S1, a profile never changes the duplicate key.** The key is computed
  from the raw row (bank sync section 6; CSV P2). Editing a profile can change
  a row's label, payee, description or structure, never whether it is
  imported again.
- **S2, a shared profile carries no personal data.** The validator refuses a
  file with an account number, a card number, an amount, or a name that is
  not a merchant pattern; the review checks it again.
- **S3, preview equals commit.** The commit applies the same profile version
  the preview showed, and refuses when the profile changed in between (the
  profile version is part of the plan fingerprint).
- **S4, structure goes through the existing processors.** A transfer leg or a
  split is written by the transfer and split code that enforces
  INV-TRANSFER-001 and the split sum; a split that does not sum is refused,
  with the difference named.

## 6. Decisions for the maintainer

- **D1.** Where shared profiles live: in the Monize repository (reviewed with
  the code), or a separate repository like Firefly's.
- **D2.** Whether to convert Firefly's CC BY-SA CSV configurations into Monize
  CSV profiles (attribution and share-alike on the converted files; they would
  live apart from the AGPL code).
- **D3.** One profile engine for CSV and bank sync now, or bank sync first.
- **D4.** Whether a user profile may add structure (transfers, splits) or
  only labels and payees until the preview is shared (unified preview U3).

## 7. Rejected alternatives

- **Bank-specific code paths** (`if institution == "PKO BP"`). They do not
  scale to 2500 banks and nobody outside the code can fix one.
- **Transaction rules for all of it.** Rules cannot create a transfer or a
  split (INV-RULE-001) and run after the row is written; a profile decides the
  row's shape before it exists.
