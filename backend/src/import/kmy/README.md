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

## Memory and time

What one file may cost is bounded while it is read (`reader/kmy-limits.ts`, spec 4.2): the document at
`KMY_MAX_XML_BYTES` (100 MiB inflated), the records kept at `KMY_MAX_RECORDS` (600,000), elements at
`KMY_MAX_ELEMENTS` (2,000,000), splits per transaction and one attribute's length. Each is checked as
the bytes arrive, so a hostile file is refused at the first chunk past a bound, and neither the inflated
document nor a filtered copy is ever held whole. The reader yields to the event loop every 256 KiB and
the mapper every 20 ms (`map/kmy-steps.ts`), in the preview request and the job alike.

Measured with `parseKmyBytes` under `ts-node` on Node 24, one fresh process each, peak resident set
against the process before the parse (about 345 MB), longest event-loop stall sampled every 5 ms:

| Input | Before (synchronous, whole-buffer) | After |
|---|---|---|
| 50,000 transactions, two splits each (23.9 MB XML, 0.6 MB gzip) | 3.8 s, stall 3.8 s, +211 MB | 1.9 s, stall 117 ms, +132 MB |
| 199,000 transactions (37.1 MB XML, 0.6 MB gzip): just under the record bound | not measured | 4.9 s, stall 260 ms, +467 MB |
| 300,000 transactions (0.9 MB gzip) | not measured | refused `kmyTooManyRecords` after 2.8 s, stall 31 ms, +230 MB |
| the review's 2.45 million one-split transactions on an undeclared account (278 MiB XML, 967 KiB gzip) | 36.4 s, stall 36.4 s, +2,945 MB, then refused | refused `kmyCorruptFile` at the first split, 10 ms |
| the same with the account declared (2 million transactions, 5.9 MB gzip) | not measured | refused `kmyTooManyRecords` after 2.8 s, stall 23 ms, +233 MB |
| 3 million empty elements (57 KiB gzip) | not measured | refused `kmyTooManyRecords` after 1.7 s, stall 41 ms, +1 MB |
| 300 MiB of spaces inside the root (299 KiB gzip) | not measured | refused `kmyXmlTooLarge` at 100 MiB, 1.5 s, +68 MB |

**The bound that remains:** a file inside every bound costs at most about 470 MB above the process's
own memory and about 5 seconds of CPU to read and map, with the event loop never held for more than a
few hundred milliseconds; the commit's writers add their own working set on top. That is within the
helm sizing rule for Money imports at its defaults (`2 x MNY_IMPORT_LIMIT_MB + 200Mi`), but a pod sized
below it can still be exhausted by one such file, and nothing rate-limits uploads beyond the one active
import per user. A real file with payees, tags, prices and longer memos sits nearer the record bound for
the same number of transactions than these two-split files do.

Payee aliases: the writer inserts each alias through a savepoint (`insertPayeeAliasIgnoringDuplicate`), so
its cost is a few round trips per alias. Measured against PostgreSQL 18 in a local container, 2,000 payees
with one alias each took about 6.5 seconds for the aliases when all were plain names and about 8.3 seconds
when all were wildcards (the collision checks are then O(w x n), and about 2,000 overlap notes are
produced), on top of about 2.6 seconds for creating the payees themselves.
