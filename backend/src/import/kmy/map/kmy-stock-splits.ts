import { addDaysYMD } from "../../../common/date-utils";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyRawFile, KmySecurity, KmyTransaction } from "../model/kmy-raw";
import {
  KmyRounding,
  Rational,
  ZERO,
  abs,
  add,
  compare,
  div,
  mul,
  rational,
  roundToDenominator,
  sub,
  toDecimalString,
} from "../model/kmy-rational";
import { AccountTree, KMY_TYPE } from "./kmy-account-tree";
import {
  QUANTITY_PLACES,
  isExactAt,
  isIsoDate,
  quantityNumber,
  toUnits,
} from "./kmy-amounts";
import { KmySecurityMapping } from "./kmy-map-securities";
import { WarningRowContext, warningRowFor } from "./kmy-warning-row";

/**
 * KMyMoney's share replay (reference 15.2) and the three stock-split checks of
 * spec 5.7.5.
 *
 * A single-split transaction whose action is `Split` multiplies the running
 * balance by its `shares` and rounds the product to the security's `saf` with
 * its rounding method (`RoundNever` is read as `RoundRound`); any other split
 * adds its `shares`. KMyMoney does this in `JournalModel::stockSplit` through
 * `AlkValue::convertDenominator(saf, method)`, which rounds the magnitude and
 * re-applies the sign (libalkimia `alkvalue.cpp`), so `RoundFloor` and
 * `RoundCeil` are mathematical floor and ceiling on a signed value: exactly
 * what `roundToDenominator` implements.
 */

/** Days either side of a split in which the file's prices are compared. */
const SUSPICIOUS_WINDOW_DAYS = 31;

export interface SplitReplay {
  readonly transactionOrdinal: number;
  readonly date: string;
  readonly ratio: Rational;
  /** KMyMoney's balance just before the split. */
  readonly before: Rational;
  /** `before * ratio`, unrounded. */
  readonly unrounded: Rational;
  /** What KMyMoney keeps after rounding to `saf`. */
  readonly after: Rational;
}

export interface Replay {
  readonly balance: Rational;
  readonly splits: readonly SplitReplay[];
}

export function isStockSplitTransaction(transaction: KmyTransaction): boolean {
  return (
    transaction.splits.length === 1 && transaction.splits[0].action === "Split"
  );
}

/** Transactions in KMyMoney's journal order: post date, then id as a string. */
export function journalOrder(
  transactions: readonly KmyTransaction[],
): KmyTransaction[] {
  return transactions
    .filter((transaction) => isIsoDate(transaction.postDate))
    .sort((a, b) =>
      a.postDate === b.postDate
        ? a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : a.ordinal - b.ordinal
        : (a.postDate as string) < (b.postDate as string)
          ? -1
          : 1,
    );
}

/** The replay of one stock account, cut off at `asOf` (null for no cut-off). */
export function replayStockAccount(
  ordered: readonly KmyTransaction[],
  accountId: string,
  security: Pick<KmySecurity, "saf" | "roundingMethod">,
  asOf: string | null,
): Replay {
  let balance = ZERO;
  const splits: SplitReplay[] = [];
  for (const transaction of ordered) {
    if (asOf !== null && (transaction.postDate as string) > asOf) {
      break;
    }
    for (const split of transaction.splits) {
      if (split.account !== accountId) {
        continue;
      }
      if (isStockSplitTransaction(transaction)) {
        const unrounded = mul(balance, split.shares);
        const after = roundToDenominator(
          unrounded,
          security.saf,
          security.roundingMethod as KmyRounding,
        );
        splits.push({
          transactionOrdinal: transaction.ordinal,
          date: transaction.postDate as string,
          ratio: split.shares,
          before: balance,
          unrounded,
          after,
        });
        balance = after;
      } else {
        balance = add(balance, split.shares);
      }
    }
  }
  return { balance, splits };
}

function describe(value: Rational): string {
  return toDecimalString(value, QUANTITY_PLACES);
}

/** The file's price of `securityId` closest to `date` on the requested side, within the window. */
function nearbyPrice(
  raw: KmyRawFile,
  securityId: string,
  currency: string,
  date: string,
  side: "before" | "after",
): Rational | null {
  const limit = addDaysYMD(
    date,
    side === "before" ? -SUSPICIOUS_WINDOW_DAYS : SUSPICIOUS_WINDOW_DAYS,
  );
  let best: { date: string; price: Rational } | null = null;
  for (const price of raw.prices) {
    if (
      price.from !== securityId ||
      price.to !== currency ||
      price.price.num <= 0n
    ) {
      continue;
    }
    const inside =
      side === "before"
        ? price.date < date && price.date >= limit
        : price.date >= date && price.date <= limit;
    if (!inside) {
      continue;
    }
    const closer =
      best === null ||
      (side === "before" ? price.date > best.date : price.date < best.date);
    if (closer) {
      best = { date: price.date, price: price.price };
    }
  }
  return best?.price ?? null;
}

export interface CheckStockSplitsInput {
  readonly raw: KmyRawFile;
  readonly tree: AccountTree;
  readonly securities: KmySecurityMapping;
  readonly context: WarningRowContext;
  /** Transaction ordinals that import as SPLIT rows. */
  readonly imported: ReadonlySet<number>;
}

/**
 * The spec 5.7.5 warnings for the stock splits that import as SPLIT rows,
 * in file order.
 */
export function checkStockSplits(input: CheckStockSplitsInput): MnyWarning[] {
  const { raw, tree, securities, context, imported } = input;
  const warnings: MnyWarning[] = [];
  const ordered = journalOrder(raw.transactions);
  const replays = new Map<string, Replay>();
  const quarter = rational(1n, 4n);

  for (const transaction of raw.transactions) {
    if (!imported.has(transaction.ordinal)) {
      continue;
    }
    const split = transaction.splits[0];
    const account = tree.byId.get(split.account);
    if (account?.type !== KMY_TYPE.STOCK || !account.currency) {
      continue;
    }
    const security = securities.rawById.get(account.currency);
    const mapped = securities.byId.get(account.currency);
    if (!security || !mapped) {
      continue;
    }
    const row = warningRowFor(transaction, context);
    const subject = mapped.symbol;

    const stored = rational(toUnits(split.shares, QUANTITY_PLACES), 10n ** 8n);
    if (!isExactAt(split.shares, QUANTITY_PLACES)) {
      warnings.push({
        code: "stockSplitRatioRounded",
        subject,
        detail: `${split.shares.num}/${split.shares.den} -> ${describe(stored)}`,
        row,
      });
    }

    let replay = replays.get(account.id);
    if (replay === undefined) {
      replay = replayStockAccount(ordered, account.id, security, null);
      replays.set(account.id, replay);
    }
    const step = replay.splits.find(
      (entry) => entry.transactionOrdinal === transaction.ordinal,
    );
    if (step !== undefined && compare(step.after, step.unrounded) !== 0) {
      warnings.push({
        code: "stockSplitRoundingDiffers",
        subject,
        detail: `${describe(step.after)} / ${describe(step.unrounded)}`,
        row,
      });
    }

    const before = nearbyPrice(
      raw,
      security.id,
      mapped.currencyCode,
      transaction.postDate as string,
      "before",
    );
    const after = nearbyPrice(
      raw,
      security.id,
      mapped.currencyCode,
      transaction.postDate as string,
      "after",
    );
    if (before !== null && after !== null && split.shares.num > 0n) {
      const observed = div(before, after);
      const ratio = split.shares;
      const asRatio = abs(sub(div(observed, ratio), rational(1n)));
      const asInverse = abs(sub(mul(observed, ratio), rational(1n)));
      if (compare(asRatio, quarter) > 0 && compare(asInverse, quarter) <= 0) {
        warnings.push({
          code: "stockSplitRatioSuspicious",
          subject,
          detail: `${quantityNumber(ratio)}`,
          row,
        });
      }
    }
  }
  return warnings;
}
