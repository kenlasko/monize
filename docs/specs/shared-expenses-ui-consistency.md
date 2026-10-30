# Shared expenses: unified split and screen consistency

Status: requester-authorized refinement, 29 October 2026. The request to read
and implement the feedback authorizes this iteration; upstream acceptance and
the `approved-to-build` label remain separate.

Sources: [WMP's review](https://github.com/kenlasko/monize/discussions/1889#discussioncomment-19254373),
its follow-up about the transaction dialog, and the approved
`docs/frontend/screens-and-dialogs.md` contract. This refines the presentation
in `docs/specs/shared-expenses-ui-polish.md`; its group-only boundary still holds.

## Scope

Use existing dialog, form, summary, tab, table, filter, attachment and paging
components. Short Title Case labels and `InfoTooltip` replace instructional
labels and passive help blocks. Settlement Currency explains the currency of
group balances even when individual purchases use another currency. Keep
Activity, independent payers/beneficiaries, selected people and explicit zero.
Do not add accounts, posting, transaction matching, dependencies or migrations.

The shared `Modal` chrome is being handled separately by WMP. Keep its accessible
`title`; do not patch global chrome or add a second header. Use the normal
transaction form's presentation controls, not its private-transaction submission
path. Single-save forms use `FormActions`; no invented second save action.

## Unified split editor

One participant list replaces the split-mode tabs. Amount, percentage and relative
shares are adjacent ways to edit the same split, with a keyboard-accessible
percentage slider and an Equal reset. Editing amounts or percentages pins those
values; clearing a field releases it to the equal remainder. Excluding a person
does not remove them from the group or alter the payer. Relative shares use the
existing WEIGHT instructions. Existing exact/percentage instructions open pinned.

Keep the current input unchanged until Apply. Opening and applying an unedited
split retains its mode/instructions and backend rounding seed. Use the existing
`splitRemainderEqually` helper for explicit remainder instructions and the existing
server preview for rounded final amounts. Percentage/weight readouts are ratios,
not a second allocation algorithm. Applying an edit updates the parent draft;
only the parent's current accepted server preview can enable the expense save.

The split preview may use a temporary description and a neutral contribution
when those unrelated fields are unfinished. It performs no write, preserves the
operation/entry identity and only supplies SHARE allocations to this dialog.
The expense preview still validates the actual description and payer totals.
An old or failed preview never supplies amounts for the current draft. Missing
amounts are disclosed, not replaced by zero. Templates edit proportions without
presenting their artificial basis as money.

| Input | Expected result |
| --- | --- |
| Three people, 400, equal | Server allocates 133.34/133.33/133.33 according to the existing seed; opening the editor does not move the extra cent. |
| 400, one fixed coffee of 20, two unfilled people | EXACT 20/190/190. |
| 100, fixed 20 and explicit 0, three unfilled people | 20/0/26.67/26.67/26.66 using the existing remainder helper. An excluded sixth person has no share. |
| One fixed 40 percent, two unfilled people | PERCENT 40/30/30. |
| All percentage fields explicitly total 99.99 | Refuse Apply; identify the missing 0.01. Do not normalize explicit values. |
| Fixed amounts exceed total, or all shares are zero | Refuse Apply; retain editable values. |
| Relative shares 2/1/1 | Server allocates half/quarter/quarter with existing rounding. |
| Cancel, unchanged edit, delayed or failed preview | Cancel leaves parent untouched; unchanged edit round-trips; stale amounts are withheld. |

## Screens and evidence

Overview: summary cards with icons, live placeholder search, Active/Archived
counts, header Refresh, navigation Tabs and the existing table/pager. Detail:
Back to Shared Expenses, summary cards, Tabs including Activity, live debounced
search, visible People/From/To filters, `ListTopToolbar` export and normal pager.
Keep stale-row actions disabled while a newer filter request is pending.

Attachments share the existing header with Scan/Add/Share a Private Document;
plain empty text replaces the decorative empty card. Repayment suggestions and
Record Other Repayment use outline buttons. Existing managed-account editing
gets a visible switch label, secondary finance navigation and one primary save.

Relevant invariants: SE-001, SE-003 through SE-009, SE-012, INV-DISPLAY-001.
Financial allocation and authorization mechanisms are unchanged. Focused tests
cover the numerical table, cancellation, stale preview, navigation, visibility,
upload retry and managed-account controls. Check actual browser persistence and
320/390px layouts; capture synthetic-data screenshots after the production build.


## Final review refinements, 30 October 2026

Requester-authorized follow-up to [Ken's layout review](https://github.com/kenlasko/monize/pull/1890#issuecomment-6511645356)
and [notification review](https://github.com/kenlasko/monize/pull/1890#issuecomment-6511698709).
Main's common Modal changes have landed and are adopted through a normal merge.

- Give overview and group tab panels explicit top padding, and separate expense
  attachments from the preceding fields/preview. Verify rendered gaps on desktop
  and phone; layout spacing must not depend on component fragments.
- Use ListTopToolbar inside the group/expense list card with all paging props,
  including filtered single-page counts; retain ListBottomPager outside it.
  Both controls share page state and cannot act on stale server results.
- Remove shared review notices from the global financial shell. Real activity
  already uses Notifications with recipient preferences and delivery receipts.
  The explicit review page shows actionable/revoked groups only, with a plain
  empty state for known zero, retry for failure and no old-user response leak.
- Preserve group-only creation, all financial/authorization rules and legacy
  private-record access. No new API, financial calculation or translation key
  is planned. Existing dialog cancel/close actions must survive main's new chrome.

Regression matrix: empty/current/changed/revoked/failed review; delegate, sign-out
and late old-user response; filtered single-page and multi-page lists; actual tab
and attachment geometry at 390px and desktop. Run focused tests and the frontend
gate once, then native PostgreSQL/browser acceptance without Docker.

CI follow-up: the preceding head also failed the security scan on three replay
fingerprint comparisons and a browser-history marker named as a token. Use the
existing timing-safe digest comparator for server receipts, and name the local
history entry as such. Extract the support-backup table exclusions without
changing their members to meet the existing 800-line module guard. The two
calendar/expiry fixture failures are already fixed by the merged main. No scanner
exception, test baseline, coverage threshold or workflow is changed.

## Navigation and walkthrough follow-up

Ken's 30 October follow-up places Shared expenses only in Tools, so remove the
dashboard greeting shortcut and retain the registered desktop/mobile navigation.
WMP also requests a guided tour. Register a 1.20 walkthrough in the existing
tour engine: discover Tools and New Group, choose a group, and explain purchases,
splits, balances and repayments. Its data-only definition uses the existing
engine, which saves tour progress. Creating or changing a group or financial
record remains the user's explicit form action.
Offer it only in the reader's own view. On phones omit the desktop menu anchor.
Anchor group selection to the loaded list. Reuse the existing tooltip placement
resolver for the phone sheet: flip it above a low anchor so it does not cover a
short page's last row, which scrolling alone cannot uncover.
If the reader skips choosing a group, the existing dynamic-route reachability
mechanism must skip those detail steps instead of waiting on an invented group.

Test the dashboard regression against the original shortcut, desktop and phone
tour completion, skipping an unavailable group, replay after reload and no new group
or expense from the walkthrough. Translate the final copy into every locale.
Use the current documentation capture tools for the changed screen and tour.
The existing-transaction handoff remains the previously agreed separate phase;
this walkthrough must not offer the deferred private-finance actions.
