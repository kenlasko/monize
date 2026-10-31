import { EntityManager } from "typeorm";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  lockAccountsForBalanceWrite,
  lockTransactionRows,
} from "../common/db/locks";
import { BookSharedEntryDto } from "./dto/shared-finance.dto";
import {
  sharedFingerprint,
  requireRevision,
  currencyPlaces,
} from "./shared-db";
import { sharedError } from "./shared-errors";
import { readSharedJournal, SharedJournalEntry } from "./shared-journal";
import { personalEffect } from "./shared-projection";
import {
  sharedBankRows,
  sharedIntegration,
  sharedPostingLinks,
  sharedPostings,
} from "./shared-finance-read";
import {
  SharedFinancePlan,
  SharedBankPaymentPlan,
} from "./shared-finance-types";
import {
  fixedUnits,
  ledgerAmount,
  moneyText,
  sharedAmount,
} from "./shared-money";
import { convertAllocations } from "./shared-allocation";
import { planSharedBankPayment } from "./shared-bank-payment-plan";
const magnitude = (n: bigint) => (n < 0n ? -n : n);

export async function planSharedFinance(
  manager: EntityManager,
  rates: ExchangeRateService,
  userId: string,
  groupId: string,
  entryId: string,
  dto: BookSharedEntryDto,
  proposedEntry?: SharedJournalEntry,
): Promise<SharedFinancePlan> {
  const integration = await sharedIntegration(manager, userId, groupId);
  if (!integration?.active) sharedError("financeDisabled");
  const entry =
    proposedEntry ??
    (await readSharedJournal(manager, groupId)).find((e) => e.id === entryId);
  if (!entry || entry.groupId !== groupId) sharedError("notFound");
  requireRevision(entry.revision, dto.expectedRevision);
  const effect = personalEffect(entry, integration.participantId);
  if (effect === null) sharedError("financeDraft");
  const existing =
    (await sharedPostings(manager, userId, groupId)).find(
      (p) => p.entryId === entryId,
    ) ?? null;
  const sourceLinks = existing
    ? await sharedPostingLinks(manager, userId, existing.id)
    : [];
  const inputs = dto.payments ?? [dto];
  if (
    dto.payments &&
    (dto.bankTransactionId ||
      dto.bankAccountId ||
      dto.bankAmount ||
      dto.sharedBankAmount ||
      dto.bankRate ||
      dto.contributionAmount ||
      dto.sourceSplits)
  )
    sharedError("financePaymentSum");
  const selectedBankIds = inputs.flatMap((input) =>
    input.bankTransactionId ? [input.bankTransactionId] : [],
  );
  if (new Set(selectedBankIds).size !== selectedBankIds.length)
    sharedError("financeMatch");
  const sourceIds = [
    ...new Set([
      ...sourceLinks.map((l) => l.transactionId),
      ...selectedBankIds,
    ]),
  ];
  // All accounts precede all transaction locks, including every own payment source.
  const before = await sharedBankRows(manager, userId, sourceIds);
  const accountIds = [
    integration.accountId,
    ...before.map((r) => r.accountId),
    ...inputs.flatMap((input) =>
      input.bankAccountId ? [input.bankAccountId] : [],
    ),
  ];
  await lockAccountsForBalanceWrite(manager, accountIds, userId);
  const closed: { id: string }[] = await manager.query(
    "SELECT id FROM accounts WHERE id = ANY($1::uuid[]) AND user_id = $2 AND is_closed",
    [accountIds, userId],
  );
  if (closed.length) sharedError("financeBank");
  await lockTransactionRows(manager, sourceIds, userId);
  const locked = await sharedBankRows(manager, userId, sourceIds);
  if (
    sharedFingerprint(before.map((r) => [r.id, r.accountId])) !==
    sharedFingerprint(locked.map((r) => [r.id, r.accountId]))
  )
    sharedError("financePreview");
  const sourceRows = locked.filter((r) =>
    sourceLinks.some((l) => l.transactionId === r.id),
  );
  if (sourceRows.length !== sourceLinks.length) sharedError("financePreview");
  if (sourceRows.some((r) => r.status === "RECONCILED"))
    sharedError("financeReconciled");
  const cash = fixedUnits(effect.cash, 4, true);
  const originalCash = fixedUnits(effect.originalCash, 4, true);
  const personal = fixedUnits(effect.personal, 4, true);
  const payments: SharedBankPaymentPlan[] = [];
  if (originalCash !== 0n) {
    const amounts = inputs.map((input, index) => ({
      participantId: String(index),
      amount:
        input.contributionAmount ??
        (inputs.length === 1 ? moneyText(magnitude(originalCash)) : ""),
    }));
    const originalPlaces =
      inputs.length > 1 ? await currencyPlaces(manager, entry.currencyCode) : 4;
    if (
      amounts.some((amount) => !amount.amount) ||
      amounts.reduce(
        (sum, item) => sum + sharedAmount(item.amount, originalPlaces),
        0n,
      ) !== magnitude(originalCash)
    )
      sharedError("financePaymentSum");
    // Allocate the already accepted group contribution, never convert its parts independently.
    const converted =
      inputs.length === 1
        ? [{ participantId: "0", amount: moneyText(magnitude(cash)) }]
        : convertAllocations(
            magnitude(cash),
            amounts,
            await currencyPlaces(manager, integration.currencyCode),
            `${entry.roundingSeed}:bank`,
          );
    const sign = originalCash < 0n ? -1n : 1n;
    for (const [index, input] of inputs.entries()) {
      payments.push(
        await planSharedBankPayment(
          manager,
          rates,
          userId,
          entry,
          integration,
          existing,
          sourceLinks,
          locked,
          input,
          sign *
            fixedUnits(
              converted.find((item) => item.participantId === String(index))!
                .amount,
              4,
            ),
          sign * fixedUnits(amounts[index].amount, 4),
        ),
      );
    }
  } else if (
    dto.payments ||
    selectedBankIds.length ||
    inputs.some((input) => input.bankAccountId)
  )
    sharedError("financeAmount");
  const categoryId = dto.categoryId ?? existing?.categoryId ?? null;
  const payeeId = dto.payeeId ?? existing?.payeeId ?? null;
  const requiredCategories = [
    personal !== 0n ? categoryId : undefined,
    ...payments.flatMap((payment) => [
      !payment.privateSplits &&
      fixedUnits(payment.breakdown.privateRemainder, 4, true) !== 0n
        ? payment.privateCategoryId
        : undefined,
      fixedUnits(payment.breakdown.fxDifference, 4, true) !== 0n
        ? payment.fxCategoryId
        : undefined,
    ]),
  ].filter((id) => id !== undefined);
  if (requiredCategories.some((id) => !id)) sharedError("financeCategory");
  const categoryIds = [
    ...new Set(
      [
        categoryId,
        ...payments.flatMap((payment) => [
          payment.privateCategoryId,
          payment.fxCategoryId,
          ...(payment.privateSplits?.map((row) => row.categoryId) ?? []),
        ]),
      ].filter((id): id is string => !!id),
    ),
  ];
  if (categoryIds.length) {
    const categories: { id: string; is_income: boolean }[] =
      await manager.query(
        "SELECT id, is_income FROM categories WHERE id = ANY($1::uuid[]) AND user_id = $2",
        [categoryIds, userId],
      );
    if (categories.length !== categoryIds.length)
      sharedError("financeCategory");
    if (
      personal !== 0n &&
      categories.find((c) => c.id === categoryId)?.is_income !==
        (entry.type === "INCOME")
    )
      sharedError("financeCategory");
  }
  if (payeeId) {
    const payees: { id: string }[] = await manager.query(
      "SELECT id FROM payees WHERE id = $1 AND user_id = $2",
      [payeeId, userId],
    );
    if (!payees[0]) sharedError("payee");
  }
  const fingerprint = sharedFingerprint({
    effect,
    integration: integration.id,
    existing,
    sourceRows,
    payments,
    categoryId,
    payeeId,
  });
  for (const amount of [
    effect.personal,
    effect.cash,
    ...payments.flatMap((payment) => [
      payment.cash,
      ...Object.values(payment.breakdown),
    ]),
  ])
    ledgerAmount(fixedUnits(amount, 4, true));
  const single = payments.length === 1 ? payments[0] : null;
  return {
    entry,
    integration,
    existing,
    effect,
    fingerprint,
    payments,
    categoryId,
    payeeId,
    sourceLinks,
    sourceRows,
    bank: single?.bank ?? null,
    bankAccountId: single?.bankAccountId ?? null,
    bankCurrency: single?.bankCurrency ?? null,
    breakdown: single?.breakdown ?? null,
    privateCategoryId: single?.privateCategoryId ?? null,
    fxCategoryId: single?.fxCategoryId ?? null,
  };
}
