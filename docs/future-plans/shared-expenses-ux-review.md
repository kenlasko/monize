# Shared expenses: UX review and refinement

Date: 2026-10-27. Starting implementation: `d83568b96`.
Requested outcome: replace the daily Tricount/Monize double entry with a familiar,
pleasant shared-expense workflow and optional private accounting integration.
Tracking: [Issue #1891](https://github.com/kenlasko/monize/issues/1891),
[scope discussion](https://github.com/kenlasko/monize/discussions/1889) and
[draft PR](https://github.com/kenlasko/monize/pull/1890).

This is a code and interface review with automated browser verification, not a
human usability study. The financial and privacy boundaries remain those in the
[requester-accepted interaction contract](../specs/shared-expenses-ux.md).

## References and method

Tricount's [custom split flow](https://www.tricount.com/en-us/features/custom-split-expenses)
keeps the bill, payer, participants and final check together. The reviewed open
source references are [Spliit](https://github.com/spliit-app/spliit) and
[SplitPro](https://github.com/oss-apps/split-pro); pinned source observations are
in the [research record](../specs/shared-expenses-research.md). The relevant ideas
are quick ordinary entry, optional custom allocations and readable personal
balances. No upstream code, brand assets or authentication model is copied.

Review tasks: enter an ordinary bill, change its total after an exact split,
allocate a remainder, record a partial repayment, and match an imported bank
payment. Inspect 1440px desktop and 360px mobile views, including delayed or
failed previews. New calculations are not introduced by this pass: accepted
shares and personal effects still come from the server's preview.

## Findings and changes

| Finding                                                | Before                                                                         | Refinement                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| An ordinary expense needs an extra preview action      | The user fills a valid bill, presses Review split, then Save                   | A 400ms typing pause requests the server preview; Save remains disabled until its group, entry and input identity match the draft  |
| A changed exact total can strand the reader            | Preview is the first place an unfinished allocation is reported                | The existing split validator explains that the split needs another review; incomplete payer contributions get their own correction |
| Exact split helpers compete with a finished allocation | Each row offers a remainder action even at zero; extras instructions stay open | A completed allocation says Ready to apply; remainder actions appear for a positive remainder; extras are an explicit disclosure   |
| Switching back to one payer has a misleading caption   | More than one person paid labels both directions                               | The return action says Use one person; receipt of income/refunds uses receiving language                                           |
| The group preview uses ledger terminology              | A cost appears as a negative categorized amount                                | The preview reuses the entry list's payer and positive personal-cost readout; the position delta stays separately labelled         |
| Mobile balances start too far down the page            | Three stacked cards and a full-width Refresh precede the tabs                  | Own balance keeps priority; secondary cards share space when amounts fit, and Refresh is a labelled icon beside Add expense        |

The balances header also offers the shared, keyboard/touch-accessible help control
to explain why a suggested recipient may differ from the person who paid an
individual bill: suggestions use the group’s net positions.

Visual inspection of the first passing browser run exposed another issue:
scrolling to the proposal hid the form's title, bill context and actions. Entry,
split and private-booking forms now use the existing fixed-height modal with a
scrolling body and a full-screen phone layout. The ordinary entry keeps its title
and amount in the header, pairs related fields, and collapses the equal-share
breakdown. Help uses the standard tooltip; private-finance detail appears after
opt-in. Browser assertions check that the title and acceptance action stay in the
viewport after scrolling to the proposal. The passing suite alone did not reveal
this usability defect; the captures prompted the additional assertions.

The preview is read-only. A save still sends its server fingerprint and the
existing command identity. Retries after a lost save response retain both;
an old response cannot enable saving a different draft because the request key
contains group, entry and the serialized input, and the loading hook retires
superseded requests. Private finance inclusion still requires explicit opt-in.

## Currency and existing-payment follow-up

The [maintainer's walkthrough feedback](https://github.com/kenlasko/monize/discussions/1889#discussioncomment-19221359)
adds a concrete acceptance journey: a trip with USD and CAD expenses, starting
from a payment already recorded in Monize.

Money fields already use `CurrencyInput` through `SharedMoneyInput`. The audit
found that its selected precision did not reach calculator evaluation, calculator
opening or zero-on-focus handling. Those paths now use the same precision as
typing; behavioral regressions cover zero, two, three and four decimals.

USD and CAD share a narrow dollar symbol. Original receipts now carry their ISO
code when their currency differs from the group's, and the summary names the
balance currency. Preview and saved detail show the server's converted amount,
accepted rate, source and observation date. No new rate lookup or client-side
recalculation is introduced. Missing conversions remain unknown and known zero
remains zero.

The browser journey starts with a tagged USD 900 bank payment, shares it into
a CAD group at 1.35, adds CAD 135 fuel, and records a CAD 100 repayment. Reload
assertions check CAD 1,350 total, CAD 450 personal cost and CAD 665 still owed to
the cabin payer, while preserving the original transaction ID, tag and USD 1,100
bank balance. Filtering by a trip tag uses the existing register; each chosen
row still receives an explicit sharing review. Batch import by tag is a separate
Phase 2 proposal, consistent with the request for a small first version.

Asserting the destination screen exposed a navigation defect in the bank-entry
flow: closing the saved dialog pushed the group route before the modal's queued
history pop, which then returned the user to the bank-entry page. The flow now
closes its dialogs and uses `afterModalHistoryPop`, as the existing UI convention
requires. Both bank-start browser journeys assert the group heading before
reloading and checking the saved result.

## Verification and limits

Focused tests cover delayed and out-of-order responses, preview retry, unchanged
save retry identity, incomplete allocations, optional extras and cancellation.
Browser journeys retain their persistence and bank-balance checks; their save
actions now wait for the automatic preview rather than asking for a second one.
Final results and captures are recorded in the [task ledger](shared-expenses-tasks.md).

Still requiring people rather than automated checks: the five-person formative
study from the UX contract, comfort with the private-ledger vocabulary, and
whether group navigation remains easy with long histories. Existing pending
maintainer scope/security approval and the smaller review-series agreement are
separate from this refinement.

## Maintainer feedback iteration

The follow-up prioritizes the maintainer’s Transactions-to-Shared-Expenses request.
A new payment offers **Save & Share** in the existing submit dropdown. The existing
transaction save completes first; the host then closes its modal through
`afterModalHistoryPop` and opens the saved row’s sharing flow. The choice is local
to that form and does not change the stored Create/Create & New preference.
Selecting a group, reviewing the split and accepting the personal-finance preview
remain explicit actions. Matching an older group entry is a collapsed secondary
path, loaded only when requested.

This iteration also adopts the navigation position, profile-name default, red
remove button, toggles, Add Expense dropdown and action wording requested by the
maintainer. Cancellation explains the retained history and its effect on balances.
The group’s managed account remains an OTHER account with SHARED_SETTLEMENT purpose;
there is no new AccountType. The copy explains that it tracks debts rather than
spendable cash.

Connecting a group does not select every entry for personal finances. The shared
review resolver retains NOT_BOOKED/MISSING_RATE information but sets needsReview
only for a previously accepted posting with a changed effect or unavailable
conversion. All consumers use that resolver; optional group-only entries no longer
raise a global review banner. Changed accepted entries and revoked access retain
their existing warnings.

The same author reviewed three areas: Monize controls and the normal workflow;
financial/privacy boundaries; and failure/recovery behavior. This is not three
independent reviews or a human usability study. Unit regressions cover the
profile/currency defaults, optional review, unsaved-document cancellation,
single-save handoff, failed saves and stale group/search results. Inspection found
one adjacent payment-editor defect: converting one source into multiple payments
dropped its selected category portions. The conversion now retains sourceSplits;
a UI test checks the original portions in the next server-preview request.

No balance formula, ownership policy, schema, dependency or guard threshold changes
in this iteration. Existing transactions still use the shared finance plan for
preview and commit, group/account/row locks, revision and fingerprint checks,
command receipts and post-commit balance-cache invalidation.

Verification results and new captures are recorded in the task ledger. The requester capped further iteration: finish this change and
fix publication-blocking failures only. Long-history usability, the planned human
study and maintainer scope/review-series approval remain open.
