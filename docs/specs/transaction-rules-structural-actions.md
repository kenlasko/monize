# Spec: structural rule actions and the rule date window

Status: approved for implementation on `claude/epic-planck-oq6u8t` (the
maintainer chose to build all three parts on one branch).
Extends: `docs/future-plans/transaction-rules.md` (sections 5, 6 and 10.5).
Supersedes: the statement of INV-RULE-001 ("a rule never moves a balance").

Read `docs/financial-semantics.md` (transfer legs, splits),
`docs/financial-calculation-contract.md` section 7 (rejection before write) and
the INV-RULE entries in `docs/system-invariants.md` before changing anything
here.

## 1. Goal

A bank statement line for a loan instalment carries the principal and the
interest in one text, for example
`PRINCIPAL: 1200,50 INTEREST: 300,25PENALTY: 0,00<loan reference>`.
The principal moves money to the loan account (a transfer); the interest is an
expense. Three additions let a rule book such a line without a person:

1. `convert_to_transfer`: the matched income or expense becomes one leg of a
   transfer, and the other leg is created in the named account.
2. `split`: the matched row becomes a split whose part amounts come from the
   `{name}` captures of the rule's `matches` patterns; a part may be a
   transfer to another account.
3. A `date` condition field, and a per-rule active window
   (`activeFrom` / `activeTo`) that switches the rule off for every
   transaction dated outside it, on every path.

The window is the safety part. A history reconciled with the bank to the cent
must not change because a rule was saved or run: a rule with
`activeFrom = 2026-10-01` never touches a row dated 2026-09-07, on create, on
import, in a test and in a manual run.

## 2. Invariants

- **INV-RULE-001 (restated).** A rule never changes the matched row's amount,
  account, date or status, and never deletes or relinks a row that exists. The
  only balance a rule moves is the one a structural action creates: the
  counterpart legs of `convert_to_transfer` and of the transfer parts of
  `split`, each written through the existing transfer-split or transfer-leg
  helpers, by exactly the counterpart's amount, in the transaction that writes
  the rule's other effects. The matched row's own account balance never moves,
  because its amount does not change. A structural action never runs on a row
  a non-owner actor (a joint-account member, an acting delegate) creates in
  the owner's account (section 4,
  `structural_not_allowed_for_actor`), and whatever a create or a run wrote in
  another account is removed, with its balance, by the undo of what wrote it
  (section 6).
- **INV-RULE-004 (new).** A rule with an active window is evaluated only for a
  transaction whose calendar date is known and inside the window, inclusive at
  both ends. Outside it the rule is traced as `skippedRule:
  "outside_active_window"` and contributes nothing. The planner decides it
  (`planRuleEffects`), so the create path, the import, the preview, the test
  and the manual run give the same answer. A manual run's `startDate` /
  `endDate` only narrow what is scanned and never widen the window.
- **INV-RULE-003 (unchanged, extended).** The preview, the test and the commit
  call one planner; the structural plan (a split's parts and signed amounts, a
  conversion's target, `clearCategory` and signed counterpart `amount`) is part
  of the planned changes and of the run fingerprint, so a row amount edited
  between the preview and the commit refuses the run with `PREVIEW_CHANGED`.
- **Rejection before write.** Every refusal below is decided by the pure
  planner before anything is written. A refused structural action is a skipped
  action with a reason; it never throws on a create or import path, so a rule
  can never make a person's create or a file import fail.

## 3. Data model

### 3.1 The active window

`transaction_rules.active_from DATE NULL`, `transaction_rules.active_to DATE
NULL`, with `CHECK (active_from IS NULL OR active_to IS NULL OR active_from <=
active_to)`. Null means open on that side. Entity `activeFrom` / `activeTo`
(`YYYY-MM-DD` strings), DTO fields validated as real calendar dates, an update
that sends `null` clears the side. The response view returns both.

### 3.2 The `date` condition field

`date`, kind `date`, operators `eq`, `lt`, `lte`, `gt`, `gte`, `between`. The
value is a real `YYYY-MM-DD` calendar date (`between` takes `[from, to]`,
`from <= to`). The fact is the transaction's own calendar date; an unknown date
is false for every operator. Dates compare as strings, never through a `Date`.

### 3.3 `convert_to_transfer`

Stored:

```json
{ "type": "convert_to_transfer", "toAccountId": "<uuid>", "clearCategory": true, "payeeId": "<uuid>" }
```

Exactly one of `toAccountId` (for an expense, the money goes there) and
`fromAccountId` (for an income, the money came from there). `clearCategory`
defaults to `true`. `payeeId` is optional and sets the payee of both legs.
Name form (assistant, MCP): `toAccountName` / `fromAccountName`, `payeeName`.

### 3.4 `split`

Stored:

```json
{
  "type": "split",
  "payeeId": "<uuid, optional: the parent row's payee>",
  "parts": [
    { "amount": "{principal}", "transferAccountId": "<uuid>", "payeeId": "<uuid>" },
    { "amount": "{interest}", "categoryId": "<uuid>", "description": "interest" },
    { "amount": "rest" }
  ]
}
```

- 2..10 parts. `amount` is `"{capture}"` naming a capture some `matches` leaf
  of the same rule defines, or `"rest"` (at most one part).
- `categoryId` and `transferAccountId` are mutually exclusive; a part may have
  neither (an uncategorised line).
- `payeeId` on a part is allowed only with `transferAccountId`: it is the payee
  of the counterpart leg in the target account. A split line has no payee
  column, so the payee of a category line is the parent row's payee (the
  action's own `payeeId`, or the row's payee).
- `description` (1..200 characters) becomes the split line's memo, and the
  counterpart's description for a transfer part.

Name form: `categoryName`, `transferTo` (an account name), `payeeName` on a
part; `payeeName` on the action.

### 3.5 Amount parsing (Polish format)

`parseRuleAmount(text)` returns the magnitude in 1/10000 units, or null:

- Whitespace is removed (space, U+00A0, U+202F, U+2009): `"1 234,56"`.
- After that the text must be digits with an optional decimal separator `,` or
  `.` and 1..4 decimals: `"1200,50"`, `"1200.50"`, `"450"`.
- `"1.234,56"` (dots as thousands separators, comma as decimal) is accepted
  only in the strict `\d{1,3}(\.\d{3})+,\d{1,4}` shape.
- A sign, a currency, letters or anything else: null (`split_amount_unparseable`).

The sign of every part is the parent's sign. Arithmetic is on scaled integers
only.

### 3.6 Combination rules (validation)

- At most one structural action (`convert_to_transfer` or `split`) per rule:
  `DUPLICATE_ACTION`.
- A structural action and `set_category` in one rule: `CONFLICTING_ACTIONS`.
- Every account, category and payee id a structural action names is checked
  for ownership with the rule's other references.

## 4. Planner semantics (pure, `planRuleEffects`)

The working state gains `isTransfer`, `hasSplits` and `structure`. A later rule
sees the row as it will be: after a conversion the `type` is `TRANSFER`, after
a split `hasSplits` is true and the category empty, so a later `set_category`
is refused as before (`row_is_transfer_leg` / `row_has_splits`) and a second
structural action is refused the same way.

A create made by someone other than the owner (a joint-account member, or a
delegate acting as the owner) plans with `structuralNotAllowed`, set from the
server-side identity as the `actorIsNotOwner` option of
`TransactionsService.create`: `JointRegisterService` from the joint grant, the
acting `POST /transactions` and the acting scheduled post from
`req.user.isActing`; no request field is read. Both structural actions are then skipped, before every refusal
below, with `structural_not_allowed_for_actor`; category, payee, description
and tag actions still apply, and the row stays a plain row of the owner's
account. The owner's own creates, imports and runs are unaffected.

Accepted gap: the auto-post cron posts a schedule as its owner and passes no
`actorIsNotOwner`, because a schedule does not record who wrote it. A schedule
(or an occurrence override) that an acting delegate with the `bills` section
created or edited therefore still runs the owner's structural rules when it
auto-posts. The money stays between the owner's accounts, by the owner's rules;
closing it needs a stored "written by a delegate" marker on the schedule.

Refusals, checked in this order, each a skipped action:

| Reason | When |
|---|---|
| `row_is_transfer_leg` | the row is (or already became) a transfer leg |
| `row_has_splits` | the row is (or already became) a split |
| `row_is_void` | the row's status is VOID |
| `zero_amount` | the row's amount is zero or unknown |
| `transfer_direction_mismatch` | `convert_to_transfer` with `toAccountId` on an income, or `fromAccountId` on an expense |
| `transfer_same_account` | a target account is the row's own account |
| `transfer_account_unavailable` | a target account is not one the planner was given (missing, or not the owner's) |
| `transfer_currency_mismatch` | a target account's currency differs from the row's (cross-currency is left to a person) |
| `split_amount_unparseable` | a capture is missing or does not parse (3.5) |
| `split_sum_mismatch` | without `rest`, the parts do not add up to the row's amount; with `rest`, the others exceed it |
| `split_too_few_parts` | fewer than two non-zero parts remain (zero parts are dropped) |

The planned structure is carried in `RuleNetChanges.structure` and in the
rule's trace entry as `changes.structure = { before: null, after: <plan> }`,
where a transfer plan carries the target, `clearCategory` and the signed
counterpart `amount` (the negative of the row's, 4 decimals) and a split plan lists each part's signed amount (4 decimals), category,
transfer account, payee and memo, so the test and the preview show the parts
before anything is saved.

The active window is checked before the condition (INV-RULE-004).

## 5. Write path

`TransactionRulesApplierService.writeEffects` writes the field patch and tags
as today, then the structure, on the caller's manager:

- **Transfer.** `convertRowToTransfer` (`backend/src/transactions/
  convert-to-transfer.ts`) creates the counterpart leg in the target account
  (amount `-row.amount`, same date, description, payee and status, the row's
  tags mirrored), links the two legs, sets `isTransfer` on the row and clears
  its category when asked, and moves the target account's balance by the
  counterpart's amount with `AccountsService.updateBalance` (or
  `recalculateCurrentBalance` for a future-dated row).
- **Split.** `TransactionSplitService.validateSplits` then `createSplits` (the
  path `PUT /transactions/:id/splits` uses), joined to the caller's
  transaction; then `isSplit = true`, `categoryId = null`; a part's payee is
  written on its counterpart leg.

`convertRowToTransfer` refuses (rolling the transaction back) a row whose
locked amount is no longer the planned counterpart `amount`. Both return the
accounts whose balance moved. `applyToNew` returns them per
row, and every caller dispatches the net-worth recompute after its commit
(INV-CACHE-001); none is dispatched inside the transaction.

## 6. Manual run and undo

The run previews the structure, includes it in the fingerprint, and writes it
through the same `writeEffects`. Before its first write it row-locks every
target account of its plan in one ascending-id statement, after the candidate
rows' locks, so two runs converting in opposite directions cannot take two
accounts in opposite orders (`docs/concurrency-and-idempotency.md`, section 8). The undo entry records, per structural row,
the kind, the counterpart leg ids and, for a split, the ids of the lines the run
wrote. Undo removes the counterpart legs (each
balance reversed by `deletionBalanceEffect`, the rows deleted conditionally),
deletes the split lines, and restores `isTransfer`, `isSplit`,
`linkedTransactionId` and the category from the snapshot, under the same row
locks and reconciled-lock check as today. Redo of a run that restructured rows
is refused (`RULE_RUN_REDO_STRUCTURAL`): run the rule again instead.

The undo refuses with `RULE_RUN_UNDO_STRUCTURE_CHANGED` (409), before any write,
when a restructured row now carries structure the run did not write: a split
line whose id is not one the run recorded, a line linked to a leg the run did
not create, or a transfer row linked to a leg other than the recorded
counterpart. `PUT /transactions/:id/splits` records no history, so a person can
replace the lines after the run; deleting every line the run wrote would orphan
the counterpart of a line they added, with its balance. Something the run wrote
that has since gone is not a change (nothing is left to orphan), and the
removal of a missing leg is skipped as before.

The undo of the "Created transaction" entry of a row a rule converted or split
(and of a user-entered split with transfer parts) removes the same legs: the
row is locked with its transfer counterpart, then the legs of its split lines
after it, the reconciled lock is checked on all of them, and each leg is
removed through `removeLockedTransactionLeg` (`deletionBalanceEffect`). Redo of
such a create is refused (`REDO_CREATE_WITH_LEGS`): the legs cannot be
replayed from the stored snapshot, so the transaction is created again
instead.

## 7. Worked example (the acceptance case)

A loan reference (for example `LOAN-0000-EXAMPLE`) in the payee text or the
description. Rules in order, all with `activeFrom: 2026-10-01`,
`stopProcessing: true`:

1. `PRINCIPAL: 0,00 INTEREST: *` -> `set_category "Loans: Interest"`,
   `set_payee "Loan repayment"`.
2. `PRINCIPAL: * INTEREST: 0,00PENALTY*` -> `convert_to_transfer` to
   "Loan account", `clearCategory`, payee "Loan repayment".
3. `PRINCIPAL: {principal} INTEREST: {interest}PENALTY*` -> `split` with payee
   "Loan repayment": `{principal}` transfer to "Loan account", payee
   "Loan overpayment", no category; `{interest}` category "Loans: Interest".

| Row (amount) | Date | Result | Loan account balance moves by |
|---|---|---|---|
| `PRINCIPAL: 0,00 INTEREST: 85,40...` (-85.40) | 2026-10-05 | expense, category set, payee set | 0 |
| `PRINCIPAL: 640,15 INTEREST: 0,00...` (-640.15) | 2026-10-05 | transfer to the loan account | +640.15 |
| `PRINCIPAL: 1200,50 INTEREST: 300,25...` (-1500.75) | 2026-10-05 | split: -1200.50 transfer, -300.25 interest | +1200.50 |
| same text, amount -1510.75 | 2026-10-05 | rule 3 skipped, `split_sum_mismatch` | 0 |
| any of the three | 2026-09-07 | unchanged, `outside_active_window` | 0 |

## 8. Test matrix

- Planner: each refusal in section 4; the three rows and the two skips of
  section 7; a later rule seeing `TRANSFER` / `hasSplits`; the window on both
  sides and with an unknown date.
- Amount parser: every accepted and refused shape of 3.5.
- Validation: the new codes, the capture check on part amounts, one `rest`.
- Applier: the counterpart's amount, account, link and status; the balance
  helper called for the target account only, with the counterpart's amount;
  `affectedAccountIds` returned; the split written through the split service.
- Run: the preview lists the parts; the fingerprint changes with them and with
  a conversion's amount (`PREVIEW_CHANGED` when the row amount changed); the
  account locks are taken once before the first write; undo restores the row
  and reverses the counterpart balance; undo is refused when the lines were
  replaced since; redo is refused.
- Create undo: the counterpart (and the legs of a split's transfer parts) is
  removed and the loan balance returns; redo is refused.
- Joint account: a member's create with the owner's converting or splitting
  rule gets no counterpart, no owner balance change and no owner account in
  the response, while a category rule still applies.
- Assistant / MCP: the name form of both actions and of the window.

## 9. Out of scope

Cross-currency structural actions, a split of a transfer leg and payees on
category split lines; the web Rules editor creates and edits both structural
actions (one card each, built from the transaction form's account, category and
payee pickers), as do the assistant and MCP.
