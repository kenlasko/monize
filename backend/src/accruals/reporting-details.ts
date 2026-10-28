import { Category } from "../categories/entities/category.entity";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { EntityManager } from "typeorm";
import {
  resolveReportingBasis,
  resolveReportingExecution,
  type ReportingBasis,
} from "./reporting-basis";
import {
  reportingCurrency,
  reportingRates,
  reportingConversion,
} from "./reporting-money";
import { FxAggregate } from "../common/fx-aggregate";
import { investmentExclusionSql } from "../common/investment-filter.util";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";

export interface ReportingDetailsInput {
  startDate: string;
  endDate: string;
  basis?: ReportingBasis;
  sourceTransactionIds?: string[];
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  tagIds?: string[];
  categoryType?: "income" | "expense";
  uncategorized?: boolean;
  kind?: "ordinary" | "transfer" | "investment" | "all";
  limit?: number;
}
/** Read-only component export, bounded before conversion. Identity/classification
 * comes from the source; period amount/date comes from persisted allocation facts.
 */
export async function readReportingDetails(
  m: EntityManager,
  userId: string,
  input: ReportingDetailsInput,
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
  const basis = await resolveReportingBasis(m, userId, input.basis),
    currency = await reportingCurrency(m, userId);
  const categoryIds = input.categoryIds
    ? await getAllCategoryIdsWithChildren(
        m.getRepository(Category),
        userId,
        input.categoryIds,
      )
    : undefined;
  const execution = await resolveReportingExecution(m, userId, basis);
  const components =
    execution === "accrual"
      ? "public.accrual_reporting_components"
      : `(SELECT t.id AS source_id,sp.id AS split_id,t.transaction_date AS effective_date,
        COALESCE(sp.amount,t.amount) AS amount,t.currency_code,t.original_currency_code,t.exchange_rate,
        t.transaction_date AS cash_date,COALESCE(sp.amount,t.amount) AS source_amount,NULL::uuid AS schedule_id
        FROM public.transactions t LEFT JOIN public.transaction_splits sp ON sp.transaction_id=t.id AND t.is_split
        WHERE t.user_id=$1)`;
  // Includes VOID: investment linkage classifies identity, not its financial effect.
  const ordinary = investmentExclusionSql({
    accountAlias: "account",
    transactionAlias: "t",
    splitAlias: "sp",
  })
    .split("FROM investment_transactions") // includes VOID: linkage identity, not financial effects.
    .join("FROM public.investment_transactions");
  const rows: any[] = await m.query(
    `WITH classified AS (
    SELECT c.source_id AS "sourceTransactionId",c.split_id AS "sourceSplitId",c.schedule_id AS "scheduleId",
      TO_CHAR(c.cash_date,'YYYY-MM-DD') AS "cashDate",TO_CHAR(c.effective_date,'YYYY-MM-DD') AS "effectiveDate",
      c.source_amount::text AS "sourceAmount",c.amount::text AS "nativeAmount",c.currency_code AS "currencyCode",
      c.original_currency_code AS "originalCurrencyCode",c.exchange_rate::text AS "exchangeRate",
      t.account_id AS "accountId",COALESCE(sp.category_id,t.category_id) AS "categoryId",t.payee_id AS "payeeId",
      t.parent_transaction_id AS "parentTransactionId",COALESCE(sp.linked_transaction_id,t.linked_transaction_id) AS "linkedTransactionId",
      sp.transfer_account_id AS "transferAccountId",
      CASE WHEN NOT (${ordinary}) THEN 'investment'
        WHEN t.is_transfer OR sp.transfer_account_id IS NOT NULL THEN 'transfer' ELSE 'ordinary' END AS kind,
      EXISTS(SELECT 1 FROM accounts ax WHERE ax.user_id=t.user_id AND ax.asset_category_id=COALESCE(sp.category_id,t.category_id)) AS "assetCategory"
    FROM ${components} c JOIN public.transactions t ON t.id=c.source_id
    LEFT JOIN public.transaction_splits sp ON sp.id=c.split_id AND sp.transaction_id=t.id
    JOIN accounts account ON account.id=t.account_id
    WHERE t.user_id=$1 AND ${LEDGER_MOVEMENT_PREDICATE}
      AND c.effective_date BETWEEN $2::date AND $3::date
      AND ($4::uuid[] IS NULL OR t.id=ANY($4::uuid[]))
      AND ($5::uuid[] IS NULL OR t.account_id=ANY($5::uuid[]))
      AND ($6::uuid[] IS NULL OR COALESCE(sp.category_id,t.category_id)=ANY($6::uuid[]))
      AND ($7::uuid[] IS NULL OR t.payee_id=ANY($7::uuid[]))
      AND ($11::text IS NULL OR COALESCE(
        (SELECT ct.is_income FROM categories ct WHERE ct.user_id=t.user_id AND ct.id=COALESCE(sp.category_id,t.category_id)), c.amount>0
      )=($11='income'))
      AND (NOT $12::boolean OR COALESCE(sp.category_id,t.category_id) IS NULL)
      AND ($8::uuid[] IS NULL OR EXISTS(SELECT 1 FROM public.transaction_tags tags WHERE tags.transaction_id=t.id AND tags.tag_id=ANY($8::uuid[]))
        OR EXISTS(SELECT 1 FROM public.transaction_split_tags tags WHERE tags.transaction_split_id=sp.id AND tags.tag_id=ANY($8::uuid[])))
    ) SELECT * FROM classified WHERE ($9='all' OR kind=$9) AND ($9<>'ordinary' OR NOT "assetCategory")
      ORDER BY "effectiveDate","sourceTransactionId","sourceSplitId" NULLS FIRST LIMIT $10`,
    [
      userId,
      input.startDate,
      input.endDate,
      input.sourceTransactionIds ?? null,
      input.accountIds ?? null,
      categoryIds ?? null,
      input.payeeIds ?? null,
      input.tagIds ?? null,
      input.kind ?? "ordinary",
      limit + 1,
      input.categoryType ?? null,
      input.uncategorized ?? false,
    ],
  );
  if (rows.length > limit)
    throw new ServiceUnavailableException({
      code: "REPORTING_ROW_LIMIT",
      limit,
      repair: "narrow_report_filters",
    });
  const sources = rows.map((row) => ({
    ...row,
    transactionDate: row.effectiveDate,
  }));
  const rates = await reportingRates(m, sources, currency),
    total = new FxAggregate(),
    native = new Map<string, FxAggregate>();
  const gaps: unknown[] = [];
  const details = rows.map((row, index) => {
    let conversion: ReturnType<typeof reportingConversion> | null = null;
    try {
      conversion = reportingConversion(
        row.nativeAmount,
        sources[index],
        currency,
        rates,
      );
    } catch (error) {
      const value =
        error instanceof ServiceUnavailableException
          ? error.getResponse()
          : null;
      if (
        !value ||
        typeof value !== "object" ||
        !("code" in value) ||
        value.code !== "REPORTING_FX_INCOMPLETE"
      )
        throw error;
      if ("missingRatePairs" in value && Array.isArray(value.missingRatePairs))
        gaps.push(...value.missingRatePairs);
    }
    total.add(conversion?.amount ?? null, row.currencyCode, currency);
    const nativeTotal = native.get(row.currencyCode) ?? new FxAggregate();
    nativeTotal.addConverted(Number(row.nativeAmount));
    native.set(row.currencyCode, nativeTotal);
    return {
      ...row,
      readOnly: true,
      convertedAmount: conversion?.amount ?? null,
      conversion: conversion
        ? {
            rate: conversion.rate,
            source: conversion.source,
            observedOn: conversion.observedOn,
          }
        : null,
    };
  });
  return {
    basis,
    currency,
    readOnly: true,
    fxComplete: total.isComplete,
    total: total.total,
    knownSubtotal: total.knownSubtotal,
    byCurrency: Object.fromEntries(
      [...native].map(([code, value]) => [code, value.total]),
    ),
    missingRatePairs: gaps,
    ...(gaps.length
      ? { repair: "currency_rate_history", fetchAttempted: false }
      : {}),
    rows: details,
  };
}
