import {
  RuleAction,
  StructuralRuleAction,
  isLedgerAction,
} from "./rule-action.types";
import { evaluateRuleConditionWithCaptures } from "./rule-condition.evaluator";
import { RuleConditionNode, RuleFacts } from "./rule-condition.types";
import { GlobCaptures } from "./rule-glob-capture";
import {
  TemplateValues,
  composeDescription,
  renderPayeeName,
  renderRuleTemplate,
} from "./rule-template";
import {
  RuleStructurePlan,
  RuleTargetAccounts,
  StructuralRefusal,
  planStructure,
} from "./rule-structure";
import { validateRuleDefinition } from "./rule-validation";

export type {
  RuleStructurePlan,
  RuleTargetAccounts,
  SplitStructurePart,
  SplitStructurePlan,
  TransferStructurePlan,
} from "./rule-structure";

/** The part of a stored rule the planner reads. `TransactionRule` satisfies it. */
export interface PlannableRule {
  readonly id: string;
  readonly enabled: boolean;
  readonly stopProcessing: boolean;
  readonly condition: RuleConditionNode;
  readonly actions: readonly RuleAction[];
  /**
   * The active window (INV-RULE-004): first and last transaction date, both
   * inclusive, `YYYY-MM-DD`. Null or absent means open on that side.
   */
  readonly activeFrom?: string | null;
  readonly activeTo?: string | null;
}

export type RuleActionSkipReason =
  | "already_set"
  | "no_change"
  | "row_has_splits"
  | "row_is_transfer_leg"
  | "cross_owner_transfer_leg"
  /** The template rendered to nothing (design 10.2). */
  | "empty_render"
  /** No payee has the rendered name and the action does not create one. */
  | "payee_not_found"
  /** The payee lookup for the rendered name has not been made yet (the applier looks it up and plans again). */
  | "payee_unresolved"
  /**
   * A structural action on a row someone other than the owner created in the
   * owner's account (a joint-account member, or a delegate acting as the
   * owner): the actor may not move the owner's other balances
   * (spec section 4, `structuralNotAllowed`).
   */
  | "structural_not_allowed_for_actor"
  /** A structural action the row cannot take (spec section 4). */
  | StructuralRefusal;

export type RuleSkipReason =
  | "disabled"
  | "invalid"
  /** The row's date is unknown or outside the rule's active window (INV-RULE-004). */
  | "outside_active_window";

/** What the planner knows about the row beyond its facts. */
/** An existing payee a rendered name resolved to. */
export interface PayeeResolution {
  readonly payeeId: string;
  readonly name: string;
}

/**
 * Payee lookups the caller has already made, by `payeeLookupKey`. `null`
 * means no payee has that name. The planner does no I/O: a name that is not
 * in the map is reported in `RuleEffects.payeeLookups` and the action waits.
 */
export type PayeeResolutions = ReadonlyMap<string, PayeeResolution | null>;

/** Payee names resolve case-insensitively, so one lookup serves every casing. */
export const payeeLookupKey = (name: string): string =>
  name.trim().toLowerCase();

export interface RulePlanContext {
  /** The payee name stored on the row, for the trace only. */
  readonly payeeName?: string | null;
  readonly payeeResolutions?: PayeeResolutions;
  /** The row is a leg of a transfer whose other leg belongs to another owner. */
  readonly crossOwnerTransferLeg?: boolean;
  /**
   * The row was created by a joint-account member (not the owner) in the
   * owner's account, under the owner's rules. A structural action would move a
   * balance in an account the member cannot read, so it is refused; category,
   * payee, description and tag actions still apply. Set by the server from the
   * joint grant, never from a request field.
   */
  readonly structuralNotAllowed?: boolean;
  /**
   * The category plus its ancestors for every category a rule may set, so a
   * later rule's `inSubtree` sees an earlier rule's category. The planner does
   * no I/O; a missing entry falls back to the category alone.
   */
  readonly categoryChains?: ReadonlyMap<string, readonly string[]>;
  /**
   * The owner's accounts a structural action may target, with their currency.
   * The planner does no I/O; an account missing here is refused as
   * `transfer_account_unavailable`.
   */
  readonly accounts?: RuleTargetAccounts;
}

export interface RuleFieldChange<T> {
  readonly before: T;
  readonly after: T;
}

/** What one rule changed, in the `{field: {before, after}}` shape of the trace. */
export interface RuleTraceChanges {
  readonly categoryId?: RuleFieldChange<string | null>;
  readonly payeeId?: RuleFieldChange<string | null>;
  /** Set by `set_payee_from_text` only: the name the payee is written with. */
  readonly payeeName?: RuleFieldChange<string | null>;
  /**
   * True when the rule's payee does not exist yet and is created with the
   * write. A preview says "will be created"; the stored application row
   * carries the created payee's id in `payeeId.after`.
   */
  readonly payeeCreated?: boolean;
  /** Set by `set_description` only. */
  readonly description?: RuleFieldChange<string | null>;
  /** Sorted tag id sets before and after the rule. */
  readonly tagIds?: RuleFieldChange<readonly string[]>;
  /** Set by `convert_to_transfer` and `split` only: before is always null. */
  readonly structure?: RuleFieldChange<RuleStructurePlan | null>;
}

/** What became of a `request_ai_review` action: a new request, or one already open. */
export type AiReviewOutcome = "queued" | "already_queued";

export interface RuleAppliedAction {
  readonly type: RuleAction["type"];
  /** Set on `request_ai_review` only. */
  readonly outcome?: AiReviewOutcome;
}

export interface RuleSkippedAction {
  readonly type: RuleAction["type"];
  readonly reason: RuleActionSkipReason;
}

export interface RuleTraceEntry {
  readonly ruleId: string;
  readonly matched: boolean;
  /** Set when the rule was not evaluated at all. */
  readonly skippedRule?: RuleSkipReason;
  readonly applied: readonly RuleAppliedAction[];
  readonly skipped: readonly RuleSkippedAction[];
  /** Ledger fields this rule changed (empty when it changed nothing). */
  readonly changes: RuleTraceChanges;
  /** True when this matched rule ended the pass (`stopProcessing`). */
  readonly stopped: boolean;
}

export interface AiReviewRequest {
  readonly ruleId: string;
  readonly instruction: string;
}

/** The net change to the row after every rule ran; absent means untouched. */
export interface RuleNetChanges {
  readonly categoryId?: string | null;
  readonly payeeId?: string | null;
  /** The name the payee is written with, when `set_payee_from_text` chose it. */
  readonly payeeName?: string;
  /**
   * A payee to create (find-or-create) and assign; `payeeId` is then absent.
   * The commit turns it into an id before it writes.
   */
  readonly createPayee?: string;
  readonly description?: string | null;
  /** What a structural action makes of the row: a transfer leg or a split. */
  readonly structure?: RuleStructurePlan;
  readonly addTagIds: readonly string[];
  readonly removeTagIds: readonly string[];
}

export interface RuleEffects {
  readonly changes: RuleNetChanges;
  readonly trace: readonly RuleTraceEntry[];
  readonly aiReviewRequests: readonly AiReviewRequest[];
  /** Rendered payee names the plan needed and `payeeResolutions` did not hold. */
  readonly payeeLookups?: readonly string[];
}

/** The ledger fields rules move, threaded through the pass (never mutated). */
interface WorkingState {
  readonly categoryId: string | null;
  readonly categoryAncestorIds: readonly string[];
  readonly payeeId: string | null;
  /** Set when `set_payee_from_text` chose the payee; null after a `set_payee`. */
  readonly payeeName: string | null;
  /**
   * A payee that does not exist yet and is created with the write (then
   * `payeeId` is null). A later rule's `payeeId` condition reads it as empty,
   * because there is no id to compare until the commit.
   */
  readonly payeeCreate: string | null;
  readonly description: string | null;
  readonly tagIds: readonly string[];
  /** The row is (or, after a conversion, will be) a leg of a transfer. */
  readonly isTransfer: boolean;
  readonly hasSplits: boolean;
  /** The structure a structural action planned; at most one per row. */
  readonly structure: RuleStructurePlan | null;
}

const NO_CHANGES: RuleTraceChanges = Object.freeze({});

function withState(facts: RuleFacts, state: WorkingState): RuleFacts {
  return Object.freeze({
    ...facts,
    categoryId: state.categoryId,
    categoryAncestorIds: state.categoryAncestorIds,
    payeeId: state.payeeId,
    description: state.description,
    tagIds: state.tagIds,
    type: state.isTransfer ? "TRANSFER" : facts.type,
    hasSplits: state.hasSplits,
  });
}

const hasPayee = (state: WorkingState): boolean =>
  state.payeeId !== null || state.payeeCreate !== null;

/** Everything a step reads besides the state: the row, the caller's knowledge, the rule's captures. */
interface StepInput {
  readonly facts: RuleFacts;
  readonly context: RulePlanContext;
  readonly captures: GlobCaptures;
  /** Payee names this step needed and could not look up (filled in place). */
  readonly lookups: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

interface StepResult {
  readonly state: WorkingState;
  readonly applied?: RuleAppliedAction;
  readonly skipped?: RuleSkippedAction;
}

function skip(
  state: WorkingState,
  action: RuleAction,
  reason: RuleActionSkipReason,
): StepResult {
  return { state, skipped: { type: action.type, reason } };
}

/** `facts` are the row as the rules before this one left it (`withState`). */
function refusal(
  action: RuleAction,
  facts: RuleFacts,
  context: RulePlanContext,
): RuleActionSkipReason | null {
  if (action.type === "set_category") {
    if (facts.hasSplits) return "row_has_splits";
    if (facts.type === "TRANSFER") return "row_is_transfer_leg";
  }
  if (
    (action.type === "set_payee" ||
      action.type === "set_payee_from_text" ||
      action.type === "set_description") &&
    context.crossOwnerTransferLeg === true
  ) {
    return "cross_owner_transfer_leg";
  }
  return null;
}

/** One ledger action against the working state (design 6.1, 6.4). */
function step(
  state: WorkingState,
  action: RuleAction,
  input: StepInput,
): StepResult {
  const { facts, context } = input;
  const refused = refusal(action, facts, context);
  if (refused !== null) return skip(state, action, refused);
  switch (action.type) {
    case "set_category": {
      if (action.onlyIfEmpty && state.categoryId !== null) {
        return skip(state, action, "already_set");
      }
      if (state.categoryId === action.categoryId) {
        return skip(state, action, "no_change");
      }
      const chain = context.categoryChains?.get(action.categoryId);
      return {
        state: {
          ...state,
          categoryId: action.categoryId,
          categoryAncestorIds: chain ?? [action.categoryId],
        },
        applied: { type: action.type },
      };
    }
    case "set_payee":
      if (action.onlyIfEmpty && hasPayee(state)) {
        return skip(state, action, "already_set");
      }
      if (state.payeeId === action.payeeId && state.payeeCreate === null) {
        return skip(state, action, "no_change");
      }
      return {
        state: {
          ...state,
          payeeId: action.payeeId,
          payeeName: null,
          payeeCreate: null,
        },
        applied: { type: action.type },
      };
    case "convert_to_transfer":
    case "split":
      return structural(state, action, input);
    case "set_payee_from_text":
      return payeeFromText(state, action, input);
    case "set_description":
      return describe(state, action, input);
    case "add_tags": {
      const added = [...new Set(action.tagIds)].filter(
        (id) => !state.tagIds.includes(id),
      );
      if (added.length === 0) return skip(state, action, "no_change");
      return {
        state: { ...state, tagIds: [...state.tagIds, ...added] },
        applied: { type: action.type },
      };
    }
    case "remove_tags": {
      const drop = new Set(action.tagIds);
      const kept = state.tagIds.filter((id) => !drop.has(id));
      if (kept.length === state.tagIds.length) {
        return skip(state, action, "no_change");
      }
      return {
        state: { ...state, tagIds: kept },
        applied: { type: action.type },
      };
    }
    default:
      // request_ai_review is collected by the caller, never a ledger step.
      return { state };
  }
}

/**
 * `convert_to_transfer` and `split` (spec section 4). A refused action is
 * skipped whole: its `payeeId` is not applied either. The row afterwards is a
 * transfer leg, or a split with no category, so a later rule sees what the
 * commit will write.
 */
function structural(
  state: WorkingState,
  action: StructuralRuleAction,
  input: StepInput,
): StepResult {
  if (input.context.structuralNotAllowed === true) {
    return skip(state, action, "structural_not_allowed_for_actor");
  }
  const planned = planStructure(
    action,
    input.facts,
    input.context.accounts,
    input.captures,
  );
  if (!planned.ok) return skip(state, action, planned.reason);
  const { structure } = planned;
  const payee =
    action.payeeId === undefined
      ? {}
      : { payeeId: action.payeeId, payeeName: null, payeeCreate: null };
  const category =
    structure.kind === "split" || structure.clearCategory
      ? { categoryId: null, categoryAncestorIds: [] }
      : {};
  return {
    state: {
      ...state,
      ...payee,
      ...category,
      structure,
      isTransfer: structure.kind === "transfer" || state.isTransfer,
      hasSplits: structure.kind === "split" || state.hasSplits,
    },
    applied: { type: action.type },
  };
}

function templateValues(state: WorkingState, input: StepInput): TemplateValues {
  return {
    captures: input.captures,
    payeeText: input.facts.payeeText,
    description: state.description,
  };
}

/** `set_payee_from_text` (design 10.2): render, look the name up, then set or create. */
function payeeFromText(
  state: WorkingState,
  action: Extract<RuleAction, { type: "set_payee_from_text" }>,
  input: StepInput,
): StepResult {
  if (action.onlyIfEmpty && hasPayee(state)) {
    return skip(state, action, "already_set");
  }
  const name = renderPayeeName(action.template, templateValues(state, input));
  if (name === "") return skip(state, action, "empty_render");
  const resolutions = input.context.payeeResolutions;
  const key = payeeLookupKey(name);
  if (resolutions === undefined || !resolutions.has(key)) {
    input.lookups.push(name);
    return skip(state, action, "payee_unresolved");
  }
  const found = resolutions.get(key) ?? null;
  if (found !== null) {
    if (state.payeeId === found.payeeId && state.payeeCreate === null) {
      return skip(state, action, "no_change");
    }
    return {
      state: {
        ...state,
        payeeId: found.payeeId,
        payeeName: found.name,
        payeeCreate: null,
      },
      applied: { type: action.type },
    };
  }
  if (!action.createIfMissing) return skip(state, action, "payee_not_found");
  if (state.payeeCreate === name && state.payeeId === null) {
    return skip(state, action, "no_change");
  }
  return {
    state: { ...state, payeeId: null, payeeName: name, payeeCreate: name },
    applied: { type: action.type },
  };
}

/** `set_description` (design 10.2): render, then replace, append or prepend. */
function describe(
  state: WorkingState,
  action: Extract<RuleAction, { type: "set_description" }>,
  input: StepInput,
): StepResult {
  if (action.onlyIfEmpty && (state.description ?? "").trim() !== "") {
    return skip(state, action, "already_set");
  }
  const rendered = renderRuleTemplate(
    action.template,
    templateValues(state, input),
  );
  const next = composeDescription(state.description, rendered, action.mode);
  if (next === null) return skip(state, action, "empty_render");
  if (next === (state.description ?? "")) {
    return skip(
      state,
      action,
      rendered.trim() === "" ? "empty_render" : "no_change",
    );
  }
  return {
    state: { ...state, description: next },
    applied: { type: action.type },
  };
}

function diffState(
  before: WorkingState,
  after: WorkingState,
): RuleTraceChanges {
  return {
    ...(before.categoryId !== after.categoryId
      ? {
          categoryId: { before: before.categoryId, after: after.categoryId },
        }
      : {}),
    ...(before.payeeId !== after.payeeId
      ? { payeeId: { before: before.payeeId, after: after.payeeId } }
      : {}),
    ...(after.payeeName !== null && after.payeeName !== before.payeeName
      ? { payeeName: { before: before.payeeName, after: after.payeeName } }
      : {}),
    ...(after.payeeCreate !== null && after.payeeCreate !== before.payeeCreate
      ? { payeeCreated: true }
      : {}),
    ...((before.description ?? null) !== (after.description ?? null)
      ? {
          description: { before: before.description, after: after.description },
        }
      : {}),
    ...(!sameSet(before.tagIds, after.tagIds)
      ? {
          tagIds: {
            before: [...before.tagIds].sort(),
            after: [...after.tagIds].sort(),
          },
        }
      : {}),
    ...(before.structure !== after.structure
      ? { structure: { before: before.structure, after: after.structure } }
      : {}),
  };
}

function isPlannable(rule: PlannableRule): RuleSkipReason | null {
  if (!rule.enabled) return "disabled";
  const problems = validateRuleDefinition({
    condition: rule.condition,
    actions: rule.actions,
  });
  return problems.length > 0 ? "invalid" : null;
}

/**
 * INV-RULE-004: a rule with a window is evaluated only for a row whose
 * calendar date is known and inside it, inclusive at both ends. Dates compare
 * as `YYYY-MM-DD` strings. A rule without a window is always inside.
 */
function isOutsideActiveWindow(rule: PlannableRule, facts: RuleFacts): boolean {
  const from = rule.activeFrom ?? null;
  const to = rule.activeTo ?? null;
  if (from === null && to === null) return false;
  if (facts.date === null) return true;
  return (
    (from !== null && facts.date < from) || (to !== null && facts.date > to)
  );
}

function netChanges(first: WorkingState, last: WorkingState): RuleNetChanges {
  return {
    ...(first.categoryId !== last.categoryId
      ? { categoryId: last.categoryId }
      : {}),
    ...(last.payeeCreate !== null
      ? { createPayee: last.payeeCreate, payeeName: last.payeeCreate }
      : first.payeeId !== last.payeeId
        ? {
            payeeId: last.payeeId,
            ...(last.payeeName !== null ? { payeeName: last.payeeName } : {}),
          }
        : {}),
    ...((first.description ?? null) !== (last.description ?? null)
      ? { description: last.description }
      : {}),
    ...(last.structure !== null && last.structure !== first.structure
      ? { structure: last.structure }
      : {}),
    addTagIds: last.tagIds.filter((id) => !first.tagIds.includes(id)),
    removeTagIds: first.tagIds.filter((id) => !last.tagIds.includes(id)),
  };
}

/**
 * Plan what the rules would do to one row. Pure: no query, no clock. `rules`
 * are in `position` order; a disabled or invalid rule is traced and skipped;
 * a later rule sees the facts an earlier rule changed (sequential, one pass,
 * design 3.5); a matched rule with `stopProcessing` ends the pass. A refused
 * action is skipped with its reason and the rest of the rule still runs.
 *
 * `request_ai_review` is collected into `aiReviewRequests` and is never a
 * ledger change. The preview, the test panel and the commit all call this one
 * function (INV-RULE-003 / design I3).
 */
export function planRuleEffects(
  facts: RuleFacts,
  rules: readonly PlannableRule[],
  context: RulePlanContext = {},
): RuleEffects {
  const initial: WorkingState = {
    categoryId: facts.categoryId,
    categoryAncestorIds: facts.categoryAncestorIds,
    payeeId: facts.payeeId,
    payeeName: context.payeeName ?? null,
    payeeCreate: null,
    description: facts.description,
    tagIds: facts.tagIds,
    isTransfer: facts.type === "TRANSFER",
    hasSplits: facts.hasSplits,
    structure: null,
  };
  let state = initial;
  const trace: RuleTraceEntry[] = [];
  const aiReviewRequests: AiReviewRequest[] = [];
  const lookups: string[] = [];

  for (const rule of rules) {
    const notRun =
      isPlannable(rule) ??
      (isOutsideActiveWindow(rule, facts) ? "outside_active_window" : null);
    if (notRun !== null) {
      trace.push({
        ruleId: rule.id,
        matched: false,
        skippedRule: notRun,
        applied: [],
        skipped: [],
        changes: NO_CHANGES,
        stopped: false,
      });
      continue;
    }
    const match = evaluateRuleConditionWithCaptures(
      rule.condition,
      withState(facts, state),
    );
    if (!match.matched) {
      trace.push({
        ruleId: rule.id,
        matched: false,
        applied: [],
        skipped: [],
        changes: NO_CHANGES,
        stopped: false,
      });
      continue;
    }

    const before = state;
    const applied: RuleAppliedAction[] = [];
    const skipped: RuleSkippedAction[] = [];
    for (const action of rule.actions) {
      if (!isLedgerAction(action)) {
        aiReviewRequests.push({
          ruleId: rule.id,
          instruction: action.instruction,
        });
        continue;
      }
      const result = step(state, action, {
        facts: withState(facts, state),
        context,
        captures: match.captures,
        lookups,
      });
      state = result.state;
      if (result.applied) applied.push(result.applied);
      if (result.skipped) skipped.push(result.skipped);
    }
    trace.push({
      ruleId: rule.id,
      matched: true,
      applied,
      skipped,
      changes: diffState(before, state),
      stopped: rule.stopProcessing,
    });
    if (rule.stopProcessing) break;
  }

  // Only the final effect decides which payee is created: a creation a later
  // rule replaced (an existing payee, or another created name) never happens,
  // so `payeeCreated` stays only on the entries that planned the final name.
  const finalKey =
    state.payeeCreate === null ? null : payeeLookupKey(state.payeeCreate);
  const finalTrace = trace.map((entry) => {
    if (!entry.changes.payeeCreated) return entry;
    const planned = entry.changes.payeeName?.after ?? null;
    if (
      finalKey !== null &&
      planned !== null &&
      payeeLookupKey(planned) === finalKey
    ) {
      return entry;
    }
    const { payeeCreated: _planned, ...changes } = entry.changes;
    return { ...entry, changes };
  });

  return {
    changes: netChanges(initial, state),
    trace: finalTrace,
    aiReviewRequests,
    ...(lookups.length > 0 ? { payeeLookups: [...new Set(lookups)] } : {}),
  };
}

/**
 * A collected `request_ai_review` is queued by the commit (`enqueue` in the
 * caller's transaction), so the trace says "queued" on the rule that asked. The
 * applier and the preview both pass the plan through this, so the two show the
 * same trace. The commit then calls `recordAiReviewAlreadyQueued` for the
 * requests the queue's dedupe skipped.
 */
export function recordAiReviewQueued(effects: RuleEffects): RuleEffects {
  return withAiReviewOutcome(effects, null, "queued");
}

/** Relabel the trace of the rules whose request was already open as "already_queued". */
export function recordAiReviewAlreadyQueued(
  effects: RuleEffects,
  ruleIds: ReadonlySet<string>,
): RuleEffects {
  return withAiReviewOutcome(effects, ruleIds, "already_queued");
}

function withAiReviewOutcome(
  effects: RuleEffects,
  onlyRuleIds: ReadonlySet<string> | null,
  outcome: AiReviewOutcome,
): RuleEffects {
  const asked = new Set(
    effects.aiReviewRequests
      .map((r) => r.ruleId)
      .filter((id) => onlyRuleIds === null || onlyRuleIds.has(id)),
  );
  if (asked.size === 0) return effects;
  return {
    ...effects,
    trace: effects.trace.map((entry) => {
      if (!asked.has(entry.ruleId)) return entry;
      const others = entry.applied.filter(
        (a) => a.type !== "request_ai_review",
      );
      return {
        ...entry,
        applied: [...others, { type: "request_ai_review" as const, outcome }],
      };
    }),
  };
}

/** True when the plan changes the row or asks for anything. */
export function hasRuleEffects(effects: RuleEffects): boolean {
  const { changes } = effects;
  return (
    changes.categoryId !== undefined ||
    changes.payeeId !== undefined ||
    changes.structure !== undefined ||
    changes.addTagIds.length > 0 ||
    changes.removeTagIds.length > 0 ||
    effects.aiReviewRequests.length > 0 ||
    effects.trace.some((entry) => entry.matched)
  );
}
