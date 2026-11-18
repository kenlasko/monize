import { applyActionToQuantity } from "../../../securities/investment-replay.util";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { investmentWritesOwnCashRow } from "../../mny/map/investment-cash";
import {
  MappedAccounts,
  MappedInvestments,
  MappedTransactions,
  MnyHoldingCheck,
} from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { MnyFileCounts } from "../../mny/mny-parser.service";
import { roundToDecimals } from "../../../common/round.util";
import { KmyRawFile } from "../model/kmy-raw";
import { unitsToNumber } from "./kmy-amounts";
import { FileExpectations } from "./kmy-file-expectations";
import { KMY_TYPE, isCategoryType } from "./kmy-account-tree";
import { KmyMapContext, warningContext } from "./kmy-row-builder";
import { warningRowFor } from "./kmy-warning-row";

/**
 * The small, separate pieces of `mapKmyFile`: counts, the mapped share replay,
 * the reader's warnings and the spec 6.3 comparisons.
 */

export function union(...sets: ReadonlySet<number>[]): Set<number> {
  return new Set(sets.flatMap((set) => [...set]));
}

export function countByAccount(
  transactions: MappedTransactions,
  investments: MappedInvestments,
): { transactions: Map<string, number>; investments: Map<string, number> } {
  const rows = new Map<string, number>();
  const trades = new Map<string, number>();
  for (const transaction of transactions.transactions) {
    rows.set(
      transaction.accountKey,
      (rows.get(transaction.accountKey) ?? 0) + 1,
    );
  }
  for (const investment of investments.transactions) {
    if (investmentWritesOwnCashRow(investment)) {
      const key = investment.cashAccountKey as string;
      rows.set(key, (rows.get(key) ?? 0) + 1);
    }
    trades.set(
      investment.accountKey,
      (trades.get(investment.accountKey) ?? 0) + 1,
    );
  }
  return { transactions: rows, investments: trades };
}

/** Mapped share replay per (brokerage key, security), cut off at `asOf` like the file's. */
export function mappedReplay(
  investments: MappedInvestments,
  asOf: string,
): Map<string, number> {
  const positions = new Map<string, number>();
  for (const row of investments.transactions) {
    if (
      row.quantity === null ||
      row.transactionDate > asOf ||
      row.status === TransactionStatus.VOID
    ) {
      continue;
    }
    const key = `${row.accountKey}|${row.securityHandle}`;
    positions.set(
      key,
      applyActionToQuantity(
        positions.get(key) ?? 0,
        row.action as InvestmentAction,
        row.quantity,
      ),
    );
  }
  return positions;
}

export function readerWarnings(
  raw: KmyRawFile,
  context: KmyMapContext,
): MnyWarning[] {
  const byOrdinal = new Map(
    raw.transactions.map((transaction) => [transaction.ordinal, transaction]),
  );
  return raw.readerWarnings.map((warning) => {
    const transaction =
      warning.transactionOrdinal === null
        ? undefined
        : byOrdinal.get(warning.transactionOrdinal);
    return {
      code: warning.code,
      subject: warning.subject,
      ...(transaction
        ? { row: warningRowFor(transaction, warningContext(context)) }
        : {}),
    };
  });
}

export function repeated(
  code: MnyWarning["code"],
  count: number,
): MnyWarning[] {
  return Array.from({ length: count }, () => ({ code }));
}

export function fileCounts(
  raw: KmyRawFile,
  rawPrices: number,
  rawRates: number,
): MnyFileCounts {
  return {
    accounts: raw.accounts.filter(
      (account) =>
        !account.isStandard &&
        !isCategoryType(account.type) &&
        account.type !== KMY_TYPE.STOCK &&
        account.type !== KMY_TYPE.EQUITY,
    ).length,
    payees: raw.payees.length,
    categories: raw.accounts.filter(
      (account) => !account.isStandard && isCategoryType(account.type),
    ).length,
    securities: raw.securities.length,
    securityPrices: rawPrices,
    exchangeRates: rawRates,
    bills: raw.schedules.length,
    transactions: raw.transactions.length,
  };
}

/**
 * The mapped side of `FileTradeValue`: per holding and transaction
 * (`holding|handle`), each BUY and REINVEST row's total net of commission,
 * minus each SELL row's total plus commission,
 * in minor units at the security currency's places. Rows of a transaction the
 * file side left out (`otherCurrencyTrades`) are left out here too.
 */
export function mappedTradeValues(
  investments: MappedInvestments,
  asOf: string,
  excluded: ReadonlySet<number>,
  placesOf: (currencyCode: string) => number,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  const unitsOf = (amount: number, places: number): bigint =>
    BigInt(Math.round(amount * 10 ** places));
  for (const row of investments.transactions) {
    if (
      row.transactionDate > asOf ||
      row.status === TransactionStatus.VOID ||
      (row.handle !== null && excluded.has(row.handle))
    ) {
      continue;
    }
    const places = placesOf(row.securityCurrencyCode);
    const total = unitsOf(row.totalAmount ?? 0, places);
    const commission = unitsOf(row.commission ?? 0, places);
    let gross: bigint;
    switch (row.action) {
      case InvestmentAction.BUY:
      case InvestmentAction.REINVEST:
        gross = total - commission;
        break;
      case InvestmentAction.SELL:
        gross = -(total + commission);
        break;
      default:
        continue;
    }
    const key = `${row.accountKey}|${row.securityHandle}|${row.handle}`;
    totals.set(key, (totals.get(key) ?? 0n) + gross);
  }
  return totals;
}

export interface KmyComparisonInput {
  readonly accounts: MappedAccounts;
  readonly expectations: FileExpectations;
  /** What the mapped rows sum to per account (`computeExpectedBalances`). */
  readonly expectedBalances: ReadonlyMap<string, number>;
  readonly checks: readonly MnyHoldingCheck[];
  readonly mappedTrades: ReadonlyMap<string, bigint>;
}

/**
 * Spec 6.3: what the mapper itself can already tell the user. A balance the
 * mapped rows would not reproduce, a holding the mapped actions would not
 * replay to, or trade totals that do not add up to the file's stock values is
 * a defect (or a difference a warning already names), and the review step
 * shows it before anything is written.
 *
 * A balance is compared with what one row per split, each rounded at the
 * account's own places, sums to -- exactly, so a coin account is held to its
 * eighth place and a fiat one to its fourth. The detail names the file's own
 * figure (the exact sum rounded once).
 */
export function explainDifferences(input: KmyComparisonInput): MnyWarning[] {
  const { accounts, expectations, expectedBalances, checks, mappedTrades } =
    input;
  const nameOf = new Map(
    accounts.accounts.map((account) => [account.key, account.name]),
  );
  const warnings: MnyWarning[] = [];
  for (const [key, fileBalance] of expectations.fileBalances) {
    const mapped = expectedBalances.get(key) ?? 0;
    const rows = expectations.rowBalances.get(key) ?? fileBalance;
    const places = expectations.balancePrecision.get(key)?.places ?? 4;
    if (roundToDecimals(mapped - rows, places) !== 0) {
      warnings.push({
        code: "mappedBalanceDiffers",
        subject: nameOf.get(key) ?? key,
        detail: `file ${fileBalance}, mapped ${mapped}`,
      });
    }
  }
  for (const check of checks) {
    if (!check.matches) {
      warnings.push({
        code: "holdingsReplayDiffers",
        subject: check.symbol,
        detail: `file ${check.lotQuantity}, mapped ${check.replayQuantity}`,
      });
    }
  }
  const fileTrades = new Map(
    expectations.tradeValues.map((value) => [
      `${value.accountKey}|${value.securityHandle}|${value.transactionOrdinal}`,
      value,
    ]),
  );
  const symbolOf = new Map(
    expectations.tradeValues.map((value) => [
      `${value.accountKey}|${value.securityHandle}`,
      value,
    ]),
  );
  for (const key of new Set([...fileTrades.keys(), ...mappedTrades.keys()])) {
    const file = fileTrades.get(key);
    const holding = file ?? symbolOf.get(key.split("|").slice(0, 2).join("|"));
    const fileUnits = file?.units ?? 0n;
    const mapped = mappedTrades.get(key) ?? 0n;
    const gap = mapped > fileUnits ? mapped - fileUnits : fileUnits - mapped;
    if (gap > BigInt(file?.splits ?? 0)) {
      const places = holding?.places ?? 4;
      warnings.push({
        code: "tradeAmountsDiffer",
        subject: holding?.symbol ?? key,
        detail: `transaction ${key.split("|")[2]}: file ${unitsToNumber(fileUnits, places)}, mapped ${unitsToNumber(mapped, places)}${holding ? ` ${holding.currencyCode}` : ""}`,
      });
    }
  }
  return warnings;
}
