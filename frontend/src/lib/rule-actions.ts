/**
 * The action list as the editor holds it, and the operations on it. Like
 * `lib/rule-tree.ts`, every operation returns a new list and each action
 * carries a `uid` so a moved card keeps its own picker state.
 */
import {
  MAX_RULE_ACTIONS,
  MAX_RULE_AI_REVIEW_ACTIONS,
  MAX_RULE_SPLIT_PARTS,
  MAX_RULE_STRUCTURAL_ACTIONS,
  MIN_RULE_SPLIT_PARTS,
  isRuleActionType,
} from '@/lib/rule-fields';
import { newUid } from '@/lib/rule-tree';
import type { RuleActionType, RuleDescriptionMode } from '@/types/transaction-rule';

/** Every action the server accepts has a card, so the editor holds all of them. */
export type EditorActionType = RuleActionType;

export const isEditorActionType = (value: unknown): value is EditorActionType => isRuleActionType(value);

/**
 * The two actions that restructure the row (a transfer, a split). At most one
 * per rule, and never together with `set_category`: the structural action
 * decides the category itself (spec section 3.6).
 */
export type StructuralActionType = 'convert_to_transfer' | 'split';

export const isStructuralActionType = (value: unknown): value is StructuralActionType =>
  value === 'convert_to_transfer' || value === 'split';

/** The types a card can be set to, and a blank card can start as: every one. */
export type EditableActionType = EditorActionType;

export const isEditableActionType = (value: unknown): value is EditableActionType => isEditorActionType(value);

/** The order the type picker lists them in: the ones that write the row first, the review last. */
export const EDITOR_ACTION_TYPES: readonly EditableActionType[] = [
  'add_tags',
  'remove_tags',
  'set_category',
  'set_payee',
  'set_payee_from_text',
  'set_description',
  'convert_to_transfer',
  'split',
  'request_ai_review',
];

/** The value of a split part's amount that takes whatever the other parts leave. */
export const SPLIT_REST = 'rest';

/** A split part's amount as stored: `{name}` for a capture. */
export const captureAmount = (name: string): string => `{${name}}`;

/** The capture name of a part amount (`{principal}` gives `principal`), or null for `rest` and anything else. */
export function captureOfAmount(amount: string): string | null {
  const match = /^\{([a-z][a-z0-9]{0,19})\}$/.exec(amount);
  return match ? match[1] : null;
}

/** Where a split part's amount goes: a category line (or an uncategorised one), or a transfer to an account. */
export type SplitPartKind = 'category' | 'transfer';

/**
 * One part of a split as the editor holds it. Empty strings stand for "not
 * chosen" and are left out of the stored part (`actionToApi`). `amount` is
 * `{capture}`, `rest`, or empty while still to be chosen.
 */
export interface EditorSplitPart {
  readonly uid: string;
  readonly amount: string;
  readonly kind: SplitPartKind;
  readonly categoryId: string;
  readonly transferAccountId: string;
  /** Only for a transfer part: the payee of the counterpart leg. */
  readonly payeeId: string;
  readonly description: string;
}

/** `to`: an expense, the money goes to the account. `from`: an income, it came from the account. */
export type TransferDirection = 'to' | 'from';

/** The ways `set_description` joins its text to the current one. */
export const DESCRIPTION_MODES: readonly RuleDescriptionMode[] = ['replace', 'append', 'prepend'];

export const isDescriptionMode = (value: unknown): value is RuleDescriptionMode =>
  typeof value === 'string' && (DESCRIPTION_MODES as readonly string[]).includes(value);

export type EditorAction =
  | { readonly uid: string; readonly type: 'add_tags' | 'remove_tags'; readonly tagIds: readonly string[] }
  | { readonly uid: string; readonly type: 'set_category'; readonly categoryId: string; readonly onlyIfEmpty: boolean }
  | { readonly uid: string; readonly type: 'set_payee'; readonly payeeId: string; readonly onlyIfEmpty: boolean }
  | {
      readonly uid: string;
      readonly type: 'set_payee_from_text';
      readonly template: string;
      readonly createIfMissing: boolean;
      readonly onlyIfEmpty: boolean;
    }
  | {
      readonly uid: string;
      readonly type: 'set_description';
      readonly template: string;
      readonly mode: RuleDescriptionMode;
      readonly onlyIfEmpty: boolean;
    }
  | { readonly uid: string; readonly type: 'request_ai_review'; readonly instruction: string }
  | {
      readonly uid: string;
      readonly type: 'convert_to_transfer';
      readonly direction: TransferDirection;
      /** The other account of the transfer; empty until chosen. */
      readonly accountId: string;
      readonly clearCategory: boolean;
      /** The payee of both legs; empty for none. */
      readonly payeeId: string;
    }
  | {
      readonly uid: string;
      readonly type: 'split';
      /** The parent row's payee; empty for none. */
      readonly payeeId: string;
      readonly parts: readonly EditorSplitPart[];
    };

/** An action the editor can create and edit: every one. */
export type EditableAction = EditorAction;

/** A blank part: the amount still to be chosen, a category line with none picked. */
export function createSplitPart(amount = ''): EditorSplitPart {
  return { uid: newUid(), amount, kind: 'category', categoryId: '', transferAccountId: '', payeeId: '', description: '' };
}

/**
 * A blank action of `type`. `onlyIfEmpty` starts on: a rule fills, it does not
 * overwrite. The two text actions start where the server's defaults are
 * (`withActionDefaults`): a payee is filled and never created, a description is
 * replaced and written even when there is one.
 */
export function createAction(type: EditableActionType = 'add_tags'): EditableAction {
  const uid = newUid();
  switch (type) {
    case 'add_tags':
    case 'remove_tags':
      return { uid, type, tagIds: [] };
    case 'set_category':
      return { uid, type, categoryId: '', onlyIfEmpty: true };
    case 'set_payee':
      return { uid, type, payeeId: '', onlyIfEmpty: true };
    case 'set_payee_from_text':
      return { uid, type, template: '', createIfMissing: false, onlyIfEmpty: true };
    case 'set_description':
      return { uid, type, template: '', mode: 'replace', onlyIfEmpty: false };
    case 'request_ai_review':
      return { uid, type, instruction: '' };
    case 'convert_to_transfer':
      // The server's default: the category goes, because a transfer has none.
      return { uid, type, direction: 'to', accountId: '', clearCategory: true, payeeId: '' };
    case 'split':
      return { uid, type, payeeId: '', parts: [createSplitPart(), createSplitPart()] };
  }
}

/** Changing the type starts over, but the card keeps its place and its `uid`. */
export function changeActionType(action: EditorAction, type: EditableActionType): EditableAction {
  if (action.type === type) return action;
  return { ...createAction(type), uid: action.uid };
}

const countAiReviews = (actions: readonly EditorAction[]): number =>
  actions.filter((a) => a.type === 'request_ai_review').length;

const countStructural = (actions: readonly EditorAction[]): number =>
  actions.filter((a) => isStructuralActionType(a.type)).length;

/** Room for another action of any type. */
export function canAddAction(actions: readonly EditorAction[]): boolean {
  return actions.length < MAX_RULE_ACTIONS;
}

/**
 * The types the card at `index` may be set to. `request_ai_review` is offered
 * only to the card that already is one, or while no other card is; the same
 * goes for the two structural actions together (one per rule). Combining a
 * structural action with `set_category` stays possible to pick, and is
 * reported as `CONFLICTING_ACTIONS` on the card (`draftGaps`).
 */
export function availableActionTypes(actions: readonly EditorAction[], index: number): EditableActionType[] {
  const others = actions.filter((_, i) => i !== index);
  const othersWithReview = countAiReviews(others);
  const othersStructural = countStructural(others);
  return EDITOR_ACTION_TYPES.filter((type) => {
    if (type === 'request_ai_review') return othersWithReview < MAX_RULE_AI_REVIEW_ACTIONS;
    if (isStructuralActionType(type)) return othersStructural < MAX_RULE_STRUCTURAL_ACTIONS;
    return true;
  });
}

// ---- split parts ---------------------------------------------------------

export const canAddSplitPart = (parts: readonly EditorSplitPart[]): boolean => parts.length < MAX_RULE_SPLIT_PARTS;
export const canRemoveSplitPart = (parts: readonly EditorSplitPart[]): boolean => parts.length > MIN_RULE_SPLIT_PARTS;

/** Whether `rest` may still be chosen for the part at `index`: one part takes it, at most. */
export const restIsFree = (parts: readonly EditorSplitPart[], index: number): boolean =>
  !parts.some((part, i) => i !== index && part.amount === SPLIT_REST);

export function addSplitPart(parts: readonly EditorSplitPart[]): readonly EditorSplitPart[] {
  return canAddSplitPart(parts) ? [...parts, createSplitPart()] : parts;
}

export function removeSplitPart(parts: readonly EditorSplitPart[], index: number): readonly EditorSplitPart[] {
  return canRemoveSplitPart(parts) ? parts.filter((_, i) => i !== index) : parts;
}

export function updateSplitPart(
  parts: readonly EditorSplitPart[],
  index: number,
  next: EditorSplitPart,
): readonly EditorSplitPart[] {
  return parts.map((part, i) => (i === index ? next : part));
}

export function updateAction(
  actions: readonly EditorAction[],
  index: number,
  next: EditorAction,
): readonly EditorAction[] {
  return actions.map((a, i) => (i === index ? next : a));
}

export function removeAction(actions: readonly EditorAction[], index: number): readonly EditorAction[] {
  return actions.filter((_, i) => i !== index);
}

export function canMoveAction(actions: readonly EditorAction[], index: number, delta: -1 | 1): boolean {
  const target = index + delta;
  return index >= 0 && index < actions.length && target >= 0 && target < actions.length;
}

export function moveAction(
  actions: readonly EditorAction[],
  index: number,
  delta: -1 | 1,
): readonly EditorAction[] {
  if (!canMoveAction(actions, index, delta)) return actions;
  const next = [...actions];
  [next[index], next[index + delta]] = [next[index + delta], next[index]];
  return next;
}

/** A second `request_ai_review` or structural action is refused by the server, so it is never offered. */
export function canDuplicateAction(actions: readonly EditorAction[], index: number): boolean {
  const action = actions[index];
  if (!action || !canAddAction(actions)) return false;
  return action.type !== 'request_ai_review' && !isStructuralActionType(action.type);
}

export function duplicateAction(actions: readonly EditorAction[], index: number): readonly EditorAction[] {
  if (!canDuplicateAction(actions, index)) return actions;
  const next = [...actions];
  next.splice(index + 1, 0, { ...actions[index], uid: newUid() });
  return next;
}

/** The stable string an error map uses for an action card. */
export const actionKey = (index: number): string => `a:${index}`;
