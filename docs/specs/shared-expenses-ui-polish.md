# Shared expenses: maintainer UI feedback specification

Status: The requester approved the narrower first delivery on 28 October 2026.
Section 0 is the current implementation contract. Sections 1 through 6 record
the earlier proposal; private-finance work remains deferred. Upstream acceptance
is separate from this authorization.

Source: [Ken's PR review, edited 28 October 2026 at 19:06:46 UTC](https://github.com/kenlasko/monize/pull/1890#issuecomment-6477862506).
Reviewed PR revision: `dede6ceb934f3fdca8f5b23746bad83823318c38`.
Ken merged main into that revision; retain this history. The relevant feature
files match the previously tested `f08198611` implementation. This document is
the earlier approved proposal with the scope correction below, not a claim that
its changes or tests have been completed.

## 0. Reassessment after the edited review

Ken added a first point after the original review was read: do not create new
accounts for this feature until its basic functionality has settled. He suggests
that other connections to core Monize functionality should probably wait too.
His subsequent Discussion reply directs further feedback to the PR. The account
restriction is explicit; the exact boundary for other connections is not yet
settled. Do not treat the remaining transaction-related review points as approval
to expand that integration now.

The current implementation creates a managed settlement account when personal
integration is enabled. Both the combined expense/finance flow and matching from
Transactions rely on that integration. Keeping those flows while hiding only
the account-creation screen would not satisfy the new restriction.

Approved first delivery:

- Keep the trip group, independent payers and beneficiaries, equal/percentage/
  exact/weighted splits, explicit zeros, fixed amounts plus equal remainder,
  running balances and recorded repayments. Repayment records in the group do
  not execute a bank transfer.
- Polish the group-only workflow: one expense form with attachments, Save
  completion, standard filters/tables, currency controls and mobile behavior.
  Keep group multi-currency calculations; those do not require private accounts.
- Defer new settlement accounts and personal posting, source-transaction
  matching/reclassification, the normal-form submission adapter, and the private
  FX policy in section 5. Preserve the existing work in Git for a later, separately
  agreed integration change. Avoid replacing the account with another accounting
  mechanism just to keep the same scope.
- Decide with the maintainer whether a simple transaction-to-group prefill is
  wanted in the first delivery. It must be evaluated separately from the current
  posting-dependent handoff; this proposal does not assume it is approved.
- Before reducing the existing draft, map the integration's UI, API, account,
  report and backup references together. Removing an entry button alone does
  not demonstrate that account creation or financial writes are unavailable.
  Do not delete existing test-instance financial records during that separation.

| Review item | Status for the proposed first delivery |
| --- | --- |
| UI-00: newly added account/integration boundary | Scope decision precedes implementation of personal integration. |
| UI-01 through UI-05 | Retain for the group-only workflow. |
| UI-06 through UI-11 | Keep as feedback for any integration that is later agreed; defer implementation while that boundary is unresolved. |
| Section 5: private FX policy | On hold; its previous requester approval is not evidence that Ken wants it in this delivery. |

Implementation boundary: the first delivery removes personal-finance creation
controls and transaction handoffs. A shared server guard refuses enable, booking
and combined entry/finance routes before their services run. Existing private
postings remain readable and may be explicitly unlinked; their financial math,
restore data and tests are retained. There is no runtime flag to re-enable new
booking. No schema migration or deletion of stored data is part of this change.

Acceptance of the narrower delivery needs the six-person trip scenario and a
check that group commands leave private account/transaction data unchanged,
including direct API access. The paired plan names the edit map and acceptance matrix. Sections 1 through 6 retain the previous proposal
for reference and must not override this section.

## 1. Goal and boundary

Make the current shared-expense workflow behave like the rest of Monize while
keeping quick entry for a fixed group of friends. Address every review point
in one bounded feedback iteration, divided into reviewable commits.

The group roster, per-expense payers/beneficiaries, equal/percent/exact/weight
splits, explicit zero, fixed amounts plus equal remainder, refunds, repayments
and optional personal transactions remain supported. This iteration does not
add guest/PIN authentication, tag-based batch import, delegated-account sharing,
new dependencies or a new accounting subsystem.

This iteration supersedes the corresponding UI sections of
`docs/specs/shared-expenses-ux.md` and the private FX policy in section 8 of
`docs/specs/shared-expenses.md`. Section 5 below is the requester-approved financial policy,
not an inference that Ken has already approved its numerical details.

## 2. Traceability: all 11 review points

| ID | Review point | Required result |
| --- | --- | --- |
| UI-01 | Save Expense unexpectedly opens attachments | Optional attachments are part of the expense form before saving. A successful Save closes the form and refreshes the list. Upload failure remains in that same form with an explicit saved-expense/pending-files state. |
| UI-02 | Filters differ from Transactions | Use the Transactions filter-panel layout: collapsible header, active count, removable selections, search, dates and Clear. Keep only filters meaningful to shared expenses. |
| UI-03 | Amount fields and currency square differ | Reuse `CurrencyInput` and `CurrencyPickerButton` composition from `TransactionForm`. Apply the same amount styling throughout the feature, with currency editing only where the underlying amount's currency is editable. |
| UI-04 | Item/amount subheading is redundant | Remove the repeated item and amount from the expense modal description. Keep the normal modal title and the form's amount field. Retain useful FX disclosures in the preview. |
| UI-05 | Shared expenses should be a table | Convert both the group overview and the group's expense list to existing Monize table conventions. On phones use the documented wrapped-row pattern, with readable money and accessible row actions. |
| UI-06 | Add to My Finances wording | Use Ken's requested English action, `Add to my Transactions`, consistently on buttons, dialog entry points and help. Translate the meaning into every supported locale. Do not rename unrelated finance concepts globally. |
| UI-07 | My Category belongs inside new-payment box | Remove the global category field above payment selection. Show the normal transaction Category field inside the new-transaction form. Matched sources supply their category information; see the mode matrix. |
| UI-08 | Use the normal New Transaction modal | Reuse the real `TransactionForm` and its controls/validation for a new payment, with a narrow submission adapter for shared-expense review and commit. Do not maintain a second bank-payment form with different fields. |
| UI-09 | Exchange difference is transaction data, not a category | Remove the dedicated FX-category selector and requirement. Keep actual bank amount and original-currency/rate data on the transaction; disclose any difference from the group agreement and account for it as specified in section 5. |
| UI-10 | Matching shows only recent transactions | Make All Dates explicit, support older transactions through server search and pagination, and filter eligibility before counting/paging. Add cases older than 12 months and beyond the first page. |
| UI-11 | More options may not apply to matching | Matched account/date/amount/payee/category/FX facts are displayed, not overwritten by generic advanced fields. Offer only relevant allocation controls: whole transaction, a shared portion, or selected category-split portions. |

## 3. Expense form, documents and lists

### Save and documents

Reuse the staged-file controls in `AttachmentsSection` and the existing shared
document upload service. A new form holds selected files locally until an entry
exists. It identifies which files will be shared with the group; private bank
attachments are not copied implicitly. Original scan publication remains opt-in.

Without personal booking, Save commits the expense using its current preview
fingerprint, uploads staged files, then closes. With personal booking enabled,
the action names the review step; final acceptance commits the entry and private
posting through the existing combined command, then processes attachments.

| Outcome | UI and retry behavior |
| --- | --- |
| Entry rejected | Keep form, selected files and error; no upload for a nonexistent entry. |
| Entry and selected uploads succeed | Close modal, show confirmation and refresh list/balances. |
| Entry saved, one upload fails | Keep the same form; say the expense was saved and name failed files. Retry failed uploads with their retained operation IDs; do not create another expense. |
| Save response is lost | Retain command ID and input fingerprint; retry the same command through its stored receipt. |
| User leaves with pending files | Confirm discarding pending files. Preserve the expense already saved and explain that state. |
| Editing an existing entry | Saved attachments remain visible in the same form; additions use the same staged controls. |

An already-shared document used to start an expense follows the same explicit
link/retry path. File storage and the expense database write are separate
operations; preserve the upload-intent, parent-access and cleanup mechanisms in
`docs/external-side-effects.md`.

### Tables and filters

Proposed group columns: Group, People, Currency, Your Balance, Status/actions.
Proposed expense columns: Date, Description, Paid/Received By, Amount, Your Share,
Type/status. A repayment row shows sender and recipient. Existing detail views
continue to hold the full allocation and currency-conversion explanation.

Use `Th`, `Td`, table constants, `Badge`, `Pagination`, `CellLabel` and
`useLongPress`. Keep current server ordering and paging; do not sort just one
page as if it were the entire dataset. Table density/column customization is not
an extra deliverable in this iteration. A standard full-page pager is sufficient.

Reuse the filter-panel presentation from `TransactionFilterPanel`; if its
layout must be extracted, share a small presentation component without moving
Transactions filtering/business logic. Group filters cover name and archive
state; entry filters cover text, type, participant and dates. Clear resets the
page. An older response must not replace a newer filter/account selection.

At 320px and 390px, money remains readable, all controls remain reachable, and
the table does not widen the viewport. Check light/dark themes and long translated
labels, including the pseudo-locale. Currency totals remain separated by currency.

### Amount controls

| Field | Currency behavior |
| --- | --- |
| Expense/income/repayment original amount | Existing square currency picker beside the amount; changes apply to the whole entry after explicit handling of dependent amounts. |
| Payer portions and exact shares | Same amount control styling, bound to the entry currency; no independent currency per beneficiary. |
| New personal payment | Standard foreign-currency entry and converted account amount from the normal transaction form. |
| Matched payment or selected source portion | Currency comes from the source account/transaction and is read-only. |
| Percentages, weights and exchange rates | Continue using `NumericInput`; rates retain ten-decimal precision. |

Currency changes invalidate the old preview and explain any reset needed for
entered payer/share amounts. Preserve zero, calculator behavior, locale parsing,
stored four-decimal bank values and currency minor-unit rules.

## 4. Adding to personal transactions

| Situation | Fields shown | Financial effect |
| --- | --- | --- |
| Group-only expense | Group form and optional shared documents | No private transaction or finance-review reminder. |
| I paid; record a new payment | Normal New Transaction form, prefilled amount/date/title, with account, category, payee and standard FX controls | Final reviewed command records one bank movement and the shared posting. |
| I paid; match a whole existing transaction | Search, source summary and allocation preview | Reuse source ID and amount; preserve bank balance and import/reconciliation identity. No global My Category or generic More options. |
| I paid; match part of an existing transaction | Source summary plus explicit shared amount or category-split portions | Preserve unrelated private portions and their categories; show the proposed reclassification before acceptance. |
| Someone else paid my share | Normal new personal-cost form for the managed settlement account, clearly explaining there is no bank payment | Record my share and liability; do not request a fictitious cash/bank account. Category lives in this creation form. |
| My payment spans multiple own sources | A bounded list of normal new-payment forms or matched-source summaries | Preserve the existing contribution-sum check and a single combined acceptance. |

For a matched ordinary row, derive the proposed personal classification from
its original category. For category-split sources, preserve the selected category
portions and allocate the personal share proportionally across those selected
portions using exact arithmetic and stable rounding. Show this proposal before
acceptance; it is not evidence of which individual items a person consumed.
Uncategorized sources remain explicitly uncategorized instead of being assigned
an invented category. Source edits belong in the regular Transactions editor;
returning to matching refreshes the source and invalidates the old preview.

The shared-context form reuses normal controls and validation but does not call
an independent transaction-create endpoint before shared acceptance. Its narrow
draft/submit adapter passes the supported payment fields to the existing scoped
combined operation. Every displayed editable field must be persisted or explicitly
unavailable in this context. Avoid recursive Save & Share, unrelated transfer or
investment modes, and nested competing submit footers.

Cancellation before acceptance leaves financial rows untouched. Preserve the
existing group/account/source locks, ownership checks, revision/fingerprint
validation and command receipts. Keep the existing reviewed exception for
derived shared postings to automatic transaction rules; do not add another
exception or allow rules to change an accepted preview.

### Search across history

Current evidence does not show an API date cutoff: the picker requests 25 rows
and removes ineligible rows after retrieval. Fix the discoverability and paging
contract rather than merely changing a date constant.

Provide All Dates by default, an explicit date range, text search, source amount
and account context, and a normal pager with an eligible-result count. Eligibility
must be applied before pagination. Use the existing transaction-search parsing
and register ordering in a feature-scoped candidate query. Retain the current
owned-account restrictions and recheck the chosen row under the commit locks.
Do not load the entire history into the browser or automatically pick a result.

Distinguish no eligible matches, a loading request and a failed lookup. Changing
account or filters clears stale selection/results and returns to the first page.

## 5. Approved private FX policy

The existing specification explicitly calls for a separate private FX/fee
category line. Ken's requested simplification changes that contract.

Keep FX facts on ordinary transactions and fold the owner's
private conversion cost into the actual personal cost, using the expense's
normal classification. Do not ask for a separate FX category, alter the group's
agreed debt, discard the difference, or fake a same-currency exchange rate.
This follows the normal transaction form's treatment of a foreign-transaction
fee as part of the charged amount, but extends the shared-posting resolver.

The bank transaction retains its real amount, currency, original amount/currency,
rate, date and identity. A matched source's fields are authoritative. New payment
FX uses the normal transaction resolver. Genuine non-shared purchases remain
separate private portions; a difference without foreign-currency/fee evidence is
not silently relabelled as FX.

For an expense, express these magnitudes in the managed settlement currency:

- `G`: accepted group contribution made by this user.
- `S`: this user's accepted group share.
- `A`: actual shared bank payment converted by the accepted private transaction
  rate to the settlement currency. Resolve and freeze that conversion in the
  server preview; same currency uses rate 1.
- `D = A - G`: private conversion/fee difference.
- Actual personal cost is `S + D`; settlement-account inflow is `A`.

The settlement position is therefore `A - (S + D) = G - S`. This preserves the
group receivable while retaining the actual bank outflow. Store the decomposition
in the accepted posting snapshot and expose it from one server resolver, used by
preview and commit. Display group share and actual personal cost with distinct
labels; reporting consumers read the resulting normal category rows. Refund,
income and repayment signs need explicit mirrored cases, including a favorable
difference and a payer with no personal share.

| Example | Expected result |
| --- | --- |
| PLN 120 dinner, three equal shares, I pay PLN 120 | Bank -120; personal cost 40; receivable 80. Matching retains the existing bank row. |
| EUR 100, group agrees PLN 430, I pay PLN 440, my share is half | Group share 215 and receivable 215; actual personal cost 225, including the disclosed private difference 10. Bank -440; settlement +440 -225 =215. No separate FX-category line. |
| Same agreement, bank charges PLN 420 | Group share/receivable remain 215; personal cost 205, including a favorable difference -10. |
| PLN 660 source: shared foreign purchase 440 plus private purchase 220; group agreement as above | Preserve private source portion 220; shared personal cost 225; receivable 215. Total personal cost 445 plus receivable 215 accounts for the bank's 660. |
| USD 100 bank payment, CAD settlement account, accepted private conversion 1.36; group contribution CAD 135 and own share CAD 45 | Settlement inflow 136, personal cost 46, receivable 90. Preserve USD bank amount and the accepted transfer conversion. |
| Missing required private or group conversion | Identify currency pair/date and repair action; withhold private commit until the required input is known. No implicit 0 or rate 1. |

For multiple source categories, apportion the private adjustment over their
selected shared portions with exact units and stable rounding, and disclose it
in the preview. Keep an uncategorized portion uncategorized. An explicit bank
fee may also remain a genuine source split when it was already recorded that way;
do not rewrite the imported source just to make the screen look simpler.

Previously accepted postings are not silently recalculated. Preserve their
accepted snapshot and legacy rows until an explicit reviewed replacement.
Retain compatibility when reading old inputs containing `fxCategoryId`; the new
UI does not ask for it. Unlink/restore must reconstruct the original bank source,
including its prior categories and FX metadata. This adjustment uses
existing transaction columns and posting snapshots; a schema migration is not
assumed or included in this approval.

## 6. Invariants and acceptance tests

Relevant existing IDs: SE-001, SE-003 through SE-009, SE-011, SE-012;
INV-BALANCE-001, INV-TRANSFER-001, INV-RECONCILE-001, INV-FX-001,
INV-FX-002, INV-FX-004, INV-CACHE-001, INV-ATTACHMENT-001 and INV-DISPLAY-001.

| Area | Required evidence |
| --- | --- |
| Save/documents | Modal closes after success; staged scan/file survives edits; partial upload retry does not duplicate an expense/file; discard and browser Back preserve the correct saved state. |
| Tables/filters | Desktop and mobile flows, row activation by keyboard/touch, reset/paging, no horizontal overflow, failed/stale requests, zero versus unknown totals. |
| Money controls | 0/2/3/4-decimal currencies, comma-decimal input, calculator, currency change, read-only account currency, unchanged stored bank precision. |
| New transaction form | Standard form integration, prefill, cancel, one submit, server rejection, preview/commit equality, existing standalone TransactionForm behavior. |
| Matching | Whole source, partial source, category splits, uncategorized source, multiple sources, old transaction beyond page one, newer ineligible rows, source changed/claimed/reconciled after preview, foreign owner/delegate denial. |
| Category/FX | Numerical table above plus refund/income/repayment signs, zero own share, favorable difference, missing rate, same-currency genuine private remainder, report/budget totals and unmodified group debt. |
| Compatibility | Previously accepted posting, explicit replacement, unlink, private source restore, revoked group access and no private attachments in group responses. |

Use focused UI/unit tests while developing, PostgreSQL with enforced RLS for
queries and financial writes, and production-build browser journeys with reload
assertions for the changed flows. Add a regression or mechanical guard for the
human-reported convention mistakes using existing abstractions; keep current
guard baselines and allowlists unchanged.

Implementation verification is recorded separately from the specification. The implementation gate and
resource limits are in `docs/future-plans/shared-expenses-ui-polish-tasks.md`.
After verification, post NEW comments in the Discussion and issue with working
screenshots and the actual tested revision; keep older comments as history.
