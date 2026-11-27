/**
 * The closed list of rule actions (design section 6.1). INV-RULE-001 (restated
 * in docs/specs/transaction-rules-structural-actions.md section 2): no action
 * changes the matched row's amount, account, date or status, and none deletes
 * or relinks a row that exists. The only balance a rule moves is the one a
 * structural action (`convert_to_transfer`, `split`,
 * `settle_loan_installment`) creates, by exactly the counterpart leg's
 * amount. Anything not in this union is not representable, and the validator
 * refuses it.
 *
 * `request_ai_review` is the one action that is not a ledger write: it asks
 * for a person-approved AI review of the row and never changes the row itself.
 * `isLedgerAction` tells the two groups apart for the applier;
 * `isStructuralAction` picks out the three that restructure the row.
 *
 * `RULE_ACTION_TYPES` is the list the frontend editor mirrors
 * (`frontend/src/lib/rule-fields.contract.test.ts`) and the hints and name
 * mappings are keyed on. Every save path accepts it plus
 * `settle_loan_installment` (`isAcceptedActionType` in `rule-validation.ts`):
 * the action is typed, validated, referenced, planned and, since its write
 * path landed (B5 of `docs/specs/loan-installment-settlement.md`),
 * written with its occurrence claim, but it joins the mirrored list only with
 * the editor card that offers it (F1), so until then a rule carrying it is
 * written by hand, by the mortgage form (B7), the assistant or MCP (B8).
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

/** The action that settles a bank debit against a scheduled loan installment. */
export const SETTLE_LOAN_INSTALLMENT = "settle_loan_installment";

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
  /**
   * Clears the row's category. Defaults to true; false keeps it, on both
   * legs. Ignored when `categoryId` names one.
   */
  readonly clearCategory: boolean;
  /**
   * The category both legs take, of any type: a transfer accepts Income,
   * Expense and Transfer categories (INV-CATEGORY-001, INV-CATEGORY-002).
   */
  readonly categoryId?: string;
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

/** What a row that paid more than the priced installment becomes. */
export const LOAN_SETTLEMENT_EXCESS_POLICIES = [
  "extra_principal",
  "refuse",
] as const;
/** What a row that paid less than the base installment becomes. */
export const LOAN_SETTLEMENT_SHORTFALL_POLICIES = [
  "refuse",
  "interest_first",
] as const;

/**
 * What a `settle_loan_installment` saved without them stores (spec section
 * 5.1, decision 19): the window, the excess and the shortfall policy. Read by
 * the save-time defaults and by the rule the "Payment matching" section builds.
 */
export const SETTLE_LOAN_INSTALLMENT_DEFAULTS = Object.freeze({
  dueDateWindow: Object.freeze({ daysBefore: 3, daysAfter: 7 }),
  excess: "extra_principal",
  shortfall: "refuse",
} as const);

/**
 * Settles the matched bank debit against the scheduled installment of a loan
 * (`docs/specs/loan-installment-settlement.md` section 5.1): the row becomes a
 * split of a principal transfer to the loan, an interest line and, when it
 * paid more, an extra-principal transfer, priced by the installment engine for
 * the occurrence it pays. No amount is stored: the engine prices every line.
 * Every field is written on save (decision 19).
 */
export interface SettleLoanInstallmentAction {
  readonly type: typeof SETTLE_LOAN_INSTALLMENT;
  /** A `MORTGAGE` or `LOAN` account of the rule's owner. */
  readonly loanAccountId: string;
  /** The slots a row dated `t` may pay: `[t - daysAfter, t + daysBefore]`, each 0..31. */
  readonly dueDateWindow: {
    readonly daysBefore: number;
    readonly daysAfter: number;
  };
  readonly excess: (typeof LOAN_SETTLEMENT_EXCESS_POLICIES)[number];
  readonly shortfall: (typeof LOAN_SETTLEMENT_SHORTFALL_POLICIES)[number];
  /** The interest line's category; absent means the loan's `interest_category_id`. */
  readonly interestCategoryId?: string;
}

/** The actions that restructure the row: a transfer leg or a split. */
export type StructuralRuleAction =
  ConvertToTransferAction | SplitAction | SettleLoanInstallmentAction;

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

/** True for `convert_to_transfer`, `split` and `settle_loan_installment`, the actions that restructure the row. */
export function isStructuralAction(
  action: RuleAction,
): action is StructuralRuleAction {
  return isStructuralActionType(action.type);
}

/** The same test on a type name, for a caller holding only the type (a trace entry, an unvalidated action). */
export function isStructuralActionType(type: unknown): boolean {
  return (
    type === "convert_to_transfer" ||
    type === "split" ||
    type === SETTLE_LOAN_INSTALLMENT
  );
}
