/**
 * The field and operator table of the rule editor, and the limits the server
 * enforces, mirrored VERBATIM from `backend/src/transaction-rules/`
 * (`rule-condition.types.ts`, `rule-action.types.ts`, `rule-trigger.types.ts`,
 * `rule-validation.ts` and `dto/create-transaction-rule.dto.ts`).
 *
 * The editor offers only what the table allows, so a field the server does not
 * know cannot be built. `rule-fields.contract.test.ts` reads the backend source
 * and fails when the two differ; change the backend first and mirror it here.
 */
import type {
  RuleActionType,
  RuleField,
  RuleOperator,
  RuleTransactionType,
  RuleTrigger,
} from '@/types/transaction-rule';

/** What kind of value a field carries; decides the value control. */
export type RuleValueKind =
  | 'accountId'
  | 'payeeId'
  | 'categoryId'
  | 'tagIds'
  | 'text'
  | 'money'
  | 'enum'
  | 'currency'
  | 'boolean'
  | 'dayOfMonth'
  | 'date';

export const RULE_OPERATORS = [
  'eq',
  'neq',
  'in',
  'notIn',
  'isEmpty',
  'contains',
  'startsWith',
  'matches',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'hasAny',
  'hasAll',
  'hasNone',
  'inSubtree',
] as const satisfies readonly RuleOperator[];

/** How many values an operator takes: none, one, a list, or a [min, max] pair. */
export type RuleOperatorShape = 'none' | 'scalar' | 'list' | 'range';

export const RULE_OPERATOR_SHAPES: Readonly<Record<RuleOperator, RuleOperatorShape>> = {
  eq: 'scalar',
  neq: 'scalar',
  in: 'list',
  notIn: 'list',
  isEmpty: 'none',
  contains: 'scalar',
  startsWith: 'scalar',
  matches: 'scalar',
  lt: 'scalar',
  lte: 'scalar',
  gt: 'scalar',
  gte: 'scalar',
  between: 'range',
  hasAny: 'list',
  hasAll: 'list',
  hasNone: 'list',
  inSubtree: 'scalar',
};

export const RULE_TRANSACTION_TYPES = [
  'EXPENSE',
  'INCOME',
  'TRANSFER',
] as const satisfies readonly RuleTransactionType[];

/** The days of the week a `weekday` leaf names, Monday first. */
export const RULE_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/** The reconciliation statuses a `status` leaf names. */
export const RULE_TRANSACTION_STATUSES = ['UNRECONCILED', 'CLEARED', 'RECONCILED', 'VOID'] as const;

/** `dayOfMonth` takes whole days 1..31. */
export const RULE_MIN_DAY_OF_MONTH = 1;
export const RULE_MAX_DAY_OF_MONTH = 31;

export interface RuleFieldSpec {
  readonly kind: RuleValueKind;
  readonly operators: readonly RuleOperator[];
  /** Only for `kind: 'enum'`. */
  readonly enumValues?: readonly string[];
}

const ID_OPERATORS = ['eq', 'neq', 'in', 'notIn'] as const;
const TEXT_OPERATORS = ['eq', 'contains', 'startsWith', 'matches', 'isEmpty'] as const;

export const RULE_CONDITION_FIELDS: Readonly<Record<RuleField, RuleFieldSpec>> = {
  accountId: { kind: 'accountId', operators: ID_OPERATORS },
  fromAccountId: { kind: 'accountId', operators: [...ID_OPERATORS, 'isEmpty'] },
  toAccountId: { kind: 'accountId', operators: [...ID_OPERATORS, 'isEmpty'] },
  type: { kind: 'enum', operators: ['eq', 'neq', 'in'], enumValues: RULE_TRANSACTION_TYPES },
  payeeId: { kind: 'payeeId', operators: [...ID_OPERATORS, 'isEmpty'] },
  payeeText: { kind: 'text', operators: TEXT_OPERATORS },
  categoryId: { kind: 'categoryId', operators: [...ID_OPERATORS, 'isEmpty', 'inSubtree'] },
  description: { kind: 'text', operators: TEXT_OPERATORS },
  amount: { kind: 'money', operators: ['eq', 'lt', 'lte', 'gt', 'gte', 'between'] },
  absAmount: { kind: 'money', operators: ['lt', 'lte', 'gt', 'gte', 'between'] },
  currencyCode: { kind: 'currency', operators: ['eq', 'in'] },
  tagIds: { kind: 'tagIds', operators: ['hasAny', 'hasAll', 'hasNone'] },
  hasSplits: { kind: 'boolean', operators: ['eq'] },
  referenceNumber: { kind: 'text', operators: TEXT_OPERATORS },
  dayOfMonth: { kind: 'dayOfMonth', operators: ['eq', 'lt', 'lte', 'gt', 'gte', 'between', 'in'] },
  weekday: { kind: 'enum', operators: ['eq', 'in'], enumValues: RULE_WEEKDAYS },
  status: { kind: 'enum', operators: ['eq', 'neq', 'in'], enumValues: RULE_TRANSACTION_STATUSES },
  hasAttachment: { kind: 'boolean', operators: ['eq'] },
  date: { kind: 'date', operators: ['eq', 'lt', 'lte', 'gt', 'gte', 'between'] },
};

export const RULE_FIELDS = Object.keys(RULE_CONDITION_FIELDS) as RuleField[];

/**
 * The fields the visual editor has a control and a label for: all of them. A
 * field newer than this client is not in the table, so it never reaches a card;
 * `RuleValueControl` still shows such a leaf's stored value as it is.
 */
export const EDITOR_RULE_FIELDS: readonly RuleField[] = RULE_FIELDS;
export const isEditorRuleField = (field: RuleField): boolean => EDITOR_RULE_FIELDS.includes(field);

export const RULE_ACTION_TYPES = [
  'add_tags',
  'remove_tags',
  'set_category',
  'set_payee',
  'request_ai_review',
  'set_payee_from_text',
  'set_description',
  'convert_to_transfer',
  'split',
] as const satisfies readonly RuleActionType[];

export const RULE_TRIGGERS = ['create', 'import'] as const satisfies readonly RuleTrigger[];

// Limits (`rule-validation.ts`, `dto/create-transaction-rule.dto.ts`).
export const MAX_RULE_CONDITION_DEPTH = 4;
export const MAX_RULE_CONDITION_LEAVES = 50;
export const MAX_RULE_CONDITION_NODES = 100;
export const MAX_RULE_ACTIONS = 10;
export const MIN_RULE_TAG_IDS = 1;
export const MAX_RULE_TAG_IDS = 20;
export const MIN_RULE_AI_INSTRUCTION_LENGTH = 1;
export const MAX_RULE_AI_INSTRUCTION_LENGTH = 1000;
export const MAX_RULE_AI_REVIEW_ACTIONS = 1;
export const MAX_RULE_STRUCTURAL_ACTIONS = 1;
export const MIN_RULE_TEMPLATE_LENGTH = 1;
export const MAX_RULE_PAYEE_TEMPLATE_LENGTH = 200;
export const MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH = 500;
export const MIN_RULE_SPLIT_PARTS = 2;
export const MAX_RULE_SPLIT_PARTS = 10;
export const MIN_RULE_SPLIT_DESCRIPTION_LENGTH = 1;
export const MAX_RULE_SPLIT_DESCRIPTION_LENGTH = 200;
export const MAX_RULE_TEXT_LENGTH = 500;
export const MAX_RULE_VALUE_LIST = 50;
export const MIN_RULE_NAME_LENGTH = 1;
export const MAX_RULE_NAME_LENGTH = 100;

export const RULE_VALIDATION_CODES = [
  'INVALID_SHAPE',
  'UNKNOWN_KEY',
  'UNKNOWN_FIELD',
  'UNKNOWN_ACTION',
  'OPERATOR_NOT_ALLOWED',
  'VALUE_REQUIRED',
  'VALUE_NOT_ALLOWED',
  'VALUE_TYPE',
  'VALUE_OUT_OF_RANGE',
  'VALUE_TOO_LONG',
  'VALUE_EMPTY',
  'INVALID_UUID',
  'INVALID_ENUM',
  'INVALID_CURRENCY',
  'ARRAY_EMPTY',
  'ARRAY_TOO_LARGE',
  'RANGE_ORDER',
  'MAX_DEPTH',
  'MAX_LEAVES',
  'MAX_NODES',
  'NO_ACTIONS',
  'TOO_MANY_ACTIONS',
  'DUPLICATE_ACTION',
  'CONFLICTING_ACTIONS',
  'INVALID_CAPTURE',
  'TOO_MANY_CAPTURES',
  'DUPLICATE_CAPTURE',
  'UNKNOWN_CAPTURE',
  'LOOKS_LIKE_REGEX',
  'PATTERN_WITHOUT_WILDCARD',
] as const;

/** Every code a card can show: the validation codes plus the reference check's. */
export type RuleErrorCode = (typeof RULE_VALIDATION_CODES)[number] | 'REFERENCE_NOT_FOUND';

export function isRuleField(value: unknown): value is RuleField {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RULE_CONDITION_FIELDS, value);
}

export function isRuleOperator(value: unknown): value is RuleOperator {
  return typeof value === 'string' && (RULE_OPERATORS as readonly string[]).includes(value);
}

export function isRuleActionType(value: unknown): value is RuleActionType {
  return typeof value === 'string' && (RULE_ACTION_TYPES as readonly string[]).includes(value);
}
