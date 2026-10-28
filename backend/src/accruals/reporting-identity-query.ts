import { escapeRegExp } from "../common/escape-regexp.util";
import type { ObjectLiteral, SelectQueryBuilder } from "typeorm";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}
/** Keep filter/order dependencies and INNER JOINs, not display-only LEFT JOINs.
 * Hydration is a separate page-bounded read using the selected identities. */
export function reportingIdentityQuery<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  ordered: boolean,
  keep: readonly string[] = [],
): SelectQueryBuilder<T> {
  const qb = query.clone();
  const joins = qb.expressionMap.joinAttributes;
  const expressions = [
    ...strings(qb.expressionMap.wheres),
    ...strings(qb.expressionMap.havings),
    ...(ordered ? Object.keys(qb.expressionMap.orderBys) : []),
  ].join(" ");
  const referenced = (name: string, sql: string) =>
    new RegExp(
      String.raw`(?:^|[^A-Za-z_0-9])"?${escapeRegExp(name)}"?\s*\.`,
    ).test(sql);
  const needed = new Set(keep);
  for (const join of joins)
    if (join.direction === "INNER" || referenced(join.alias.name, expressions))
      needed.add(join.alias.name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const join of joins)
      if (needed.has(join.alias.name)) {
        const dependencies = [
          join.parentAlias,
          ...joins
            .filter((other) =>
              referenced(other.alias.name, join.condition ?? ""),
            )
            .map((other) => other.alias.name),
        ];
        for (const name of dependencies)
          if (name && !needed.has(name)) {
            needed.add(name);
            changed = true;
          }
      }
  }
  qb.expressionMap.joinAttributes = joins.filter((join) =>
    needed.has(join.alias.name),
  );
  return qb;
}
export function reportingIdentityPage<T extends ObjectLiteral>(
  query: SelectQueryBuilder<T>,
  skip: number,
  limit: number,
) {
  const qb = reportingIdentityQuery(query, true)
    .select(`${query.alias}.id`, "id")
    .distinct(true);
  for (const [index, key] of Object.keys(
    query.expressionMap.orderBys,
  ).entries())
    qb.addSelect(key, `__order${index}`);
  return qb
    .skip(undefined)
    .take(undefined)
    .offset(skip)
    .limit(limit)
    .getRawMany<{ id: string }>();
}
