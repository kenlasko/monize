import { baseInvestmentAction } from "../securities/investment-replay.util";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { ExactDecimal } from "./domain/exact-decimal";

/**
 * One investment transaction of a linked security, as the lot derivation reads
 * it. `quantity` is the column read as text (NUMERIC(20,8)): it is parsed
 * exactly and never through a JavaScript number.
 */
export interface BondLotTransaction {
  /**
   * The row's id, when the caller has one: a refusal then names the row that
   * caused it (`BondLotsRefusal.rowId`), which the write guard compares with the
   * row it has just written.
   */
  readonly id?: string;
  readonly action: string;
  readonly status: string;
  /** YYYY-MM-DD. */
  readonly transactionDate: string;
  readonly quantity: string | null;
  /**
   * What an acquisition cost, as exact text: the row's total amount less its
   * accrued interest. `null` or absent is unknown (a transfer in with no cost,
   * a row the caller has no amount for); it is never guessed.
   */
  readonly cost?: string | null;
  /**
   * For a TRANSFER_IN or TRANSFER_OUT: the other leg of the same security is
   * linked and not VOID. The pair moves the quantity first-in first-out from the
   * source account's lots to the destination account, keeping each lot's
   * purchase date (the TRANSFER_OUT leg does the move, the TRANSFER_IN leg adds
   * nothing of its own).
   */
  readonly pairedTransfer: boolean;
  /**
   * The account the row is recorded in. Lots are held per account: a removal
   * takes from the lots of this account only. A row without one belongs to the
   * single unnamed account (a caller that has no accounts to tell apart).
   */
  readonly accountId?: string | null;
  /** For a paired transfer leg: the account of the other leg. */
  readonly counterpartAccountId?: string | null;
  /**
   * The series (bond instrument id) the row acts on
   * (`docs/specs/bond-program-securities.md` 2.3). An acquisition names the
   * series its lot belongs to: `null` is a program-linked row with no series
   * (none stored and, for a BUY or REINVEST, none inferable from its date), which
   * makes the lots unknown (`SERIES_NOT_DETERMINED`); `undefined`
   * is a caller with no series to tell apart. A removal's series is optional:
   * given, the quantity leaves that series' lots, absent it leaves the
   * account's lots first-in first-out across series.
   */
  readonly instrumentId?: string | null;
}

export interface BondLot {
  /** The account that holds the lot; absent for the unnamed account. */
  readonly accountId?: string | null;
  /** The series the lot belongs to; null for a caller with no series to tell apart. */
  readonly instrumentId: string | null;
  readonly purchaseDate: string;
  /** A whole number of bonds. */
  readonly quantity: number;
  /** A TRANSFER_IN with no linked leg: the real purchase date is unknown. */
  readonly purchaseDateAssumed: boolean;
  /**
   * What the lot cost, net of accrued interest, as exact text; null when unknown.
   * When part of a lot leaves, the cost is split first-in first-out pro rata to
   * the bonds (`splitCost`): the parts always add up to the whole.
   */
  readonly cost: string | null;
}

export type BondLotsRefusalCode =
  /** A bond does not split. */
  | "SPLIT"
  /** A share-moving row whose quantity is not a whole number of bonds. */
  | "FRACTIONAL_QUANTITY"
  /** A removal larger than the lots its account holds at that point. */
  | "OVER_REMOVAL"
  /** A removal that names a series, larger than the lots of that series its account holds. */
  | "REMOVAL_EXCEEDS_SERIES"
  /** An acquisition of a program-linked security with no stored series. */
  | "SERIES_NOT_DETERMINED"
  /** A share-moving row with no quantity, a negative one, or one too large to count. */
  | "INVALID_QUANTITY";

/** The row that made the lots unknowable, as raw values a client formats itself. */
export interface BondLotsRefusalParams {
  /** The base action of the row (`SELL`, not a `SELL`-flavoured variant). */
  readonly action: string;
  /** The row's transaction date, YYYY-MM-DD. */
  readonly date: string;
  /** The row's quantity as stored (NUMERIC text), null when it has none. */
  readonly quantity: string | null;
}

export interface BondLotsRefusal {
  readonly code: BondLotsRefusalCode;
  /** The id of the row that refused, when the caller supplied ids. */
  readonly rowId?: string;
  /** Which row refused; a client renders its translated message from `code` and this. */
  readonly params: BondLotsRefusalParams;
  /**
   * English text for the logs only. Clients must not display it: compose the
   * message from `code` and `params` with translations and the user's number
   * and date formats.
   */
  readonly detail: string;
}

/** Lots known, or the reason they are not: never a guess. */
export type BondLotsResult =
  | {
      readonly lots: readonly BondLot[];
      readonly refusal: null;
      /**
       * The portions the last row took out of its account's lots, oldest
       * first, each with the exact cost it carried (`takeFifo`): empty when the
       * last row took nothing. What a removal takes is read from here, never
       * rebuilt from a difference of two folds (INV-BOND-007).
       */
      readonly takenByLastRow: readonly BondLot[];
    }
  | { readonly lots: null; readonly refusal: BondLotsRefusal };

type Step =
  | { readonly kind: "add"; readonly assumed: boolean }
  | { readonly kind: "remove" }
  /** A paired TRANSFER_OUT: the removed lots arrive in the other leg's account. */
  | { readonly kind: "move"; readonly toAccount: string }
  | { readonly kind: "split" }
  | { readonly kind: "none" };

/**
 * What each base action does to the lots (spec 12.2), as a table rather than a
 * switch: a split is not folded into a quantity here -- a bond does not split,
 * so the row refuses the derivation -- and the share-count reducer
 * (`applyActionToQuantity`) stays the one place that applies a split's ratio.
 * TRANSFER_IN and TRANSFER_OUT depend on whether the other leg is linked, so
 * they are resolved in `stepOf`. Anything absent is cash only (DIVIDEND,
 * INTEREST, CAPITAL_GAIN) and changes nothing.
 */
const LOT_EFFECT_BY_BASE_ACTION: ReadonlyMap<string, Step> = new Map<
  string,
  Step
>([
  [InvestmentAction.BUY, { kind: "add", assumed: false }],
  [InvestmentAction.REINVEST, { kind: "add", assumed: false }],
  [InvestmentAction.ADD_SHARES, { kind: "add", assumed: false }],
  [InvestmentAction.SELL, { kind: "remove" }],
  [InvestmentAction.REMOVE_SHARES, { kind: "remove" }],
  [InvestmentAction.SPLIT, { kind: "split" }],
]);

const NONE: Step = { kind: "none" };

function stepOf(row: BondLotTransaction): Step {
  const base = baseInvestmentAction(row.action);
  if (base === InvestmentAction.TRANSFER_IN) {
    // A linked leg arrives with the lots its TRANSFER_OUT moved, which keep
    // their purchase dates; an unlinked one is shares that arrived with no known
    // purchase.
    return row.pairedTransfer ? NONE : { kind: "add", assumed: true };
  }
  if (base === InvestmentAction.TRANSFER_OUT) {
    if (!row.pairedTransfer) return { kind: "remove" };
    // The pair is read at its outgoing leg, which names the destination. A pair
    // whose other account is unknown moves nothing between accounts.
    return row.counterpartAccountId === undefined ||
      row.counterpartAccountId === null
      ? NONE
      : { kind: "move", toAccount: row.counterpartAccountId };
  }
  return LOT_EFFECT_BY_BASE_ACTION.get(base) ?? NONE;
}

const refuse = (
  code: BondLotsRefusalCode,
  row: BondLotTransaction,
  detail: string,
): BondLotsResult => ({
  lots: null,
  refusal: {
    code,
    ...(row.id !== undefined ? { rowId: row.id } : {}),
    params: {
      action: baseInvestmentAction(row.action),
      date: row.transactionDate,
      quantity: row.quantity,
    },
    detail,
  },
});

/**
 * The open lots of a linked security from its investment transactions, per the
 * truth table of spec 12.2.
 *
 * `rows` must be in register order (`INVESTMENT_REPLAY_ORDER_SQL`); this is a
 * pure fold of them, so the lots on a past day are the fold of the rows dated up
 * to it. VOID rows are excluded. Lots are held per account: a removal takes
 * quantity first-in first-out from the lots of the row's own account, and a
 * paired transfer moves it between accounts keeping the purchase dates.
 * Anything that makes the lots unknowable -- a split, a quantity that is not a
 * whole number of bonds, a removal larger than the open lots -- refuses with the
 * reason and the date of the row, and returns no lots: nothing is guessed.
 */
export function bondLotsFromTransactions(
  rows: readonly BondLotTransaction[],
): BondLotsResult {
  // Lots per account, in the order the accounts first appear.
  const byAccount = new Map<string, BondLot[]>();
  const heldIn = (account: string): readonly BondLot[] =>
    byAccount.get(account) ?? [];

  let takenByLastRow: BondLot[] = [];
  for (const row of rows) {
    takenByLastRow = [];
    if (row.status === "VOID") continue;
    const step = stepOf(row);
    if (step.kind === "none") continue;
    const where = `${row.action} on ${row.transactionDate}`;

    if (step.kind === "split") {
      return refuse(
        "SPLIT",
        row,
        `A split (${where}) is recorded on this security, and a bond does not split`,
      );
    }

    const quantity = parseWholeQuantity(row.quantity);
    if (quantity === "fractional") {
      return refuse(
        "FRACTIONAL_QUANTITY",
        row,
        `${where} moves ${row.quantity} bonds, which is not a whole number`,
      );
    }
    if (quantity === "invalid") {
      return refuse(
        "INVALID_QUANTITY",
        row,
        `${where} has no usable quantity (${row.quantity ?? "none"})`,
      );
    }
    if (quantity === 0) continue;

    const account = accountKey(row.accountId);

    if (step.kind === "add") {
      if (row.instrumentId === null) {
        return refuse(
          "SERIES_NOT_DETERMINED",
          row,
          `${where} names no bond series and none could be determined from its date`,
        );
      }
      byAccount.set(account, [
        ...heldIn(account),
        {
          accountId: row.accountId ?? undefined,
          instrumentId: row.instrumentId ?? null,
          purchaseDate: row.transactionDate,
          quantity,
          purchaseDateAssumed: step.assumed,
          cost: step.assumed ? null : costText(row.cost),
        },
      ]);
      continue;
    }

    const series = row.instrumentId ?? null;
    const held = heldIn(account);
    const inSeries = (lot: BondLot) =>
      series === null || lot.instrumentId === series;
    const candidates = held.filter(inSeries);
    const taken = takeFifo(candidates, quantity);
    if (taken === null) {
      return series === null
        ? refuse(
            "OVER_REMOVAL",
            row,
            `${where} removes ${quantity} bonds, more than the ${totalOf(held)} held in its account`,
          )
        : refuse(
            "REMOVAL_EXCEEDS_SERIES",
            row,
            `${where} removes ${quantity} bonds of series ${series}, more than the ${totalOf(candidates)} of it held in its account`,
          );
    }
    byAccount.set(account, [
      ...held.filter((lot) => !inSeries(lot)),
      ...taken.rest,
    ]);
    takenByLastRow = taken.removed;

    if (step.kind === "move") {
      const destination = accountKey(step.toAccount);
      byAccount.set(destination, [
        ...heldIn(destination),
        ...taken.removed.map((lot) => ({ ...lot, accountId: step.toAccount })),
      ]);
    }
  }

  // Oldest first across accounts; the sort is stable, so equal dates keep the
  // order the accounts first appeared in.
  const open = [...byAccount.values()]
    .flat()
    .sort((a, b) => compareDates(a.purchaseDate, b.purchaseDate));
  return { lots: open, refusal: null, takenByLastRow };
}

/**
 * The lots open at the end of `date`: the fold of the rows dated on or before it.
 * A price for a past day is struck on the lots held that day, not on what is
 * left today.
 */
export function bondLotsAsOf(
  rows: readonly BondLotTransaction[],
  date: string,
): BondLotsResult {
  return bondLotsFromTransactions(
    rows.filter((row) => row.transactionDate <= date),
  );
}

type WholeQuantity = number | "fractional" | "invalid";

function parseWholeQuantity(text: string | null): WholeQuantity {
  if (text === null) return "invalid";
  let value: ExactDecimal;
  try {
    value = ExactDecimal.parse(text);
  } catch {
    return "invalid";
  }
  if (value.isNegative()) return "invalid";
  if (value.denominator !== 1n) return "fractional";
  if (value.numerator > BigInt(Number.MAX_SAFE_INTEGER)) return "invalid";
  // Whole and within the safe-integer range, so the conversion is exact.
  return Number(value.numerator);
}

function totalOf(lots: readonly BondLot[]): number {
  return lots.reduce((sum, lot) => sum + lot.quantity, 0);
}

const accountKey = (accountId: string | null | undefined): string =>
  accountId ?? "";

const compareDates = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Oldest lots first (by purchase date, then the order they arrived in); null
 * when `quantity` exceeds what is open. Returns what is left and the portions
 * taken, which keep their purchase dates (a transfer carries them along).
 */
function takeFifo(
  lots: readonly BondLot[],
  quantity: number,
): { rest: BondLot[]; removed: BondLot[] } | null {
  if (quantity > totalOf(lots)) return null;
  const rest: BondLot[] = [];
  const removed: BondLot[] = [];
  let remaining = quantity;
  const oldestFirst = [...lots].sort((a, b) =>
    compareDates(a.purchaseDate, b.purchaseDate),
  );
  for (const lot of oldestFirst) {
    if (remaining === 0) {
      rest.push(lot);
    } else if (lot.quantity <= remaining) {
      remaining -= lot.quantity;
      removed.push(lot);
    } else {
      const [takenCost, keptCost] = splitCost(
        lot.cost,
        remaining,
        lot.quantity,
      );
      rest.push({
        ...lot,
        quantity: lot.quantity - remaining,
        cost: keptCost,
      });
      removed.push({ ...lot, quantity: remaining, cost: takenCost });
      remaining = 0;
    }
  }
  return { rest, removed };
}

/** The cost places of a row's total amount (NUMERIC(20,4)); a split rounds to them. */
const COST_PLACES = 4;

/** A cost that is a usable non-negative decimal, else null (unknown). */
function costText(cost: string | null | undefined): string | null {
  if (cost === null || cost === undefined) return null;
  try {
    const parsed = ExactDecimal.parse(cost);
    // On the cost places, so every split of it stays on them and adds up.
    return parsed.isNegative()
      ? null
      : parsed.round(COST_PLACES, "HALF_UP").toFixed(COST_PLACES);
  } catch {
    return null;
  }
}

/**
 * `cost` split for `taken` of `quantity` bonds, pro rata: the taken part is
 * rounded to the cost places (half up) and the part that stays is the rest, so
 * the two add up to the whole exactly. An unknown cost stays unknown in both.
 */
function splitCost(
  cost: string | null,
  taken: number,
  quantity: number,
): readonly [string | null, string | null] {
  if (cost === null) return [null, null];
  const whole = ExactDecimal.parse(cost);
  const part = whole
    .mul(ExactDecimal.ratio(taken, quantity))
    .round(COST_PLACES, "HALF_UP");
  return [part.toFixed(COST_PLACES), whole.sub(part).toFixed(COST_PLACES)];
}
