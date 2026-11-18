import { randomUUID } from "node:crypto";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { MappedTransaction } from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyRawFile, KmySplit, KmyTransaction } from "../model/kmy-raw";
import { Rational } from "../model/kmy-rational";
import { AccountTree, KMY_TYPE } from "./kmy-account-tree";
import {
  amountPlaces,
  effectiveShares,
  toUnits,
  unitsToNumber,
} from "./kmy-amounts";
import { KmyAccountMapping, rawCurrencyOf } from "./kmy-map-accounts";
import type { KmyRateLookup } from "./kmy-map-prices";
import { WarningRowContext, warningRowFor } from "./kmy-warning-row";

/**
 * What the transaction and investment mappers share: the mapping context, the
 * state of a split, and the one place an ordinary row is built (spec 5.6.5).
 */

export const MAX_REFERENCE_LENGTH = 100;

export interface KmyMapContext {
  readonly raw: KmyRawFile;
  readonly tree: AccountTree;
  readonly mapping: KmyAccountMapping;
  readonly coinDecimals: ReadonlyMap<string, number>;
  readonly payeeHandleById: ReadonlyMap<string, number>;
  readonly tagHandleById: ReadonlyMap<string, number>;
  /** The file's own currency-to-currency prices (spec 5.9). */
  readonly rateLookup: KmyRateLookup;
}

export function statusOfSplit(split: KmySplit): TransactionStatus {
  switch (split.reconcileFlag) {
    case 1:
      return TransactionStatus.CLEARED;
    case 2:
    case 3:
      return TransactionStatus.RECONCILED;
    default:
      return TransactionStatus.UNRECONCILED;
  }
}

export function transactionCommodity(
  transaction: KmyTransaction,
  context: KmyMapContext,
): string {
  return transaction.commodity?.trim() || context.mapping.baseCurrency;
}

export function warningContext(context: KmyMapContext): WarningRowContext {
  return {
    keyById: context.mapping.keyById,
    payeeHandleById: context.payeeHandleById,
    placesOf: (accountId) => {
      const key = context.mapping.keyById.get(accountId);
      const currency =
        (key && context.mapping.currencyByKey.get(key)) ||
        context.mapping.baseCurrency;
      return amountPlaces(currency, context.coinDecimals);
    },
  };
}

/** Shares of a split in its own account's currency, with the fix-version compensation. */
export function sharesOf(
  split: KmySplit,
  transaction: KmyTransaction,
  context: KmyMapContext,
): Rational {
  const account = context.tree.byId.get(split.account);
  return effectiveShares(
    split,
    account ? rawCurrencyOf(account, context.mapping.baseCurrency) : "",
    transactionCommodity(transaction, context),
    context.raw.fileInfo.fixVersion,
  );
}

/** The Monize currency of the account a split is on (imported accounts only). */
export function currencyOfSplit(
  split: KmySplit,
  context: KmyMapContext,
): string | null {
  const key = context.mapping.keyById.get(split.account);
  return key === undefined
    ? null
    : (context.mapping.currencyByKey.get(key) ?? null);
}

export function unitsOf(
  value: Rational,
  currency: string,
  context: KmyMapContext,
): bigint {
  return toUnits(value, amountPlaces(currency, context.coinDecimals));
}

export function numberOf(
  units: bigint,
  currency: string,
  context: KmyMapContext,
): number {
  return unitsToNumber(units, amountPlaces(currency, context.coinDecimals));
}

/** Collects what a pass over a transaction references and warns about. */
export class RowCollector {
  readonly rows: MappedTransaction[] = [];
  readonly warnings: MnyWarning[] = [];
  readonly payees = new Set<number>();
  readonly categories = new Set<number>();
  readonly tags = new Set<number>();
  readonly equityUsed = new Set<number>();
  transfersLinked = 0;

  constructor(private readonly context: KmyMapContext) {}

  warn(
    code: MnyWarning["code"],
    transaction: KmyTransaction,
    detail?: string,
  ): void {
    this.warnings.push({
      code,
      subject: `transaction ${transaction.ordinal}`,
      ...(detail === undefined ? {} : { detail }),
      row: warningRowFor(transaction, warningContext(this.context)),
    });
  }

  /** Payee handle for the row of `own`: its own payee, else the first among the others. */
  payee(transaction: KmyTransaction, own: KmySplit): number | null {
    const id =
      own.payee ||
      transaction.splits.find((split) => split !== own && split.payee)?.payee;
    if (!id) {
      return null;
    }
    const handle = this.context.payeeHandleById.get(id);
    if (handle === undefined) {
      this.warn("unknownPayeeReference", transaction, id);
      return null;
    }
    this.payees.add(handle);
    return handle;
  }

  tagHandles(splits: readonly KmySplit[]): number[] {
    const handles: number[] = [];
    for (const split of splits) {
      for (const id of split.tags) {
        const handle = this.context.tagHandleById.get(id);
        if (handle !== undefined && !handles.includes(handle)) {
          handles.push(handle);
          this.tags.add(handle);
        }
      }
    }
    return handles;
  }

  category(account: { ordinal: number; type: number }): number {
    this.categories.add(account.ordinal);
    if (account.type === KMY_TYPE.EQUITY) {
      this.equityUsed.add(account.ordinal);
    }
    return account.ordinal;
  }
}

function referenceOf(split: KmySplit): string | null {
  const trimmed = split.number.trim().slice(0, MAX_REFERENCE_LENGTH);
  return trimmed === "" ? null : trimmed;
}

export function memoOf(text: string): string | null {
  return text.trim() === "" ? null : text;
}

/** One ordinary row on `split`'s account: amount its shares, description its memo or the transaction's. */
export function ordinaryRow(
  transaction: KmyTransaction,
  split: KmySplit,
  context: KmyMapContext,
  collector: RowCollector,
  overrides: Partial<MappedTransaction> & { descriptionSource?: string } = {},
): MappedTransaction {
  const key = context.mapping.keyById.get(split.account) as string;
  const currency = context.mapping.currencyByKey.get(key) as string;
  const { descriptionSource, ...rest } = overrides;
  return {
    id: randomUUID(),
    handle: transaction.ordinal,
    accountKey: key,
    transactionDate: transaction.postDate as string,
    amount: numberOf(
      unitsOf(sharesOf(split, transaction, context), currency, context),
      currency,
      context,
    ),
    currencyCode: currency,
    // A row in its own account's currency; a transfer leg overrides it.
    exchangeRate: 1,
    reconciledDate: split.reconcileDate || null,
    status: statusOfSplit(split),
    payeeHandle: collector.payee(transaction, split),
    categoryHandle: null,
    description: memoOf(descriptionSource ?? (split.memo || transaction.memo)),
    referenceNumber: referenceOf(split),
    isTransfer: false,
    linkedTransactionId: null,
    splits: [],
    collapsedTradeHandle: null,
    tagHandles: collector.tagHandles([split]),
    ...rest,
  };
}
