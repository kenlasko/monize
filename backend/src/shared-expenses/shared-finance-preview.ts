import type { SharedFinancePlan } from "./shared-finance-types";

export function publicSharedFinancePlan(plan: SharedFinancePlan) {
  return {
    fingerprint: plan.fingerprint,
    payments: plan.payments.map((payment) => ({
      cash: payment.cash,
      originalCash: payment.originalCash,
      bankCurrency: payment.bankCurrency,
      bankAccountId: payment.bankAccountId,
      sourceTransactionId: payment.bank?.id ?? null,
      breakdown: payment.breakdown,
    })),
    effect: plan.effect,
    breakdown: plan.breakdown,
    bankCurrency: plan.bankCurrency,
    settlementCurrency: plan.integration.currencyCode,
    settlementAccountId: plan.integration.accountId,
    bankAccountId: plan.bankAccountId,
    sourceTransactionId: plan.bank?.id ?? null,
    previous: plan.existing?.snapshot.effect ?? null,
    categoryId: plan.categoryId,
    payeeId: plan.payeeId,
  };
}
