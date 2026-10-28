import { escapeRegExp } from "../common/escape-regexp.util";
import type { EntityManager, ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { prepareReportingRelations, reportingSql } from "./reporting-relations";
import { reportingIdentityQuery } from "./reporting-identity-query";

type Row = Record<string, any>;
function pageColumns(sql: string, alias: string): string {
  const references = new RegExp(
    String.raw`"?${escapeRegExp(alias)}"?\s*\.\s*"?([A-Za-z_][A-Za-z_0-9]*)"?`,
    "g",
  );
  return [...new Set([...sql.matchAll(references)].map((match) => match[1]))]
    .map((column) => `"${column}"`)
    .join(",");
}
const day = (value: unknown) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
/** Project immutable copies of source entities, never write fabricated ledger rows. */
export function projectRecognitionRow(
  source: Row,
  fact: Row,
  splits: readonly Row[],
  preserveReportIds: boolean,
): Row {
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(source)),
    source,
  );
  copy.id = preserveReportIds ? fact.id : fact.sourceId;
  copy.amount = fact.amount;
  copy.transactionDate = day(fact.effectiveDate);
  copy.reportingProvenance = {
    readOnly: true,
    reportId: fact.id,
    sourceTransactionId: fact.sourceId,
    cashDate: day(fact.cashDate),
    effectiveDate: day(fact.effectiveDate),
    sourceAmount: String(fact.sourceAmount),
    nativeAmount: String(fact.amount),
    ...(preserveReportIds
      ? { isRecognition: fact.isRecognition === true }
      : {}),
  };
  if (Array.isArray(source.splits)) {
    const originals = new Map<string, Row>(
      source.splits.map((split: Row) => [split.id, split]),
    );
    copy.splits = splits
      .filter((split) => originals.has(split.sourceId))
      .map((split) => {
        const line = Object.assign(
          Object.create(Object.getPrototypeOf(originals.get(split.sourceId))),
          originals.get(split.sourceId),
        );
        line.id = preserveReportIds ? split.id : split.sourceId;
        line.transactionId = preserveReportIds ? fact.id : fact.sourceId;
        line.amount = split.amount;
        line.reportingProvenance = {
          readOnly: true,
          reportId: split.id,
          sourceTransactionId: fact.sourceId,
          sourceSplitId: split.sourceId,
          scheduleId: split.scheduleId ?? null,
          cashDate: day(split.cashDate),
          effectiveDate: day(fact.effectiveDate),
          sourceAmount: String(split.sourceAmount),
          nativeAmount: String(split.amount),
        };
        return line;
      });
  }
  return copy;
}

/** Select scoped facts first; only the visible source entities are hydrated.
 * No display join expands reporting views into further reporting views. */
export async function readReportingEntities<T extends ObjectLiteral>(
  manager: EntityManager,
  query: SelectQueryBuilder<T>,
  preserveReportIds = false,
): Promise<T[]> {
  const alias = query.alias;
  const factsQuery = reportingIdentityQuery(query, true)
    .select(`${alias}.id`, "id")
    .addSelect(`${alias}.source_transaction_id`, "sourceId")
    .addSelect(`${alias}.amount`, "amount")
    .addSelect(
      `TO_CHAR(${alias}.transaction_date,'YYYY-MM-DD')`,
      "effectiveDate",
    )
    .addSelect(`TO_CHAR(${alias}.source_cash_date,'YYYY-MM-DD')`, "cashDate")
    .addSelect(`${alias}.source_amount`, "sourceAmount")
    .addSelect(`${alias}.is_recognition`, "isRecognition")
    .distinct(true);
  for (const [index, key] of Object.keys(
    query.expressionMap.orderBys,
  ).entries())
    factsQuery.addSelect(key, `__order${index}`);
  const facts = await factsQuery
    .skip(undefined)
    .take(undefined)
    .offset(query.expressionMap.skip ?? query.expressionMap.offset)
    .limit(query.expressionMap.take ?? query.expressionMap.limit)
    .getRawMany<Row>();
  if (!facts.length) return [];
  const native = prepareReportingRelations(query.clone(), "cash")
    .where(`${alias}.id IN (:...__recognitionSourceIds)`, {
      __recognitionSourceIds: [...new Set(facts.map((fact) => fact.sourceId))],
    })
    .orderBy()
    .skip(undefined)
    .take(undefined)
    .offset(undefined)
    .limit(undefined);
  const sources = await native.getMany();
  const byId = new Map<string, T>(sources.map((source) => [source.id, source]));
  const splitJoin = query.expressionMap.joinAttributes.find(
    (join) =>
      join.parentAlias === alias &&
      join.alias.hasMetadata &&
      join.alias.metadata.tableName ===
        "accrual_reporting_transaction_splits" &&
      query.expressionMap.selects.some(
        (select) => select.selection === join.alias.name,
      ),
  );
  let splitFacts: Row[] = [];
  const visibleSplitIds = sources.flatMap((source) =>
    Array.isArray(source.splits)
      ? source.splits.map((split: Row) => split.id)
      : [],
  );
  if (splitJoin && visibleSplitIds.length) {
    const name = splitJoin.alias.name;
    const splitQuery = reportingIdentityQuery(query, false, [name])
      .select(`${alias}.id`, "parentId")
      .addSelect(`${name}.id`, "id")
      .addSelect(`${name}.source_split_id`, "sourceId")
      .addSelect(`${name}.amount`, "amount")
      .addSelect(`${name}.source_amount`, "sourceAmount")
      .addSelect(`${name}.schedule_id`, "scheduleId")
      .addSelect(`TO_CHAR(${name}.source_cash_date,'YYYY-MM-DD')`, "cashDate")
      .andWhere(`${name}.source_split_id IN (:...__recognitionSplitIds)`, {
        __recognitionSplitIds: visibleSplitIds,
      })
      .andWhere(
        `${alias}.source_transaction_id IN (:...__recognitionSourceIds)`,
        {
          __recognitionSourceIds: [...byId.keys()],
        },
      )
      .andWhere(`${alias}.id IN (:...__recognitionPageIds)`, {
        __recognitionPageIds: facts.map((fact) => fact.id),
      })
      .orderBy()
      .skip(undefined)
      .take(undefined)
      .offset(undefined)
      .limit(undefined)
      .distinct(true);
    const [sql, parameters] = splitQuery.getQueryAndParameters();
    const sourceParameter = `$${parameters.length + 1}`;
    const splitParameter = `$${parameters.length + 2}`;
    // Materialize the visible sources/splits once before joining. These explicit
    // page relations preserve all original filters without expanding two full
    // recognition views into each other during planning and execution.
    splitFacts = await manager.query(
      `WITH recognition_page AS MATERIALIZED (
        SELECT ${pageColumns(sql, alias)} FROM public.accrual_reporting_transactions
        WHERE source_transaction_id=ANY(${sourceParameter}::uuid[])
      ), recognition_page_splits AS MATERIALIZED (
        SELECT ${pageColumns(sql, name)} FROM public.accrual_reporting_transaction_splits
        WHERE source_split_id=ANY(${splitParameter}::uuid[])
      ) ${reportingSql(sql, "accrual", undefined, {
        transactions: "recognition_page",
        transaction_splits: "recognition_page_splits",
      })}`,
      [...parameters, [...byId.keys()], visibleSplitIds],
    );
  }
  return facts
    .filter((fact) => byId.has(fact.sourceId))
    .map(
      (fact) =>
        projectRecognitionRow(
          byId.get(fact.sourceId)!,
          fact,
          splitFacts.filter(
            (split) => split.parentId === fact.id && split.sourceId,
          ),
          preserveReportIds,
        ) as T,
    );
}
