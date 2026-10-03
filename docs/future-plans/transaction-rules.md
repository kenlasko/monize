# Transaction rules

Design for user-defined transaction rules: a rule has a trigger, a condition
tree and an ordered list of actions (WHEN / IF / THEN). A rule changes how a
new transaction is labelled (tags, category, payee). A rule never moves money.
(Superseded in part by [`docs/specs/transaction-rules-structural-actions.md`](../specs/transaction-rules-structural-actions.md): structural actions now add a counterpart leg or split lines that move a balance in another account.)
This is the design half of a two-document plan; the task list is
[`transaction-rules-tasks.md`](./transaction-rules-tasks.md).

Status: **proposal**. It is not approved. The discussion that carries this
proposal must get the `approved-to-build` label before any task in the task
list starts (`CONTRIBUTING.md`). Sections 5 to 9 are the specification that
`docs/financial-calculation-contract.md` section 9 asks for, because a rule
writes to the ledger (it does not change amounts, but it changes what a report
counts in a category).

## 1. Goal

- **A user creates rules in the Tools menu.** A new entry "Rules" in the Tools
  menu opens a list of rules. The editor follows the Home Assistant
  automation editor: three sections (When, If, Then), each a list of cards.
- **A rule applies automatically** when a transaction is created: by hand, by a
  scheduled posting, by an import, by the AI assistant or by an MCP client.
- **A rule can run on existing transactions.** The user selects "Run on
  existing transactions", sees a preview of every change, and confirms. The
  change is recorded in action history and can be undone.
- **The user rarely types an expression.** The visual editor is the primary
  mode. It uses the pickers Monize already has (accounts, payees, categories,
  tags, amounts, dates), so the user never sees an id.
- **The same engine serves the AI assistant and MCP.** A model can list, draft,
  test and save rules through the same action path the other writes use, and a
  human confirms every save.

Out of scope for this plan: reading or parsing email (a later plan, which
produces AI review requests through section 6.5); report definitions and alerts (a separate plan,
which can reuse the condition model from section 5); rules that change amount,
account, date or status; rules that run on a schedule; sharing rules between
users.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
|---|---|---|
| The core create path | `TransactionsService.create` (`backend/src/transactions/transactions.service.ts`) | One `withScopedDb` block saves the row, the splits, the tags and the balance. REST, joint register, scheduled posting, AI actions and MCP all reach it. |
| The preview of a create | `TransactionsService.previewCreate` (same file) | AI and MCP confirmation cards show it. A rule must show in the preview (section 7, I3). |
| Transfers | `TransactionTransferService.writeTransferLegs` (`backend/src/transactions/transaction-transfer.service.ts`) and `TransactionsService.completeTransfer` | Tags are set in `completeTransfer`, after the legs commit. Section 6.3 moves the rule step into the leg transaction. |
| QIF / OFX / CSV import | `ImportService.importParsedTransactions` (`backend/src/import/import.service.ts`), `ImportRegularProcessorService.processTransaction` (`backend/src/import/import-regular-processor.service.ts`) | One transaction per file, one savepoint per row. The processor writes rows directly, not through `create()`. |
| MNY import | `MnyImportService.writeAll` (`backend/src/import/mny/mny-import.service.ts`), `writeTransactions` (`backend/src/import/mny/writers/write-transactions.ts`) | Bulk insert in one transaction. |
| Tags | `TagsService.setTransactionTags` / `setTransactionTagsBulk` (`backend/src/tags/tags.service.ts`) | These replace the whole set. There is no additive operation; section 6.2 adds one. |
| The closest existing rule | `payees.default_category_id`, applied in `create()` and in the import processor | Section 6.4 fixes the order between it and a rule. |
| Safe text matching | `matchesAliasPattern` (`backend/src/payees/alias-match.util.ts`) | Glob matching without regex. The `matches` operator reuses it. |
| Signed write actions | `AiActionType` and the descriptors (`backend/src/ai/actions/ai-action.types.ts`), `AiActionBuilderService` (`backend/src/ai/actions/ai-action-builder.service.ts`), `AiActionsService.confirm` / `execute` (`backend/src/ai/actions/ai-actions.service.ts`) | The AI assistant and the MCP relay card use them. Rule CRUD becomes new action types here. |
| MCP write confirmation | `confirmWrite` (`backend/src/mcp/mcp-confirm.ts`), `emitRelayCard` (`backend/src/mcp/mcp-relay-confirm.ts`), `McpWriteLimiter` (`backend/src/mcp/mcp-write-limiter.ts`) | Required for a new write tool (`docs/backend/mcp.md`). |
| Undo | `ActionHistoryService.record` (`backend/src/action-history/action-history.service.ts`) | A manual run records one bulk entry, so undo reverts it. |
| Reconciled lock | `assertReconciledRowsMutable` (`backend/src/transactions/reconciled-lock.util.ts`) | A manual run skips a locked row and reports it (INV-RECONCILE-001). |
| Tools menu | `TOOLS_LINKS` and `NAV_ICONS` (`frontend/src/lib/nav-links.ts`), `AppHeader` (`frontend/src/components/layout/AppHeader.tsx`), `MobileNavDrawer` (`frontend/src/components/layout/MobileNavDrawer.tsx`) | A delegate sees only the tools in `toolsCapabilityByHref`, so "Rules" is hidden from a delegate by default. |
| UI parts | `Card`, `Modal`, `Select`, `Combobox`, `MultiSelect`, `ToggleSwitch`, `ActionMenu`, `EmptyState`, `Badge`, `CurrencyInput`, `DateInput` (`frontend/src/components/ui/`) | The editor is built from these (`frontend/CLAUDE.md`). |

## 3. Product decisions

1. **Visual first, Home Assistant layout.** The editor has three sections:
   - **When** (trigger): one or more of "a transaction is created",
     "a transaction is imported". A manual run is an action on the rule, not a
     trigger.
   - **If** (conditions): a tree of AND / OR groups. Each leaf is a card with
     three controls: field, operator, value. The value control is the existing
     picker for that field.
   - **Then** (actions): an ordered list of action cards.
   Each card has an `ActionMenu` with: duplicate, disable, move up, move down,
   delete. The Home Assistant layout fits better than an n8n canvas, because a
   rule has no branches and no data flow between steps. From n8n we take two
   ideas: the "test step" button (the preview in section 3.6) and field
   insertion by selection, not by typing.
2. **The stored form is a JSON condition tree, not text.** The server validates
   the tree and evaluates it. The visual editor edits the tree directly. So the
   visual mode and the text mode (section 3.7) can never mean two different
   things.
3. **A rule fills, it does not overwrite, by default.** `set_category` and
   `set_payee` have `onlyIfEmpty: true` by default. The user can clear the flag
   per action. `add_tags` adds, `remove_tags` removes; neither replaces the set.
4. **Rules run in a fixed order.** The list page orders rules by `position`. The
   user drags a rule to change it. A rule can set `stopProcessing`: rules after
   it do not run for that transaction.
5. **One run per transaction per trigger.** An action does not start the rules
   again. A later rule sees the values that earlier rules set (sequential, like
   Home Assistant), and never a second pass.
6. **Test before save.** The editor has a "Test" panel. It evaluates the draft
   rule against the latest N transactions (default 200, filterable by account
   and date range) and shows a table: transaction, matched yes/no, and the
   changes the actions would make. The test writes nothing.
7. **Expression mode is a CEL-syntax view of the same tree, built with no
   dependency.** The repo owner decided against a CEL library and an editor
   library (the candidates were `@bufbuild/cel`, `@marcbachmann/cel-js`,
   `react-querybuilder` and CodeMirror 6; Monaco was excluded for bundle size and
   its workers under the CSP). The stored form stays the JSON tree and the
   backend is unchanged. `frontend/src/lib/rule-cel/` prints the tree as text and
   parses text back with a hand-written recursive-descent parser (no `eval`, no
   `new Function`), and accepts only the subset that maps one to one onto the tree
   (the operators in section 5.2).
   - **Text of a rule.** A field is `transaction.<field>`. Comparisons are `==`,
     `!=`, `<`, `<=`, `>`, `>=`; `in` takes a list and `!(x in [...])` is "is none
     of". Methods: `contains`, `startsWith`, `matchesGlob` (a glob with `*`, never
     a regular expression), `between(a, b)`, `inSubtree`, `hasAny`, `hasAll`,
     `hasNone`. `isEmpty(x)` is the empty test. Groups are `&&` (all) and `||`
     (any) with CEL precedence, `!( ... )` for not, and parentheses. A group inside
     another is always printed in parentheses, so `a && b && c` (one group) and
     `a && (b && c)` (a group in a group) stay different rules. A group of one is
     `all(x)` / `any(x)`, an empty one `true` / `false`. A value not chosen yet
     prints as `_`, so a half-built rule can be shown and edited.
   - **Names, not ids.** Items are written `account("Name")`, `payee("Name")`,
     `category("Parent: Child")` and `tag("Name")`. A name that two items share
     takes its number among them, ordered by id: `payee("Amazon", 2)`. An item that
     no longer exists prints as `missing("<id>")`, the only place an id appears,
     so opening a rule never loses a reference.
   - **Refusals.** Text outside the subset is refused with the position (line and
     column) and a translated message that names the part: an unknown field or
     function, an operator the field does not allow, a value of the wrong kind, an
     unknown or ambiguous name, a text over 20000 characters, and the depth, leaf
     and node limits of section 5. While the text does not parse, Save, the test
     panel and the switch back to Visual are disabled, and the tree keeps the last
     text that did parse.
   - **Round trip.** `parse(print(tree))` equals the tree for every tree the visual
     editor can build; `roundtrip.test.ts` checks a table and several hundred
     generated trees.
   - **Autocomplete** is a suggestion list under the text box (no library),
     chosen by caret context: fields after `transaction.`, the methods and
     operators the field allows, enum values, and entity names inside
     `account("`, `payee("`, `category("` and `tag("`. It inserts the name form,
     never an id.
8. **Rules are per user.** A rule belongs to the owner of the rows it changes.
   A transaction a delegate or a joint-account partner creates on the owner's
   account runs the owner's rules, because `create()` runs as the owner
   (`JointRegisterService.create` uses `withSystemContext` and passes the
   owner id). A delegate does not see the Rules page in this plan.

## 4. Data model

Two tables, both with `user_id` and an RLS policy
(`docs/row-level-security-contract.md`), one migration plus `database/schema.sql`
in the same commit (`database/CLAUDE.md`):

```
transaction_rules
  id uuid pk
  user_id uuid not null -> users
  name varchar(100) not null
  enabled boolean not null default true
  position integer not null            -- order, unique per user (deferrable)
  triggers text[] not null             -- subset of {'create','import'}
  condition jsonb not null             -- section 5, validated on write
  actions jsonb not null               -- section 6, validated on write
  stop_processing boolean not null default false
  revision integer not null default 1  -- CAS on update
  created_at, updated_at

transaction_rule_applications          -- the "trace", like Home Assistant traces
  id uuid pk
  user_id uuid not null
  rule_id uuid not null -> transaction_rules on delete cascade
  transaction_id uuid not null -> transactions on delete cascade
  source varchar(20) not null          -- 'create' | 'import' | 'manual'
  changes jsonb not null               -- before/after per field
  applied_at timestamptz not null
```

- `condition` and `actions` are bounded: at most 50 condition leaves, depth at
  most 4, at most 10 actions, at most 200 rules per user. The DTO holds these
  limits (`whitelist` + `forbidNonWhitelisted`).
- Every id in a rule (account, payee, category, tag) is checked against the
  owner on every write. A rule that refers to a deleted entity is kept, marked
  `invalid` in the list, and skipped at run time with a reason in the trace.
- `transaction_rule_applications` is trimmed by the existing retention pattern
  (a cron; task B8 names the concrete one after reading `docs/cron-jobs.md`).

## 5. The condition model

### 5.1 Shape

```json
{ "all": [
    { "field": "type", "op": "eq", "value": "TRANSFER" },
    { "field": "fromAccountId", "op": "eq", "value": "<uuid>" },
    { "any": [
        { "field": "payeeText", "op": "matches", "value": "*BIEDRONKA*" },
        { "field": "amount", "op": "between", "value": [-500, -100] } ] } ] }
```

A node is either a group (`all` or `any`, with an optional `not: true`) or a
leaf (`field`, `op`, `value`).

### 5.2 Fields and operators

| Field | Type | Operators | Notes |
|---|---|---|---|
| `accountId` | account id | `eq`, `neq`, `in`, `notIn` | The account the row is posted to. |
| `fromAccountId`, `toAccountId` | account id | `eq`, `neq`, `in`, `notIn`, `isEmpty` | Only set on a transfer; empty on other rows. |
| `type` | enum `EXPENSE`, `INCOME`, `TRANSFER` | `eq`, `neq`, `in` | Derived from what the row is (sign and link), never from the account type (INV-REPORT-001 principle). |
| `payeeId` | payee id | `eq`, `neq`, `in`, `notIn`, `isEmpty` | After alias resolution. |
| `payeeText` | text | `eq`, `contains`, `startsWith`, `matches`, `isEmpty` | The raw payee text from the source (import text or typed name). |
| `categoryId` | category id | `eq`, `neq`, `in`, `notIn`, `isEmpty`, `inSubtree` | `inSubtree` includes child categories. |
| `description` | text | `eq`, `contains`, `startsWith`, `matches`, `isEmpty` | Case-insensitive. |
| `amount` | money, signed | `eq`, `lt`, `lte`, `gt`, `gte`, `between` | In the account currency. |
| `absAmount` | money | `lt`, `lte`, `gt`, `gte`, `between` | So "more than 100" does not depend on the sign. |
| `currencyCode` | currency | `eq`, `in` | Derived from the account. |
| `tagIds` | tag ids | `hasAny`, `hasAll`, `hasNone` | Tags present when the rule runs. |
| `hasSplits` | bool | `eq` | |

- `matches` is a glob (`*`, no regex), evaluated by `matchesAliasPattern`, so no
  pattern can cause ReDoS. There is no regex operator. The pattern is matched
  against the WHOLE text, so the validator refuses the two ways that goes
  wrong (section 10.1, "Glob traps").
- There is no `memo` field. The `Transaction` entity has no memo column, so a
  `memo` leaf could only ever read `null` and was false for every operator but
  `isEmpty`. A stored rule that still names it shows as invalid in the rules
  list with `UNKNOWN_FIELD` and is skipped by the applier, like any rule the
  validator no longer accepts: the field never worked, so there is nothing to
  keep working and no migration.
- Text comparison is case-insensitive and trims whitespace, the same as payee
  alias matching.
- Money comparison uses scaled integers (`Math.round(Number(x) * 10000)`) on
  both sides. There is no arithmetic on money in a condition.
- A leaf whose field is unknown for the row (for example `fromAccountId` on a
  row that is not a transfer) is `false` for every operator except `isEmpty`.
  It is never an error and never a default value.
- Splits: a condition reads the parent row. A split line is not evaluated in
  this plan (open question Q2).

### 5.3 Evaluator

A pure function, `evaluateRuleCondition(node, facts)`, in a new
`backend/src/transaction-rules/` module. No `eval`, no `new Function`, no
dependency. `facts` is a frozen object that the applier builds once per row.
The same function runs in the preview, the test panel and the commit (I3).

## 6. Actions

### 6.1 The closed list

| Action | Parameters | Effect | Refused when |
|---|---|---|---|
| `add_tags` | `tagIds[]` (1..20) | Adds the tags that the row does not have | never |
| `remove_tags` | `tagIds[]` (1..20) | Removes the tags if present | never |
| `set_category` | `categoryId`, `onlyIfEmpty` | Sets the category | the row has splits; the row is a transfer leg |
| `set_payee` | `payeeId`, `onlyIfEmpty` | Sets the payee | the row is a leg of a cross-owner transfer |
| `request_ai_review` | `instruction` (1..1000 chars), at most one per rule | Adds a durable request to the AI review queue (section 6.5) | never |
| `convert_to_transfer` | `toAccountId` or `fromAccountId`, `clearCategory`, `payeeId` | Added later: turns the row into one leg of a transfer and creates the counterpart leg | see `docs/specs/transaction-rules-structural-actions.md` section 4 |
| `split` | `parts[]` (2..10), `payeeId` | Added later: turns the row into a split whose part amounts come from the rule's captures | see `docs/specs/transaction-rules-structural-actions.md` section 4 |

The first four are ledger actions (`isLedgerAction`); `request_ai_review` writes
only to the queue. No action changes `amount`, `accountId`, `date`, `status`, splits or links. So
a rule cannot move a balance (I1). A refused action is skipped and the trace
records the reason; the other actions of the rule still run.

The two rows added after this plan (`convert_to_transfer`, `split`) are the
exception to the sentence above: they move the balance of the counterpart
account only. The restated I1 is in `docs/specs/transaction-rules-structural-actions.md`
section 2 and `INV-RULE-001` in `docs/system-invariants.md`.

### 6.2 Additive tags

`TagsService` gets `addTransactionTags(m, userId, transactionIds, tagIds)` and
`removeTransactionTags(...)`, both inside the caller's `EntityManager`, both
checking tag ownership. `INSERT ... ON CONFLICT DO NOTHING` makes the add safe
to repeat. Transfer legs of one owner share tags, as `syncTransferTags` does
today: a rule that tags one leg tags its mirror leg.

### 6.3 Where the rules run (every creation path)

The applier is `TransactionRulesService.applyToNew(m, userId, rowIds, source)`.
It runs inside the transaction that inserts the rows, after the row, its
splits and its explicit tags are written, and before the commit. It loads the
user's enabled rules for the trigger once per call (import: once per file).

| Path | Call site | Trigger |
|---|---|---|
| REST create, joint register, scheduled posting, AI, MCP | `TransactionsService.create`, inside its `withScopedDb` | `create` |
| Transfer (REST, AI, MCP, scheduled) | `writeTransferLegs`; `completeTransfer` then merges explicit tags with the rule tags instead of replacing them | `create` |
| QIF / OFX / CSV import | `ImportRegularProcessorService.processTransaction`, inside the row savepoint | `import` |
| MNY import | `MnyImportService.writeAll`, after `writeTransactions`, over the inserted ids | `import` |
| Split transfer legs created by `createSplits` / `addSplit` | not evaluated in this plan (Q2) | none |

Not in scope, on purpose (a guard lists them, section 9): backup restore, demo
and seed data, action-history undo and redo, the cash leg of an investment
transaction.

### 6.4 Order against the payee default category

1. The explicit values in the request.
2. The payee default category (today's rule, unchanged).
3. The transaction rules, in `position` order.

With `onlyIfEmpty: true` a rule does not replace steps 1 and 2. With
`onlyIfEmpty: false` a rule replaces them. The editor says this in an
`InfoTooltip` on the flag.

### 6.5 The AI review queue (prepared now, used by later features)

A rule can ask an AI to look at a row, for example "split this Allegro
purchase by the items in the order". Monize does not always have an AI
provider; the user may work only through the MCP relay, on their own
subscription, and the relay's prompt queue expires within minutes when no
agent answers. So a review request is a durable row:

```
ai_review_requests
  id, user_id, transaction_id, rule_id (nullable: a manual request has none)
  kind        varchar  -- 'transaction_review' now; later kinds reuse the table
  instruction text     -- the rule's instruction, user data
  status      varchar  -- pending | claimed | proposed | applied | rejected | expired
  claimed_by, claimed_at, proposal jsonb, created_at, expires_at (default 30 days)
```

- **Producers:** the `request_ai_review` action, in the same transaction as the
  insert (I2); later, a "Ask AI later" button on a transaction, and email or
  share ingestion.
- **Consumers:** the in-app assistant when a provider is configured, and any
  MCP client, the relay agent included, through three tools:
  `list_ai_review_requests`, `claim_ai_review_request` (a conditional
  `UPDATE ... WHERE status = 'pending'`, so two agents cannot claim one) and
  `submit_ai_review_proposal`.
- **A proposal is never a write.** It is a signed `PendingAiAction` built by
  `AiActionBuilderService` (for example an `update_transaction` with split
  lines), stored on the request and shown as a confirmation card in a review
  inbox. Only the human's approval commits it, through the existing confirm
  path. The server validates the proposal like any other action: split lines
  must sum to the amount; a difference (delivery cost) is named, not assigned.
- **Privacy:** the request carries the instruction and the transaction id,
  not a copy of the row. What an agent reads, it reads through the existing
  read tools, under the user's scopes.
- Pending requests expire; an expired request is reported in the inbox, not
  deleted silently.

## 7. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| I1 | A rule never moves a balance (superseded by `docs/specs/transaction-rules-structural-actions.md`: a structural action moves the target account's balance), and an AI proposal is never committed without a human approval | The action list in section 6.1 is a closed union type; a proposal is a `PendingAiAction` committed only by the confirm path; the DTO refuses any other action; a unit test asserts that no action writes `amount`, `account_id`, `status` or a link. |
| I2 | A rule applies in the same transaction as the insert, on every creation path in 6.3 | The applier takes an `EntityManager`; a source-scanning guard lists every `create(Transaction)` / `insert` site on `transactions` and fails on a site that is neither a call to the applier nor in the exempt list. |
| I3 | A preview shows what the commit will do | `previewCreate`, the test panel and the manual-run preview call the same `planRuleEffects(facts, rules)`; the commit applies its result. A test compares preview and commit for the same input. |
| I4 | A rule runs at most once per row per trigger, in `position` order | One call site per path; a test with two rules and `stopProcessing`. |
| I5 | A rejected rule write has written nothing | Ownership, bounds and `revision` checks run in the same `withScopedDb` as the save (`docs/financial-calculation-contract.md` section 7). |
| I6 | A manual run does not alter a reconciled row while the strict lock is on | `assertReconciledRowsMutable` per row; locked rows are counted and named in the result. |

The PR that lands I1 and I2 adds them to `docs/system-invariants.md` as
`INV-RULE-001` and `INV-RULE-002` with an honest status.

## 8. AI assistant and MCP

Rule management goes through the existing action path, as the MCP and AI
writes already do:

- New `AiActionType` values: `create_transaction_rule`,
  `update_transaction_rule`, `delete_transaction_rule`,
  `run_transaction_rule` (manual run on existing rows). The builder resolves
  names to ids (payees, categories, tags, accounts), validates the rule and
  attaches the test result (matched rows, planned changes) to the card.
  `AiActionsService.execute` commits through `TransactionRulesService`.
- AI assistant tools (`backend/src/ai/query/tool-definitions.ts`,
  `backend/src/ai/query/tool-executor.service.ts`): `list_transaction_rules`
  (read) and `manage_transaction_rules` (write, with `operation`).
- MCP: one tool, `manage_transaction_rules`, in a new
  `backend/src/mcp/tools/rules.tool.ts`, with the five required fields,
  `confirmWrite` with all four outcomes, relay card first,
  `McpWriteLimiter`, and `stripHtml` on the name. Reads go through the same
  tool with `operation: "list"`, to keep the `tools/list` budget small.
  `tools-list-budget.spec.ts` is a ratchet: adding the tool raises the total
  cap, which is a reviewed decision in that PR.
- A client truncates a tool description at 2,048 characters (Claude Code logs
  `description truncated from 2328 to 2048 chars` and drops the tail). The
  rule language (`RULE_LANGUAGE_GUIDE`, `backend/src/ai/query/rule-language.ts`,
  shared by the assistant and the MCP tool) therefore leads with the contract
  (`condition` is an object, `actions` an array, one complete example, the
  group and leaf keys, the operators, the glob rules, the action shapes) and
  the per-field detail lives in the `condition` and `actions` field
  descriptions. `tools-list-budget.spec.ts` fails when any tool description
  is over 2,048 characters and holds the rule tool's under 2,000.
- A refused definition comes back with the `{ path, code }` entries and one
  short English hint per distinct problem (`rule-validation-hints.ts`): what
  is wrong and the correct form, with the allowed keys, fields or operators
  named. `condition` and `actions` sent as JSON strings are parsed once
  (bounded at 20,000 characters) instead of refused, because models do this
  routinely.
- A test or a card that matched no transaction says so plainly ("This rule
  matches none of the N latest transactions") and tells the model that such a
  rule is usually wrong and to re-check the pattern before asking the user to
  confirm. The editor's Save shows the same line under the last Test when it
  matched nothing (it never blocks).
- A model drafts a rule; it never saves one without the human card. The
  domain logic sits on `TransactionRulesService`, so both surfaces return the
  same shape (`docs/backend/mcp.md`, checklist item 1).
- Transactions that the AI or MCP creates run the rules automatically, because
  they go through `create()`. The confirmation card of a create shows the rule
  effects (I3).

## 9. Test matrix

| Area | Cases |
|---|---|
| Evaluator | every operator per field type; unknown field on a row (false, `isEmpty` true); nested `all`/`any`/`not`; glob edge cases shared with `alias-match.util.ts`; money boundaries (`-100.0000` vs `-100.00005`) |
| Validation | foreign id refused; bounds (depth, leaves, actions, rules per user); unknown field or operator refused; `revision` conflict |
| Actions | `onlyIfEmpty` both ways; `set_category` on a split row and on a transfer leg refused; `add_tags` idempotent; mirror leg receives tags |
| Order | payee default vs rule (truth table in 6.4); two rules and `stopProcessing`; later rule sees earlier result |
| Creation paths | one integration test per row of the table in 6.3, on real PostgreSQL; rollback of the insert rolls back the rule effects |
| Preview | `previewCreate` result equals the committed row for the same input (I3) |
| Manual run | preview equals commit; reconciled rows skipped; undo restores tags, category and payee |
| Guard | a new `create(Transaction)` site outside the applier and the exempt list fails |
| RLS | a rule and an application row are invisible to another user (`rls-context-smoke` pattern) |
| AI / MCP | the four confirmation outcomes; relay card; write limiter; output schema |
| Frontend | editor round trip (tree in, tree out); every picker writes an id and shows a name; test panel renders matched and not-matched rows; nav entry hidden for a delegate |
| E2E | create a rule in the UI, import a small QIF, see the tag on the row |

## 10. Phase 2: extensions (approved direction, not built)

Discussion #991 (a PKO BP CSV import script) showed what rules still cannot
do. The import half of that script belongs to the import (plan
[`csv-source-profiles.md`](./csv-source-profiles.md)); these four
extensions are the rule half. All of them keep I1: they write the payee,
the description, tags or nothing, never an amount, an account, a date, a
status or a link.

### 10.1 Captures in a glob (X1)

A `matches` leaf may name captures: `{name}` in the pattern matches the
shortest run of characters that lets the rest of the pattern match, `*`
stays an anonymous wildcard. Example: `*Nazwa odbiorcy: {payee} Rachunek*`.

- The matcher stays iterative and linear in the text length (no regex, no
  backtracking beyond the existing glob's segment search); it lives beside
  `matchesAliasPattern` and shares its 500-character bound.
- At most 5 captures per pattern, names `[a-z][a-z0-9]{0,19}`, each captured
  value trimmed and at most 200 characters.
- Captures are visible to the actions of the same rule only, as `{name}` in
  a template. A capture from a leaf inside an `any` group that did not match
  is empty.
- The validator refuses a template that names a capture no leaf of the rule
  defines.
- From phase 2 on, `{...}` in a `matches` pattern is capture syntax. A
  pattern saved earlier with literal braces is either refused by validation
  (it then shows as invalid in the rules list, with its reason) or reads as a
  capture. Phase 2 ships together with phase 1, so no stored rule needs
  migrating. A literal brace cannot be written in a `matches` pattern; there
  is no escape.

Glob traps (every surface: REST, editor, assistant, MCP). Two `matches`
patterns are refused because they are never what a person meant:

- `LOOKS_LIKE_REGEX`: the pattern holds `|`, `.*`, a backslash, or a bracket
  class of 1 to 3 characters (`[xy]`, `[łl]`). A glob has no escape, so `^`,
  `$` and longer bracketed words (`*[PENDING]*`) stay allowed: refusing them
  would make that literal text impossible to match. The listed characters are
  matched literally, so a pattern written as a regex never matches what was
  meant. The hint sends the author to an `any` group of `contains` / `matches`
  leaves.
- `PATTERN_WITHOUT_WILDCARD`: the pattern holds no `*` and no `{capture}`, so
  it equals the whole text, which is what `eq` says. The hint sends the author
  to `eq` for the whole text, or `contains` / `*text*` for a part.

At most one of the two is reported, the regex first; a malformed `{Capture}`
is `INVALID_CAPTURE`, not a missing wildcard. Both are authoring checks only:
they run when a rule is created or updated (REST, the draft preview, the
assistant and MCP, through `validateRuleDefinition(..., { authoring: true })`)
and never when a stored rule is loaded, listed, evaluated or run. A stored rule
such as `matches "NETFLIX.COM"` keeps applying and is not marked invalid;
creating it anew is refused, and an update that leaves the condition alone does
not re-run them. A stored rule that names the removed `memo` field is different:
it is invalid (`UNKNOWN_FIELD`) and the applier skips it.

### 10.2 Two text actions (X2)

| Action | Parameters | Effect | Refused when |
|---|---|---|---|
| `set_payee_from_text` | `template` (1..200), `createIfMissing` (default false), `onlyIfEmpty` (default true) | Renders the template, resolves the name through the existing payee resolution (exact name, then alias, then the unique normalized match), and sets the payee; with `createIfMissing` it creates the payee through the existing find-or-create path | the rendered name is empty; the row is a cross-owner transfer leg |
| `set_description` | `template` (1..500), `mode` (`replace`, `append`, `prepend`), `onlyIfEmpty` (default false) | Renders the template (`{description}` is the current text) and writes the description within the column's length, `stripHtml` applied | the rendered text is empty in `replace` mode; the row is a cross-owner transfer leg (a same-owner transfer writes both legs) |

Templates are plain text with `{capture}`, `{payeeText}` and `{description}`
placeholders; there is no expression language inside a template. The
preview renders the same template through the same function (I3). A payee
created by a rule is traced in the application row, and undo of a manual
run does not delete it (a payee is reference data, as when a form creates
one).

### 10.3 More condition fields (X3)

| Field | Kind | Operators |
|---|---|---|
| `referenceNumber` | text | `eq`, `contains`, `startsWith`, `matches`, `isEmpty` |
| `dayOfMonth` | number 1..31, from the transaction date | `eq`, `lt`, `lte`, `gt`, `gte`, `between`, `in` |
| `weekday` | enum `MON`..`SUN` | `eq`, `in` |
| `status` | enum of the transaction statuses | `eq`, `neq`, `in` |
| `hasAttachment` | bool | `eq` |

The date is the transaction's own calendar date, never a clock reading.

Decisions made in X3:

- `dayOfMonth` and `weekday` are computed from the `YYYY-MM-DD` text
  (`calendarDayParts` in `rule-facts.ts`: `Date.UTC` and `getUTCDay`), never
  from a `Date` in the server timezone. A value that is not a real calendar
  date is unknown. `dayOfMonth` is a new value kind of its own (whole days
  1..31, `VALUE_OUT_OF_RANGE` outside it, `VALUE_TYPE` for a non-number) and
  `weekday` values are upper case (`MON` is Monday).
- `status` values are the four `TransactionStatus` values, listed in
  `rule-condition.types.ts` (which the frontend contract test runs without its
  imports) and held equal to the enum by a spec.
- An unknown fact is false for every operator except `isEmpty` (so `status neq
  VOID` is false on a row whose status is unknown), as for every other field.
- `hasAttachment` counts visible attachments only: a scanned document's hidden
  original (`original_of_attachment_id` set) is left out with the shared
  `primaryAttachmentSql`, so a scan pair is one attachment, as in the register.
  A manual run and a draft preview read the presence of every candidate's
  primary row in one query (`loadAttachmentPresence`); a row written by the
  create and import paths has none yet, so it is `false` there.
- A transfer is evaluated on its outgoing leg's reference, date, status and
  attachments, like every other fact.
- The previews of a create and of a transfer pass the same facts the commit
  reads from the stored row: the reference number, the stored calendar date
  (the first ten characters of the input), the status with its `UNRECONCILED`
  default, and `hasAttachment` false (`previewCreate`, `previewCreateTransfer`).
- The visual editor has a control for each of the five fields (task X5): the
  text control for `referenceNumber`, a 1 to 31 number input for `dayOfMonth`,
  translated day and status names for `weekday` and `status`, a switch for
  `hasAttachment`; the expression mode parses and prints them. Only a field
  the editor does not know is kept as a read-only stored value.

### 10.4 Rule effects in the import preview (X4)

Deferred (owner: rules-only scope): X4 needs the import module's review step
and stays open until that module is in scope.

The import wizard's review step shows, per row, what the import-trigger
rules will do, through `planRuleEffects` on the facts the import will build
(I3). The commit stays unchanged; a row whose preview and commit differ
(for example a payee the import creates) says so, as `previewCreate` does.

### 10.5 Not in phase 2

A regex operator (ReDoS, or a new RE2 dependency), an action that turns a
row into a transfer or changes its account, amount or date (breaks I1; the
import profile does it before the row exists), `split_by_template`,
`notify`, an `update` trigger, rule export and rule groups. Each can be a
later proposal.

Update: `docs/specs/transaction-rules-structural-actions.md` supersedes this
for an action that turns a row into a transfer (`convert_to_transfer`) and for
splitting a row (`split`, with amounts from captures rather than a template);
the rest of this list is unchanged.

## 11. Open questions

- **Q1.** Is "Rules" a direct entry in the Tools menu, or a section under
  Payees? This plan says direct entry, because a rule touches payees,
  categories and tags equally.
- **Q2.** Do split lines get their own evaluation (a rule that sets a
  category on a split line)? This plan says no; it can come later without a
  format change (a `scope: "split"` field on the rule).
- **Q3.** Should a delegate with manage rights on categories or tags see the
  Rules page? This plan says no, until delegation gets a `rules` capability.
- **Q4.** Should the private copy of the glob matcher in
  `import-regular-processor.service.ts` be replaced by `matchesAliasPattern`?
  It is an unrelated duplication; it is reported, not fixed, in this plan.
