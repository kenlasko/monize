import type { AiActionType, RuleAiActionType } from '@/types/ai';

/** Which confirmation card draws an action type. */
export type AiActionCardKind = 'single' | 'bulk' | 'rule';

/**
 * A total map over every action type: adding a type to `AI_ACTION_TYPES`
 * without saying which card draws it is a type error, so an approved action can
 * never reach the chat with no card (or the wrong one).
 */
export const AI_ACTION_CARD_KIND: Readonly<Record<AiActionType, AiActionCardKind>> = {
  create_transaction: 'single',
  categorize_transaction: 'single',
  create_payee: 'single',
  update_payee: 'single',
  delete_payee: 'single',
  create_security: 'single',
  update_security: 'single',
  delete_security: 'single',
  create_investment_transaction: 'single',
  update_investment_transaction: 'single',
  delete_investment_transaction: 'single',
  update_transaction: 'single',
  delete_transaction: 'single',
  create_transfer: 'single',
  update_transfer: 'single',
  create_transactions: 'bulk',
  create_investment_transactions: 'bulk',
  batch_actions: 'bulk',
  create_transaction_rule: 'rule',
  update_transaction_rule: 'rule',
  delete_transaction_rule: 'rule',
  run_transaction_rule: 'rule',
  create_tag: 'single',
  update_tag: 'single',
  delete_tag: 'single',
};

/**
 * The card for a type. A type this client does not know (a newer server) gets
 * the single card, which titles it generically instead of as another action.
 */
export function aiActionCardKind(type: string): AiActionCardKind {
  return Object.prototype.hasOwnProperty.call(AI_ACTION_CARD_KIND, type)
    ? AI_ACTION_CARD_KIND[type as AiActionType]
    : 'single';
}

export function isRuleAiActionType(type: string): type is RuleAiActionType {
  return aiActionCardKind(type) === 'rule';
}
