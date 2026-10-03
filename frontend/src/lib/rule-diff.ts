import type { RuleTrigger } from '@/types/transaction-rule';

/** The parts of a rule a card compares, in the order the editor shows them. */
export type RulePart = 'name' | 'enabled' | 'triggers' | 'condition' | 'actions' | 'stopProcessing' | 'activeWindow';

/** What a comparison needs of a rule; both the stored and the proposed one have it. */
export interface RuleDiffInput {
  name: string;
  enabled: boolean;
  triggers: readonly RuleTrigger[];
  condition: unknown;
  actions: readonly unknown[];
  stopProcessing: boolean;
  activeFrom?: string | null;
  activeTo?: string | null;
}

/**
 * The parts whose value differs, by value and not by presence. Triggers are a
 * set (their order says nothing); conditions and actions are ordered, so a
 * reordering is a change. Nothing here reads an id's name: the comparison is on
 * what the rule stores.
 */
export function changedRuleParts(before: RuleDiffInput, after: RuleDiffInput): RulePart[] {
  const changed: RulePart[] = [];
  if (before.name !== after.name) changed.push('name');
  if (before.enabled !== after.enabled) changed.push('enabled');
  if (JSON.stringify([...before.triggers].sort()) !== JSON.stringify([...after.triggers].sort())) {
    changed.push('triggers');
  }
  if (JSON.stringify(before.condition) !== JSON.stringify(after.condition)) changed.push('condition');
  if (JSON.stringify(before.actions) !== JSON.stringify(after.actions)) changed.push('actions');
  if (before.stopProcessing !== after.stopProcessing) changed.push('stopProcessing');
  if ((before.activeFrom ?? null) !== (after.activeFrom ?? null) || (before.activeTo ?? null) !== (after.activeTo ?? null)) {
    changed.push('activeWindow');
  }
  return changed;
}
