/**
 * The closed list of rule actions (design section 6.1). INV-RULE-001 (restated
 * in docs/specs/transaction-rules-structural-actions.md section 2): no action
 * changes the matched row's amount, account, date or status, and none deletes
 * or relinks a row that exists. The only balance a rule moves is the one a
 * structural action (`convert_to_transfer`, `split`) creates, by exactly the
 * counterpart leg's amount. Anything not in this union is not representable,
 * and the validator refuses it.
 *
 * `request_ai_review` is the one action that is not a ledger write: it asks
 * for a person-approved AI review of the row and never changes the row itself.
 * `isLedgerAction` tells the two groups apart for the applier;
 * `isStructuralAction` picks out the two that restructure the row.
 */

export const RULE_ACTION_TYPES = [
  "add_tags",
  "remove_tags",
  "set_category",
  "set_payee",
  "request_ai_review",
  "set_payee_from_text",
  "set_description",
  "convert_to_transfer",
  "split",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

export interface AddTagsAction {
  readonly type: "add_tags";
  readonly tagIds: readonly string[];
}

export interface RemoveTagsAction {
  readonly type: "remove_tags";
  readonly tagIds: readonly string[];
}

export interface SetCategoryAction {
  readonly type: "set_category";
  readonly categoryId: string;
  readonly onlyIfEmpty: boolean;
}

export interface SetPayeeAction {
  readonly type: "set_payee";
  readonly payeeId: string;
  readonly onlyIfEmpty: boolean;
}

/**
 * Sets the payee from text (design 10.2): the template is rendered from the
 * rule's captures, the name resolved through the existing payee resolution
 * (exact name, alias, unique normalized match), and with `createIfMissing` a
 * payee that does not exist is created through the existing find-or-create.
 */
export interface SetPayeeFromTextAction {
  readonly type: "set_payee_from_text";
  readonly template: string;
  readonly createIfMissing: boolean;
  readonly onlyIfEmpty: boolean;
}

export const RULE_DESCRIPTION_MODES = ["replace", "append", "prepend"] as const;
export type RuleDescriptionMode = (typeof RULE_DESCRIPTION_MODES)[number];

/** Writes the description from a template; `{description}` is the current text. */
export interface SetDescriptionAction {
  readonly type: "set_description";
  readonly template: string;
  readonly mode: RuleDescriptionMode;
  readonly onlyIfEmpty: boolean;
}

export interface RequestAiReviewAction {
  readonly type: "request_ai_review";
  /** What the user wants checked, e.g. "split this purchase by the receipt". */
  readonly instruction: string;
}

/**
 * Makes the matched income or expense one leg of a transfer; the other leg is
 * created in the named account. Exactly one of `toAccountId` (an expense: the
 * money goes there) and `fromAccountId` (an income: it came from there).
 */
export interface ConvertToTransferAction {
  readonly type: "convert_to_transfer";
  readonly toAccountId?: string;
  readonly fromAccountId?: string;
  /** Clears the row's category (a transfer has none). Defaults to true. */
  readonly clearCategory: boolean;
  /** The payee of both legs. */
  readonly payeeId?: string;
}

/** The amount of a split part that takes whatever the other parts leave. */
export const SPLIT_REST_AMOUNT = "rest";

/** One part of a `split`: its amount and where it goes. */
export interface SplitActionPart {
  /** `"{capture}"` naming a capture of the rule's `matches` patterns, or `"rest"`. */
  readonly amount: string;
  readonly categoryId?: string;
  readonly transferAccountId?: string;
  /** Only with `transferAccountId`: the payee of the counterpart leg. */
  readonly payeeId?: string;
  /** The split line's memo (1..200 characters). */
  readonly description?: string;
}

/** Turns the matched row into a split whose part amounts come from captures. */
export interface SplitAction {
  readonly type: "split";
  /** The parent row's payee. */
  readonly payeeId?: string;
  readonly parts: readonly SplitActionPart[];
}

/** The actions that restructure the row: a transfer leg or a split. */
export type StructuralRuleAction = ConvertToTransferAction | SplitAction;

/**
 * The actions that change the row's tags, category, payee or description, or
 * restructure it (`StructuralRuleAction`). None of them touches the row's
 * amount, account, date or status.
 */
export type LedgerRuleAction =
  | AddTagsAction
  | RemoveTagsAction
  | SetCategoryAction
  | SetPayeeAction
  | SetPayeeFromTextAction
  | SetDescriptionAction
  | StructuralRuleAction;

export type RuleAction = LedgerRuleAction | RequestAiReviewAction;

/** True for an action that writes to the ledger; false for `request_ai_review`. */
export function isLedgerAction(action: RuleAction): action is LedgerRuleAction {
  return action.type !== "request_ai_review";
}

/** True for `convert_to_transfer` and `split`, the actions that restructure the row. */
export function isStructuralAction(
  action: RuleAction,
): action is StructuralRuleAction {
  return action.type === "convert_to_transfer" || action.type === "split";
}
