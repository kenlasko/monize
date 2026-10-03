import {
  ConvertToTransferAction,
  SPLIT_REST_AMOUNT,
  SplitAction,
  StructuralRuleAction,
} from "./rule-action.types";
import { parseRuleAmount } from "./rule-amount";
import { RuleFacts } from "./rule-condition.types";
import { GlobCaptures } from "./rule-glob-capture";

/**
 * The planned structure of a row (spec section 4): what a structural action
 * will make of it. Pure data, carried in `RuleNetChanges.structure` and in
 * the rule's trace (`changes.structure`), so the preview, the test and the
 * commit show and write the same parts.
 */
export interface TransferStructurePlan {
  readonly kind: "transfer";
  /** The account that receives the counterpart leg. */
  readonly accountId: string;
  readonly clearCategory: boolean;
  /**
   * The counterpart leg's signed amount (the negative of the row's), 4
   * decimals. It is part of the plan so the preview shows it, the run
   * fingerprint covers it, and the write refuses a row whose amount moved
   * since (INV-RULE-003).
   */
  readonly amount: number;
  /**
   * The leg the write created in `accountId`. Absent in a plan; set by the
   * applier on the trace it stores, so the run's undo and the trace show it.
   */
  readonly counterpartIds?: readonly string[];
}

/** One part of a planned split; `amount` is signed like the row, 4 decimals. */
export interface SplitStructurePart {
  readonly amount: number;
  readonly categoryId: string | null;
  readonly transferAccountId: string | null;
  /** The payee of the counterpart leg of a transfer part. */
  readonly payeeId: string | null;
  readonly memo: string | null;
}

export interface SplitStructurePlan {
  readonly kind: "split";
  readonly parts: readonly SplitStructurePart[];
  /**
   * The counterpart legs the write created, one per transfer part in part
   * order. Absent in a plan; set by the applier on the stored trace.
   */
  readonly counterpartIds?: readonly string[];
  /**
   * The split lines the write created, in part order. Absent in a plan; set
   * by the applier on the stored trace, so the run's undo can tell the lines
   * the run wrote from lines a person added or replaced since.
   */
  readonly lineIds?: readonly string[];
}

export type RuleStructurePlan = TransferStructurePlan | SplitStructurePlan;

/** The reasons a structural action is refused, in the order they are checked (spec section 4). */
export type StructuralRefusal =
  | "row_is_transfer_leg"
  | "row_has_splits"
  | "row_is_void"
  | "zero_amount"
  | "transfer_direction_mismatch"
  | "transfer_same_account"
  | "transfer_account_unavailable"
  | "transfer_currency_mismatch"
  | "split_amount_unparseable"
  | "split_sum_mismatch"
  | "split_too_few_parts";

/** Every account a plan's write will move the balance of, each once. */
export function structureTargetAccountIds(
  structure: RuleStructurePlan,
): string[] {
  if (structure.kind === "transfer") return [structure.accountId];
  return [
    ...new Set(
      structure.parts
        .map((part) => part.transferAccountId)
        .filter((id): id is string => id !== null),
    ),
  ];
}

/** The owner's accounts a structural action may target, by id. */
export type RuleTargetAccounts = ReadonlyMap<
  string,
  { readonly currencyCode: string }
>;

export type StructurePlanResult =
  | { readonly ok: true; readonly structure: RuleStructurePlan }
  | { readonly ok: false; readonly reason: StructuralRefusal };

const MONEY_SCALE = 10000;
const refused = (reason: StructuralRefusal): StructurePlanResult => ({
  ok: false,
  reason,
});

/** The row-level refusals shared by both actions (spec section 4, first four). */
function rowRefusal(facts: RuleFacts): StructuralRefusal | null {
  if (facts.type === "TRANSFER") return "row_is_transfer_leg";
  if (facts.hasSplits) return "row_has_splits";
  if (facts.status === "VOID") return "row_is_void";
  if (facts.amount === null || facts.amount === 0) return "zero_amount";
  return null;
}

/** A target account the row can pair with: not its own, known, same currency. */
function targetRefusal(
  accountId: string,
  facts: RuleFacts,
  accounts: RuleTargetAccounts | undefined,
): StructuralRefusal | null {
  if (accountId === facts.accountId) return "transfer_same_account";
  const target = accounts?.get(accountId);
  if (target === undefined) return "transfer_account_unavailable";
  const own = facts.currencyCode?.toUpperCase() ?? null;
  return own !== null && own === target.currencyCode.toUpperCase()
    ? null
    : "transfer_currency_mismatch";
}

function planConvert(
  action: ConvertToTransferAction,
  facts: RuleFacts,
  accounts: RuleTargetAccounts | undefined,
): StructurePlanResult {
  const income = (facts.amount ?? 0) > 0;
  const target = action.toAccountId ?? action.fromAccountId;
  if (target === undefined) return refused("transfer_account_unavailable");
  if (
    (action.toAccountId !== undefined && income) ||
    (action.fromAccountId !== undefined && !income)
  ) {
    return refused("transfer_direction_mismatch");
  }
  const reason = targetRefusal(target, facts, accounts);
  if (reason !== null) return refused(reason);
  return {
    ok: true,
    structure: {
      kind: "transfer",
      accountId: target,
      clearCategory: action.clearCategory,
      // The row's amount is non-zero here (`rowRefusal`).
      amount: -(facts.amount ?? 0) / MONEY_SCALE,
    },
  };
}

/** The magnitude a part names: a capture parsed as an amount, or null. */
function captureMagnitude(
  amount: string,
  captures: GlobCaptures,
): number | null {
  const name = /^\{(.+)\}$/.exec(amount)?.[1];
  if (
    name === undefined ||
    !Object.prototype.hasOwnProperty.call(captures, name)
  )
    return null;
  return parseRuleAmount(captures[name]);
}

function planSplit(
  action: SplitAction,
  facts: RuleFacts,
  accounts: RuleTargetAccounts | undefined,
  captures: GlobCaptures,
): StructurePlanResult {
  for (const part of action.parts) {
    if (part.transferAccountId === undefined) continue;
    const reason = targetRefusal(part.transferAccountId, facts, accounts);
    if (reason !== null) return refused(reason);
  }
  const total = Math.abs(facts.amount ?? 0);
  const sign = (facts.amount ?? 0) < 0 ? -1 : 1;
  const magnitudes: Array<number | null> = [];
  let named = 0;
  for (const part of action.parts) {
    if (part.amount === SPLIT_REST_AMOUNT) {
      magnitudes.push(null);
      continue;
    }
    const magnitude = captureMagnitude(part.amount, captures);
    if (magnitude === null) return refused("split_amount_unparseable");
    magnitudes.push(magnitude);
    named += magnitude;
  }
  const hasRest = action.parts.some((p) => p.amount === SPLIT_REST_AMOUNT);
  if (hasRest ? named > total : named !== total) {
    return refused("split_sum_mismatch");
  }
  const parts: SplitStructurePart[] = [];
  action.parts.forEach((part, i) => {
    const magnitude = magnitudes[i] ?? total - named;
    if (magnitude === 0) return;
    parts.push({
      amount: (sign * magnitude) / MONEY_SCALE,
      categoryId: part.categoryId ?? null,
      transferAccountId: part.transferAccountId ?? null,
      payeeId: part.payeeId ?? null,
      memo: part.description?.trim() || null,
    });
  });
  if (parts.length < 2) return refused("split_too_few_parts");
  return { ok: true, structure: { kind: "split", parts } };
}

/**
 * Plan one structural action against the row as the rules before it left it
 * (`facts` already reflects an earlier conversion or split). Pure; every
 * refusal is decided here, before anything is written (spec section 2).
 */
export function planStructure(
  action: StructuralRuleAction,
  facts: RuleFacts,
  accounts: RuleTargetAccounts | undefined,
  captures: GlobCaptures,
): StructurePlanResult {
  const row = rowRefusal(facts);
  if (row !== null) return refused(row);
  return action.type === "convert_to_transfer"
    ? planConvert(action, facts, accounts)
    : planSplit(action, facts, accounts, captures);
}
