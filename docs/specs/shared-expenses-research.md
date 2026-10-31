# Shared expenses: repository and upstream research

Research date: 2026-10-25. Companion to [the product specification](shared-expenses.md).
The [interaction contract](shared-expenses-ux.md) adds the second review's split,
document-publication and usability requirements.
This is a source review, not a runtime, security or usability certification.
No upstream application was deployed and no upstream implementation was copied.

## 1. What Monize already provides

Reviewed Monize revision: `b9ee599b2`. The following are existing capabilities;
the group journal and personal posting bridge in the specification are proposals.

| Existing area | Evidence | Design implication |
| --- | --- | --- |
| User-owned accounts and signed cash transactions | [Account](../../backend/src/accounts/entities/account.entity.ts), [Transaction](../../backend/src/transactions/entities/transaction.entity.ts) | Preserve bank amounts, account ownership and original-currency fields. |
| Category, transfer and investment splits | [SplitKind](../../backend/src/transactions/entities/split-kind.enum.ts), [TransactionSplit](../../backend/src/transactions/entities/transaction-split.entity.ts) | A person allocation needs a separate model; a category split does not represent a debt. |
| Merchant/counterparty records with contact fields | [Payee](../../backend/src/payees/entities/payee.entity.ts) | A private payee can be linked to a person, but does not identify a group member or grant access. |
| Joint account visibility and operation grants | [JointAccountsService](../../backend/src/delegation/joint-accounts.service.ts) | Reuse account permission decisions where applicable; group membership is a different permission. |
| Cross-owner transfer checks, including rechecking grants inside a write | [CrossOwnerAccessService](../../backend/src/delegation/cross-owner-access.service.ts) | Joining a group must not manufacture a grant to somebody else's bank account. |
| Conversion of an existing bank row to a transfer | [convertRowToTransfer](../../backend/src/transactions/convert-to-transfer.ts) | Useful bridge primitive, but currently refuses cross-currency accounts, existing splits, transfers and VOID rows. It is not a ready-made general linking API. |
| Split-transfer currency conversion | [TransactionSplitService](../../backend/src/transactions/transaction-split.service.ts) | There is an FX-aware path to build on; an agreed explicit counterpart amount still needs a reviewed interface. |
| Budget category actuals and transfer classification | [budget-spending.util](../../backend/src/budgets/budget-spending.util.ts), [investment-filter.util](../../backend/src/common/investment-filter.util.ts) | Own consumption and repayments must retain different ledger meanings across reports. |
| Provider-backed attachments, currently parented by a transaction or warranty | [AttachmentParent](../../backend/src/attachments/attachment-parent.ts), [attachment entity](../../backend/src/attachments/entities/transaction-attachment.entity.ts) | A shared receipt needs a new authorized parent, not exposure of a private transaction's documents. |
| Staged uploads, scanner and document preview | [AttachmentsSection](../../frontend/src/components/transactions/AttachmentsSection.tsx), [DocumentScanDialog](../../frontend/src/components/transactions/DocumentScanDialog.tsx), [AttachmentPreviewDialog](../../frontend/src/components/transactions/AttachmentPreviewDialog.tsx) | Reuse image/PDF preview, crop/rotation and upload failure states. The scanner may return an original alongside the processed image; sharing that original needs explicit consent. |
| Bounded document admission | [attachment types](../../frontend/src/types/attachment.ts), [MIME validation](../../backend/src/attachments/attachment-mime.util.ts), [attachment service](../../backend/src/attachments/attachments.service.ts) | Current limits are 10 visible documents per parent and 10 MiB per object, with JPEG/PNG/GIF/WebP/PDF. A group-level cap and new parents are proposed extensions; HEIC input depends on browser decoding through the scanner. |
| Common navigation, form and input conventions | [nav-links](../../frontend/src/lib/nav-links.ts), [forms and formatting](../frontend/forms-and-formatting.md), [UI conventions](../frontend/ui-conventions.md) | Reuse Monize controls and navigation; do not introduce a second design system. |
| Currency-specific precision metadata | [schema](../../database/schema.sql), [CurrencyInput](../../frontend/src/components/ui/CurrencyInput.tsx) | The database has `currencies.decimal_places`; the current money input uses cents for typed values. Currency-aware entry is a real dependency for JPY/KWD, not an existing capability to assume. |

Searches of production code and current feature specifications found no dedicated
shared-expense group, participant-share or repayment journal. Existing delegation,
loans and payees cover different problems. Older shipped specifications contain
historical scope descriptions; the code and current contracts take precedence.

## 2. Tricount: verified functional reference

The [official feature list](https://www.tricount.com/en-us/features) describes
group expenses, custom shares, currencies, a calculator, income/transfers,
receipt photos, spending insights, offline entry and Splitwise import. These are
the comparison categories, not a promise to implement every adjacent service.

The [expense management guide](https://help.tricount.com/en/articles/how-can-i-manage-my-tricounts-and-expenses)
documents unequal amounts/shares, adding a transfer, marking a suggested repayment
paid, invitations, archiving and repayments in the group's currency. The
[FAQ](https://help.tricount.com/en/articles/tricount-faqs) distinguishes group
spending from repayments and explains why debt simplification can propose paying
someone who did not directly pay for you. Monize should explain that distinction
at the repayment itself.

The [custom split page](https://www.tricount.com/en-us/features/custom-split-expenses)
shows selecting beneficiaries, adjusting shares and reviewing amounts before save.
The [photo page](https://www.tricount.com/en-us/features/share-expense-photos)
also describes a group Photos tab containing trip photos and receipts. This is
evidence for files independent of a financial entry. The proposed Monize Files
view includes group documents and entry receipts; PDF support comes from Monize's
existing viewer, not a claim about Tricount's accepted formats.

The [multi-currency page](https://www.tricount.com/features/multi-currency-support)
describes original-currency entry and a common group currency. The
[offline page](https://tricount.com/features/offline-expense-tracking) explicitly
describes later synchronization. An installable PWA alone does not provide that.

[Payment requests](https://help.tricount.com/en/articles/tricount-request-links)
are a separate bank-linked capability with availability restrictions. This
proposal records repayments; it does not promise a Polish bank/BLIK integration,
initiate payments or reproduce bunq card/eSIM services. Some help pages retain
older deprecation language; the specification states its own scope explicitly.

## 3. Spliit: useful reference for a low-friction group

Repository: [spliit-app/spliit](https://github.com/spliit-app/spliit).
Reviewed commit: `73478ed2f67a59e83866948caeece6bf2ecb985e`.

| Inspected source at that commit | Finding | Use in Monize |
| --- | --- | --- |
| [Prisma schema](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/prisma/schema.prisma) | A participant belongs to a group independently of a login. An expense has one payer, beneficiary shares and optional original currency/conversion rate. | Start with named participants; model optional authenticated membership separately. Support multiple payer contributions explicitly rather than assuming the upstream model already does. |
| [Expense form](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/app/groups/%5BgroupId%5D/expenses/expense-form.tsx) | Equal/shares/percentage/amount modes, active-person defaults and an original-currency editor. | Use progressive disclosure and prefill the reader as payer, with Monize inputs and server preview. |
| [Document input](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/components/expense-documents-input.tsx) | Image thumbnails, carousel preview and per-upload retry. | Keep the document next to the expense; use Monize's authenticated storage and broader existing image/PDF viewer instead of upstream public image URLs. |
| [Share allocation](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/lib/shares.ts) | Largest-remainder allocation; participant-id ordering and expense-id rotation make rounding deterministic. | Adopt the mathematical approach with Monize precision and independently specified fixtures. Invalid exact splits are rejected, not silently rescaled. |
| [Balances](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/lib/balances.ts), [repayment UI](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/app/groups/%5BgroupId%5D/reimbursement-list.tsx) | Stable suggestions and a prefilled repayment action. | Show an understandable suggested payment and let the user record a partial one. Do not advertise a mathematically minimal number of transfers. |
| [Currency conversion](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/lib/currency-conversion.ts) | Original-to-group conversion and the inverse for repayments are separate operations. | Keep the debt discharged in group currency separate from actual bank money. Use Monize's dated rate resolver. |
| [tRPC setup](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/trpc/init.ts), [balances procedure](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/src/trpc/routers/groups/balances/list.procedure.ts) | The inspected procedure accepts a group identifier through a public base procedure; the context carries no login identity. | Borrow the short invitation journey, not identifier-as-access authorization for Monize financial data. |

The source contains currency conversion and recurring-entry models even where
the README's future-feature checklist lags. Product comparisons here use the
pinned code. Its Next.js/Tailwind stack is familiar, but Prisma, shadcn components,
client storage and API handlers are not drop-in Monize modules.
The inspected form also apportions the remaining exact amount among unedited
participants. Monize's proposal makes that helper an explicit action and keeps
typed amounts stable when the total changes, so a convenient default cannot
silently change an accepted personal obligation.

## 4. SplitPro: useful reference for people and bank selection

Repository: [oss-apps/split-pro](https://github.com/oss-apps/split-pro).
Reviewed commit: `3583568319807e193fbe57085ea9560a2e872b93`.
The self-hosted repository and the separately maintained hosted cloud should
not be treated as identical feature sets.

| Inspected source at that commit | Finding | Use in Monize |
| --- | --- | --- |
| [Schema](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/prisma/schema.prisma) | Membership connects groups to users; participant amounts use BigInt; a balance view reads expense-derived facts. | Read balances from the journal, retain exact arithmetic, but do not create login users merely to represent friends. |
| [Split selector](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/src/components/AddExpense/SplitTypeSection.tsx), [desktop reference image](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/public/Desktop.webp) | Focused participant selection, separate split editor and a people-first receivable/payable overview. | A simple expense editor plus a useful People view; do not present unrelated currency balances as one payable number. |
| [Simplification](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/src/lib/simplify.ts) | Simplification is performed separately per currency using net positions. | Preserve currency boundaries and distinguish suggested net repayments from historical direct obligations. |
| [Bank picker](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/src/components/AddExpense/AddBankTransactions.tsx), [bank documentation](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/docs/BANK_TRANSACTIONS.md) | Existing bank transactions can be selected to create shared expenses. | Adapt this interaction to Monize's already imported ledger rows, without adding another bank-provider stack. |
| [Splitwise parser](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/src/utils/splitwiseImport.ts), [import service](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/src/server/api/services/splitService.ts) | Import reads friends, groups and balances; it does not reproduce historical expense items. | Treat future balance-only import as opening balances, not spending history. Preview and explain omissions. |
| [Currency documentation](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/docs/CURRENCY_CONVERSIONS.md), [README](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/README.md) | Optional conversions, provider configuration, soft-deletion activity and pg_cron-based recurrence. | Reuse interaction ideas; retain Monize's providers, notification service, recurrence contracts and database infrastructure. |

The split selector has an `ADJUSTMENT` option alongside equal, exact, percentage
and share modes: fixed extras with the remainder shared equally. The Monize UX
proposal adopts this as a preview helper that produces exact allocations. Its
explicit Apply/Cancel behavior is our design choice, not a claim that either
upstream application has passed Monize's proposed usability targets.

## 5. Reuse boundary and licensing evidence

Both reviewed repositories declare MIT:
[Spliit license](https://github.com/spliit-app/spliit/blob/73478ed2f67a59e83866948caeece6bf2ecb985e/LICENSE),
[SplitPro license](https://github.com/oss-apps/split-pro/blob/3583568319807e193fbe57085ea9560a2e872b93/LICENSE).
Monize declares AGPL-3.0-only in [its backend package](../../backend/package.json).
If implementation adapts upstream code, retain the applicable MIT copyright and
permission notice, identify the exact source/revision and inspect the provenance
of that particular file and its dependencies. A repository license is not evidence
for every external asset or algorithm attribution it contains.

Recommended reuse is the interaction design and independently tested allocation
approach. Do not embed another application, add Prisma/NextAuth/shadcn/pg_cron,
replace Monize authentication, copy brand assets, or import provider integrations
as part of this feature. Any direct code reuse is a later, explicit implementation
decision with attribution; this documentation change contains original prose only.
