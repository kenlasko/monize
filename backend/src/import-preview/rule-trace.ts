import type {
  RuleTraceChanges,
  RuleTraceEntry,
} from "../transaction-rules/rule-effects";
import type {
  ImportPreviewLabels,
  ImportPreviewRuleChanges,
  ImportPreviewRuleView,
} from "./import-preview.types";

/** A trace's changes as plain data, in the `{field: {before, after}}` shape. */
export function ruleChangesView(
  changes: RuleTraceChanges,
): ImportPreviewRuleChanges {
  return {
    ...(changes.categoryId ? { categoryId: { ...changes.categoryId } } : {}),
    ...(changes.payeeId ? { payeeId: { ...changes.payeeId } } : {}),
    ...(changes.payeeName ? { payeeName: { ...changes.payeeName } } : {}),
    ...(changes.payeeCreated === true ? { payeeCreated: true } : {}),
    ...(changes.description ? { description: { ...changes.description } } : {}),
    ...(changes.tagIds
      ? {
          tagIds: {
            before: [...changes.tagIds.before],
            after: [...changes.tagIds.after],
          },
        }
      : {}),
  };
}

/**
 * The rules of a row's trace that matched, in the order they ran, each by name
 * (`ruleNames` by rule id; a rule it has no name for is null, never its id)
 * with what it changed, the actions it applied and skipped (with the reason)
 * and whether it ended the pass. A rule that did not match, or was not run,
 * is not part of the answer. Pure.
 */
export function matchedRuleViews(
  trace: readonly RuleTraceEntry[],
  ruleNames: Readonly<Record<string, string>> | null,
): ImportPreviewRuleView[] {
  return trace
    .filter((entry) => entry.matched)
    .map((entry) => ({
      ruleId: entry.ruleId,
      ruleName: ruleNames?.[entry.ruleId] ?? null,
      changes: ruleChangesView(entry.changes),
      applied: entry.applied.map((action) => ({ type: action.type })),
      skipped: entry.skipped.map((action) => ({
        type: action.type,
        reason: action.reason,
      })),
      stopped: entry.stopped,
    }));
}

/** An empty set of labels, to be filled row by row. */
export const emptyImportPreviewLabels = (): ImportPreviewLabels => ({
  categories: {},
  payees: {},
  tags: {},
});

/**
 * Adds the names one row's labels hold to the preview's, which every row
 * shares. Mutates `into`, which the caller owns.
 */
export function mergeImportPreviewLabels(
  into: ImportPreviewLabels,
  from: Pick<ImportPreviewLabels, "categories" | "payees" | "tags">,
): void {
  Object.assign(into.categories, from.categories);
  Object.assign(into.payees, from.payees);
  Object.assign(into.tags, from.tags);
}
