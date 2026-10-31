# Shared expenses: interaction and document contract

Current delivery boundary: `docs/specs/shared-expenses-ui-polish.md` section 0
supersedes the private-finance creation and Transactions handoff behavior below.
New booking is deferred; existing private records remain readable/unlinkable.
The accounting definitions below are retained for those accepted records.


Status: **implementation authorized by the requesting user**. Date: 2026-10-25.
Upstream maintainer approval has not been claimed.
Part of the [product specification](shared-expenses.md); the
[research record](shared-expenses-research.md) identifies source evidence.
This document defines proposed behavior and acceptance, not an implementation
plan or evidence that a prototype has passed usability tests.

## 1. Product boundary and feasibility

Shared expenses must work with names, amounts and optional documents before the
user configures a bank connection or invites anyone. Personal finance integration
adds a private accounting view to that working group. Joining a group, uploading
a photo or selecting a split never requires sharing a bank account.

The source review supports this architecture: Monize already has ledger transfers,
category splits, attachment storage, a scanner and a document viewer. It has no
group participant/allocation journal or membership-authorized document parent.
Those are new domain work. A category split is not a person's share, and a joint
bank account is not a group. Their different meanings must survive the integration.

Three boundaries need implementation evidence before calling the feature ready:

| Boundary | Required proof |
| --- | --- |
| Group journal to private finances | The real ledger and reports reproduce the numerical examples without a second bank debit, a repayment counted as income or receivables counted as available cash. |
| Private document to shared document | Independent copies and current-membership checks protect metadata, bytes and original photos, including after revoke/delete/restore. |
| Friendly input to exact money | The same accepted allocation survives save/reopen, currency precision, total changes, retries and participant changes. |

These are feasible extensions, not capabilities established by similar frontend
frameworks in the upstream projects. The eventual plan must sequence them into
reviewable changes; fitting the whole feature into one large PR is not a product
acceptance criterion.

## 2. One short entry form, three starting points

The ordinary form has amount, description, payer and beneficiaries. The date is
visible with today's value; equal split and group currency are defaults. A short
preview shows the reader's cost and the position change caused by this entry.
Documents and private finance integration are secondary sections, with explicit
audience labels. Advanced split options appear only when selected.

Illustrative Polish mobile copy, not a new design system:

```text
Dodaj wydatek                              Zamknij

300,00 PLN
Kolacja
Dzisiaj                            Zmień datę

Zapłacił: Ty                       Zmień
Dla: Ty, Ania, Bartek              Zmień
Podział: Po równo                  Zmień

Twój koszt: 100,00 zł
Ten wydatek zwiększy należność o 200,00 zł

Paragon lub plik                   Dodaj / Skanuj
Widoczny dla osób z dostępem do tej grupy

Moje finanse                      Nie uwzględniaj
Widoczne tylko dla Ciebie

                      Dodaj wydatek
```

The position delta is labelled as this entry's effect, not as the group's entire
outstanding debt. Amounts use the reader's locale and explicit currency.

| Start | Prefilled information | What the user still decides |
| --- | --- | --- |
| Group: Add expense | Group, date, reader as payer, equal shares | Amount, title and any exceptions. A bank account is optional. |
| Bank row: Split with people | Actual bank row, amount/date/currency, proposed title | Group, shared portion, participants, split and exactly which documents to publish. |
| Files: Add photo/PDF | Group and selected file | Save a standalone group document, or explicitly use it to start an expense. No amount is invented from the file. |

Bank descriptions are suggestions for a shared title; the publication preview
shows the final text. Linking does not automatically publish private notes, tags,
account names, payee contact details or documents.

The file-first path returns to the saved document when expense entry is cancelled.
A group-only file can later be attached to one expense through an authorized
parent change, with revision checking and activity; it is moved, not duplicated.
The Files view also lists entry-owned documents, so attaching a file does not make
it disappear. Reusing it for another expense requires an explicitly created copy.

## 3. Split editor: meaning before controls

The editor says who benefits separately from who paid. Every selected person has
a visible final amount. Four primary modes use words as well as icons:

| Mode / Polish label | User input | Numerical example |
| --- | --- | --- |
| Equal / Po równo | Select beneficiaries | PLN 300, three people: 100 / 100 / 100. |
| Exact / Kwoty | Enter each person's final amount | PLN 300: 80 / 110 / 110. |
| Percentage / Procenty | Percentages that sum to 100 | PLN 300 at 50 / 30 / 20 percent: 150 / 90 / 60. |
| Weights / Udziały | Relative units, optionally labelled nights or tickets | PLN 480 at 2 / 1 / 1 nights: 240 / 120 / 120. |

Weight units describe a relative allocation, not calendar pricing. Different
nightly prices require explicit amounts or separate expense entries. The UI must
not imply that counting nights reconstructs a varying hotel tariff.

Selecting a person and assigning zero are different from leaving their required
amount blank. At least one beneficiary must have a positive share. A payer can
be excluded from beneficiaries, and a beneficiary can have paid nothing.
Multiple payers have their own contribution editor with a separate remainder.
Beneficiary amounts and payer amounts must each equal the expense total.

### Useful helpers inside exact amounts

Helpers calculate a preview; Apply copies the proposed exact amounts into the
editor. The saved financial mode remains exact amounts. Reopening reads those
amounts, not a hidden formula that silently reallocates the bill.

- **Fill the remainder:** keep the explicit PLN 80 assigned to me and divide
  the remaining PLN 220 between the two explicitly selected recipients: 110 each.
  The action names the recipients. It does not overwrite other filled amounts.
  Selected people with blank amounts are the remainder recipients; an entered
  zero stays zero, and an unselected person is excluded without leaving the
  group. `splitRemainderEqually` in `frontend/src/lib/shared-split-draft.ts`
  reuses the existing fixed-unit allocation and fills only those blank rows.
  This is an explicit action before Apply, not a recalculation on every edit.
- **Extras plus equal remainder:** on a PLN 300 bill, assign me an extra PLN 60
  and split the remaining PLN 240 across all three: 140 / 80 / 80. This differs
  from fixing my final share at PLN 60, which would yield 60 / 120 / 120.
  Show both the extra and the final amount so these two intentions cannot be
  confused. Negative extras or extras over the bill total are refused by input
  validation; ordinary discounts can be entered in the final exact amounts.

Do not add a primary mode for every convenience. Receipt item recognition, tip/tax
allocation and line-by-line ownership are later work. A photo plus exact amounts
supports manual allocation now; the application does not claim to read the photo.

```text
Podział: Kwoty                         Anuluj

Ty          80,00 zł
Ania        [kwota]
Bartek      [kwota]

Pozostało 220,00 zł
Podziel resztę między Anię i Bartka

Po zastosowaniu: 80,00 / 110,00 / 110,00 zł
                            Zastosuj podział
```

### Editing without losing intent

| Change | Required behavior |
| --- | --- |
| Total changes in equal/weights/percent mode | Preserve selected people and relative inputs, recompute the preview, show changed amounts. Percentages still need to sum to 100. |
| Total changes in exact mode | Keep all typed amounts. Show the remaining/excess amount and explicit redistribution actions. |
| Switch to a mode for the first time | Equal starts with selected people; weights start with one unit each; exact is seeded with the currently valid displayed allocation. Percentage starts with equal percentages only when exactly representable at 0.01 percent, otherwise leaves an explicit remainder to assign. |
| Switch away and back before applying | Keep each mode's draft inputs in the editor session. Only the currently applied mode is saved. |
| Add a group participant | Existing entries retain their beneficiaries. A new expense uses the current active participants unless an explicit saved template says otherwise. A template that omits the new person calls that out. |
| Exclude someone in equal/weights mode | Preview the recalculation among the remaining selected people. Saved historical rows change only after Apply and Save. |
| Exclude someone in exact/percent mode | Remove that person's allocation in the draft and show the remainder; no silent redistribution. |
| Change the expense currency | Ask for the amount in the new currency and review the new allocation/rate. Do not relabel existing numbers as a conversion. Group settlement currency remains fixed. |
| Cancel split editing / browser Back | Return to the expense form with its previously applied split. An invalid sub-editor is cancellable; it must not trap the user. |
| Reopen and save without changes | Preserve instructions, accepted amounts, FX inputs and rounding seed. Reordering names does not shift a cent. |

Use a 0.01-percent input precision and up to four fractional digits for weights,
represented as scaled values. Equal mode handles thirds without requiring users
to enter 33.33 percent three times. Percentage mode with 99.99 percent shows
0.01 percent remaining; the user chooses the recipient instead of an automatic
normalization. Rounding cents in a valid percentage or weight allocation follows
the product specification's deterministic allocation resolver.

Messages identify the correction: “Pozostało 20,00 zł”, “Przydzielono o 10,00 zł
za dużo”, “Pozostało 5%”. Errors sit beside the responsible field and in the
summary. A pending server preview cannot replace newer typed inputs; Save uses
the preview's input/revision identity. A failed preview offers retry and retains
the draft, without showing a provisional value as an accepted debt.

An owner can explicitly save beneficiaries and relative shares as a default for
future expenses. Saving one unusual dinner does not change the group's default.
An exact-amount template is outside the first release because a new bill needs
new absolute amounts. No setting rewrites older expenses.

## 4. Photos and files are useful without financial setup

The group has **Expenses / Balances / Files / Activity**. Files is a unified list
of documents attached directly to the group and documents attached to its entries.
The list names each file's parent, uploader and date. Filters distinguish group
documents from receipts; opening a receipt offers its related expense.

Supported first-release cases include a restaurant photo, a multipage invoice
PDF, two photos of a long receipt, a booking confirmation before spending is known,
and a repayment confirmation. A repayment attachment documents a recorded claim;
it does not certify that a bank has settled it. A trip photo is an ordinary group
file with no balance effect, not a separate social feed.

Reuse Monize's existing [attachment section](../../frontend/src/components/transactions/AttachmentsSection.tsx),
[document scanner](../../frontend/src/components/transactions/DocumentScanDialog.tsx)
and [preview](../../frontend/src/components/transactions/AttachmentPreviewDialog.tsx)
after extending their parent support. Keep the shared viewer's zoom, multipage
PDF rendering, download action and typed failure states.

Proposed limits preserve the current MIME allowlist and 10 MiB per stored object,
with 10 visible documents per entry and a separate 50 directly on the group.
A scan plus an explicitly retained original counts as one visible document but
two size-checked objects. Capacity checks run under the parent lock. Pagination
of Files counts entries' files too; the group-direct cap is not a cap on every
receipt throughout the group.

Camera/scan and Choose file are separate actions. Plain upload keeps the file as
selected. Scan lets the user review crop, rotation and readability. The existing
scanner's large-input/smaller-output policy stays intact. An unsupported file
names the accepted formats; an HEIC selection is offered the scanner where the
browser can decode it, otherwise asks for JPEG/PNG. Do not promise universal
HEIC decoding from an `image/*` picker.

### Publication and privacy

| File's origin | Default audience / action | Effect of deletion or later editing |
| --- | --- | --- |
| Uploaded through group Files or a group expense | Group, stated before upload, including future members who gain access to history | Removing it affects this shared copy and writes activity; balances remain unchanged. |
| Already attached to my bank transaction/warranty | Private; nothing selected for sharing | Unshared originals retain their private access and lifecycle. |
| Selected for publication from my private documents | Preview the exact selected bytes, filename and group; create new shared attachment/bytes after confirmation | Deleting the shared copy leaves the private original. Deleting/editing the private original does not change the shared copy. |
| Scan with enhanced and original images | Publish the selected processed image; original sharing off by default, with a separate preview/opt-in | Cropping does not expose the original through a secondary viewer action unless that original was explicitly published. |

The existing scanner often returns both images; that behavior must not silently
choose the audience. This publication boundary is an explicit extension of the
scan flow. Cropping is not advertised as PDF redaction. Plain uploads retain
their content and metadata; the preview explains that the selected file is shared.

A private document chosen from a warranty reached through a transaction follows
the same publication rules as one attached directly to that transaction. Private
source IDs and provenance stay in the publisher's private scope, not group DTOs.

Group read permission is checked for both document metadata and bytes. Uploaders
do not retain group access after revocation merely because their user ID is on
the attachment. Group documents survive an uploader leaving; user-erasure policy
must preserve the agreed group history and avoid cascading the shared objects.
Downloaded copies are outside subsequent access revocation.

Editors may add documents to readable group entries, including another author's,
without acquiring permission to alter that entry's amount. They rename/remove
their own uploads; the group owner can manage all with an activity record.
Viewers read only. Archived groups keep readable files; writes require reopening.
File changes use document revision and expected parent identity, with current
membership/lifecycle checks under the parent lock. They do not increment the
group's financial revision or invalidate an unchanged settlement suggestion.

### Save and failure states

Financial entry creation and file upload are separate outcomes. A successful
expense with two of three uploaded files says “Wydatek zapisany. 1 plik wymaga
ponowienia”, identifies that file and retries only its upload. It never offers
to recreate the expense. Attachment failure alone does not invalidate a known
expense balance or create financial review work.

Each file operation carries a client operation ID backed by a durable result and
payload digest. The same retry returns the stored attachment; a conflicting
payload is refused. A timeout checks that operation before posting again. A
parent revocation/deletion during upload is refused under the final parent lock;
unreferenced bytes go through the existing intent/tombstone cleanup. A failed
copy keeps the private source intact. A broken image is shown as a failed load,
not as evidence that no receipt was attached.

Pending files stay in the current form session until uploaded or explicitly
discarded. Navigation warns about pending/failed files; reload recovery and
offline file queues are not promised. A server-saved document can be reopened
from Files. Sensitive draft amounts and photos are not put in localStorage.

## 5. Personal finance integration stays understandable

The 27 October maintainer-feedback iteration keeps the standalone group as the
default. Enabling private finances does not enrol every group entry: each entry
is included only after its owner accepts its preview. An unbooked entry remains
available to add later, without a pending-review count or a financial-page
banner. Missing rates on unbooked entries remain repairable in the group.
Changes to an already accepted posting, lost group access and a failed review
request still disclose that the reports use previously accepted figures. A
successful check with no such issue displays no banner. Group activity continues
to use the existing notification centre, including its reminder action.

Use Monize's existing switches for on/off options and its transaction-action
dropdown pattern for Expense and Income. Place Shared expenses between Warranties
and Taxes. A new group starts with the profile's first name, still editable; an
untouched default is not an unsaved edit. Remove a draft participant with an
accessible red cross beside their name. English action labels use Title Case.

Private setup explains the managed account as a record of money owed to or by
the reader, not a payment account. Its name is an optional setting. The booking
form leads with the personal category and necessary payment; partial payments,
additional payments and other private adjustments are progressive options.
Use "My Finances" and "transactions" in the interface rather than "ledger".
"Cancel Entry" explains that its group effect is removed while its history is
retained; accepted private transactions still require their owner's review.
Pending attachments require the same leave confirmation before cancellation as
before editing or closing an entry.

The follow-up feedback prioritizes starting in Transactions. Its existing save
dropdown offers "Save & Share" for a new transaction on the reader's own
payment account. Saving happens once; closing the form and its history entry
precedes navigation to the shared-expense flow. That flow reuses the saved row's
amount, date and identity. Choosing a group leads with creating the expense;
matching a previously recorded expense is an expandable alternative. The sharing
choice is per transaction, not a persisted change to the ordinary save action.
No group entry or private attachment is published merely by saving the bank row.

Group creation starts with Group only. “Include in my finances” is the one-time
opt-in, with a preview of costs, receivables/payables and any historical items
needing a bank match. The application manages the settlement account; users do
not need to create an OTHER account or understand transfer legs.
Group-only entries leave existing bank categories and budget figures as they are;
the private-cost adjustment starts when the user accepts the integration preview.
The bank register retains the real amount and shows “Shared expense / your share”
with a link, rather than forcing the user to interpret the managed transfer legs.

The group screen names the three states in ordinary language: “Tylko w grupie”,
“Uwzględnione w moich finansach”, “2 zmiany do sprawdzenia”. Account selection,
category mapping and bank candidates appear only in the private section. A
remembered own-account choice is visible and editable before each Save.

| Real situation | User interaction and financial result |
| --- | --- |
| Bank purchase PLN 350, of which PLN 50 is private; shared PLN 300 with my share PLN 80 | Pick “Only part is shared”, enter 300, split it. Preview: bank -350 unchanged, my costs 50 + 80 = 130, receivable 220. |
| I paid 200, Anna paid 100 toward one PLN 300 bill; shares 80 / 110 / 110 | One expense, two payers. Positions: me +120, Anna -10, Bartek -110. My bank match is 200, not the entire 300. |
| Start from my PLN 200 row but the receipt total was 300 | “This was my part of a larger bill” reveals total and other payer contributions. Do not infer that my bank amount was the whole bill. |
| An expense is already in the group when my bank import arrives | Suggest matching it; the user confirms. Keep one group expense and one real bank effect. Equal amount/date is a candidate, not identity. |
| Two of my own accounts funded one contribution | Explicitly map both real rows to that entry; their contribution amounts must sum to my declared payment. Do not require another fake participant. |
| Someone else paid and my share is 60 | Accept my cost/payable of 60 without choosing a bank account. Choose/match a bank row when I later repay. |
| My share changes from 80 to 100 after my bank payment was booked | Review says cost +20, receivable -20, bank unchanged. Accepting the existing mapping does not require entering the account again. |

For my own new expense, saving the group entry can also accept the displayed
private posting in one command. Other members' financial edits to entries I have
already accepted create a review item for my affected finances. Group totals remain current; personal
reports retain accepted figures and explain the pending changes. A receipt,
participant rename or unchanged financial input does not require a finance review.

Historical enablement lists unresolved mappings instead of fabricating bank
movements or claiming the whole group is synchronized. The user can keep the
group usable while completing their private mappings. Existing reconciled rows
retain Monize's reconciliation lock and explain how to resolve it.

## 6. Balances and corrections that people can explain

The summary separates my cost, my paid amount and my remaining position. A
suggested transfer has a short “Why this person?” explanation. The People view
keeps groups separate; a net group debtor is not automatically my direct debtor.

“Record repayment” opens amount, from, to and date with a suggested amount filled
in. Partial repayment is ordinary: a debt of 100, payment of 40, remainder 60.
The user optionally matches their own bank side. The opposite party's account
is not needed. A saved payment identifies who recorded it and can be reversed
with history; a photo is optional evidence, not a required approval workflow.

Changing a paid expense shows the old and proposed shares and explains that the
recorded payments stay in history. A later refund uses the original expense's
refundable shares, not the group's newest equal-split default. Fully settled
groups can acquire a balance again after a refund/correction; archiving does not
erase it. Unsupported cases, such as one bank row repaying several groups, name
the boundary rather than silently allocating everything to the selected group.

## 7. Reviewable acceptance scenarios

Automated scenarios below complement the financial matrix in the main spec.
They describe expected observable behavior, not a request to write tests in this
documentation change.

| Scenario | Required observation |
| --- | --- |
| Solo start, then invite | A group with named people accepts expenses and photos before invitations; later claiming a participant preserves earlier shares. |
| Exact 80 + remainder on 300 | Explicit action yields 80 / 110 / 110; save/reopen preserves it. Changing total to 330 leaves 30 to allocate. |
| Extra 60 on 300 | Helper previews 140 / 80 / 80; it does not confuse extra 60 with final share 60. |
| 100 split three ways | Amounts sum to 100.00; changing name order/reopening keeps the same cent recipient. |
| Percent 33.33 each | Show 0.01 percent remaining and refuse final acceptance until assigned. Equal thirds remain one action in equal mode. |
| Child or shorter stay | Weights 2 / 2 / 1 on 500 give 200 / 200 / 100; excluding a nonparticipant is explicit. |
| Mode switch / cancel | Typed custom allocations survive switching back; cancelling restores the parent form's applied split. |
| Multiple payers | Both contribution and beneficiary sums are enforced; a person who paid zero can owe money. |
| File without amount | Booking PDF can be saved directly to group Files with no ledger entry or balance change. |
| Private transaction with three files | Publishing one exposes exactly that selected copy to another member; private file IDs/bytes remain unavailable. |
| Cropped scan with original | Group member can see the published crop, cannot fetch an unpublished original, including by known attachment ID. |
| Copy/delete/revoke | Deleting either copy leaves the other intact; revocation blocks later metadata/byte reads, including by former uploader. |
| Upload fails after saved expense | Retry adds the missing file once and leaves financial totals unchanged. Lost-response recovery uses the operation result. |
| Reconciled bank row / duplicate import | Lock refusal has no group/ledger side effect; confirmed matching preserves one economic payment. |
| Foreign bill / JPY / KWD | Original/group/bank values stay distinct; money entry respects currency precision; missing FX names the missing pair. |
| Partial repayment / refund after settlement | Show remaining debt or reopened balance and retain earlier repayments. |
| Other member edits my share | Group changes immediately; my accounts stay at their accepted version until I review; file-only edits do not trigger that review. |

Before visual sign-off, use a small formative test with at least five people who
are not implementing the feature. Include both a habitual expense-sharing user
and a person who mainly manages their own budget. Have them perform solo creation,
unequal split, adding a receipt, partial repayment and bank matching on a phone.
Observe whether they can state their own cost, amount owed and document audience.
This is qualitative design evidence, not a statistical reliability guarantee.

Retain the main spec's 60-second first-entry and 20-second repeat-entry targets.
At least four of five testers should complete each task without facilitator help;
any observed accidental publication or duplicate-booking interpretation requires
redesign and another check of that journey. Record failures as findings, not as
users failing a test. Financial and authorization correctness still require the
automated invariants regardless of this sample.

Verify 360 px width, larger text, long translated names, keyboard-only operation,
screen-reader labels, dark mode, a software keyboard, image preview/back behavior,
slow requests and expired login during save/upload. Use Monize's shared controls
and responsive Modal; no second drawer/modal framework or arbitrary theme palette.
Final visual polish is judged against a working prototype, not this text alone.
