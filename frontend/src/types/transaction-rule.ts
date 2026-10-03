/**
 * Transaction rules as the API returns and accepts them. Mirrors
 * `backend/src/transaction-rules/rule-condition.types.ts`,
 * `rule-action.types.ts` and `rule-trigger.types.ts`; the field and operator
 * table itself (which operators a field allows) belongs to the editor
 * (`lib/rule-fields.ts`), not to these types.
 */

export type RuleTrigger = 'create' | 'import';

export type RuleField =
  | 'accountId'
  | 'fromAccountId'
  | 'toAccountId'
  | 'type'
  | 'payeeId'
  | 'payeeText'
  | 'categoryId'
  | 'description'
  | 'amount'
  | 'absAmount'
  | 'currencyCode'
  | 'tagIds'
  | 'hasSplits'
  | 'referenceNumber'
  | 'dayOfMonth'
  | 'weekday'
  | 'status'
  | 'hasAttachment'
  | 'date';

export type RuleOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'notIn'
  | 'isEmpty'
  | 'contains'
  | 'startsWith'
  | 'matches'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'between'
  | 'hasAny'
  | 'hasAll'
  | 'hasNone'
  | 'inSubtree';

export type RuleTransactionType = 'EXPENSE' | 'INCOME' | 'TRANSFER';

/** A leaf value: a scalar, a list of scalars, or a [min, max] pair. */
export type RuleLeafValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[];

export interface RuleConditionLeaf {
  readonly field: RuleField;
  readonly op: RuleOperator;
  /** Absent for `isEmpty`. */
  readonly value?: RuleLeafValue;
}

export interface RuleAllGroup {
  readonly all: readonly RuleConditionNode[];
  readonly not?: boolean;
}

export interface RuleAnyGroup {
  readonly any: readonly RuleConditionNode[];
  readonly not?: boolean;
}

export type RuleConditionGroup = RuleAllGroup | RuleAnyGroup;
export type RuleConditionNode = RuleConditionGroup | RuleConditionLeaf;

export interface AddTagsAction {
  readonly type: 'add_tags';
  readonly tagIds: readonly string[];
}

export interface RemoveTagsAction {
  readonly type: 'remove_tags';
  readonly tagIds: readonly string[];
}

export interface SetCategoryAction {
  readonly type: 'set_category';
  readonly categoryId: string;
  readonly onlyIfEmpty: boolean;
}

export interface SetPayeeAction {
  readonly type: 'set_payee';
  readonly payeeId: string;
  readonly onlyIfEmpty: boolean;
}

/** Sets the payee from a template rendered from the rule's captures (design 10.2). */
export interface SetPayeeFromTextAction {
  readonly type: 'set_payee_from_text';
  readonly template: string;
  readonly createIfMissing: boolean;
  readonly onlyIfEmpty: boolean;
}

export type RuleDescriptionMode = 'replace' | 'append' | 'prepend';

/** Writes the description from a template; `{description}` is the current text. */
export interface SetDescriptionAction {
  readonly type: 'set_description';
  readonly template: string;
  readonly mode: RuleDescriptionMode;
  readonly onlyIfEmpty: boolean;
}

/**
 * Makes the matched row one leg of a transfer. Exactly one of `toAccountId`
 * (an expense) and `fromAccountId` (an income). Created in the rule editor, the
 * assistant or MCP.
 */
export interface ConvertToTransferAction {
  readonly type: 'convert_to_transfer';
  readonly toAccountId?: string;
  readonly fromAccountId?: string;
  readonly clearCategory: boolean;
  readonly payeeId?: string;
}

/** One part of a `split`: `amount` is `"{capture}"` or `"rest"`. */
export interface SplitActionPart {
  readonly amount: string;
  readonly categoryId?: string;
  readonly transferAccountId?: string;
  readonly payeeId?: string;
  readonly description?: string;
}

/** Turns the matched row into a split whose part amounts come from the rule's captures. */
export interface SplitAction {
  readonly type: 'split';
  readonly payeeId?: string;
  readonly parts: readonly SplitActionPart[];
}

/** The two actions that restructure the row (a transfer, a split). */
export type StructuralRuleAction = ConvertToTransferAction | SplitAction;

/** Queues a person-approved AI review; never changes the row itself. */
export interface RequestAiReviewAction {
  readonly type: 'request_ai_review';
  readonly instruction: string;
}

export type RuleAction =
  | AddTagsAction
  | RemoveTagsAction
  | SetCategoryAction
  | SetPayeeAction
  | SetPayeeFromTextAction
  | SetDescriptionAction
  | StructuralRuleAction
  | RequestAiReviewAction;

export type RuleActionType = RuleAction['type'];

/** Why a stored rule cannot run: a validation code or `REFERENCE_NOT_FOUND`. */
export interface RuleInvalidReason {
  path: string;
  code: string;
}

export interface TransactionRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Evaluation order, ascending. */
  position: number;
  triggers: RuleTrigger[];
  condition: RuleConditionNode;
  actions: RuleAction[];
  stopProcessing: boolean;
  /**
   * The active window: first and last transaction date (`YYYY-MM-DD`, both
   * inclusive) the rule is evaluated for, on every path. Null is open on that
   * side.
   */
  activeFrom: string | null;
  activeTo: string | null;
  /** Compare-and-swap token: send the value last read with every update. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /**
   * True when the stored definition fails validation or names an id that no
   * longer exists. The rule is kept and skipped at run time; its `condition`
   * and `actions` may then be malformed (a restore leaves `{}` and `[]`).
   */
  invalid: boolean;
  invalidReasons: RuleInvalidReason[];
}

export interface CreateTransactionRuleData {
  name: string;
  enabled?: boolean;
  triggers: RuleTrigger[];
  condition: RuleConditionNode;
  actions: RuleAction[];
  stopProcessing?: boolean;
  /** `YYYY-MM-DD`; null (on an update) clears the side. */
  activeFrom?: string | null;
  activeTo?: string | null;
}

export interface UpdateTransactionRuleData extends Partial<CreateTransactionRuleData> {
  revision: number;
}

/** Error codes the rules endpoints answer 409 with. */
export type TransactionRuleConflictCode = 'REVISION_CONFLICT' | 'RULE_LIST_CHANGED';
