import { EntityManager } from "typeorm";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { todayYMD } from "../common/date-utils";
import { roundFxRate } from "../common/fx-entry.util";
import { SharedBankPaymentDto } from "./dto/shared-finance.dto";
import {
  SharedBankPaymentPlan,
  SharedBankRow,
  SharedIntegration,
  SharedLedgerLink,
  SharedPosting,
} from "./shared-finance-types";
import { SharedJournalEntry } from "./shared-journal";
import { sharedError } from "./shared-errors";
import { sharedBankBreakdown } from "./shared-projection";
import { allocateBankSplits } from "./shared-bank-splits";
import {
  convertSharedAmount,
  fixedUnits,
  moneyText,
  sharedAmount,
} from "./shared-money";
const BANK_TYPES = [
  "CHEQUING",
  "SAVINGS",
  "CASH",
  "CREDIT_CARD",
  "LINE_OF_CREDIT",
];
const magnitude = (n: bigint) => (n < 0n ? -n : n);

/** Sources were locked together before resolving any payment. */
export async function planSharedBankPayment(
  manager: EntityManager,
  rates: ExchangeRateService,
  userId: string,
  entry: SharedJournalEntry,
  integration: SharedIntegration,
  existing: SharedPosting | null,
  sourceLinks: SharedLedgerLink[],
  locked: SharedBankRow[],
  dto: SharedBankPaymentDto,
  cash: bigint,
  originalCash: bigint,
): Promise<SharedBankPaymentPlan> {
  let bank: SharedBankRow | null = null;
  let bankAccountId: string | null = null;
  let bankCurrency: string | null = null;
  let breakdown: SharedBankPaymentPlan["breakdown"] | null = null;
  let privateCategoryId = dto.privateCategoryId ?? null;
  let privateSplits: SharedBankPaymentPlan["privateSplits"];
  if (originalCash !== 0n) {
    if (!!dto.bankTransactionId === !!dto.bankAccountId)
      sharedError("financeBank");
    if (dto.bankTransactionId) {
      const current = locked.find((r) => r.id === dto.bankTransactionId);
      if (!current) sharedError("financeMatch");
      if (current.postingId && current.postingId !== existing?.id)
        sharedError("financeMatch");
      const link = sourceLinks.find(
        (l) => l.transactionId === current.id && l.kind === "BANK",
      );
      bank = link?.before
        ? {
            ...link.before,
            status: current.status,
            description: current.description,
            payeeId: current.payeeId,
            payeeName: current.payeeName,
          }
        : link?.created
          ? {
              ...current,
              isSplit: false,
              isTransfer: false,
              linkedTransactionId: null,
              postingId: null,
              categoryId: null,
              splits: [],
            }
          : current;
      if (
        bank.investmentLinked ||
        bank.isTransfer ||
        bank.parentTransactionId ||
        bank.linkedTransactionId ||
        bank.status === "VOID" ||
        bank.status === "RECONCILED"
      )
        sharedError("financeMatch");
      if (bank.date > todayYMD()) sharedError("financeDraft");
      bankAccountId = bank.accountId;
      privateCategoryId ??= bank.categoryId;
    } else bankAccountId = dto.bankAccountId!;
    const accounts: {
      currencyCode: string;
      decimalPlaces: number;
      accountType: string;
      managed: string | null;
      closed: boolean;
    }[] = await manager.query(
      `SELECT a.currency_code AS "currencyCode", c.decimal_places AS "decimalPlaces", a.account_type AS "accountType", a.managed_purpose AS managed, a.is_closed AS closed
      FROM accounts a JOIN currencies c ON c.code = a.currency_code WHERE a.id = $1 AND a.user_id = $2`,
      [bankAccountId, userId],
    );
    const account = accounts[0];
    if (
      !account ||
      account.closed ||
      account.managed ||
      !BANK_TYPES.includes(account.accountType)
    )
      sharedError("financeBank");
    bankCurrency = account.currencyCode;
    const sign = originalCash < 0n ? -1n : 1n;
    const total = bank
      ? fixedUnits(bank.amount, 4, true)
      : sign * sharedAmount(dto.bankAmount!, 4);
    const splitAllocation = bank
      ? allocateBankSplits(bank, dto.sourceSplits)
      : null;
    if (!bank && dto.sourceSplits) sharedError("financeSplit");
    privateSplits = splitAllocation?.privateSplits;
    const shared = splitAllocation
      ? fixedUnits(splitAllocation.sharedAmount, 4, true)
      : dto.sharedBankAmount
        ? sign * sharedAmount(dto.sharedBankAmount, 4)
        : total;
    if (
      splitAllocation &&
      dto.sharedBankAmount &&
      shared !== sign * sharedAmount(dto.sharedBankAmount, 4)
    )
      sharedError("financeSplit");
    let agreed: bigint;
    if (bankCurrency === integration.currencyCode) agreed = cash;
    else if (bankCurrency === entry.currencyCode && !dto.bankRate)
      agreed = originalCash;
    else {
      const resolved = await rates.resolveStoredRate(
        integration.currencyCode,
        bankCurrency,
        bank?.date ?? entry.date,
      );
      const rate =
        dto.bankRate ??
        (resolved.rate === null
          ? null
          : roundFxRate(resolved.rate).toFixed(10));
      if (!rate)
        sharedError("financeRate", {
          from: integration.currencyCode,
          to: bankCurrency,
          date: bank?.date ?? entry.date,
        });
      agreed =
        sign *
        convertSharedAmount(magnitude(cash), rate, account.decimalPlaces);
    }
    try {
      breakdown = sharedBankBreakdown(
        moneyText(total),
        moneyText(shared),
        moneyText(agreed),
      );
    } catch {
      sharedError("financeAmount");
    }
  }

  return {
    cash: moneyText(cash),
    originalCash: moneyText(originalCash),
    bank,
    bankAccountId: bankAccountId!,
    bankCurrency: bankCurrency!,
    breakdown: breakdown!,
    privateCategoryId,
    fxCategoryId: dto.fxCategoryId ?? null,
    ...(privateSplits ? { privateSplits } : {}),
  };
}
