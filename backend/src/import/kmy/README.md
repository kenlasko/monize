# KMyMoney (`.kmy`, `.xml`) import

Native TypeScript pipeline for importing a KMyMoney file. Design, mapping rules and test matrix:
`docs/specs/kmymoney-import.md`; the format reference the rules cite is `docs/kmymoney-data-model.md`.
The user guide is `website/docs/importing-from-kmymoney.md`.

```
.kmy/.xml upload -> reader/ (container sniff, bounded gunzip, byte filter, tokenizer, raw model)
  -> map/ (pure functions: raw model -> shared Mapped* model, file-computed expectations, warnings)
  -> the shared Money pipeline (staging, job, writers, post-processing) -> verification report
```

## Layering

- `reader/` turns bytes into the typed raw model (exact BigInt rationals, numbered handles).
  `map/` turns the raw model into the `Mapped*` model `backend/src/import/mny/model/mny-import-model.ts`
  defines. `model/` holds the raw types, the rational type and the typed errors.
- The `Mny*` names, tables, routes and i18n namespaces are shared and stay as they are; this directory
  only replaces the parser. Where shared code needed to know the format, the change is an optional field
  or a defaulted parameter (spec 4.9), so the Money path is unchanged.

## Rules carried from the Money README (spec 4.1)

- Mappers never touch the database; the writer never parses.
- Every failure is a typed error with a stable code (`KmyImportError`, a subclass of `MnyImportError`).
  An untyped error escaping the reader or mapper is a defect: a 500, and a retryable job over a file
  that can never import.
- Synthesized rows get payees or descriptions.
- The same movement recorded twice must sum correctly, so specs assert row counts as well as balances.

## Traps

- **Dispatch elements by path, never by name.** `ACCOUNT`, `PAYEE` and `TAG` recur inside `REPORT` and
  `BUDGET` with other meanings.
- **Ordinals are counted before filtering.** A handle is the 1-based position among the elements of
  its section in document order; the five standard accounts keep a number though they never import.
  The preview's parse and the job's parse must give the same element the same number.
- **A row's amount is the split's `shares`, not its `value`.** `shares` is in the split account's
  currency and is what balances sum; `value` is in the transaction commodity and only converts legs.
- **Never `Number(num) / Number(den)`.** Rationals are summed exactly and become a `number` once, at
  the edge, through a decimal string rounded at the column's precision.
- **The brokerage cash account is found by KVP, then by a localized name suffix.** The suffix list
  (`KMY_BROKERAGE_SUFFIXES`) is a constant with its provenance commit.
- **Stock splits are applied, unlike Money.** A KMyMoney split is the share movement itself, so it
  becomes a SPLIT row with the multiplier as its quantity. Money's `SEC_SPLIT` rows are quote-feed metadata.
- **Verification is computed from the raw model**, never from mapped rows and never through the mapper's
  amount logic (`kmy-file-expectations.ts`, its imports held by `kmy-file-expectations.guard.spec.ts`);
  that independence is what makes a mapping defect visible. Balances are held to the account's own
  places (a coin's eighth), share counts to KMyMoney's replay, and each trade's total net of commission
  to the file's stock value. **Cost basis is not verified**: the file stores none, and the amount invested
  is not a basis once a sale removes basis at average cost (spec 6.1).
- **Payee matching: regex keys are searched, aliases are whole-text globs.** A KMyMoney key is a PCRE2
  pattern found anywhere in an imported payee text; a Monize alias is a glob over the whole text,
  case-insensitive, with `*` the only metacharacter (`matchesAliasPattern`). `kmy-payee-match.ts` translates
  a key only when the two agree on every text: the subset grammar (`^`, `$`, plain and backslash-escaped
  characters, `.*`, `.*?`), then checks 1 to 9 of spec 5.5.1. The key is tokenized by hand and never
  compiled: no `RegExp` is built from file text. Anything else is named in `payeeMatchKeyNotImported`
  with the payee and the key, never approximated. Collisions between payees use
  `payee-alias-collision.ts`, which the mapper and the writer share, over `aliasesConflict` and
  `aliasesCanOverlap` (`backend/src/payees/alias-overlap.util.ts`, the same refusal `PayeesService.createAlias`
  applies).
- **The payee writer runs after the rule pass.** `writePayeeExtras` is called right after `applyImportRules`
  in `writeAll`'s one transaction, so a rule's `set_payee_from_text` cannot see this import's aliases and
  the rows keep the payee KMyMoney assigned (`kmy-import-payee-rules.integration.spec.ts`, with its
  control). It only fills empty fields of an existing payee (`payeeDetailsKept`), and issues no query for a
  payee list without a new field, which is every Money file.
- **No prettier on this directory.** It is not prettier-formatted; use eslint only.

## Memory

Measured on a 50,000-transaction file built with the XML builders (two accounts, two splits per
transaction; 22.8 MB of XML, 0.6 MB gzipped), parsed by `parseKmyBytes` under `ts-node` on Node 24:
about 4 seconds, and peak resident set 560 MB against 345 MB for the same process before the parse, so
roughly 215 MB for the reader and mapper. The inflated XML is held once as a string (the 4.2 bound is the
upload limit) and the raw model and mapped rows are the rest; the writers add the commit's own
working set on top of that. A real file with payees, tags, prices and longer memos will sit above the
figure; it is a floor for sizing, not a ceiling.

Payee aliases: the writer inserts each alias through a savepoint (`insertPayeeAliasIgnoringDuplicate`), so
its cost is a few round trips per alias. Measured against PostgreSQL 18 in a local container, 2,000 payees
with one alias each took about 6.5 seconds for the aliases when all were plain names and about 8.3 seconds
when all were wildcards (the collision checks are then O(w x n), and about 2,000 overlap notes are
produced), on top of about 2.6 seconds for creating the payees themselves.
