import { EntityManager } from "typeorm";
import { RULE_CONDITION_FIELDS } from "../transaction-rules/rule-condition.types";

/**
 * Every place a payee id is stored inside a JSON column, where no foreign key
 * exists and `ON DELETE` cannot see it. `PAYEE_REFERENCE_MOVES` covers the
 * foreign keys; this covers the rest, so a merge leaves nothing pointing at the
 * deleted id (INV-PAYEE-003). `payee-references.spec.ts` fails when a rule
 * action type that carries a `payeeId` is missing from
 * `PAYEE_RULE_ACTION_PATHS`, and when a condition field of kind `payeeId` is
 * not read by `repointRuleCondition`.
 *
 * Not moved on purpose: `action_history` snapshots (a record of what happened,
 * undo restores them), `transaction_rule_applications.changes` (the trace) and
 * `ai_review_requests.proposal` (expires in 30 days; confirming it checks
 * ownership and refuses a deleted payee).
 */
export const PAYEE_JSON_REFERENCES = [
  "transaction_rules.condition",
  "transaction_rules.actions",
  "custom_reports.filters",
] as const;

/** Rule action type -> where its payee ids sit (`parts[]` is each split part). */
export const PAYEE_RULE_ACTION_PATHS = {
  set_payee: ["payeeId"],
  convert_to_transfer: ["payeeId"],
  split: ["payeeId", "parts[].payeeId"],
} as const;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Swap `from` for `to` in a string or string list; a list never repeats `to`. */
function swap(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (!Array.isArray(value) || !value.includes(from)) return value;
  return [...new Set(value.map((v) => (v === from ? to : v)))];
}

export function repointRuleCondition(
  node: unknown,
  from: string,
  to: string,
): unknown {
  if (!isRecord(node)) return node;
  for (const key of ["all", "any"]) {
    const children = node[key];
    if (Array.isArray(children)) {
      return {
        ...node,
        [key]: children.map((c) => repointRuleCondition(c, from, to)),
      };
    }
  }
  const spec =
    RULE_CONDITION_FIELDS[node.field as keyof typeof RULE_CONDITION_FIELDS];
  return spec?.kind === "payeeId"
    ? { ...node, value: swap(node.value, from, to) }
    : node;
}

export function repointRuleActions(
  actions: unknown,
  from: string,
  to: string,
): unknown {
  if (!Array.isArray(actions)) return actions;
  return actions.map((action) => {
    if (!isRecord(action)) return action;
    const paths =
      PAYEE_RULE_ACTION_PATHS[
        action.type as keyof typeof PAYEE_RULE_ACTION_PATHS
      ];
    if (!paths) return action;
    const next: Json = { ...action, payeeId: swap(action.payeeId, from, to) };
    if (next.payeeId === undefined) delete next.payeeId;
    if (action.type === "split" && Array.isArray(action.parts)) {
      next.parts = action.parts.map((p) =>
        isRecord(p) && p.payeeId !== undefined
          ? { ...p, payeeId: swap(p.payeeId, from, to) }
          : p,
      );
    }
    return next;
  });
}

/** `custom_reports.filters`: legacy `payeeIds` and `filterGroups[].conditions`. */
export function repointReportFilters(
  filters: unknown,
  from: string,
  to: string,
): unknown {
  if (!isRecord(filters)) return filters;
  const next: Json = { ...filters };
  if (next.payeeIds !== undefined)
    next.payeeIds = swap(next.payeeIds, from, to);
  if (Array.isArray(next.filterGroups)) {
    next.filterGroups = next.filterGroups.map((g) =>
      isRecord(g) && Array.isArray(g.conditions)
        ? {
            ...g,
            conditions: g.conditions.map((c) =>
              isRecord(c) && c.field === "payee"
                ? { ...c, value: swap(c.value, from, to) }
                : c,
            ),
          }
        : g,
    );
  }
  return next;
}

export interface PayeeJsonMoves {
  rules: number;
  reports: number;
}

/**
 * Rewrite the source payee's id to the target's in every rule and custom
 * report of the user, inside the caller's transaction. A rule's revision is
 * bumped so an editor holding the old one cannot write the deleted id back.
 * The text match only picks candidates; the rewrite itself is structural.
 */
export async function repointPayeeJsonReferences(
  m: EntityManager,
  userId: string,
  from: string,
  to: string,
): Promise<PayeeJsonMoves> {
  const like = `%${from}%`;
  const rules: { id: string; condition: unknown; actions: unknown }[] =
    await m.query(
      `SELECT id, condition, actions FROM transaction_rules
       WHERE user_id = $1 AND (condition::text LIKE $2 OR actions::text LIKE $2)`,
      [userId, like],
    );
  for (const r of rules) {
    await m.query(
      `UPDATE transaction_rules SET condition = $1::jsonb, actions = $2::jsonb,
         revision = revision + 1 WHERE id = $3 AND user_id = $4`,
      [
        JSON.stringify(repointRuleCondition(r.condition, from, to)),
        JSON.stringify(repointRuleActions(r.actions, from, to)),
        r.id,
        userId,
      ],
    );
  }
  const reports: { id: string; filters: unknown }[] = await m.query(
    `SELECT id, filters FROM custom_reports
     WHERE user_id = $1 AND filters::text LIKE $2`,
    [userId, like],
  );
  for (const r of reports) {
    await m.query(
      `UPDATE custom_reports SET filters = $1::jsonb WHERE id = $2 AND user_id = $3`,
      [JSON.stringify(repointReportFilters(r.filters, from, to)), r.id, userId],
    );
  }
  return { rules: rules.length, reports: reports.length };
}

/** What a merge of `payeeId` would repoint, for the confirmation text. */
export async function countPayeeJsonReferences(
  m: EntityManager,
  userId: string,
  payeeId: string,
): Promise<PayeeJsonMoves> {
  const like = `%${payeeId}%`;
  const count = async (sql: string): Promise<number> =>
    Number((await m.query(sql, [userId, like]))[0].n);
  return {
    rules: await count(
      `SELECT count(*) AS n FROM transaction_rules
       WHERE user_id = $1 AND (condition::text LIKE $2 OR actions::text LIKE $2)`,
    ),
    reports: await count(
      `SELECT count(*) AS n FROM custom_reports
       WHERE user_id = $1 AND filters::text LIKE $2`,
    ),
  };
}
