import { EntityManager } from "typeorm";
import { returnedRows } from "../common/db/query-result";
import { roundMoney } from "../common/round.util";

/**
 * A rule's figures per period (docs/specs/payroll-deductions.md section 11).
 * The period starting on `P` uses the rule's row with the greatest
 * `periodStart <= P`, so a period with no row of its own carries the previous
 * figures forward; a rule with no such row reads its own columns, which is
 * how every rule created before the table answered.
 */

/** One stored row: the figures from `periodStart` on. */
export interface RulePeriodFigures {
  periodStart: string;
  yearlyMaximum: number;
  expectedPerPaycheque: number | null;
}

/** What a rule needs to answer for a period. */
export interface RuleWithPeriods {
  yearlyMaximum: number;
  /** Absent where only the maximum is read (the report, the reminder). */
  expectedPerPaycheque?: number | null;
  periods?: readonly RulePeriodFigures[] | null;
}

/** The figures a period uses, and whether a row (not the columns) gave them. */
export interface ResolvedPeriodFigures {
  yearlyMaximum: number;
  expectedPerPaycheque: number | null;
  /** The row the figures came from starts on this day; `null` for the columns. */
  fromPeriodStart: string | null;
  /** A row gave the figures; the columns hold only the latest current figure. */
  recorded: boolean;
}

function toNumberOrNull(value: number | string | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

/** The figures of the period starting on `periodStart` (truth table D). */
export function figuresForPeriod(
  rule: RuleWithPeriods,
  periodStart: string,
): ResolvedPeriodFigures {
  let best: RulePeriodFigures | null = null;
  for (const row of rule.periods ?? []) {
    if (row.periodStart > periodStart) continue;
    if (!best || row.periodStart > best.periodStart) best = row;
  }
  if (best) {
    return {
      yearlyMaximum: roundMoney(Number(best.yearlyMaximum)),
      expectedPerPaycheque: toNumberOrNull(best.expectedPerPaycheque),
      fromPeriodStart: best.periodStart,
      recorded: true,
    };
  }
  return {
    yearlyMaximum: roundMoney(Number(rule.yearlyMaximum)),
    expectedPerPaycheque: toNumberOrNull(rule.expectedPerPaycheque),
    fromPeriodStart: null,
    recorded: false,
  };
}

/** The stored rows of each rule, keyed by rule id; RLS scopes them to the caller. */
export async function loadRulePeriods(
  m: EntityManager,
  ruleIds: readonly string[],
): Promise<Map<string, RulePeriodFigures[]>> {
  const result = new Map<string, RulePeriodFigures[]>();
  if (ruleIds.length === 0) return result;
  const rows = returnedRows<{
    rule_id: string;
    period_start: string;
    yearly_maximum: string;
    expected_per_paycheque: string | null;
  }>(
    await m.query(
      `SELECT rule_id, TO_CHAR(period_start, 'YYYY-MM-DD') AS period_start,
              yearly_maximum, expected_per_paycheque
         FROM payroll_deduction_rule_periods
        WHERE rule_id = ANY($1)
        ORDER BY rule_id, period_start`,
      [[...ruleIds]],
    ),
  );
  for (const row of rows) {
    let periods = result.get(row.rule_id);
    if (!periods) {
      periods = [];
      result.set(row.rule_id, periods);
    }
    periods.push({
      periodStart: row.period_start,
      yearlyMaximum: Number(row.yearly_maximum),
      expectedPerPaycheque: toNumberOrNull(row.expected_per_paycheque),
    });
  }
  return result;
}

/** Write the figures of the period starting on `periodStart` (an upsert). */
export async function writeRulePeriod(
  m: EntityManager,
  userId: string,
  ruleId: string,
  figures: RulePeriodFigures,
): Promise<void> {
  await m.query(
    `INSERT INTO payroll_deduction_rule_periods
            (user_id, rule_id, period_start, yearly_maximum, expected_per_paycheque)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (rule_id, period_start)
     DO UPDATE SET yearly_maximum = EXCLUDED.yearly_maximum,
                   expected_per_paycheque = EXCLUDED.expected_per_paycheque`,
    [
      userId,
      ruleId,
      figures.periodStart,
      roundMoney(figures.yearlyMaximum),
      figures.expectedPerPaycheque === null
        ? null
        : roundMoney(figures.expectedPerPaycheque),
    ],
  );
}

/**
 * Remove every row starting after `after`, the current period's first day:
 * the next period's own figures, and any left on the anniversaries of a
 * reset date the rule no longer has.
 */
export async function deleteRulePeriodsAfter(
  m: EntityManager,
  userId: string,
  ruleId: string,
  after: string,
): Promise<void> {
  await m.query(
    `DELETE FROM payroll_deduction_rule_periods
      WHERE user_id = $1 AND rule_id = $2 AND period_start > $3::date`,
    [userId, ruleId, after],
  );
}
