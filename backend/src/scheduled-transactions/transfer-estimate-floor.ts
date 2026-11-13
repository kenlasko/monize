import { computeStatementCycle } from "../accounts/statement-cycle.util";
import { addDaysYMD } from "../common/date-utils";
import type { FrequencyType } from "../common/recurrence";
import { roundMoney } from "../common/round.util";

/**
 * The balance floor of an estimated scheduled transfer (issue #2164,
 * docs/specs/scheduled-amount-estimate.md section 10). Pure: the destination's
 * ledger figures arrive already read, so every rule here is testable without
 * a database.
 *
 * The transfer's history estimate is the baseline of each occurrence. What the
 * destination is owed raises it, never lowers it:
 *
 *  - STATEMENT mode, a monthly transfer into a credit card whose statement
 *    settlement and due days are both set. The occurrence paying the statement
 *    that last closed is raised to what that statement still owes; the one
 *    paying the open cycle is raised to what the card owes beyond it. Later
 *    occurrences stay at the baseline.
 *  - BALANCE mode, any other transfer. The next occurrence is raised to what
 *    the destination owes today; later occurrences stay at the baseline. A
 *    destination holding money (an asset with a positive balance) owes nothing,
 *    so it never raises anything.
 */

/** What the floor needs to know about the transfer's destination account. */
export interface TransferDestinationFacts {
  accountType: string;
  statementSettlementDay: number | null;
  statementDueDay: number | null;
}

/** How one schedule's occurrences are raised, decided before the ledger read. */
export type TransferFloorPlan =
  | {
      mode: "statement";
      /** The newest settlement date strictly before today: the closed statement. */
      lastSettlement: string;
      /** The first settlement date on or after today: the open cycle's close. */
      openSettlement: string;
      /** The settlement after the open one. */
      followingSettlement: string;
    }
  | { mode: "balance" };

/**
 * The destination's ledger, signed as stored (a card in debt is negative), in
 * the destination's currency.
 */
export interface TransferDestinationLedger {
  /** The balance as of today: every movement dated on or before today. */
  balanceToday: number;
  /**
   * The balance as of `lastSettlement` (statement mode), or `null` when the
   * plan does not read one.
   */
  balanceAtLastSettlement: number | null;
  /**
   * The sum of the credits (payments, refunds) dated after `lastSettlement`
   * and on or before today, >= 0; 0 when the plan reads none.
   */
  creditsSinceLastSettlement: number;
}

/**
 * One raise: an occurrence due after `after` (exclusive, `null` for no lower
 * bound) and on or before `through` is raised to `owed`, when `owed` is more
 * than its baseline.
 */
export interface EstimateBalanceFloor {
  after: string | null;
  through: string;
  /** What the destination is owed for these occurrences, >= 0, in the schedule's currency. */
  owed: number;
}

/**
 * The settlement dates around `today` for a card settling on `settlementDay`.
 * The settlement day is the last day of its cycle, so a cycle closing today is
 * still open: its rows are dated on or before today.
 */
function settlementDatesAround(
  settlementDay: number,
  today: string,
): {
  lastSettlement: string;
  openSettlement: string;
  followingSettlement: string;
} {
  const current = computeStatementCycle(settlementDay, null, today);
  const following = computeStatementCycle(
    settlementDay,
    null,
    addDaysYMD(current.nextSettlementDate, 1),
  );
  return {
    lastSettlement: current.lastSettlementDate,
    openSettlement: current.nextSettlementDate,
    followingSettlement: following.nextSettlementDate,
  };
}

/**
 * Statement mode for a monthly transfer into a credit card with both statement
 * days; balance mode otherwise. A schedule paying more often than monthly has
 * more than one occurrence per cycle, and raising each of them to the same
 * statement would ask for it twice, so it raises only its next occurrence.
 */
export function transferFloorPlan(
  destination: TransferDestinationFacts | null,
  frequency: FrequencyType,
  today: string,
): TransferFloorPlan {
  if (
    destination &&
    destination.accountType === "CREDIT_CARD" &&
    destination.statementSettlementDay !== null &&
    destination.statementDueDay !== null &&
    frequency === "MONTHLY"
  ) {
    return {
      mode: "statement",
      ...settlementDatesAround(destination.statementSettlementDay, today),
    };
  }
  return { mode: "balance" };
}

/**
 * The floors of one schedule, in the destination's currency.
 *
 * Statement mode, with S the closed statement's settlement date:
 *  - an occurrence due after S through the open settlement pays the closed
 *    statement: what it still owes, the debt at S less the credits since;
 *  - an occurrence due in the cycle after pays the open cycle: today's debt
 *    less what the closed statement still owes.
 *
 * Balance mode: the next occurrence (due on or before `nextOccurrenceDueDate`)
 * is raised to today's debt.
 *
 * @param decimals the destination currency's money precision.
 */
export function transferBalanceFloors(
  plan: TransferFloorPlan,
  ledger: TransferDestinationLedger,
  nextOccurrenceDueDate: string,
  decimals: number,
): EstimateBalanceFloor[] {
  const owedToday = Math.max(0, roundMoney(-ledger.balanceToday, decimals));
  if (plan.mode === "balance" || ledger.balanceAtLastSettlement === null) {
    return [{ after: null, through: nextOccurrenceDueDate, owed: owedToday }];
  }
  const statementOwed = Math.max(
    0,
    roundMoney(
      -ledger.balanceAtLastSettlement - ledger.creditsSinceLastSettlement,
      decimals,
    ),
  );
  return [
    {
      after: plan.lastSettlement,
      through: plan.openSettlement,
      owed: statementOwed,
    },
    {
      after: plan.openSettlement,
      through: plan.followingSettlement,
      owed: Math.max(0, roundMoney(owedToday - statementOwed, decimals)),
    },
  ];
}

/** The floor an occurrence due on `dueDate` is raised by, if any. */
export function floorFor(
  floors: readonly EstimateBalanceFloor[],
  dueDate: string,
): EstimateBalanceFloor | null {
  return (
    floors.find(
      (f) => (f.after === null || dueDate > f.after) && dueDate <= f.through,
    ) ?? null
  );
}

/**
 * `amount` (an estimate, signed) raised to `floor`'s debt when that is more,
 * keeping the estimate's sign, rounded to `decimals` (the entry places every
 * estimate is rounded to). `raised` says which of the two it is.
 */
export function applyBalanceFloor(
  amount: number,
  floor: EstimateBalanceFloor | null,
  decimals: number,
): { amount: number; raised: boolean } {
  if (!floor) return { amount, raised: false };
  const owed = roundMoney(floor.owed, decimals);
  if (owed <= Math.abs(amount)) return { amount, raised: false };
  return { amount: amount > 0 ? owed : -owed, raised: true };
}
