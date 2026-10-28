import type { EntityManager } from "typeorm";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { accrualErrors } from "./accrual-errors";
export interface SystemMovementInput {
  startDate: string;
  endDate: string;
  limit?: number;
}
/** Read-only, exact native-currency timing movements. Never ledger transactions. */
export async function readAccrualSystemMovements(
  m: EntityManager,
  userId: string,
  id: string,
  input: SystemMovementInput,
) {
  if (
    !isCalendarDate(input.startDate) ||
    !isCalendarDate(input.endDate) ||
    input.startDate > input.endDate
  )
    throw new BadRequestException({ code: "REPORTING_PERIOD_INVALID" });
  const limit = input.limit ?? 2000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
    throw new BadRequestException({ code: "REPORTING_ROW_LIMIT", limit: 5000 });
  const [account] = await m.query(
    `SELECT id,family,currency_code AS "currencyCode" FROM accrual_system_accounts WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  if (!account) throw accrualErrors.missing();
  const [result] = await m.query(
    `
 WITH components AS (
  SELECT s.id AS schedule_id,s.source_split_id,t.id AS source_id,t.account_id,t.transaction_date,
   CASE WHEN s.family='expense' THEN 1 ELSE -1 END AS factor,COALESCE(sp.amount,t.amount) AS source_amount
  FROM accrual_schedules s
  JOIN transactions t ON t.id=s.source_transaction_id AND t.user_id=s.user_id
  LEFT JOIN transaction_splits sp ON sp.id=s.source_split_id AND sp.transaction_id=t.id
  JOIN accrual_system_accounts a ON a.user_id=s.user_id AND a.family=s.family AND a.currency_code=s.currency_code
  WHERE s.user_id=$1 AND a.id=$2 AND t.status IS DISTINCT FROM 'VOID' AND NOT t.is_transfer
 ), movements AS (
  SELECT c.*,c.transaction_date AS day,'payment'::text AS kind,-c.factor*c.source_amount AS amount FROM components c
  UNION ALL
  SELECT c.*,a.recognition_date AS day,'recognition'::text AS kind,c.factor*a.amount AS amount
  FROM components c JOIN accrual_allocations a ON a.schedule_id=c.schedule_id AND a.user_id=$1
 ), selected AS (SELECT * FROM movements WHERE day BETWEEN $3::date AND $4::date),
 bounded AS (SELECT * FROM selected ORDER BY day,source_id,source_split_id NULLS FIRST,schedule_id,kind LIMIT $5)
 SELECT COALESCE((SELECT SUM(amount) FROM movements WHERE day<$3::date),0)::numeric(20,4)::text AS opening,
 COALESCE((SELECT SUM(amount) FROM movements WHERE day<=$4::date),0)::numeric(20,4)::text AS closing,
 (SELECT count(*)::int FROM selected) AS count,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('date',to_char(day,'YYYY-MM-DD'),'kind',kind,'amount',amount::numeric(20,4)::text,
 'sourceTransactionId',source_id,'sourceSplitId',source_split_id,'scheduleId',schedule_id,'accountId',account_id,
 'cashDate',to_char(transaction_date,'YYYY-MM-DD')) ORDER BY day,source_id,source_split_id NULLS FIRST,schedule_id,kind) FROM bounded),'[]'::jsonb) AS rows
 `,
    [userId, id, input.startDate, input.endDate, limit + 1],
  );
  if (result.count > limit)
    throw new ServiceUnavailableException({
      code: "REPORTING_ROW_LIMIT",
      repair: "narrow_report_filters",
    });
  return {
    readOnly: true as const,
    basis: "accrual" as const,
    account,
    startDate: input.startDate,
    endDate: input.endDate,
    ...result,
  };
}
