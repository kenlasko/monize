# Advanced transaction search

Specification of the one transaction search string's small, documented
query syntax: field qualifiers, exact match, wildcards, quoted phrases,
negation, and amount and date comparisons, with no regular expressions.
Proposed in answer to Discussion #1723, which asked for a dedicated exact
"Ref #" filter because searching `#10` returned cheques 100, 101, 110 and
1010 and every amount or memo containing "10". It shipped on 2026-10-13 in
PRs #1729 to #1734, with the review fixes in #1736 and #1742 and the E2E and
release note in #1741; the decisions in section 3 were agreed in the planning
session of 2026-10-12 and section 13 records how each open question was
answered. The plan is retired and this document is kept as the specification
the code is held to.

**Answer to the Discussion:** `ref:=10`, or the shorthand `#10`, returns
cheque 10 and nothing else.

## 1. Goal

- A reader can find cheque 10 without wading through 100, 1010, a $10.00
  grocery run and a memo reading "Invoice 10".
- Narrowing works the way the reader already knows from Gmail and GitHub:
  `field:value`, quotes for a phrase, `-` to exclude. Nothing new to learn
  for the plain case: typing a single word keeps finding exactly what it
  finds today.
- One syntax, every surface that takes a search string, with no second
  implementation anywhere:
  - the top-bar search icon (it navigates to the Transactions page, route
    /transactions, with `?search=`);
  - the Transactions filter box;
  - bulk update's filter;
  - the summary, grouped-totals, tag-key-breakdown and monthly-totals
    endpoints;
  - the AI assistant and MCP `list_transactions` tools.
- The reader can see how their input was read, so a typo in a qualifier is
  visible instead of silently matching nothing.
- No regular expressions in this version. `*` is the only wildcard.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
| --- | --- | --- |
| The search predicate | `buildTransactionSearchClause` and `escapeLikePattern` in `backend/src/transactions/transaction-search.util.ts` | One `( ... OR ... )` of `ILIKE :search` over description, payee text, reference, split memo, the amount and split amount as text, payee name, transfer-counterpart account name, category and split category names, and transaction and split tag names. Exact `ABS(amount)` and date arms are OR-ed on when the term parses as one. Relational arms are `EXISTS`, so aggregates are not inflated. The whole input is one token. |
| Amount and date interpretation | `parseSearchTerm` in `backend/src/transactions/transaction-search-parse.util.ts` | Amounts follow the user's number format, with a lenient fallback to the other one; dates follow the user's `dateFormat` (ISO always accepted). Reused unchanged for bare terms and for `amount:` / `date:` values. |
| Loading the user's formats | `resolveSearchTerm` (private, in `backend/src/transactions/transactions.service.ts` and `backend/src/transactions/transaction-analytics.service.ts`) | Loads `numberFormat` and `dateFormat` from `UserPreference`. |
| Call sites of the predicate | `findAll` and `buildFilteredIdsSubquery` in `transactions.service.ts`; `createFilteredAnalyticsQuery` and `getLlmGroupedBreakdown` in `transaction-analytics.service.ts`; the filter builder in `backend/src/transactions/transaction-bulk-update.service.ts` | Five sites, each escaping, wrapping in `%...%`, resolving the term and binding three parameters by hand. They join splits under different aliases (`splits`, `bfSplits`, `ts`, `searchSplits`, `filterSplits`) and at two different grains (section 4.4). |
| The LLM totals path | `getLlmQueryTransactions` and `getLlmListTransactions` in `transaction-analytics.service.ts` | Both run `sanitizeLikePattern` (which escapes) and then hand the escaped term to `getSummary`, which escapes it again in `createFilteredAnalyticsQuery`. A term holding `%`, `_` or `\` is double-escaped there and single-escaped on the rows path, so the tool's totals can disagree with its own rows. Fixed by construction here (INV-SEARCH-001). |
| The `search` query param | `backend/src/transactions/transactions.controller.ts` | `GET /transactions` runs `assertStringParam` and slices to 200 characters. `/summary`, `/grouped-totals`, `/tag-key-breakdown` and `/monthly-totals` pass `search` through with neither check. |
| Bulk update's filter | `BulkUpdateFilterDto.search` in `backend/src/transactions/dto/bulk-update.dto.ts` | `@IsString @MaxLength(200)`. |
| Header search | `submitSearch` in `frontend/src/components/layout/AppHeader.tsx` | Trims, clears the stored filters, dispatches `HEADER_SEARCH_EVENT`, routes to the Transactions page with `?search=`. No suggestions or results dropdown. Untouched except for the help affordance. |
| Filter-box search | `frontend/src/components/transactions/TransactionFilterPanel.tsx` (the `Input` with `filter.placeholders.search`, and the gray search chip), `frontend/src/hooks/useTransactionFilters.ts` (300 ms debounce, URL and `transactions.filter.search` in localStorage) | The raw string is what is stored and sent; that stays true. |
| Client API | `frontend/src/lib/transactions.ts` (`TransactionsGetAllParams.search`, `getAll`) | Gains the response field of section 6. |
| Deep links into search | `frontend/src/components/reports/DuplicateTransactionReport.tsx`, `frontend/src/components/reports/SpendingAnomaliesReport.tsx` | Both link with a bare payee name, which today is a substring search and under this plan would become several AND-ed words (section 3, decision 2). |
| Tag `key:value` names | `frontend/src/lib/tag-key-value.ts`, `backend/src/tags/tag-key-value.util.ts` | Tags already use a first-colon `key:value` convention, and today a search for `country:usa` substring-matches tag names. Decision 5 keeps that working. |
| AI tool text | `searchText` in `backend/src/mcp/tools/transactions.tool.ts` and `backend/src/ai/query/tool-definitions.ts` | Described as "substring of a payee name or description". Both adapters change in one PR (`docs/backend/ai-and-payees.md`, "Shared AI tools"). |
| A help popover | `frontend/src/components/ui/InfoTooltip.tsx` (hover and tap help), `frontend/src/components/transactions/RecentTransactionsPopover.tsx` (a click-opened popover in the same folder) | The syntax help needs clickable examples, so it follows the click-opened popover, not the tooltip. |

## 3. Decisions

1. **One uniform rule for text fields.** `field:value` is contains,
   `field:=value` is exact, and a `*` in the value makes it an anchored
   wildcard (`ref:10*` starts with 10). Rejected: exact-by-default for
   identifier-like fields (`ref:10` exact), which saves a keystroke but gives
   every field its own rule to remember.
2. **Bare words are AND-ed; quotes make a phrase.** `costco gas` finds rows
   where both words match somewhere; `"costco gas"` is today's whole-string
   match. This changes what a multi-word search returns, and is why B2 is
   deploy class **change**. The two report deep links are moved to an exact
   payee qualifier in the same plan (F2). Rejected: keeping phrase
   matching, which makes "find the Costco gas fill-up from March" impossible
   to type.
3. **`#10` is shorthand for `ref:=10`.** It is what the Discussion's author
   typed, and what a cheque reads like.
4. **Amount and date are value fields, not text.** For them `:` already
   means "equals" (`:=` is accepted as the same), and the comparison
   operators `>`, `>=`, `<`, `<=` and the inclusive range `a..b` are added.
   Matching amount text by substring (`amount:10` finding 110.00) is what
   a bare term does today and stays available that way; it is never what a
   qualifier means.
5. **Only reserved field names are qualifiers.** Any other `word:value` is
   a plain term, so `country:usa` still finds the tag. `tag:country:usa`
   splits on the first colon only. Quoting escapes a reserved name:
   `"payee:x"` is the literal text.
6. **Malformed input degrades, it does not refuse.** A qualifier whose
   value cannot be read (`amount:>abc`, `date:31/31/2026`) becomes a bare
   term of its raw text, and the echo (section 6) marks it `malformed`.
   An empty qualifier (`ref:`) is dropped and marked `empty`. The only
   refusals are the existing 200-character cap and a new 12-term cap.
7. **The server parses; the client only displays.** The response carries
   how the server read the string (section 6), and the client renders that.
   Rejected: a second parser in the frontend, which would drift. The
   two-layer contract-spec pattern (`register-sort.contract.spec.ts`) would
   be needed to hold it, and nothing here needs client-side parsing.
8. **An amount comparison reads the transaction's total; equality also
   reads its splits.** `amount:=42.10` (like today's bare `42.10`) finds the
   figure on a statement even when it is one split line. `amount:>100` and
   `amount:50..100` compare the transaction's total, because a range asks
   how big the transaction was. Both compare magnitude, `ABS(...)`; the
   direction stays the job of the existing signed Amount filter and the
   Category filter's `income` / `expense` pseudo-ids.

## 4. Definitions

### 4.1 Grammar

Whitespace separates terms; terms are AND-ed.

```text
query     := ws* term (ws+ term)* ws*
term      := neg? (qualified | hashref | phrase | word)
neg       := "-"           only when followed by a letter, a quote, "#", or a field name;
                           "-" followed by a digit, "." or "," is part of a number word
qualified := field ":" ( "=" value | cmp value | range | value )
hashref   := "#" value     a "#" followed by whitespace or end of input is the word "#"
cmp       := ">" | ">=" | "<" | "<="              (amount and date only)
range     := value? ".." value?                    (amount and date only; one side may be open)
value     := phrase | word
phrase    := '"' ( char | '\"' | '\\' )* '"'      an unterminated quote runs to end of input
word      := run of non-whitespace characters
field     := payee | memo | desc | cat | category | tag | account | ref
           | amount | date | status | is | has     (case-insensitive)
```

Limits: the raw string is cut at 200 characters, as today. More than 12
terms is a 400 with `errors.transactions.searchTooManyTerms`.

### 4.2 Fields and what each one reads

The arms of today's `buildTransactionSearchClause` are partitioned among
the text fields, unchanged; a bare term still ORs all of them.

| Field | Kind | Reads |
| --- | --- | --- |
| `payee:` | text | `transactions.payee_name`; `payees.name` via `payee_id`; on a transfer leg, the counterpart account's name (the arm added for issue #1214) |
| `memo:`, alias `desc:` | text | `transactions.description`; `transaction_splits.memo` |
| `cat:`, alias `category:` | text | the category and split-category name arms, as today |
| `tag:` | text | transaction and split tag names, as today |
| `ref:` | text, plus the reference key of 4.3 for `:=` | `transactions.reference_number` |
| `account:` | text | the row's own account name. **New arm**: today only a transfer leg's counterpart account is searchable, and a bare term does not gain this arm (it would make an account-name search return the whole account, which is why #1214 restricted it) |
| `amount:` | number | magnitude; decision 8 |
| `date:` | date | `transactions.transaction_date` |
| `status:` | enum | `cleared`, `reconciled`, `unreconciled`, `void`, mapped to `transactions.status` |
| `is:` | enum | `transfer` (`is_transfer`), `split` (`is_split`), `uncategorized` (`uncategorizedSql`; the category filter's three inline copies are not yet folded onto it, see section 11), `provisional` (`amount_is_provisional`: an imported transfer leg whose amount is the importer's estimate, never the description text; `-is:provisional` is every other row; `docs/specs/provisional-amounts.md` decision 6) |
| `has:` | enum | `attachment` (`hasAttachmentSql`: at least one visible attachment of the row's own, or a document of any warranty linked to the row, archived or not, through `attachmentReachableFromTransactionSql` in `backend/src/attachments/attachment-parent.ts`, the same rows the register's `attachmentCount` counts; the `hasAttachments` filter's inline copies share the fragment and fold onto `hasAttachmentSql` later, section 11), `warranty` (`hasWarrantySql`: at least one unarchived warranty linked to the row, the same rows the register's `warrantyCount` counts), `ref` (non-blank reference), `memo` (non-blank description or any non-blank split memo), `tag` (any transaction or split tag) |

An unknown enum value (`status:pending`) is `malformed` (decision 6).

### 4.3 Operators on text fields

| Op | Written | SQL, per arm |
| --- | --- | --- |
| contains | `field:v` | `col ILIKE` the pattern `%v%`, with `v` escaped |
| exact | `field:=v` | `col ILIKE escaped(btrim(v))` with `btrim` on the column, so case and surrounding spaces are ignored |
| glob | `field:v*`, `field:*v`, `field:a*b` | `ILIKE` of `escaped(v)` with each `*` turned into `%`, anchored at both ends |

Escaping is `escapeLikePattern`, applied once, inside the builder, and
nowhere else on this path.

**The reference key.** For `ref:=v` and `#v` both sides are compared
through one expression and its TypeScript twin, `referenceKey`:

- trim the value and lower-case it;
- strip one leading `#`;
- if what remains is all digits, strip leading zeros, keeping a single `0`.

So `#10` matches `10`, `#10`, `0010` and `00010`, and not `100` or `A10`
(open question 1).

### 4.4 Grain

The builder supports two grains, and a term is evaluated against the row
the query counts:

- **Split grain**, used by every call site (question 5): the query joins
  its splits, and a split arm reads the row's own split, as the joined-alias
  clause always has. Every term must hold on the same line, so the register
  draws only matching lines with a filtered total, bulk update selects the
  transactions the register lists, and a category breakdown of `groceries` counts the
  groceries line and not its sibling. `findAll`, `buildFilteredIdsSubquery`,
  `createFilteredAnalyticsQuery`, the bulk-update filter and
  `getLlmGroupedBreakdown`.
- **Transaction grain**, available but unused: a split arm is
  `EXISTS (SELECT 1 FROM transaction_splits ... WHERE ... = t.id AND ...)`,
  so two terms can be satisfied by different splits and `-term` excludes the
  transaction if any split matches. Kept for a future surface that lists
  whole transactions without hydrating lines; the builder's specs pin it.

The builder takes the grain as an argument, and correlates every split
condition through one subquery (`search_sx.transaction_id = t.id` at
transaction grain, `search_sx.id = <split alias>.id` at split grain), so
split fields never depend on how a call site joined its splits.

**Finding recorded during B2 (2026-10-12): the register's joined-alias
filter is deliberate, not a defect.** `findAll` filters on the `splits`
alias it also hydrates from, so a filtered split transaction is drawn with
only its matching lines; `applyCategoryFilters` documents this as the
mechanism by which the frontend detects a partial amount and shows a
filtered total. Today's search inherits the same behaviour: a split-memo
search draws only the matching line. Which grain the register's search
uses was open question 5, decided for split grain before B3.

## 5. Invariants

| ID | Statement | Mechanism |
| --- | --- | --- |
| INV-SEARCH-001 | Every surface that takes a search string reads it through one parser and one clause builder, and escapes it exactly once. | `applyTransactionSearch` is the only caller of the builder. A source-scanning guard fails any import of the builder, or of `parseTransactionSearch`, outside the util and the helper, and fails a `%${` template next to a `search` identifier in `backend/src/transactions/`. `escapeLikePattern` stays a shared helper (email receipts and the tag-key filter use it), so the guard does not ban it. |
| INV-SEARCH-002 | A single bare term with no operator characters matches exactly the rows it matches today, on every surface. | The truth-table integration spec, whose expected sets are hand-derived from the fixture, plus a parity case per call site. |
| INV-SEARCH-003 | A term is evaluated against the row the query counts (section 4.4); at transaction grain, terms are independent and negation is per transaction. | The builder's `grain` argument and the integration cases in section 10. |
| INV-SEARCH-004 | Search never inflates an aggregate. | Every relational arm is `EXISTS`, as today. Integration case: a summary total with a three-split match equals the unsearched total of that one transaction. |
| INV-SEARCH-005 | The LLM tools' totals and rows agree for any search string, including `%`, `_` and `\`. | INV-SEARCH-001 removes `sanitizeLikePattern`. Integration case: `list_transactions` with `searchText: "50%"` returns a total equal to the sum of its rows. |

They are added to `docs/system-invariants.md` under a new "Search" heading
in B2, each `enforced` by the mechanism above.

## 6. Data contracts

**Backend, internal.**

```ts
// transaction-search-query.util.ts
type SearchField = "payee" | "memo" | "cat" | "tag" | "account" | "ref"
                 | "amount" | "date" | "status" | "is" | "has";
type SearchOp = "contains" | "exact" | "glob"
              | "eq" | "gt" | "gte" | "lt" | "lte" | "between";
interface SearchTerm {
  field: SearchField | "any";        // "any" is a bare word or phrase
  op: SearchOp;
  value: string;                     // unescaped; amount and date values normalised (section 7)
  valueTo?: string;                  // "between" only; an open range is gte or lte
  negated: boolean;
  raw: string;                       // the term as typed, for the echo
  ignored?: "malformed" | "empty";
  interpreted?: {                    // "any" only: the bare term read as an amount
    amount: number | null;           // and a date (parseSearchTerm); builder-internal,
    date: string | null;             // never echoed
  };
}
interface ParsedSearch { terms: SearchTerm[] }
function parseTransactionSearch(raw: string, formats: SearchFormats): ParsedSearch;
```

`applyTransactionSearch(qb, raw, { userId, aliases, grain, paramPrefix })`
loads the formats, parses, enforces the caps, appends one `andWhere` of
AND-ed bracketed terms with parameters named `${paramPrefix}${i}...`, and
returns the `ParsedSearch` for the echo.

**Wire, `GET /transactions` only.** A new optional field on the paginated
response, present exactly when a non-blank `search` was sent and the
service built the page (a delegate with no visible accounts gets the
controller's empty page, with no echo):

```ts
searchInterpretation?: {
  terms: Array<{
    field: SearchField | "any";
    op: SearchOp;
    value: string;
    valueTo?: string;
    negated: boolean;
    raw: string;
    ignored?: "malformed" | "empty";
  }>;
}
```

A dropped `empty` term is still echoed. The other search-taking endpoints
keep their response shapes. The AI tools do not surface the echo; their
description teaches the syntax instead.

## 7. Value fields

**Amount.** A value is read by the amount half of `parseSearchTerm`, so
`1,234.50` and `1.234,50` follow the user's number format as a bare term
does today. A bare `amount:v` or `amount:=v` is equality (decision 8). The
operators and both ends of a range are compared against
`ABS(transactions.amount)`.

**Date.** A value is either the user's full date in their format, or ISO at
day, month (`2026-03`) or year (`2026`) precision. A partial ISO value
names a period, `[start, end]`:

| Written | Means |
| --- | --- |
| `date:2026-03` | `2026-03-01` to `2026-03-31` |
| `date:>=2026-03` | on or after `2026-03-01` |
| `date:>2026-03` | after `2026-03-31` |
| `date:<2026-03` | before `2026-03-01` |
| `date:<=2026-03` | on or before `2026-03-31` |
| `date:2026-01..2026-03` | `2026-01-01` to `2026-03-31` |
| `date:2026..` | on or after `2026-01-01` |

A partial value in the user's own format is not accepted. `03/2026` is
ambiguous across the formats the app offers; it is `malformed`.

## 8. Truth tables

**References.** The fixture is one account holding these six rows:

| Row | `reference_number` | Amount | Memo |
| --- | --- | --- | --- |
| A | `10` | -50.00 | |
| B | `100` | -75.00 | |
| C | `0010` | -20.00 | |
| D | `A10` | -30.00 | |
| E | null | -10.00 | |
| F | null | -40.00 | `Invoice 10` |

| Query | Rows matched |
| --- | --- |
| `10` | A, B, C, D, E, F (today's behaviour) |
| `ref:10` | A, B, C, D |
| `ref:=10` | A, C |
| `#10` | A, C |
| `ref:10*` | A, B |
| `has:ref -ref:=10` | B, D |
| `amount:=10` | E |
| `memo:10` | F |
| `ref:` | all six (dropped; echoed `empty`) |

**Words and splits.** The fixture is a split transaction S with payee
`Costco`, a split for 80.00 under category `Groceries` and a split for
20.00 under category `Gas` (total 100.00, no description), plus a plain
transaction P with payee `Costco Gas Bar`, category `Gas` and amount 60.00.
All amounts are expenses.

| Query | Transaction grain | Split grain (breakdown rows) |
| --- | --- | --- |
| `costco gas` | S, P | S/Gas, P |
| `"costco gas"` | P | P |
| `cat:groceries cat:gas` | S | none (no single line is both) |
| `costco -cat:gas` | none (S has a Gas line; P's category is Gas) | S/Groceries |
| `amount:>90` | S (total 100.00) | S/Groceries, S/Gas (total 100.00) |
| `amount:=20` | S (a split line) | S/Gas |

## 9. Frontend

- **Syntax help.** A new `SearchSyntaxHelp.tsx` in
  `frontend/src/components/transactions/` is a `?` button that opens a
  click-opened popover beside the input. It holds a short table of the
  syntax, and each example is a button that writes the example into the
  input. It is mounted beside the filter box and beside the header search
  input.
- **Placeholder.** `filter.placeholders.search` gains a hint, "try ref:=10
  or payee:costco".
- **Interpretation line.** A new `SearchInterpretationLine.tsx` sits under the
  filter box and renders `searchInterpretation` as translated phrases, for
  example "Reference is 10 · not Category contains transfer". An ignored
  term is shown struck through with its reason. It renders nothing when the
  field is absent, which covers an older backend during a rolling deploy.
- **The search chip** keeps the raw string.
- **Deep links.** A new `frontend/src/lib/search-query.ts` exports
  `quoteSearchValue(field, value)`, which returns `payee:="..."`, escaping
  `"` and `\`. The two reports use it.
- **Unchanged:** storage, URL, debounce and the header event all carry the
  raw string exactly as today.

All strings are English-first plus the pseudo-locale; translations are
task Q.

## 10. Test matrix

| Layer | Spec | Cases |
| --- | --- | --- |
| Parser | `backend/src/transactions/transaction-search-query.util.spec.ts` | Every row of section 4.1: whitespace runs; quotes, escapes and an unterminated quote; `-word` against `-10` and `-.5`; `#10`, a lone `#` and `-#10`; each field and alias, in mixed case; an unknown `x:y`; `tag:k:v`; `:=`, `*` and comparisons on text (malformed); ranges with open ends; every date form of section 7; amounts in both number formats; empty and malformed values; 12 and 13 terms; the 200-character cut. |
| Builder | `backend/src/transactions/transaction-search.util.spec.ts` (extended) | The SQL shape per op and grain; parameter names unique across two calls with different prefixes; no `%` escaping outside `escapeLikePattern`; `referenceKey` against the reference-key SQL on the section 8 values. |
| Integration | `backend/test/integration/transaction-search.integration.spec.ts` (real PostgreSQL) | Both truth tables of section 8 through `findAll`, at transaction grain, and through `getLlmGroupedBreakdown`, at split grain; INV-SEARCH-002 parity per call site; the INV-SEARCH-004 and INV-SEARCH-005 cases; LIKE metacharacters `ref:50%`, `memo:a_b` and `\`. |
| Guard | `backend/src/transactions/transaction-search.guard.spec.ts` | INV-SEARCH-001. |
| Controller | `transactions.controller.spec.ts` (extended) | The four endpoints that skipped it now reject a non-string `search` and cut at 200; `searchInterpretation` is present exactly when a search was sent. |
| Frontend | `SearchSyntaxHelp.test.tsx`, `SearchInterpretationLine.test.tsx`, `search-query.test.ts` | An example writes into the input; each op and an ignored term render; nothing renders with the field absent; quoting and escaping. |
| E2E | `e2e/tests/transaction-search.spec.ts` | Seed cheques 10, 100 and 1010; type `#10`; exactly one row; the interpretation line reads "Reference is 10". |

## 11. Scope cuts

- Regular expressions.
- `OR` and parentheses. Terms are AND-only; `OR` typed as a word is a plain
  term.
- Keyword autocomplete inside the input.
- Saved and named searches.
- A form-based advanced-search builder. If built later, it emits this
  syntax.
- A trigram index on `reference_number` or `transaction_splits.memo`. Add
  one only if `EXPLAIN` on a realistic account shows a regression.
- Searching scheduled transactions, payees or the investment register.
- Folding the category filter's three inline `uncategorized` predicates
  (`transactions.service.ts`, `transaction-analytics.service.ts`,
  `transaction-bulk-update.service.ts`) and the inline attachment-presence
  predicates onto `uncategorizedSql` / `hasAttachmentSql`. The search uses
  the helpers; moving the filters is its own change. The bulk-update copy
  has no split-line arm, so there `is:uncategorized` and the uncategorized
  category filter can select different rows until it is folded.
- Bulk update's tag filter joins its own `tagSplits` alias while its search
  reads `searchSplits` / `filterSplits`, so a tag and a search term can hold
  on different lines of a split that the register (one `splits` alias) would
  not list. This predates the syntax; aligning the aliases is its own change.
- Narrowing a bulk category change to the lines the search matched, as the
  register draws them. Today `resolveCategoryRestriction` reads only the
  category filter, as it did before the syntax.

## 12. Deploy and compatibility

- No migration.
- B2 changes what a multi-word search returns (decision 2). Its PR body says
  so, and the release note for that version names it.
- A stored or bookmarked search keeps working: a single word reads as
  before, and a multi-word phrase now narrows to rows holding every word.
- The frontend reads `searchInterpretation` as optional, so mixed versions
  during a rolling deploy render correctly.

## 13. Open questions (recorded with the default)

1. Ignore leading zeros and one leading `#` on an exact reference
   (section 4.3)? **Default: yes.** A bank import often pads cheque numbers.
   *Built as the default (B2, `referenceKey` and its SQL twin, #1730).*
2. Include `account:` in v1? **Default: yes**, as the row's own account
   name, without adding that arm to a bare term. *Built as the default (B2,
   #1730).*
3. Is the term cap 12? **Default: 12.** *Built as the default (B1,
   `MAX_SEARCH_TERMS`, #1729).*
4. Should an amount comparison read the total only (decision 8), or also
   the splits? **Default: total only.** *Built as the default (B2, #1730):
   equality reads the splits too, a comparison reads the total.*
5. Does the register's search (`findAll` and `buildFilteredIdsSubquery`,
   which must agree) run at transaction grain, listing whole transactions
   with every split drawn, or at split grain, keeping today's partial-line
   hydration and filtered totals the category filter also uses? Split grain
   changes the second truth table's transaction column to its split column
   for the register. **Decided 2026-10-12: split grain.** The register
   keeps drawing only matching lines with a filtered total, as its category
   filter does, and bulk update selects the transactions the register lists
   (a category change still rewrites the lines the category filter picks,
   not the lines the search matched, as before the syntax); every term
   of a search must hold on the same line.

## 14. Follow-ups

None.
