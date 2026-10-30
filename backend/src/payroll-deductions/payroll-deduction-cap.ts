import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { roundMoney } from "../common/round.util";
import { deductionPeriod, DeductionPeriod } from "./payroll-deduction-period";

/**
 * The one definition of "paid", "remaining" and "capped" the posting and the
 * projection share (docs/specs/payroll-deductions.md, INV-PAYROLL-003). The
 * posting applies it under its own lock; the read model computes the same
 * figures as of today and the forecast spends them occurrence by occurrence.
 */

/** A deduction line reduced to the room left; a positive line is not one. */
export function capDeductionLine(line: number, remaining: number): number {
  if (!(line < 0)) return line;
  const owed = Math.min(-line, Math.max(remaining, 0));
  return roundMoney(-owed);
}

/** The room left under `yearlyMaximum` after `paidToDate`, never below zero. */
export function remainingRoom(
  yearlyMaximum: number,
  paidToDate: number,
): number {
  const max = Math.max(0, Number(yearlyMaximum));
  return roundMoney(Math.min(max, Math.max(0, max - paidToDate)));
}

/** What the ledger holds for one category in one period, in one currency. */
export interface CategoryPeriodPaid {
  /** The negation of the signed sum of the rows in `currencyCode`. */
  paidToDate: number;
  /** Rows of the category in the period in another currency, not converted. */
  foreignCurrencyRows: number;
}

/** How a figures resolver reads the ledger; `memoisedPaidLookup` dedupes it. */
export type PaidLookup = (
  categoryId: string,
  period: Pick<DeductionPeriod, "periodStart" | "periodEnd">,
  currencyCode: string,
) => Promise<CategoryPeriodPaid>;

/**
 * One ledger read per (category, period, currency) for the lifetime of the
 * lookup: two paycheques capping one category, or two rules sharing a
 * period, cost one query instead of one per rule on the scheduled list read.
 */
export function memoisedPaidLookup(
  m: EntityManager,
  userId: string,
): PaidLookup {
  const cache = new Map<string, Promise<CategoryPeriodPaid>>();
  return (categoryId, period, currencyCode) => {
    const key = `${categoryId}|${period.periodStart}|${period.periodEnd}|${currencyCode}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = queryCategoryPeriodPaid(
        m,
        userId,
        categoryId,
        period,
        currencyCode,
      );
      cache.set(key, hit);
    }
    return hit;
  };
}

/**
 * The category's rows between two dates, the one definition of what "paid"
 * sums: unsplit transactions carrying the category and split lines carrying
 * it, VOID excluded, every account. The same rows `queryCategorySpending`
 * counts for a budget. Parameters: `$1` user, `$2` category, `$3` first day,
 * `$4` last day. Columns: `transaction_id`, `transaction_date`, `created_at`,
 * `payee_name`, `amount` (signed), `currency_code`. The year-to-date figure
 * and the payroll deductions report both read through it, so the report's
 * columns add up to the figure the cap spends (INV-PAYROLL-003).
 */
export const CATEGORY_DEDUCTION_ROWS_SQL = `SELECT t.id AS transaction_id, t.transaction_date, t.created_at,
              t.payee_name, t.amount, t.currency_code
         FROM transactions t
        WHERE t.user_id = $1
          AND t.category_id = $2
          AND t.is_split = false
          AND t.status <> 'VOID'
          AND t.transaction_date BETWEEN $3::date AND $4::date
       UNION ALL
       SELECT t.id, t.transaction_date, t.created_at,
              t.payee_name, s.amount, t.currency_code
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
        WHERE t.user_id = $1
          AND s.category_id = $2
          AND t.status <> 'VOID'
          AND t.transaction_date BETWEEN $3::date AND $4::date`;

/**
 * What the category's rows (`CATEGORY_DEDUCTION_ROWS_SQL`) between the two
 * dates add up to; the sum is taken only over rows in the bill's currency
 * (decision 6).
 */
export async function queryCategoryPeriodPaid(
  m: EntityManager,
  userId: string,
  categoryId: string,
  period: Pick<DeductionPeriod, "periodStart" | "periodEnd">,
  currencyCode: string,
): Promise<CategoryPeriodPaid> {
  const rows = returnedRows<{ total: string | null; foreign_rows: string }>(
    await m.query(
      `SELECT COALESCE(SUM(x.amount) FILTER (WHERE x.currency_code = $5), 0) AS total,
              COUNT(*) FILTER (WHERE x.currency_code <> $5) AS foreign_rows
         FROM (${CATEGORY_DEDUCTION_ROWS_SQL}) x`,
      [userId, categoryId, period.periodStart, period.periodEnd, currencyCode],
    ),
  );
  const signed = Number(rows[0]?.total ?? 0);
  return {
    paidToDate: roundMoney(-signed),
    foreignCurrencyRows: Number(rows[0]?.foreign_rows ?? 0),
  };
}

/** A rule as the capping and figure helpers need it. */
export interface DeductionRuleFacts {
  id: string;
  categoryId: string;
  yearlyMaximum: number;
  resetDate: string;
  expectedPerPaycheque: number | null;
}

/** One split line as the posting payload carries it. */
export interface CappableSplit {
  splitKind?: string;
  categoryId?: string | null;
  amount: number;
  investment?: unknown;
}

export interface CapResult<T extends CappableSplit> {
  splits: T[];
  changed: boolean;
}

/**
 * The other active bills' rules on these categories that the projection
 * pools with the posting bill's own: same currency, and a positive expected
 * figure (an entered one, or a negative line on the bill). Mirrors
 * `spendableRules` and `buildDeductionPools` in `frontend/src/lib/forecast.ts`
 * so the posting and the forecast reduce a line by one definition
 * (INV-PAYROLL-003).
 */
export async function loadPooledPeerRules(
  m: EntityManager,
  userId: string,
  scheduledTransactionId: string,
  categoryIds: readonly string[],
  currencyCode: string,
): Promise<DeductionRuleFacts[]> {
  if (categoryIds.length === 0) return [];
  const rows = returnedRows<{
    id: string;
    category_id: string;
    yearly_maximum: string;
    reset_date: string;
  }>(
    await m.query(
      `SELECT r.id, r.category_id, r.yearly_maximum,
              TO_CHAR(r.reset_date, 'YYYY-MM-DD') AS reset_date
         FROM payroll_deduction_rules r
         JOIN scheduled_transactions s ON s.id = r.scheduled_transaction_id
        WHERE r.user_id = $1
          AND r.category_id = ANY($2)
          AND r.scheduled_transaction_id <> $3
          AND s.is_active = true
          AND s.currency_code = $4
          AND (COALESCE(r.expected_per_paycheque, 0) > 0
               OR EXISTS (SELECT 1 FROM scheduled_transaction_splits sp
                           WHERE sp.scheduled_transaction_id = s.id
                             AND sp.category_id = r.category_id
                             AND sp.amount < 0))`,
      [userId, [...categoryIds], scheduledTransactionId, currencyCode],
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    categoryId: r.category_id,
    yearlyMaximum: Number(r.yearly_maximum),
    resetDate: r.reset_date,
    expectedPerPaycheque: null,
  }));
}

/**
 * Reduce every category line a rule names to the room left on `postDate`,
 * reading the ledger through the posting transaction's own manager
 * (INV-PAYROLL-002). Lines without a rule, positive lines, transfer and
 * investment lines are returned as they came.
 */
export async function applyPayrollDeductionCaps<T extends CappableSplit>(
  m: EntityManager,
  userId: string,
  rules: readonly DeductionRuleFacts[],
  currencyCode: string,
  postDate: string,
  splits: readonly T[],
  peers: readonly DeductionRuleFacts[] = [],
): Promise<CapResult<T>> {
  if (rules.length === 0) return { splits: [...splits], changed: false };
  const byCategory = new Map(rules.map((r) => [r.categoryId, r]));
  const roomByCategory = new Map<string, number>();
  const paidLookup = memoisedPaidLookup(m, userId);
  let changed = false;
  const result: T[] = [];
  for (const split of splits) {
    const rule =
      split.categoryId && !split.investment
        ? byCategory.get(split.categoryId)
        : undefined;
    if (!rule || (split.splitKind && split.splitKind !== "category")) {
      result.push(split);
      continue;
    }
    let room = roomByCategory.get(rule.categoryId);
    if (room === undefined) {
      // The lowest room among every rule on the category binds, each over
      // its own period, as `buildDeductionPools` pools them.
      room = Infinity;
      for (const r of [
        rule,
        ...peers.filter((p) => p.categoryId === rule.categoryId),
      ]) {
        const paid = await paidLookup(
          r.categoryId,
          deductionPeriod(r.resetDate, postDate),
          currencyCode,
        );
        room = Math.min(room, remainingRoom(r.yearlyMaximum, paid.paidToDate));
      }
    }
    const capped = capDeductionLine(Number(split.amount), room);
    // Two lines of one category share the room, in order.
    roomByCategory.set(rule.categoryId, roundMoney(room + capped));
    if (capped !== roundMoney(Number(split.amount))) {
      changed = true;
      result.push({ ...split, amount: capped });
    } else {
      result.push(split);
    }
  }
  return { splits: result, changed };
}

/** The figures a rule carries on every surface (spec section 5.3). */
export interface PayrollDeductionFigures extends DeductionPeriod {
  paidToDate: number;
  remaining: number;
  foreignCurrencyRows: number;
  currencyCode: string;
  /** A magnitude, `null` when neither a line nor an entered value gives one. */
  expectedPerPaycheque: number | null;
  expectedSource: "line" | "entered" | null;
}

/**
 * The expected amount a rule projects with: the bill's own line for the
 * category when it has one, else the figure the user entered (decision 3).
 */
export function resolveExpectedPerPaycheque(
  rule: Pick<DeductionRuleFacts, "categoryId" | "expectedPerPaycheque">,
  lines: readonly { categoryId?: string | null; amount: number }[],
): Pick<PayrollDeductionFigures, "expectedPerPaycheque" | "expectedSource"> {
  const line = lines.find((l) => l.categoryId === rule.categoryId);
  if (line && Number(line.amount) < 0) {
    return {
      expectedPerPaycheque: roundMoney(-Number(line.amount)),
      expectedSource: "line",
    };
  }
  if (
    rule.expectedPerPaycheque !== null &&
    rule.expectedPerPaycheque !== undefined
  ) {
    return {
      expectedPerPaycheque: roundMoney(Number(rule.expectedPerPaycheque)),
      expectedSource: "entered",
    };
  }
  return { expectedPerPaycheque: null, expectedSource: null };
}

/** The figures of one rule as of `asOf`, read through `m`. */
export async function resolvePayrollDeductionFigures(
  m: EntityManager,
  userId: string,
  rule: DeductionRuleFacts,
  lines: readonly { categoryId?: string | null; amount: number }[],
  currencyCode: string,
  asOf: string,
  paidLookup: PaidLookup = (categoryId, period, currency) =>
    queryCategoryPeriodPaid(m, userId, categoryId, period, currency),
): Promise<PayrollDeductionFigures> {
  const period = deductionPeriod(rule.resetDate, asOf);
  const paid = await paidLookup(rule.categoryId, period, currencyCode);
  return {
    ...period,
    paidToDate: paid.paidToDate,
    remaining: remainingRoom(rule.yearlyMaximum, paid.paidToDate),
    foreignCurrencyRows: paid.foreignCurrencyRows,
    currencyCode,
    ...resolveExpectedPerPaycheque(rule, lines),
  };
}
