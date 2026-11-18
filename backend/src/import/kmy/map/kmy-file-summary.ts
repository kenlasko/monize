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
import { BALANCE_TOLERANCE } from "../../mny/model/mny-import-job";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { MnyFileCounts } from "../../mny/mny-parser.service";
import { KmyRawFile } from "../model/kmy-raw";
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
 * Spec 6.3: what the mapper itself can already tell the user. A balance the
 * mapped rows would not reproduce, or a holding the mapped actions would not
 * replay to, is a defect (or a difference a warning already names), and the
 * review step shows it before anything is written.
 */
export function explainDifferences(
  accounts: MappedAccounts,
  fileBalances: ReadonlyMap<string, number>,
  expectedBalances: ReadonlyMap<string, number>,
  checks: readonly MnyHoldingCheck[],
): MnyWarning[] {
  const nameOf = new Map(
    accounts.accounts.map((account) => [account.key, account.name]),
  );
  const warnings: MnyWarning[] = [];
  for (const [key, fileBalance] of fileBalances) {
    const mapped = expectedBalances.get(key) ?? 0;
    if (Math.abs(mapped - fileBalance) > BALANCE_TOLERANCE) {
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
  return warnings;
}
