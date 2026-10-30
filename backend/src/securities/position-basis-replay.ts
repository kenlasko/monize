import {
  InvestmentAction,
  InvestmentTransaction,
} from "./entities/investment-transaction.entity";
import {
  acquisitionCost,
  applyActionToQuantity,
  applyReturnOfCapital,
  baseInvestmentAction,
  HOLDING_QUANTITY_EPSILON,
  orderTransferOutBeforeIn,
  returnOfCapitalAmount,
} from "./investment-replay.util";

/**
 * The one fold of a position's cost basis (`docs/specs/realized-gain-basis-and-currency.md`).
 *
 * The cost-basis lots, the realized-gain report and the capital-gains-by-period
 * report each kept their own copy, so a rule fixed in one (an unpriced lot,
 * commission in the basis, a return of capital, a basis in two currencies) was
 * missing in another and the same sale read differently on each. They now read
 * this, and what differs between them is an option, not a second fold.
 *
 * It folds share counts with `applyActionToQuantity`, acquisitions with
 * `acquisitionCost` and distributions with `applyReturnOfCapital`.
 */

/** Why a replayed basis cannot be trusted against the live holding. */
export type ReplayedBasisGap =
  | "quantity_only_action"
  | "unpriced_acquisition"
  | "mixed_basis_currency"
  | "transferred_basis_unknown";

/**
 * Where a trade's money landed, in the two roles an account can play. Both maps
 * are keyed by account id and agree for every account that is not a brokerage
 * with a linked cash account.
 */
export interface SettlementCurrencies {
  /** The account's own currency -- what an explicitly named funding account settles in. */
  own: Map<string, string>;
  /** Where a brokerage's cash sits: its linked cash account's currency, or its own. */
  brokerage: Map<string, string>;
}

/**
 * The rate converting `from` into `to` on `onDate`, or null when none is
 * known. Synchronous because the replay is: the caller resolves rates first
 * (see `PortfolioCalculationService.replayWithRates`).
 */
export type ReplayRateLookup = (
  from: string,
  to: string,
  onDate: string,
) => number | null;

export interface ReplayOptions {
  settlement: SettlementCurrencies;
  /**
   * Without it, a position's basis is in whatever currency its first lot
   * settled in and a second currency makes it `mixed_basis_currency` (the lots
   * replay, whose callers compare `currencyCode` themselves).
   *
   * With it, a position is reported in its holding account's currency: each
   * row's amount is converted into it, or the figure is unknown. A row's own
   * amounts are used where they reach the target (the native amount for the
   * security's currency, the row's rate for its settlement currency) and the
   * market rate on the row's own date otherwise (INV-FX-002, INV-FX-001).
   */
  rateFor?: ReplayRateLookup;
  /**
   * A TRANSFER_IN whose paired leg cannot be used: the leg is outside the rows,
   * its source basis is unknown, or the two accounts differ in currency.
   * `own_row` prices it from its own price and rate (the realized-gain and
   * by-period reports' recorded residual); `unknown` marks the basis unknown
   * (the lots replay).
   */
  orphanTransferIn: "own_row" | "unknown";
}

export interface PositionState {
  quantity: number;
  costBasis: number;
  /** The currency `costBasis` is in; null when the replay could not settle on one. */
  currencyCode: string | null;
  basisGap: ReplayedBasisGap | null;
}

/** What one row did, for a caller that reports per row. */
export interface ReplayStep {
  /** The position's quantity after the row. */
  quantity: number;
  /**
   * BUY, REINVEST and TRANSFER_IN: the cost that joined the basis, in the
   * position's currency, or null when the row could not state one.
   */
  acquired?: number | null;
  /** SELL (and REDEEM) and RETURN_OF_CAPITAL: what the row realized. */
  disposal?: {
    /** The basis relieved: a sale's share of the average, a return's part of the basis. */
    basisRelieved: number;
    /** The proceeds in the position's currency; null when they could not be converted. */
    proceeds: number | null;
    /** The proceeds as the row settled them, whatever currency that is. */
    settledProceeds: number;
    /** Why the gain is unknown; null when `realizedGain` is a figure. */
    gap: ReplayedBasisGap | null;
    realizedGain: number | null;
  };
}

export interface ReplayResult {
  /** Keyed `${accountId}:${securityId}`. */
  positions: Map<string, PositionState>;
  steps: Map<InvestmentTransaction, ReplayStep>;
}

interface Carried {
  amount: number;
  currencyCode: string | null;
  known: boolean;
}

interface Entry extends PositionState {
  /** The holding account's currency when converting; null in the lots replay. */
  target: string | null;
}

export function replayPositionBasis(
  transactions: readonly InvestmentTransaction[],
  options: ReplayOptions,
): ReplayResult {
  const { settlement, rateFor, orphanTransferIn } = options;
  const entries = new Map<string, Entry>();
  const steps = new Map<InvestmentTransaction, ReplayStep>();
  // What each TRANSFER_OUT released, keyed by its id, which the IN leg names in
  // `linkedTransactionId`. The OUT leg is read first (`orderTransferOutBeforeIn`).
  const carriedByTransferOut = new Map<string, Carried>();

  const settledIn = (
    tx: InvestmentTransaction,
    entry: Entry,
  ): string | undefined => {
    // The funding account settles in its own currency; a row with no funding
    // account settles wherever the brokerage's cash sits.
    const found = tx.fundingAccountId
      ? settlement.own.get(tx.fundingAccountId)
      : settlement.brokerage.get(tx.accountId);
    // Converting with nothing recorded for the account: its own currency.
    return (
      found ?? (tx.fundingAccountId ? undefined : (entry.target ?? undefined))
    );
  };

  /** `settled` is in `from`; `native` in the security's currency; null when unconvertible. */
  const convert = (
    tx: InvestmentTransaction,
    entry: Entry,
    from: string | undefined,
    settled: number,
    native: number | null,
  ): number | null => {
    const target = entry.target;
    if (target === null || rateFor === undefined) return settled;
    if (from === undefined) return null;
    if (from === target) return settled;
    if (native !== null && tx.security?.currencyCode === target) return native;
    const rate = rateFor(from, target, tx.transactionDate);
    return rate === null ? null : settled * rate;
  };

  for (const tx of orderTransferOutBeforeIn(transactions)) {
    if (!tx.securityId) continue;

    const key = `${tx.accountId}:${tx.securityId}`;
    let entry = entries.get(key);
    if (!entry) {
      const target = rateFor ? (tx.account?.currencyCode ?? null) : null;
      entry = {
        quantity: 0,
        costBasis: 0,
        currencyCode: target,
        basisGap: null,
        target,
      };
      entries.set(key, entry);
    }
    const position = entry;
    const step: ReplayStep = { quantity: 0 };
    steps.set(tx, step);
    const quantity = Number(tx.quantity) || 0;

    /** An acquisition priced from the row itself. */
    const acquire = (): void => {
      position.quantity = applyActionToQuantity(
        position.quantity,
        tx.action,
        quantity,
      );
      // A stored `0` or a missing price is unknown, not a free acquisition
      // (`acquisitionCost`); the units joined and nothing joined the basis.
      const cost = acquisitionCost(tx);
      if (cost === null) {
        position.basisGap ??= "unpriced_acquisition";
        step.acquired = null;
        return;
      }
      const from = settledIn(tx, position);
      if (from === undefined) {
        position.basisGap ??= "mixed_basis_currency";
        step.acquired = null;
        return;
      }
      const amount = convert(
        tx,
        position,
        from,
        cost,
        acquisitionCost({
          quantity: tx.quantity,
          price: tx.price,
          commission: tx.commission,
          totalAmount: tx.totalAmount,
          exchangeRate: 1,
        }),
      );
      if (amount === null) {
        position.basisGap ??= "mixed_basis_currency";
        step.acquired = null;
        return;
      }
      if (position.target === null) {
        // Acquisitions settled in two currencies cannot be added together.
        if (position.currencyCode === null) position.currencyCode = from;
        else if (position.currencyCode !== from) {
          position.basisGap ??= "mixed_basis_currency";
        }
      }
      position.costBasis += amount;
      step.acquired = amount;
    };

    switch (baseInvestmentAction(tx.action)) {
      case InvestmentAction.BUY:
      case InvestmentAction.REINVEST:
        acquire();
        break;
      // A transfer is neither a sale nor a purchase: the destination takes the
      // basis the source gave up (A26-M21).
      case InvestmentAction.TRANSFER_IN: {
        const carried = tx.linkedTransactionId
          ? carriedByTransferOut.get(tx.linkedTransactionId)
          : undefined;
        const sameCurrency =
          position.currencyCode === null ||
          position.currencyCode === carried?.currencyCode;
        if (carried?.known && sameCurrency) {
          position.quantity = applyActionToQuantity(
            position.quantity,
            tx.action,
            quantity,
          );
          position.currencyCode ??= carried.currencyCode;
          position.costBasis += carried.amount;
          step.acquired = carried.amount;
        } else if (orphanTransferIn === "own_row") {
          acquire();
        } else {
          position.quantity = applyActionToQuantity(
            position.quantity,
            tx.action,
            quantity,
          );
          position.basisGap ??= carried?.known
            ? "mixed_basis_currency"
            : "transferred_basis_unknown";
        }
        break;
      }
      case InvestmentAction.SELL:
      case InvestmentAction.TRANSFER_OUT: {
        let released = 0;
        let releasedAll = false;
        if (position.quantity > 0) {
          const avgCostPerShare = position.costBasis / position.quantity;
          const sellQty = Math.min(quantity, position.quantity);
          released = sellQty * avgCostPerShare;
          releasedAll = sellQty >= quantity - HOLDING_QUANTITY_EPSILON;
          position.costBasis -= released;
        }
        // The quantity is the one replay every surface shares (INV-HOLDING-002):
        // the whole sale comes off, as the holdings rebuild takes it. Units the
        // position did not hold have no recorded cost, so the basis is unknown,
        // not an invented zero.
        position.quantity = applyActionToQuantity(
          position.quantity,
          tx.action,
          quantity,
        );
        if (!releasedAll && quantity !== 0) {
          position.basisGap ??= "quantity_only_action";
        }
        if (baseInvestmentAction(tx.action) === InvestmentAction.SELL) {
          // `totalAmount` is in the security's currency and net of commission;
          // the row's rate takes it into the settlement currency.
          const total = Number(tx.totalAmount);
          // An absent rate is the column's own default (settled in the
          // security's currency); a stored zero or negative one cannot convert,
          // and is unknown rather than par.
          const rate = tx.exchangeRate == null ? 1 : Number(tx.exchangeRate);
          const rateUsable = Number.isFinite(rate) && rate > 0;
          const settledProceeds = rateUsable ? total * rate : total;
          const proceeds = rateUsable
            ? convert(
                tx,
                position,
                settledIn(tx, position),
                settledProceeds,
                total,
              )
            : null;
          // Judged before the position snaps to zero: selling everything of an
          // unknown basis is still a sale of an unknown basis.
          const gap =
            position.basisGap ??
            (proceeds === null ? "mixed_basis_currency" : null);
          step.disposal = {
            basisRelieved: released,
            proceeds,
            settledProceeds,
            gap,
            realizedGain:
              gap === null && proceeds !== null ? proceeds - released : null,
          };
        } else {
          // What the destination inherits. Recorded even when it is not
          // knowable, so the paired leg can tell "the source gave up an
          // unpriced position" from "the source is not in this replay"; and
          // not known unless the source held every unit moved, or the
          // destination would get a basis for fewer shares than it received.
          carriedByTransferOut.set(tx.id, {
            amount: released,
            currencyCode: position.currencyCode,
            known:
              position.basisGap === null &&
              position.currencyCode !== null &&
              releasedAll,
          });
        }
        break;
      }
      case InvestmentAction.ADD_SHARES:
      case InvestmentAction.REMOVE_SHARES:
        // Units with no cost in the ledger: not a zero-cost lot, an unknown one.
        position.quantity = applyActionToQuantity(
          position.quantity,
          tx.action,
          quantity,
        );
        if (quantity !== 0) position.basisGap = "quantity_only_action";
        break;
      case InvestmentAction.RETURN_OF_CAPITAL: {
        // Pays back cost, never below zero; the excess is a gain realized on
        // the row's date. It comes off the basis only in the basis's currency,
        // the test an acquisition passes to join it.
        const raw = returnOfCapitalAmount(tx);
        const from = settledIn(tx, position);
        const amount =
          raw === null
            ? null
            : convert(
                tx,
                position,
                from,
                raw,
                returnOfCapitalAmount({ totalAmount: tx.totalAmount }),
              );
        if (
          amount === null ||
          from === undefined ||
          (position.target === null &&
            position.currencyCode !== null &&
            position.currencyCode !== from)
        ) {
          position.basisGap ??= "mixed_basis_currency";
          step.disposal = {
            basisRelieved: 0,
            proceeds: null,
            settledProceeds: raw ?? 0,
            gap: "mixed_basis_currency",
            realizedGain: null,
          };
          break;
        }
        const effect = applyReturnOfCapital(position.costBasis, amount);
        position.costBasis = effect.costBasis;
        step.disposal = {
          basisRelieved: effect.basisReturned,
          proceeds: amount,
          settledProceeds: raw ?? amount,
          gap: position.basisGap,
          realizedGain: position.basisGap === null ? effect.realizedGain : null,
        };
        break;
      }
      default:
        // SPLIT scales the quantity and keeps the total cost; the cash actions
        // move no shares.
        position.quantity = applyActionToQuantity(
          position.quantity,
          tx.action,
          quantity,
        );
        break;
    }

    // Snap near-zero quantities to exactly zero so precision drift does not
    // leave a residual basis on a closed position. A closed position also
    // clears the gap -- what the history could not price was disposed of, and
    // the next purchase is priced by the rows that buy it -- and the currency,
    // since the next position may settle somewhere else.
    if (Math.abs(position.quantity) < 0.0001) {
      position.quantity = 0;
      position.costBasis = 0;
      position.basisGap = null;
      position.currencyCode = position.target;
    }
    step.quantity = position.quantity;
  }

  return { positions: entries, steps };
}
