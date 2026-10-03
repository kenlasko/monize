import { EntityManager } from "typeorm";
import { TransactionRuleResponseDto } from "./dto/transaction-rule-response.dto";
import {
  RuleErrorEntry,
  findMissingReferences,
  referenceErrors,
} from "./rule-references";
import {
  RuleReferencedIds,
  collectReferencedIds,
  validateRuleDefinition,
} from "./rule-validation";
import { TransactionRule } from "./transaction-rule.entity";

/**
 * Mark rules whose stored JSON no longer validates (a support-backup restore
 * leaves `{}` and `[]`) or names an id that is gone. Never throws for a
 * stored value: the list must still open so the user can repair or delete.
 */
export async function toRuleResponses(
  m: EntityManager,
  userId: string,
  rules: readonly TransactionRule[],
): Promise<TransactionRuleResponseDto[]> {
  const shape = new Map<string, RuleErrorEntry[]>();
  const wanted: RuleReferencedIds = {
    accountIds: [],
    payeeIds: [],
    categoryIds: [],
    tagIds: [],
  };
  const validIds = new Set<string>();
  for (const rule of rules) {
    const errors = validateRuleDefinition(rule);
    shape.set(rule.id, errors);
    if (errors.length > 0) continue;
    validIds.add(rule.id);
    const ids = collectReferencedIds(rule);
    wanted.accountIds.push(...ids.accountIds);
    wanted.payeeIds.push(...ids.payeeIds);
    wanted.categoryIds.push(...ids.categoryIds);
    wanted.tagIds.push(...ids.tagIds);
  }
  const missing = await findMissingReferences(m, userId, {
    accountIds: [...new Set(wanted.accountIds)],
    payeeIds: [...new Set(wanted.payeeIds)],
    categoryIds: [...new Set(wanted.categoryIds)],
    tagIds: [...new Set(wanted.tagIds)],
  });
  return rules.map((rule) => {
    const reasons: RuleErrorEntry[] = [...(shape.get(rule.id) ?? [])];
    if (validIds.has(rule.id)) reasons.push(...referenceErrors(rule, missing));
    return toRuleResponse(rule, reasons);
  });
}

export function toRuleResponse(
  rule: TransactionRule,
  invalidReasons: readonly RuleErrorEntry[],
): TransactionRuleResponseDto {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    position: rule.position,
    triggers: rule.triggers,
    condition: rule.condition,
    actions: rule.actions,
    stopProcessing: rule.stopProcessing,
    activeFrom: rule.activeFrom ?? null,
    activeTo: rule.activeTo ?? null,
    revision: rule.revision,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    invalid: invalidReasons.length > 0,
    invalidReasons: [...invalidReasons],
  };
}
