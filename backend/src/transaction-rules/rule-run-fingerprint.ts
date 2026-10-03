import { createHash } from "node:crypto";
import { RuleTraceChanges } from "./rule-effects";

/**
 * The fields a rule can change, in one fixed key order, with the tag sets
 * sorted: the same plan always serialises to the same bytes. A payee the run
 * will create is part of the digest (`payeeCreated`), so a payee that appeared
 * between the preview and the commit refuses the commit as a changed preview.
 */
export function canonicalChanges(changes: RuleTraceChanges): {
  categoryId: RuleTraceChanges["categoryId"] | null;
  payeeId: RuleTraceChanges["payeeId"] | null;
  tagIds: RuleTraceChanges["tagIds"] | null;
  payeeName?: RuleTraceChanges["payeeName"];
  payeeCreated?: true;
  description?: RuleTraceChanges["description"];
  structure?: RuleTraceChanges["structure"];
} {
  const sortedSet = (
    change: RuleTraceChanges["tagIds"],
  ): RuleTraceChanges["tagIds"] | null =>
    change
      ? {
          before: [...change.before].sort(),
          after: [...change.after].sort(),
        }
      : null;
  return {
    categoryId: changes.categoryId ?? null,
    payeeId: changes.payeeId ?? null,
    tagIds: sortedSet(changes.tagIds),
    // The text actions' fields join the digest only when a rule changed them,
    // after the original three keys, so a plan without them hashes as before.
    ...(changes.payeeName ? { payeeName: changes.payeeName } : {}),
    ...(changes.payeeCreated ? { payeeCreated: true as const } : {}),
    ...(changes.description ? { description: changes.description } : {}),
    // The planned parts and amounts are part of what a run writes (INV-RULE-003).
    ...(changes.structure ? { structure: changes.structure } : {}),
  };
}

/**
 * The fingerprint of a plan: SHA-256 over the rule revision and the
 * (transactionId, changes) pairs sorted by transaction id. It is a function of
 * what would be written and of the rule that would write it, never of an id
 * generated per call, so a preview and a commit over unchanged data agree, and
 * an edit to the rule, to a row or to the strict lock disagrees.
 */
export function planFingerprint(
  ruleRevision: number,
  rows: readonly { transactionId: string; changes: RuleTraceChanges }[],
): string {
  const pairs = [...rows]
    .sort((a, b) =>
      a.transactionId < b.transactionId
        ? -1
        : a.transactionId > b.transactionId
          ? 1
          : 0,
    )
    .map((row) => [row.transactionId, canonicalChanges(row.changes)]);
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, revision: ruleRevision, rows: pairs }))
    .digest("hex");
}
