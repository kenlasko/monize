import { sharedEntryFixture } from "./shared-entry";
import { personalEffect, personalFingerprint } from "../shared-projection";
import type {
  SharedBankRow,
  SharedFinancePlan,
  SharedIntegration,
  SharedPosting,
} from "../shared-finance-types";
import type { SharedGroup } from "../shared-types";

export const sharedGroup = (): SharedGroup => ({
  id: "group",
  ownerUserId: "owner",
  myParticipantId: "me",
  name: "Trip",
  description: null,
  currencyCode: "PLN",
  decimalPlaces: 2,
  revision: 2,
  financialRevision: 1,
  archivedAt: null,
  role: "OWNER",
});
export const sharedIntegrationFixture = (): SharedIntegration => ({
  id: "integration",
  groupId: "group",
  participantId: "me",
  accountId: "settlement",
  currencyCode: "PLN",
  currentBalance: "200.0000",
  active: true,
});
export const sharedBankFixture = (
  patch: Partial<SharedBankRow> = {},
): SharedBankRow => ({
  id: "bank-row",
  accountId: "bank",
  date: "2026-01-01",
  amount: "-300.0000",
  currencyCode: "PLN",
  status: "UNRECONCILED",
  isSplit: false,
  isTransfer: false,
  linkedTransactionId: null,
  parentTransactionId: null,
  postingId: null,
  categoryId: "food",
  payeeId: null,
  payeeName: null,
  description: "Imported receipt",
  externalId: "import-id",
  originalAmount: null,
  originalCurrencyCode: null,
  exchangeRate: "1",
  ...patch,
});
export const sharedPostingFixture = (
  patch: Partial<SharedPosting> = {},
): SharedPosting => {
  const effect = personalEffect(sharedEntryFixture(), "me")!;
  return {
    id: "posting",
    entryId: "entry",
    fingerprint: personalFingerprint(effect),
    acceptedRevision: 1,
    snapshot: { title: "Dinner", effect, input: {} },
    categoryId: "food",
    payeeId: null,
    ...patch,
  };
};
export const sharedFinancePlanFixture = (): SharedFinancePlan => {
  const entry = sharedEntryFixture();
  const bank = sharedBankFixture();
  const breakdown = {
    bankTotal: "-300.0000",
    sharedPortion: "-300.0000",
    agreedPortion: "-300.0000",
    privateRemainder: "0.0000",
    fxDifference: "0.0000",
  };
  return {
    entry,
    integration: sharedIntegrationFixture(),
    existing: null,
    effect: personalEffect(entry, "me")!,
    fingerprint: "accepted-plan",
    bank,
    bankAccountId: "bank",
    bankCurrency: "PLN",
    breakdown,
    categoryId: "food",
    payeeId: null,
    privateCategoryId: null,
    fxCategoryId: null,
    sourceLinks: [],
    sourceRows: [],
    payments: [
      {
        cash: "-300.0000",
        originalCash: "-300.0000",
        bank,
        bankAccountId: "bank",
        bankCurrency: "PLN",
        breakdown,
        privateCategoryId: null,
        fxCategoryId: null,
      },
    ],
  };
};
