import {
  assertRuleAccrualWrite,
  assertAutomaticRuleSources,
} from "./rule-accrual";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";
import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { ArrayContains, EntityManager, In } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { PayeesService } from "../payees/payees.service";
import { AccountsService } from "../accounts/accounts.service";
import { convertRowToTransfer } from "../transactions/convert-to-transfer";
import { CreateTransactionSplitDto } from "../transactions/dto/create-transaction-split.dto";
import { TransactionSplitService } from "../transactions/transaction-split.service";
import { Tag } from "../tags/entities/tag.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { ensureYMD } from "../common/recurrence";
import {
  ClaimedLoanOccurrence,
  claimLoanOccurrence,
} from "../loan-installments/claim-loan-occurrence";
import { AiReviewRequestsService } from "../ai-review/ai-review-requests.service";
import {
  AiReviewRequest,
  OPEN_AI_REVIEW_STATUSES,
} from "../ai-review/ai-review-request.entity";
import { TagsService } from "../tags/tags.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import {
  PayeeResolution,
  PayeeResolutions,
  PlannableRule,
  RuleEffects,
  RulePlanContext,
  RuleTraceEntry,
  hasRuleEffects,
  payeeLookupKey,
  planRuleEffects,
  recordAiReviewAlreadyQueued,
  recordAiReviewQueued,
} from "./rule-effects";
import {
  RuleFactsInput,
  buildRuleFacts,
  loadCategoryChains,
} from "./rule-facts";
import { RuleStructurePlan, SplitStructurePlan } from "./rule-structure";
import { loadRuleTargetAccounts } from "./rule-target-accounts";
import {
  LoanFactsSource,
  answerLoanFactsLookups,
  newLoanFactsSource,
} from "./rule-loan-facts";
import { RuleFacts } from "./rule-condition.types";
import { loadRuleLabels, mergeRuleLabels } from "./rule-labels";
import {
  ListedRule,
  RuleRowExplanation,
  assembleExplainedRules,
  explainedIds,
} from "./rule-row-explain";
import { toRuleResponses } from "./transaction-rule-view";
import {
  RuleApplicationSource,
  TransactionRuleApplication,
} from "./transaction-rule-application.entity";
import { TransactionRule } from "./transaction-rule.entity";
import { RuleTrigger } from "./rule-trigger.types";

/** What the applier changed on one row. */
export interface AppliedRuleRow {
  readonly transactionId: string;
  readonly effects: RuleEffects;
  /**
   * The accounts whose balance a structural action moved (the target of a
   * conversion, the transfer parts of a split). Empty for every other rule.
   * The caller dispatches the net-worth recompute for them after its commit
   * (INV-CACHE-001); the applier never does.
   */
  readonly affectedAccountIds: readonly string[];
  /**
   * The scheduled payments a `settle_loan_installment` claimed an occurrence
   * of (at most one per row). The caller reprices each one's template
   * (`rewriteLoanTemplate`) after its commit, never inside the transaction
   * (INV-CACHE-001, `docs/specs/loan-installment-settlement.md` section 12.8).
   */
  readonly settledScheduleIds: readonly string[];
}

/** The two stored legs of a transfer just written, and who owns each. */
export interface NewTransferLegs {
  readonly fromLegId: string;
  readonly toLegId: string;
  readonly fromOwnerId: string;
  readonly toOwnerId: string;
}

export interface ApplyToNewOptions {
  /** Rules already loaded for this call (an import loads them once per file). */
  readonly rules?: readonly TransactionRule[];
  /**
   * The raw payee text per transaction id, when the source has it. A row not
   * named here falls back to its stored `payee_name`.
   */
  readonly payeeTextById?: ReadonlyMap<string, string | null>;
  /**
   * The rows were written by an actor who is not the owner (a joint-account member, or a delegate acting as the owner):
   * structural actions are skipped (`structural_not_allowed_for_actor`).
   */
  readonly structuralNotAllowed?: boolean;
  /**
   * The rows are a bill `post()` just created. Set by that path only, never
   * from a request: a `settle_loan_installment` refuses them
   * (`row_from_scheduled_posting`), because the occurrence they pay is the
   * one `post()` claimed.
   */
  readonly fromScheduledPosting?: boolean;
}

/**
 * Names for the ids in a preview, so a confirmation card shows a category, a
 * payee, a tag and a rule by name and never an id.
 */
export interface RuleEffectsLabels {
  /** Account names of the targets a structural action's plan names. */
  readonly accounts: Readonly<Record<string, string>>;
  readonly categories: Readonly<Record<string, string>>;
  readonly payees: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly rules: Readonly<Record<string, string>>;
}

/** The plan a preview returns: exactly what the commit will write, plus names. */
export interface RuleEffectsPreview extends RuleEffects {
  readonly labels: RuleEffectsLabels;
}

/**
 * The facts of a row that is not stored yet (the preview) or just stored.
 * `payeeName` is the name stored on the row, for the trace of a payee change
 * only; no condition reads it (`payeeText` is the fact).
 */
export type RuleRowInput = Omit<RuleFactsInput, "categoryAncestorIds"> & {
  readonly payeeName?: string | null;
};

/** What the planner may be told besides the row: the transfer's owner and who wants to watch the evaluation. */
export type RulePlanOptions = PlanRowContext;

/**
 * The columns of a row that a rule's facts are built from, as the row stores
 * them. `amount` is what the column holds: a number, or the decimal string the
 * driver returns for a `decimal(20,4)`. A row not stored yet may not know its
 * amount or date (null): the facts then treat each as unknown.
 */
export type StoredRuleRow = Pick<
  Transaction,
  | "accountId"
  | "currencyCode"
  | "payeeId"
  | "payeeName"
  | "categoryId"
  | "description"
  | "isSplit"
  | "isTransfer"
  | "referenceNumber"
  | "status"
> & {
  readonly amount: number | string | null;
  readonly transactionDate: string | null;
};

/** What the caller knows about a stored row beyond its columns. */
export interface StoredRuleRowExtras {
  readonly tagIds: readonly string[];
  /** The raw payee text of the source; the stored `payeeName` when the source has none. */
  readonly payeeText: string | null;
  readonly fromAccountId?: string | null;
  readonly toAccountId?: string | null;
}

/**
 * The input the rules are planned over for a row as it is stored. The one
 * builder: the writer's `applyToNew` reads each stored row through it, and the
 * import preview builds the row it would store and reads it through the same
 * function, so the two cannot hand the rules different facts.
 */
export function ruleRowInputFromStored(
  row: StoredRuleRow,
  extras: StoredRuleRowExtras,
): RuleRowInput {
  return {
    accountId: row.accountId,
    currencyCode: row.currencyCode,
    amount: row.amount,
    isTransfer: row.isTransfer,
    fromAccountId: extras.fromAccountId ?? null,
    toAccountId: extras.toAccountId ?? null,
    payeeId: row.payeeId,
    payeeText: extras.payeeText,
    payeeName: row.payeeName,
    categoryId: row.categoryId,
    description: row.description,
    tagIds: extras.tagIds,
    hasSplits: row.isSplit,
    ...storedRowFacts(row),
  };
}

/**
 * The X3 facts of a row this applier has just been handed: reference number,
 * date and status from the stored row. A row written in this transaction has
 * no attachment yet (nothing can attach to a row before it exists), so
 * `hasAttachment` is false, the same answer the preview gives for a row that
 * is not stored.
 */
function storedRowFacts(
  row: Pick<Transaction, "referenceNumber" | "status"> & {
    readonly transactionDate: string | null;
  },
): Pick<
  RuleFactsInput,
  "referenceNumber" | "transactionDate" | "status" | "hasAttachment"
> {
  return {
    referenceNumber: row.referenceNumber,
    transactionDate: row.transactionDate,
    status: row.status,
    hasAttachment: false,
  };
}

/**
 * What a caller knows about the row besides its facts: transfer ownership, the
 * target accounts, the row's id, the loan facts and the settlements planned
 * earlier in the pass, and who wants to watch the evaluation.
 */
export type PlanRowContext = Pick<
  RulePlanContext,
  | "crossOwnerTransferLeg"
  | "accounts"
  | "structuralNotAllowed"
  | "onEvaluate"
  | "transactionId"
  | "fromScheduledPosting"
  | "loanFacts"
  | "priorSettlements"
>;

/** Payee lookups made while planning; share one across the rows of a call. */
export type PayeeLookupCache = Map<string, PayeeResolution | null>;

/**
 * Planning rounds for payee lookups. Each round looks up the names the last
 * plan needed and plans again; a rule list needs one or two.
 */
const MAX_PAYEE_LOOKUP_ROUNDS = 12;

/**
 * Planning rounds for loan facts. The loader answers a loan's schedule, slots,
 * claims and slot debts in one read, so a row needs one round; a second widens
 * a read whose window did not cover the row, and the bound stops a plan that
 * keeps asking.
 */
export const MAX_LOAN_FACTS_ROUNDS = 3;

/**
 * The rows of one `applyToNew` call oldest first: by date, then by the order
 * they were written (`created_at`, which an import spaces by file position),
 * then by id so two rows written in one statement order the same way twice.
 * A settlement written for an earlier row is in the ledger when the next row
 * plans, so the fold runs forward through time whatever order the caller
 * listed the ids in (INV-RULE-005). The same three legs, as a query, are
 * `applyRegisterOrder(..., "ASC")`.
 */
function chronological(rows: readonly Transaction[]): Transaction[] {
  const writtenAt = (row: Transaction): number =>
    row.createdAt instanceof Date ? row.createdAt.getTime() : 0;
  return [...rows].sort(
    (a, b) =>
      (a.transactionDate < b.transactionDate
        ? -1
        : a.transactionDate > b.transactionDate
          ? 1
          : 0) ||
      writtenAt(a) - writtenAt(b) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Applies a user's transaction rules to rows in the caller's transaction
 * (design 6.3). It never opens its own transaction: every read and write goes
 * through the `EntityManager` it is handed, so a rollback of the insert rolls
 * back the rule effects (INV-RULE-002). It changes only category, payee and
 * tags -- never amount, account, date, status or a link (INV-RULE-001). A
 * `request_ai_review` action is queued through the same manager
 * (`queueAiReviews`), so it is written or dropped with the row that asked.
 */
@Injectable()
export class TransactionRulesApplierService {
  constructor(
    private readonly tagsService: TagsService,
    private readonly aiReviewRequests: AiReviewRequestsService,
    // forwardRef: PayeesModule reaches this module back through TransactionsModule.
    @Inject(forwardRef(() => PayeesService))
    private readonly payeesService: PayeesService,
    // forwardRef: the transactions module reaches this one (create's rules step).
    @Inject(forwardRef(() => AccountsService))
    private readonly accountsService: AccountsService,
    @Inject(forwardRef(() => TransactionSplitService))
    private readonly splitService: TransactionSplitService,
  ) {}

  /**
   * The user's enabled rules for a trigger, in `position` order, without the
   * ones that no longer validate or name an id that is gone (the trace of such
   * a rule would only say "invalid").
   */
  async loadRulesFor(
    m: EntityManager,
    userId: string,
    trigger: RuleTrigger,
  ): Promise<TransactionRule[]> {
    const rules = await m.getRepository(TransactionRule).find({
      where: { userId, enabled: true, triggers: ArrayContains([trigger]) },
      order: { position: "ASC" },
    });
    if (rules.length === 0) return [];
    const invalid = await this.invalidRuleIds(m, userId, rules);
    return rules.filter((rule) => !invalid.has(rule.id));
  }

  /** The ids among `rules` whose definition no longer validates or names an id that is gone. */
  private async invalidRuleIds(
    m: EntityManager,
    userId: string,
    rules: readonly TransactionRule[],
  ): Promise<Set<string>> {
    const views = await toRuleResponses(m, userId, rules);
    return new Set(views.filter((v) => v.invalid).map((v) => v.id));
  }

  /**
   * Plan one row that is not (or not yet) stored. The one planning path: the
   * preview calls it directly and `applyToNew` calls it per stored row, so a
   * preview shows what the commit writes (design I3).
   */
  async planForRow(
    m: EntityManager,
    userId: string,
    input: RuleRowInput,
    rules: readonly TransactionRule[],
    context: PlanRowContext = {},
  ): Promise<RuleEffects> {
    if (rules.length === 0) return planRuleEffects(buildRuleFacts(input), []);
    const chains = await this.chainsFor(m, userId, rules, [input.categoryId]);
    const accounts = await loadRuleTargetAccounts(m, userId, rules);
    return this.planResolved(
      userId,
      input,
      rules,
      chains,
      { ...context, accounts },
      new Map(),
      // A plan for a row that may never be written reads unlocked.
      newLoanFactsSource(m, userId, {
        dates: [input.transactionDate],
        lock: false,
      }),
    );
  }

  /**
   * `planWithChains` with the payee lookups the plan asks for: a
   * `set_payee_from_text` renders its name from the rule's captures, so the
   * name is known only while planning. The names the plan reports are looked
   * up through the payee service's `resolveByName` (exact name, alias, unique
   * normalized match) and the plan runs again, until it needs no more. The
   * preview never creates a payee; a name nobody has stays a
   * `payeeCreated` note on the plan. `cache` is shared by the rows of one
   * call so a batch looks each name up once.
   *
   * A `settle_loan_installment` asks for its loan's facts the same way
   * (`loanFactsLookups`): `loans` reads them in the caller's transaction and
   * keeps them for the rows of the call, by loan account id. Without a source
   * the plan uses `context.loanFacts` as it is.
   */
  async planResolved(
    userId: string,
    input: RuleRowInput,
    rules: readonly PlannableRule[],
    chains: ReadonlyMap<string, readonly string[]>,
    context: PlanRowContext,
    cache: PayeeLookupCache = new Map(),
    loans?: LoanFactsSource,
  ): Promise<RuleEffects> {
    const withLoans: PlanRowContext =
      loans === undefined ? context : { ...context, loanFacts: loans.entries };
    const plan = () =>
      this.planWithChains(input, rules, chains, withLoans, cache);
    let effects = plan();
    let payeeRounds = 0;
    let loanRounds = 0;
    for (;;) {
      let answered = false;
      if (
        payeeRounds < MAX_PAYEE_LOOKUP_ROUNDS &&
        effects.payeeLookups !== undefined
      ) {
        const missing = effects.payeeLookups.filter(
          (name) => !cache.has(payeeLookupKey(name)),
        );
        for (const name of missing) {
          cache.set(payeeLookupKey(name), await this.lookUpPayee(userId, name));
        }
        if (missing.length > 0) {
          payeeRounds += 1;
          answered = true;
        }
      }
      if (
        loans !== undefined &&
        loanRounds < MAX_LOAN_FACTS_ROUNDS &&
        effects.loanFactsLookups !== undefined &&
        (await answerLoanFactsLookups(loans, effects.loanFactsLookups))
      ) {
        loanRounds += 1;
        answered = true;
      }
      if (!answered) return effects;
      effects = plan();
    }
  }

  private async lookUpPayee(
    userId: string,
    name: string,
  ): Promise<PayeeResolution | null> {
    const payee = await this.payeesService.resolveByName(userId, name);
    return payee === null ? null : { payeeId: payee.id, name: payee.name };
  }

  /**
   * The preview of a create: the plan for a row that is not stored, or null
   * when the user has no rule for the trigger or nothing matched. It loads the
   * rules and plans through `planForRow`, the same path `applyToNew` uses.
   */
  async previewForRow(
    m: EntityManager,
    userId: string,
    input: RuleRowInput,
    trigger: RuleTrigger = "create",
  ): Promise<RuleEffectsPreview | null> {
    const rules = await this.loadRulesFor(m, userId, trigger);
    if (rules.length === 0) return null;
    const effects = await this.planForRow(m, userId, input, rules);
    if (!hasRuleEffects(effects)) return null;
    return {
      ...effects,
      labels: await this.labelsFor(m, userId, effects, rules),
    };
  }

  /**
   * Why each of the user's rules for a trigger did or did not apply to one
   * row, in the order the rules run. Read-only: it writes nothing and queues
   * nothing.
   *
   * The effects are `planForRow`'s own, over the rules `loadRulesFor` would
   * return (enabled and valid), so what is explained is what the writer does.
   * Only the condition of each rule is added: the planner reports the facts it
   * evaluated each condition against (`onEvaluate`, the row as the rules
   * before it left it) and `explainRuleCondition` explains the tree over
   * exactly those. A disabled or invalid rule is listed with the reason it was
   * skipped; a rule after one that stopped the pass is listed as not
   * evaluated.
   */
  async explainRow(
    m: EntityManager,
    userId: string,
    input: RuleRowInput,
    trigger: RuleTrigger,
  ): Promise<RuleRowExplanation> {
    const stored = await m.getRepository(TransactionRule).find({
      where: { userId, triggers: ArrayContains([trigger]) },
      order: { position: "ASC" },
    });
    const invalid =
      stored.length === 0
        ? new Set<string>()
        : await this.invalidRuleIds(m, userId, stored);
    const usable = stored.filter(
      (rule) => rule.enabled && !invalid.has(rule.id),
    );

    // One pass over the rules is one run of the planner; a payee lookup the
    // plan asks for plans again, and the facts of the last pass are the ones
    // behind the trace it returned. A rule seen twice is a new pass.
    let observed = new Map<string, RuleFacts>();
    const effects = await this.planForRow(m, userId, input, usable, {
      onEvaluate: (ruleId, facts) => {
        if (observed.has(ruleId)) observed = new Map();
        observed.set(ruleId, facts);
      },
    });

    const listed: ListedRule[] = stored.map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      position: rule.position,
      condition: rule.condition,
      invalid: invalid.has(rule.id),
    }));
    const rules = assembleExplainedRules(listed, effects.trace, observed);

    // Names for the effects (`labelsFor`), and the qualified names of every id
    // a condition or an effect mentions; the qualified name wins.
    const effectLabels = await this.labelsFor(m, userId, effects, usable);
    const named = await loadRuleLabels(m, userId, explainedIds(rules));
    return {
      rules,
      labels: mergeRuleLabels(
        {
          accounts: {},
          payees: effectLabels.payees,
          categories: effectLabels.categories,
          tags: effectLabels.tags,
        },
        named,
      ),
    };
  }

  /** Names for the ids the effects and their traces mention (public: the manual run labels a whole batch). */
  async labelsFor(
    m: EntityManager,
    userId: string,
    effects: RuleEffects,
    rules: readonly (PlannableRule & { name?: string })[],
  ): Promise<RuleEffectsLabels> {
    const categoryIds = new Set<string>();
    const payeeIds = new Set<string>();
    const accountIds = new Set<string>();
    const tagIds = new Set<string>([
      ...effects.changes.addTagIds,
      ...effects.changes.removeTagIds,
    ]);
    const structures = [
      effects.changes.structure,
      ...effects.trace.map((entry) => entry.changes.structure?.after),
    ];
    for (const structure of structures) {
      if (!structure) continue;
      if (structure.kind === "transfer") accountIds.add(structure.accountId);
      else {
        for (const part of structure.parts) {
          if (part.categoryId) categoryIds.add(part.categoryId);
          if (part.transferAccountId) accountIds.add(part.transferAccountId);
          if (part.payeeId) payeeIds.add(part.payeeId);
        }
      }
    }
    for (const entry of effects.trace) {
      const { categoryId, payeeId, tagIds: tags } = entry.changes;
      for (const id of [categoryId?.before, categoryId?.after])
        if (id) categoryIds.add(id);
      for (const id of [payeeId?.before, payeeId?.after])
        if (id) payeeIds.add(id);
      for (const id of [...(tags?.before ?? []), ...(tags?.after ?? [])])
        tagIds.add(id);
    }
    const names = async (
      entity: typeof Account | typeof Category | typeof Payee | typeof Tag,
      ids: Set<string>,
    ): Promise<Record<string, string>> => {
      if (ids.size === 0) return {};
      const found = (await m.find(entity as typeof Category, {
        select: { id: true, name: true },
        where: { id: In([...ids]), userId },
      })) as Array<{ id: string; name: string }>;
      return Object.fromEntries(found.map((row) => [row.id, row.name]));
    };
    return {
      accounts: await names(Account, accountIds),
      categories: await names(Category, categoryIds),
      payees: await names(Payee, payeeIds),
      tags: await names(Tag, tagIds),
      rules: Object.fromEntries(
        rules
          .filter((rule) =>
            effects.trace.some((e) => e.ruleId === rule.id && e.matched),
          )
          .map((rule) => [rule.id, rule.name ?? rule.id]),
      ),
    };
  }

  /**
   * Apply the rules to rows just written in the caller's transaction. Returns
   * the rows a rule changed. Nothing is loaded or written when the user has no
   * rule for the trigger.
   */
  async applyToNew(
    m: EntityManager,
    userId: string,
    transactionIds: readonly string[],
    source: RuleApplicationSource,
    options: ApplyToNewOptions = {},
  ): Promise<AppliedRuleRow[]> {
    const ids = [...new Set(transactionIds)];
    if (ids.length === 0) return [];
    const rules =
      options.rules ??
      (await this.loadRulesFor(
        m,
        userId,
        source === "import" ? "import" : "create",
      ));
    if (rules.length === 0) return [];
    await assertAutomaticRuleSources(m, userId, ids);

    const rows = chronological(
      await m.find(Transaction, { where: { id: In(ids), userId } }),
    );
    const tagsByRow = await this.loadTagIds(m, ids);
    const chains = await this.chainsFor(
      m,
      userId,
      rules,
      rows.map((row) => row.categoryId),
    );

    const accounts = await loadRuleTargetAccounts(m, userId, rules);
    const applied: AppliedRuleRow[] = [];
    const lookups: PayeeLookupCache = new Map();
    // This path writes: the loan's facts are read under the schedule row and
    // account locks (spec section 13), so the claims and the debt each plan is
    // made from are the ones its write acts on.
    const loans = newLoanFactsSource(m, userId, {
      rowIds: rows.map((row) => row.id),
      dates: rows.map((row) => row.transactionDate),
      lock: true,
    });
    for (const row of rows) {
      const { input, context } = await this.inputFromRow(
        m,
        userId,
        row,
        tagsByRow.get(row.id) ?? [],
        options.payeeTextById,
      );
      const planned = await this.planResolved(
        userId,
        input,
        rules,
        chains,
        {
          ...context,
          accounts,
          ...(options.structuralNotAllowed
            ? { structuralNotAllowed: true }
            : {}),
          ...(options.fromScheduledPosting
            ? { fromScheduledPosting: true }
            : {}),
        },
        lookups,
        loans,
      );
      const affected = new Set<string>();
      const settled = new Set<string>();
      const effects = await this.writeEffects(
        m,
        userId,
        row.id,
        planned,
        source,
        affected,
        settled,
      );
      // A payee this row created answers the lookups of the rows after it.
      if (planned.changes.createPayee !== undefined) lookups.clear();
      // A settlement this row wrote is a claim and a counterpart leg the rows
      // after it must see: the loan's cached facts are dropped, so the next
      // row that asks reads the claims and the debts the write left (spec
      // section 7.2), rather than planning the same slot again on the debt
      // before it. A plan made on the stale facts would reach the claim's
      // backstop conflict, which throws.
      if (
        effects.changes.settlementClaim !== undefined &&
        effects.changes.loanSettlement !== undefined
      ) {
        loans.entries.delete(effects.changes.loanSettlement.loanAccountId);
      }
      applied.push({
        transactionId: row.id,
        effects,
        affectedAccountIds: [...affected],
        settledScheduleIds: [...settled],
      });
    }
    return this.queueAiReviews(m, userId, applied);
  }

  /**
   * Apply the `create` rules to the legs of a transfer just written in the
   * caller's transaction (design 6.3). One evaluation per transfer per owner:
   *
   * - Same owner: evaluated once over the outgoing leg's facts, and the
   *   result is written to BOTH legs (tags mirrored the way `syncTransferTags`
   *   does, the payee on both). `set_category` is refused by the planner.
   * - Cross owner: each owner's rules run on that owner's leg only, and the
   *   other owner's leg is never read or written. The partner account is not
   *   put in the facts, and `set_payee` is refused (`crossOwnerTransferLeg`).
   *
   * Nothing is written when the owner has no rule for the trigger.
   */
  async applyToNewTransfer(
    m: EntityManager,
    legs: NewTransferLegs,
  ): Promise<AppliedRuleRow[]> {
    const sameOwner = legs.fromOwnerId === legs.toOwnerId;
    const applied: AppliedRuleRow[] = [];
    const evaluations: Array<{ ownerId: string; legIds: string[] }> = sameOwner
      ? [{ ownerId: legs.fromOwnerId, legIds: [legs.fromLegId, legs.toLegId] }]
      : [
          { ownerId: legs.fromOwnerId, legIds: [legs.fromLegId] },
          { ownerId: legs.toOwnerId, legIds: [legs.toLegId] },
        ];
    for (const { ownerId, legIds } of evaluations) {
      const rules = await this.loadRulesFor(m, ownerId, "create");
      if (rules.length === 0) continue;
      const rows = await m.find(Transaction, {
        where: { id: In(legIds), userId: ownerId },
      });
      const from = rows.find((row) => row.id === legs.fromLegId);
      const to = rows.find((row) => row.id === legs.toLegId);
      const primary = from ?? to;
      if (!primary) continue;
      const tagIds = (await this.loadTagIds(m, [primary.id])).get(primary.id);
      const chains = await this.chainsFor(m, ownerId, rules, [
        primary.categoryId,
      ]);
      const planned = await this.planResolved(
        ownerId,
        {
          accountId: primary.accountId,
          currencyCode: primary.currencyCode,
          amount: primary.amount,
          isTransfer: true,
          fromAccountId: from?.accountId ?? null,
          toAccountId: to?.accountId ?? null,
          payeeId: primary.payeeId,
          payeeText: primary.payeeName,
          payeeName: primary.payeeName,
          categoryId: primary.categoryId,
          description: primary.description,
          tagIds: tagIds ?? [],
          hasSplits: primary.isSplit,
          ...storedRowFacts(primary),
        },
        rules,
        chains,
        {
          crossOwnerTransferLeg: !sameOwner,
          accounts: await loadRuleTargetAccounts(m, ownerId, rules),
        },
      );
      // A payee the rules create is created once, for both legs.
      const effects = await this.resolveCreatedPayee(m, ownerId, planned);
      // One review request per transfer, on the outgoing leg (`primary`).
      const [queued] = await this.queueAiReviews(m, ownerId, [
        {
          transactionId: primary.id,
          effects,
          affectedAccountIds: [],
          settledScheduleIds: [],
        },
      ]);
      // A structural action is always refused on a transfer leg (the planner
      // reports `row_is_transfer_leg`), so nothing here moves a balance.
      for (const row of rows) {
        await this.writeEffects(m, ownerId, row.id, effects, "create");
        applied.push({
          transactionId: row.id,
          effects: queued.effects,
          affectedAccountIds: [],
          settledScheduleIds: [],
        });
      }
    }
    return applied;
  }

  /**
   * Queue the `request_ai_review` actions the plans collected, in the caller's
   * transaction and through one `enqueue` (the queue's partial unique index
   * dedupes a request already open for the same row and rule). Returns the
   * rows with a trace that says "queued", or "already_queued" where the
   * dedupe skipped it. The manual run calls it on commit, never on preview.
   */
  async queueAiReviews(
    m: EntityManager,
    userId: string,
    rows: readonly AppliedRuleRow[],
  ): Promise<AppliedRuleRow[]> {
    const requests = rows.flatMap((row) =>
      row.effects.aiReviewRequests.map((request) => ({
        transactionId: row.transactionId,
        ruleId: request.ruleId,
        instruction: request.instruction,
      })),
    );
    if (requests.length === 0) return [...rows];
    const { alreadyQueued } = await this.aiReviewRequests.enqueue(
      m,
      userId,
      requests,
    );
    return rows.map((row) => {
      const skipped = new Set(
        alreadyQueued
          .filter((key) => key.transactionId === row.transactionId)
          .map((key) => key.ruleId)
          .filter((id): id is string => id !== null),
      );
      return skipped.size === 0
        ? row
        : {
            ...row,
            effects: recordAiReviewAlreadyQueued(row.effects, skipped),
          };
    });
  }

  /**
   * The transactions among `transactionIds` that already hold an open request
   * from `ruleId`: the rows `queueAiReviews` would skip (the enqueue's dedupe
   * covers exactly `OPEN_AI_REVIEW_STATUSES`), so a preview counts only the
   * requests a run would really add.
   */
  async openAiReviewTransactionIds(
    m: EntityManager,
    userId: string,
    ruleId: string,
    transactionIds: readonly string[],
  ): Promise<Set<string>> {
    if (transactionIds.length === 0) return new Set();
    const open = await m.getRepository(AiReviewRequest).find({
      select: { transactionId: true },
      where: {
        userId,
        ruleId,
        transactionId: In([...transactionIds]),
        status: In([...OPEN_AI_REVIEW_STATUSES]),
      },
    });
    return new Set(
      open
        .map((r) => r.transactionId)
        .filter((id): id is string => id !== null),
    );
  }

  planWithChains(
    input: RuleRowInput,
    rules: readonly PlannableRule[],
    chains: ReadonlyMap<string, readonly string[]>,
    context: PlanRowContext,
    payeeResolutions?: PayeeResolutions,
  ): RuleEffects {
    const facts = buildRuleFacts({
      ...input,
      categoryAncestorIds:
        input.categoryId === null ? [] : chains.get(input.categoryId),
    });
    return recordAiReviewQueued(
      planRuleEffects(facts, rules, {
        ...context,
        categoryChains: chains,
        // A row not stored yet (the preview) has no stored name; the text the
        // create will store is the payee text, so the trace agrees with the commit.
        payeeName:
          input.payeeName !== undefined ? input.payeeName : input.payeeText,
        payeeResolutions,
      }),
    );
  }

  /** One query for the chains of the rows' categories and of every category a rule sets. */
  chainsFor(
    m: EntityManager,
    userId: string,
    rules: readonly PlannableRule[],
    rowCategoryIds: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const wanted = new Set<string>();
    for (const id of rowCategoryIds) if (id) wanted.add(id);
    for (const rule of rules) {
      for (const action of rule.actions) {
        if (action.type === "set_category") wanted.add(action.categoryId);
      }
    }
    return loadCategoryChains(m, userId, [...wanted]);
  }

  async loadTagIds(
    m: EntityManager,
    transactionIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const links = await m.find(TransactionTag, {
      where: { transactionId: In([...transactionIds]) },
    });
    const byRow = new Map<string, string[]>();
    for (const link of links) {
      byRow.set(link.transactionId, [
        ...(byRow.get(link.transactionId) ?? []),
        link.tagId,
      ]);
    }
    return byRow;
  }

  /**
   * The facts input of a stored row. A transfer leg also needs the other
   * leg's account to say which way the money went; a partner leg the caller's
   * scope cannot read is another owner's, and the row is then treated as a
   * cross-owner leg (the safe side: `set_payee` is refused).
   */
  private async inputFromRow(
    m: EntityManager,
    userId: string,
    row: Transaction,
    tagIds: readonly string[],
    payeeTextById: ReadonlyMap<string, string | null> | undefined,
  ): Promise<{
    input: RuleRowInput;
    context: PlanRowContext;
  }> {
    let fromAccountId: string | null = null;
    let toAccountId: string | null = null;
    let crossOwnerTransferLeg = false;
    if (row.isTransfer) {
      const partner = row.linkedTransactionId
        ? await m.findOne(Transaction, {
            where: { id: row.linkedTransactionId, userId },
          })
        : null;
      crossOwnerTransferLeg = partner === null;
      const outgoing = Number(row.amount) < 0;
      fromAccountId = outgoing ? row.accountId : (partner?.accountId ?? null);
      toAccountId = outgoing ? (partner?.accountId ?? null) : row.accountId;
    }
    return {
      input: ruleRowInputFromStored(row, {
        tagIds,
        payeeText: payeeTextById?.has(row.id)
          ? (payeeTextById.get(row.id) ?? null)
          : row.payeeName,
        fromAccountId,
        toAccountId,
      }),
      context: { crossOwnerTransferLeg, transactionId: row.id },
    };
  }

  /**
   * Turn a payee the plan wants created into an id, in the caller's
   * transaction: the payee service's `resolveByName` again (the plan was made
   * before this write), then its `findOrCreate` when still nobody has the
   * name. Returns the effects with `payeeId` / `payeeName` in place of
   * `createPayee`, and the trace carrying the payee's id; a plan that creates
   * nothing is returned as it is. A payee is reference data: the undo of a
   * manual run does not delete it.
   */
  async resolveCreatedPayee(
    m: EntityManager,
    userId: string,
    effects: RuleEffects,
  ): Promise<RuleEffects> {
    const name = effects.changes.createPayee;
    if (name === undefined) return effects;
    const existing = await this.payeesService.resolveByName(userId, name);
    const payee =
      existing ?? (await this.payeesService.findOrCreate(userId, name));
    const created = existing === null;
    // Only the last rule that asked for the creation owns its outcome.
    const lastAsking = effects.trace.reduce(
      (found, entry, i) => (entry.changes.payeeCreated ? i : found),
      -1,
    );
    const trace: RuleTraceEntry[] = effects.trace.map((entry, i) => {
      if (!entry.changes.payeeCreated) return entry;
      const { payeeCreated: _asked, ...rest } = entry.changes;
      if (i !== lastAsking) return { ...entry, changes: rest };
      return {
        ...entry,
        changes: {
          ...rest,
          payeeId: { before: rest.payeeId?.before ?? null, after: payee.id },
          payeeName: {
            before: rest.payeeName?.before ?? null,
            after: payee.name,
          },
          ...(created ? { payeeCreated: true } : {}),
        },
      };
    });
    const { createPayee: _create, ...rest } = effects.changes;
    return {
      ...effects,
      changes: { ...rest, payeeId: payee.id, payeeName: payee.name },
      trace,
    };
  }

  /**
   * Category, payee and description through the manager's parameterized
   * UPDATE, tags through TagsService, then the structure a structural action
   * planned (a transfer counterpart or split lines, on the row as the patch
   * left it), then, for a `settle_loan_installment`, the occurrence claim the
   * split accounts for (`claimLoanOccurrence`: the claim, and the cursor
   * advance when the slot is the bill's next due date), one trace row per
   * rule. Returns the effects as written: a payee the rules created now has
   * its id, the structure carries the ids of the counterpart legs it created,
   * and a settlement carries its claim (`settlementClaim`).
   *
   * `affectedAccountIds` collects the accounts a structural write moved, and
   * `settledScheduleIds` the schedules a settlement claimed on, for the caller
   * to invalidate and reprice after its commit (INV-CACHE-001); nothing is
   * recalculated or triggered in here. The claim's conflict is the one throw
   * on this path (`docs/specs/loan-installment-settlement.md` decision 17):
   * the planner refuses a taken slot before any write from the claims read
   * under the locks, so the conflict is the database's backstop against a
   * plan made on stale facts, and the caller's transaction rolls back.
   */
  async writeEffects(
    m: EntityManager,
    userId: string,
    transactionId: string,
    planned: RuleEffects,
    source: RuleApplicationSource,
    affectedAccountIds?: Set<string>,
    settledScheduleIds?: Set<string>,
  ): Promise<RuleEffects> {
    const refreshAccrual = await assertRuleAccrualWrite(
      m,
      userId,
      transactionId,
      planned,
      source,
    );
    const resolved = await this.resolveCreatedPayee(m, userId, planned);
    const { changes } = resolved;
    const patch: Partial<
      Pick<Transaction, "categoryId" | "payeeId" | "payeeName" | "description">
    > = {
      ...(changes.categoryId !== undefined
        ? { categoryId: changes.categoryId }
        : {}),
      ...(changes.description !== undefined
        ? { description: changes.description }
        : {}),
    };
    if (changes.payeeId !== undefined) {
      const payee =
        changes.payeeId === null
          ? null
          : changes.payeeName !== undefined
            ? { name: changes.payeeName }
            : await m.findOne(Payee, {
                where: { id: changes.payeeId, userId },
              });
      Object.assign(patch, {
        payeeId: changes.payeeId,
        payeeName: payee?.name ?? null,
      });
    }
    if (Object.keys(patch).length > 0) {
      await m.update(Transaction, { id: transactionId, userId }, patch);
    }
    if (changes.addTagIds.length > 0) {
      await this.tagsService.addTransactionTags(
        m,
        userId,
        [transactionId],
        changes.addTagIds,
      );
    }
    if (changes.removeTagIds.length > 0) {
      await this.tagsService.removeTransactionTags(
        m,
        userId,
        [transactionId],
        changes.removeTagIds,
      );
    }
    let effects = resolved;
    if (changes.structure !== undefined) {
      const written = await this.writeStructure(
        m,
        userId,
        transactionId,
        changes.structure,
      );
      for (const id of written.affectedAccountIds) affectedAccountIds?.add(id);
      effects = withWrittenStructure(resolved, written.structure);
      if (changes.loanSettlement !== undefined) {
        // Only one rule can restructure a row (a later one sees the split),
        // so the one entry carrying the settlement is the planning rule.
        const planner = effects.trace.find(
          (entry) => entry.changes.loanSettlement !== undefined,
        );
        if (planner === undefined || written.rowDate === undefined) {
          throw new Error(
            `writeEffects: settlement of ${transactionId} has no planning rule or no split row`,
          );
        }
        const claim = await claimLoanOccurrence(m, userId, {
          plan: changes.loanSettlement,
          transactionId,
          ruleId: planner.ruleId,
          postedDate: written.rowDate,
        });
        settledScheduleIds?.add(claim.scheduledTransactionId);
        effects = withWrittenClaim(effects, claim);
      }
    }
    const traceRows = effects.trace
      .filter((entry) => Object.keys(entry.changes).length > 0)
      .map((entry) => ({
        userId,
        ruleId: entry.ruleId,
        transactionId,
        source,
        changes: { ...entry.changes },
      }));
    if (traceRows.length > 0) {
      await m.insert(TransactionRuleApplication, traceRows);
    }
    if (refreshAccrual) await refreshSourceAccruals(m, userId, transactionId);
    return effects;
  }

  /**
   * Write the planned structure on the row as it stands (the field patch is
   * already in): a transfer counterpart through `convertRowToTransfer`, or the
   * split lines through the split service's `validateSplits` / `createSplits`
   * (the path `PUT /transactions/:id/splits` uses), joined to the caller's
   * transaction. Same-currency only (the planner refuses the rest), so no
   * provider is called. Returns the structure with the counterpart ids and the
   * accounts whose balance moved.
   */
  private async writeStructure(
    m: EntityManager,
    userId: string,
    transactionId: string,
    structure: RuleStructurePlan,
  ): Promise<{
    structure: RuleStructurePlan;
    affectedAccountIds: readonly string[];
    /** The row's date as a split read it; a settlement's claim is posted on it. */
    rowDate?: string;
  }> {
    if (structure.kind === "transfer") {
      const result = await convertRowToTransfer(
        m,
        this.accountsService,
        userId,
        transactionId,
        structure.accountId,
        {
          clearCategory: structure.clearCategory,
          expectedCounterpartAmount: structure.amount,
        },
      );
      return {
        structure: { ...structure, counterpartIds: [result.counterpartId] },
        affectedAccountIds: result.affectedAccountIds,
      };
    }
    return this.writeSplit(m, userId, transactionId, structure);
  }

  private async writeSplit(
    m: EntityManager,
    userId: string,
    transactionId: string,
    structure: SplitStructurePlan,
  ): Promise<{
    structure: RuleStructurePlan;
    affectedAccountIds: readonly string[];
    rowDate: string;
  }> {
    const row = await m.findOne(Transaction, {
      where: { id: transactionId, userId },
    });
    if (!row) {
      throw new Error(`Transaction ${transactionId} vanished mid-write`);
    }
    const parts: CreateTransactionSplitDto[] = structure.parts.map((part) => ({
      amount: part.amount,
      ...(part.categoryId !== null ? { categoryId: part.categoryId } : {}),
      ...(part.transferAccountId !== null
        ? { transferAccountId: part.transferAccountId }
        : {}),
      ...(part.memo !== null ? { memo: part.memo } : {}),
    }));
    this.splitService.validateSplits(parts, Number(row.amount));
    const affected = new Set<string>();
    const created = await this.splitService.createSplits(
      row.id,
      parts,
      userId,
      row.accountId,
      new Date(row.transactionDate),
      row.payeeName,
      row.payeeId,
      { parentStatus: row.status },
      affected,
    );
    await m.update(
      Transaction,
      { id: row.id, userId },
      { isSplit: true, categoryId: null },
    );

    // A transfer part's payee is the payee of its counterpart leg (a split
    // line has no payee column of its own).
    const counterpartIds: string[] = [];
    const wantedPayees = new Set(
      structure.parts
        .map((part) => part.payeeId)
        .filter((id): id is string => id !== null),
    );
    const payees =
      wantedPayees.size === 0
        ? []
        : await m.find(Payee, {
            where: { id: In([...wantedPayees]), userId },
            select: { id: true, name: true },
          });
    const payeeNames = new Map(payees.map((payee) => [payee.id, payee.name]));
    for (const [i, part] of structure.parts.entries()) {
      if (part.transferAccountId === null) continue;
      const counterpartId = created[i]?.linkedTransactionId;
      if (!counterpartId) continue;
      counterpartIds.push(counterpartId);
      const name =
        part.payeeId === null ? undefined : payeeNames.get(part.payeeId);
      if (part.payeeId !== null && name !== undefined) {
        await m.update(
          Transaction,
          { id: counterpartId, userId },
          { payeeId: part.payeeId, payeeName: name },
        );
      }
    }
    return {
      structure: {
        ...structure,
        counterpartIds,
        lineIds: created.map((line) => line.id),
      },
      affectedAccountIds: [...affected],
      rowDate: ensureYMD(row.transactionDate),
    };
  }
}

/**
 * The effects with the claim a settlement wrote: on the net changes
 * (`settlementClaim`, for the run snapshot) and on the trace entry that
 * planned the settlement (`claimId`, `cursorAdvanced` and the cursor before
 * and after, for the stored application row; spec section 12.2). The
 * planned fields of the entry are unchanged, so the fingerprint of a stored
 * trace is the plan's.
 */
function withWrittenClaim(
  effects: RuleEffects,
  claim: ClaimedLoanOccurrence,
): RuleEffects {
  return {
    ...effects,
    changes: { ...effects.changes, settlementClaim: claim },
    trace: effects.trace.map((entry) => {
      const planned = entry.changes.loanSettlement;
      if (planned === undefined || planned.after === null) return entry;
      return {
        ...entry,
        changes: {
          ...entry.changes,
          loanSettlement: {
            before: planned.before,
            after: {
              ...planned.after,
              claimId: claim.claimId,
              cursorAdvanced: claim.cursorAdvanced,
              ...(claim.cursor !== undefined
                ? {
                    cursor: {
                      before: claim.cursor.before,
                      after: claim.cursor.after,
                    },
                  }
                : {}),
            },
          },
        },
      };
    }),
  };
}

/**
 * The effects with the written structure (it carries the counterpart ids) in
 * place of the planned one, in the net changes and in the trace entry that
 * planned it, so the stored application row shows what was created.
 */
function withWrittenStructure(
  effects: RuleEffects,
  written: RuleStructurePlan,
): RuleEffects {
  const planned = effects.changes.structure;
  return {
    ...effects,
    changes: { ...effects.changes, structure: written },
    trace: effects.trace.map((entry) =>
      entry.changes.structure?.after === planned
        ? {
            ...entry,
            changes: {
              ...entry.changes,
              structure: { before: null, after: written },
            },
          }
        : entry,
    ),
  };
}
