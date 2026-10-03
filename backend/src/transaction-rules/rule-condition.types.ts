/**
 * The condition model of a transaction rule (design: `docs/future-plans/
 * transaction-rules.md` section 5).
 *
 * A condition is a tree: a group (`all` / `any`, optionally negated by `not`)
 * or a leaf (`field`, `op`, `value`). The field/operator table below is the
 * one place that says what a leaf may say; the validator and the evaluator
 * both read it, so a field cannot be accepted by one and ignored by the other.
 */

/** What kind of value a field carries; decides the value check and the compare. */
export type RuleValueKind =
  | "accountId"
  | "payeeId"
  | "categoryId"
  | "tagIds"
  | "text"
  | "money"
  | "enum"
  | "currency"
  | "boolean"
  | "dayOfMonth"
  | "date";

export const RULE_OPERATORS = [
  "eq",
  "neq",
  "in",
  "notIn",
  "isEmpty",
  "contains",
  "startsWith",
  "matches",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "hasAny",
  "hasAll",
  "hasNone",
  "inSubtree",
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

/** How many values an operator takes: none, one, a list, or a [min, max] pair. */
export type RuleOperatorShape = "none" | "scalar" | "list" | "range";

export const RULE_OPERATOR_SHAPES: Readonly<
  Record<RuleOperator, RuleOperatorShape>
> = {
  eq: "scalar",
  neq: "scalar",
  in: "list",
  notIn: "list",
  isEmpty: "none",
  contains: "scalar",
  startsWith: "scalar",
  matches: "scalar",
  lt: "scalar",
  lte: "scalar",
  gt: "scalar",
  gte: "scalar",
  between: "range",
  hasAny: "list",
  hasAll: "list",
  hasNone: "list",
  inSubtree: "scalar",
};

/** The type of a row, derived from what it is (sign and link), never from the account type. */
export const RULE_TRANSACTION_TYPES = [
  "EXPENSE",
  "INCOME",
  "TRANSFER",
] as const;
export type RuleTransactionType = (typeof RULE_TRANSACTION_TYPES)[number];

/** The days of the week a `weekday` leaf names, Monday first (ISO 8601). */
export const RULE_WEEKDAYS = [
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
  "SUN",
] as const;
export type RuleWeekday = (typeof RULE_WEEKDAYS)[number];

/**
 * The reconciliation statuses a `status` leaf names. Written out here because
 * the frontend contract test runs this file without its imports; a spec holds
 * the list equal to `TransactionStatus`.
 */
export const RULE_TRANSACTION_STATUSES = [
  "UNRECONCILED",
  "CLEARED",
  "RECONCILED",
  "VOID",
] as const;

/** `dayOfMonth` takes whole days 1..31 (design 10.3). */
export const RULE_MIN_DAY_OF_MONTH = 1;
export const RULE_MAX_DAY_OF_MONTH = 31;

export interface RuleConditionFieldSpec {
  readonly kind: RuleValueKind;
  readonly operators: readonly RuleOperator[];
  /** Only for `kind: "enum"`. */
  readonly enumValues?: readonly string[];
}

const ID_OPERATORS = ["eq", "neq", "in", "notIn"] as const;
const TEXT_OPERATORS = [
  "eq",
  "contains",
  "startsWith",
  "matches",
  "isEmpty",
] as const;

/** Design section 5.2, verbatim: the single table of fields and their operators. */
export const RULE_CONDITION_FIELDS = {
  accountId: { kind: "accountId", operators: ID_OPERATORS },
  fromAccountId: {
    kind: "accountId",
    operators: [...ID_OPERATORS, "isEmpty"],
  },
  toAccountId: { kind: "accountId", operators: [...ID_OPERATORS, "isEmpty"] },
  type: {
    kind: "enum",
    operators: ["eq", "neq", "in"],
    enumValues: RULE_TRANSACTION_TYPES,
  },
  payeeId: { kind: "payeeId", operators: [...ID_OPERATORS, "isEmpty"] },
  payeeText: { kind: "text", operators: TEXT_OPERATORS },
  categoryId: {
    kind: "categoryId",
    operators: [...ID_OPERATORS, "isEmpty", "inSubtree"],
  },
  description: { kind: "text", operators: TEXT_OPERATORS },
  amount: {
    kind: "money",
    operators: ["eq", "lt", "lte", "gt", "gte", "between"],
  },
  absAmount: {
    kind: "money",
    operators: ["lt", "lte", "gt", "gte", "between"],
  },
  currencyCode: { kind: "currency", operators: ["eq", "in"] },
  tagIds: { kind: "tagIds", operators: ["hasAny", "hasAll", "hasNone"] },
  hasSplits: { kind: "boolean", operators: ["eq"] },
  // Design 10.3 (X3). The date fields read the transaction's own calendar date.
  referenceNumber: { kind: "text", operators: TEXT_OPERATORS },
  dayOfMonth: {
    kind: "dayOfMonth",
    operators: ["eq", "lt", "lte", "gt", "gte", "between", "in"],
  },
  weekday: {
    kind: "enum",
    operators: ["eq", "in"],
    enumValues: RULE_WEEKDAYS,
  },
  status: {
    kind: "enum",
    operators: ["eq", "neq", "in"],
    enumValues: RULE_TRANSACTION_STATUSES,
  },
  hasAttachment: { kind: "boolean", operators: ["eq"] },
  // The transaction's own calendar date, compared as a `YYYY-MM-DD` string.
  date: {
    kind: "date",
    operators: ["eq", "lt", "lte", "gt", "gte", "between"],
  },
} as const satisfies Record<string, RuleConditionFieldSpec>;

export type RuleField = keyof typeof RULE_CONDITION_FIELDS;
export const RULE_FIELDS = Object.keys(RULE_CONDITION_FIELDS) as RuleField[];

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

/**
 * The frozen facts of one row that the evaluator reads. The applier builds it
 * once per row; the evaluator never queries anything, so the preview, the test
 * panel and the commit answer the same way.
 *
 * `null` means unknown for the row (a leaf on it is false for every operator
 * except `isEmpty`), never a default value.
 */
export interface RuleFacts {
  readonly accountId: string;
  /** Null when the row is not a transfer. */
  readonly fromAccountId: string | null;
  /** Null when the row is not a transfer. */
  readonly toAccountId: string | null;
  /** Null when the row is neither income nor spending (a zero amount, no link). */
  readonly type: RuleTransactionType | null;
  readonly payeeId: string | null;
  readonly payeeText: string | null;
  readonly categoryId: string | null;
  /** The category itself plus its ancestors; empty when the row has no category. */
  readonly categoryAncestorIds: readonly string[];
  readonly description: string | null;
  /** Signed, in 1/10000 units of the account currency (a scaled integer). */
  readonly amount: number | null;
  readonly currencyCode: string | null;
  readonly tagIds: readonly string[];
  readonly hasSplits: boolean;
  /** The reference number (check number, bank reference); null when the row has none. */
  readonly referenceNumber: string | null;
  /** 1..31 from the transaction's calendar date (never a clock reading); null when the date is unknown. */
  readonly dayOfMonth: number | null;
  /** The transaction's calendar date, `YYYY-MM-DD`; null when it is not a real date. */
  readonly date: string | null;
  /** The weekday of the transaction's calendar date; null when the date is unknown. */
  readonly weekday: RuleWeekday | null;
  /** The reconciliation status; null when the source does not know it yet. */
  readonly status: string | null;
  /** Whether the row has a visible attachment (a scan pair counts once). */
  readonly hasAttachment: boolean;
}
