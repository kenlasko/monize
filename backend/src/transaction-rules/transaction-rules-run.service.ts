import {
  planRuleAccruals,
  ruleAccrualFingerprint,
  captureRuleAccrualHistory,
} from "./rule-accrual";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  forwardRef,
} from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { DataSource, EntityManager } from "typeorm";
import {
  SETTLE_LOAN_INSTALLMENT,
  isStructuralActionType,
} from "./rule-action.types";
import {
  ActionHistoryService,
  MAX_JSONB_SIZE_BYTES,
} from "../action-history/action-history.service";
import { RULE_RUN_ENTITY_TYPE } from "../action-history/rule-run-undo";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { withScopedDb } from "../common/db/scoped-db";
import { PriorSettlement } from "../loan-installments/loan-settlement.types";
import { repriceSettledLoanTemplates } from "../loan-installments/reprice-template";
import { NetWorthService } from "../net-worth/net-worth.service";
import { tr } from "../i18n/translate";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { isReconciledLockEnabled } from "../transactions/reconciled-lock.util";
import { ExplainRuleRowDto } from "./dto/explain-rule-row.dto";
import { PreviewDraftRuleDto, RunTransactionRuleDto } from "./dto/rule-run.dto";
import { checkedRuleRowInput } from "./rule-row-input";
import type { RuleRowExplanation } from "./rule-row-explain";
import { withActionDefaults } from "./rule-references";
import { PayeeResolution, PlannableRule } from "./rule-effects";
import { loadAttachmentPresence } from "./rule-facts";
import {
  effectiveRunLimit,
  loadCandidateUnits,
  unitRowInput,
} from "./rule-run-candidates";
import { loadRuleApplications } from "./rule-run-applications";
import { planFingerprint } from "./rule-run-fingerprint";
import { PlannedUnit, buildRunSnapshots } from "./rule-run-snapshot";
import { structureTargetAccountIds } from "./rule-structure";
import { loadRuleTargetAccounts } from "./rule-target-accounts";
import { newLoanFactsSource } from "./rule-loan-facts";
import {
  RuleApplicationRow,
  RuleRunChanges,
  RuleRunFilters,
  RuleRunMatchedRow,
  RuleRunPreview,
  RuleRunResult,
  RuleRunSkippedRow,
  RuleRunSkipReason,
} from "./rule-run.types";
import { RuleDefinition } from "./rule-validation";
import { TransactionRule } from "./transaction-rule.entity";
import { toRuleResponses } from "./transaction-rule-view";
import { TransactionRulesApplierService } from "./transaction-rules-applier.service";
import { TransactionRulesService } from "./transaction-rules.service";
import {
  DEFAULT_RULE_APPLICATIONS_LIMIT,
  MAX_RULE_APPLICATIONS_LIMIT,
} from "./transaction-rules.limits";

/** The rule as the planner reads it, plus what the run needs to name it. */
type RunRule = PlannableRule & { name: string; revision: number };

interface Plan {
  readonly preview: RuleRunPreview;
  readonly writable: readonly PlannedUnit[];
  /** Units whose rule asked for an AI review, changed or not (queued on commit only). */
  readonly asking: readonly PlannedUnit[];
  readonly tagsByRow: ReadonlyMap<string, readonly string[]>;
}

/**
 * The run's date filters cut down to the rule's active window: the later of
 * the two starts and the earlier of the two ends (`YYYY-MM-DD` strings
 * compare in date order). Null when nothing is left to scan.
 */
function narrowToActiveWindow(
  filters: RuleRunFilters,
  rule: PlannableRule,
): RuleRunFilters | null {
  const startDate = [filters.startDate, rule.activeFrom]
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  const endDate = [filters.endDate, rule.activeTo]
    .filter((d): d is string => !!d)
    .sort()[0];
  if (startDate && endDate && startDate > endDate) return null;
  return { ...filters, startDate, endDate };
}

/** The planner's refusals that a person can act on, in the words of the preview. */
const REFUSAL_REASONS: Readonly<Record<string, RuleRunSkipReason>> = {
  row_is_transfer_leg: "transfer_leg_category",
  row_has_splits: "split_category",
  cross_owner_transfer_leg: "cross_owner_transfer_payee",
  empty_render: "empty_render",
  payee_not_found: "payee_not_found",
};

/**
 * Every refusal only a structural action can make, named as the planner names
 * it, `settle_loan_installment`'s own included
 * (`docs/specs/loan-installment-settlement.md` section 11).
 */
const STRUCTURAL_REFUSAL_REASONS: ReadonlySet<string> = new Set<
  Exclude<RuleRunSkipReason, "row_is_transfer_leg" | "row_has_splits">
>([
  "row_is_void",
  "zero_amount",
  "transfer_direction_mismatch",
  "transfer_same_account",
  "transfer_account_unavailable",
  "transfer_currency_mismatch",
  "split_amount_unparseable",
  "split_sum_mismatch",
  "split_too_few_parts",
  "row_from_scheduled_posting",
  "row_is_income",
  "loan_account_unavailable",
  "loan_interest_booked_separately",
  "loan_not_configured",
  "no_installment_in_window",
  "occurrence_already_posted",
  "loan_debt_retired",
  "installment_amount_excess",
  "installment_amount_shortfall",
]);

/**
 * The preview's word for a skipped action. A structural action keeps the
 * planner's own name (the category words of `set_category` would mislead).
 * A refusal that is not the row's (a lookup the plan is still waiting for)
 * has no word and is not listed.
 */
export function runSkipReason(refused: {
  type: string;
  reason: string;
}): RuleRunSkipReason | undefined {
  if (isStructuralActionType(refused.type)) {
    return refused.reason === "row_is_transfer_leg" ||
      refused.reason === "row_has_splits" ||
      STRUCTURAL_REFUSAL_REASONS.has(refused.reason)
      ? (refused.reason as RuleRunSkipReason)
      : undefined;
  }
  return REFUSAL_REASONS[refused.reason];
}

/**
 * Run a rule on existing transactions (design 3.6, invariants I3 and I6).
 *
 * One planning path serves the preview, the test of an unsaved draft and the
 * commit: `plan` builds the facts in batches and calls the applier's
 * `planWithChains`, the function `create` uses. The commit re-plans inside its
 * own transaction and refuses, before any write, when the plan no longer
 * hashes to the fingerprint the preview returned.
 */
@Injectable()
export class TransactionRulesRunService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rulesService: TransactionRulesService,
    private readonly applier: TransactionRulesApplierService,
    private readonly actionHistory: ActionHistoryService,
    // forwardRef: the net-worth module reaches the transactions module, which
    // reaches this one (create's rules step).
    @Inject(forwardRef(() => NetWorthService))
    private readonly netWorth: NetWorthService,
  ) {}

  /** What running a saved rule on existing transactions would change. Writes nothing. */
  async previewRun(
    userId: string,
    ruleId: string,
    filters: RuleRunFilters,
  ): Promise<RuleRunPreview> {
    this.assertRange(filters);
    return withScopedDb(this.dataSource, async (m) => {
      const rule = await this.usableRule(m, userId, ruleId, false);
      return (await this.plan(m, userId, rule, filters, false)).preview;
    });
  }

  /**
   * The same for an unsaved draft, validated exactly like a create. Writes
   * nothing. `authoring: false` skips the glob-trap advice, for a draft that
   * is a stored rule whose condition an update leaves alone.
   *
   * With `dto.ruleId` the stored rule is loaded for the caller in the same
   * transaction (404 when missing or foreign) and the advice is skipped only
   * when the draft condition equals the stored one, the comparison an update
   * makes; an explicit `options.authoring` wins.
   */
  async previewDraft(
    userId: string,
    dto: PreviewDraftRuleDto,
    options: { authoring?: boolean } = {},
  ): Promise<RuleRunPreview> {
    const filters = dto.filters ?? {};
    this.assertRange(filters);
    return withScopedDb(this.dataSource, async (m) => {
      let authoring = options.authoring ?? true;
      if (dto.ruleId !== undefined && options.authoring === undefined) {
        const stored = await this.rulesService.getOwnedRule(
          m,
          userId,
          dto.ruleId,
        );
        authoring = !isDeepStrictEqual(dto.condition, stored.condition);
      }
      const definition: RuleDefinition =
        await this.rulesService.checkedDefinition(
          m,
          userId,
          dto.condition,
          dto.actions,
          authoring,
        );
      const draft: RunRule = {
        id: "draft",
        name: "draft",
        enabled: true,
        stopProcessing: false,
        revision: 0,
        condition: definition.condition,
        actions: withActionDefaults(definition.actions) as RunRule["actions"],
        // A blank side is open, exactly as a save reads it.
        activeFrom: dto.activeFrom || null,
        activeTo: dto.activeTo || null,
      };
      if (
        draft.activeFrom &&
        draft.activeTo &&
        draft.activeFrom > draft.activeTo
      ) {
        throw this.rulesService.activeWindowInvalid();
      }
      return (await this.plan(m, userId, draft, filters, false)).preview;
    });
  }

  /**
   * Why each rule of a trigger did or did not apply to one row that is not
   * stored (an import preview's row): its condition tree with the answer of
   * every node, and the effects `planForRow` plans. Writes nothing: the row's
   * ids are checked against the caller's data, then the applier reads.
   */
  async explainRow(
    userId: string,
    dto: ExplainRuleRowDto,
  ): Promise<RuleRowExplanation> {
    return withScopedDb(this.dataSource, async (m) => {
      const input = await checkedRuleRowInput(m, userId, dto.input);
      return this.applier.explainRow(m, userId, input, dto.trigger);
    });
  }

  /**
   * Commit a run. Inside ONE `withScopedDb`: the rule is share-locked, the
   * candidate rows are row-locked and read again, the plan is rebuilt, and a
   * fingerprint that differs from the preview's refuses with 409
   * PREVIEW_CHANGED before anything is written. Reconciled rows under the
   * strict lock are skipped and reported (I6). The undo entry is recorded once
   * the transaction has committed.
   */
  async run(
    userId: string,
    ruleId: string,
    dto: RunTransactionRuleDto,
  ): Promise<RuleRunResult> {
    this.assertRange(dto);
    const done = await withScopedDb(this.dataSource, async (m) => {
      const rule = await this.usableRule(m, userId, ruleId, true);
      const plan = await this.plan(m, userId, rule, dto, true);
      if (plan.preview.fingerprint !== dto.fingerprint) {
        throw new ConflictException({
          message: tr(
            "errors.transactionRules.previewChanged",
            "The transactions or the rule changed since the preview. Review the new preview and run again",
          ),
          errorCode: "PREVIEW_CHANGED",
          fingerprint: plan.preview.fingerprint,
        });
      }
      const tooLarge = (): BadRequestException =>
        new BadRequestException({
          message: tr(
            "errors.transactionRules.runTooLarge",
            "This run changes too many transactions to be undone in one step. Narrow the accounts or the dates and try again",
          ),
          errorCode: "RUN_TOO_LARGE",
        });
      const fits = (snapshots: object): boolean =>
        Buffer.byteLength(JSON.stringify(snapshots), "utf8") <=
        MAX_JSONB_SIZE_BYTES;
      // The undo entry must hold every row this run touches; refuse a run it
      // could not hold, before the first write.
      if (
        !fits(
          buildRunSnapshots(
            plan.writable,
            plan.tagsByRow,
            plan.preview.labels.payees,
          ),
        )
      ) {
        throw tooLarge();
      }
      const accrualBefore = buildRunSnapshots(
        plan.writable,
        plan.tagsByRow,
        plan.preview.labels.payees,
      ).before;
      await captureRuleAccrualHistory(m, userId, accrualBefore);
      if (!fits(accrualBefore)) throw tooLarge();
      // Every account a structural write will credit is row-locked now, in
      // ascending id order and in one statement, after the transaction rows
      // the plan locked (the order the other transaction writers use) and
      // before the first write. Without it each row's write locked its own
      // target as it went, so two runs (or a run and a create) converting in
      // opposite directions could take two accounts in opposite orders.
      await lockAccountsForBalanceWrite(
        m,
        plan.writable.flatMap(({ effects }) =>
          effects.changes.structure
            ? structureTargetAccountIds(effects.changes.structure)
            : [],
        ),
        userId,
      );
      // A payee the rule creates is created once per row (both legs of a
      // transfer share it), inside this transaction, before the row is
      // written; the snapshots then hold its id.
      const written: PlannedUnit[] = [];
      // Accounts a structural action moved, and schedules a settlement claimed
      // on; their net-worth state and their templates are refreshed after the
      // commit, never in here (INV-CACHE-001).
      const affectedAccountIds = new Set<string>();
      const settledScheduleIds = new Set<string>();
      for (const { unit, effects } of plan.writable) {
        const resolved = await this.applier.resolveCreatedPayee(
          m,
          userId,
          effects,
        );
        // The effects as written: a structural write adds the counterpart ids
        // the snapshot (and so the undo) needs. A structural action is never
        // planned on a transfer pair, so its unit has one leg.
        let writtenEffects = resolved;
        for (const leg of unit.legs) {
          const result = await this.applier.writeEffects(
            m,
            userId,
            leg.id,
            resolved,
            "manual",
            affectedAccountIds,
            settledScheduleIds,
          );
          if (leg === unit.primary) writtenEffects = result;
        }
        written.push({ unit, effects: writtenEffects });
      }
      const { before, after } = buildRunSnapshots(
        written,
        plan.tagsByRow,
        plan.preview.labels.payees,
      );
      for (const row of before) {
        const prior = accrualBefore.find((value) => value.id === row.id);
        if (prior?.ruleAccrual) row.ruleAccrual = prior.ruleAccrual;
      }
      await captureRuleAccrualHistory(m, userId, after);
      // The created payees' ids are longer than "will be created"; a run that
      // no longer fits rolls back with the transaction.
      if (!fits({ before, after })) throw tooLarge();
      // Review requests are queued on commit only, never on preview, one per
      // unit on its primary (outgoing) leg, in this same transaction.
      const reviewed = await this.applier.queueAiReviews(
        m,
        userId,
        plan.asking.map(({ unit, effects }) => ({
          transactionId: unit.primary.id,
          effects,
          affectedAccountIds: [],
          settledScheduleIds: [],
        })),
      );
      const aiReviewsAlreadyQueued = reviewed.filter(({ effects }) =>
        effects.trace.some((entry) =>
          entry.applied.some(
            (applied) =>
              applied.type === "request_ai_review" &&
              applied.outcome === "already_queued",
          ),
        ),
      ).length;
      return {
        rule,
        plan,
        aiReviewsQueued: reviewed.length - aiReviewsAlreadyQueued,
        aiReviewsAlreadyQueued,
        before,
        after,
        affectedAccountIds,
        settledScheduleIds,
      };
    });

    // After the commit, so a rollback leaves nothing queued: the accounts a
    // structural action credited have derived state (net worth) to refresh,
    // and a schedule a settlement claimed on has its next installment to
    // reprice on the ledger the settlement left (spec section 12.8).
    for (const accountId of done.affectedAccountIds) {
      this.netWorth.triggerDebouncedRecalc(accountId, userId);
    }
    await repriceSettledLoanTemplates(this.dataSource, done.settledScheduleIds);

    const changed = done.before.length;
    // After the commit: a history write inside the transaction would hide an
    // abort behind its own swallow (derived-state-writers.guard.spec.ts).
    const entry =
      changed > 0
        ? await this.actionHistory.record(userId, {
            entityType: RULE_RUN_ENTITY_TYPE,
            entityId: done.rule.id,
            action: "bulk_update",
            beforeData: { ruleId: done.rule.id, transactions: done.before },
            afterData: { ruleId: done.rule.id, transactions: done.after },
            description: `Ran rule "${done.rule.name}" on ${changed} transaction${changed === 1 ? "" : "s"}`,
            descriptionKey: "ranTransactionRule",
            descriptionParams: { name: done.rule.name, count: changed },
          })
        : null;
    return {
      changed,
      skipped: done.plan.preview.skipped,
      historyId: entry?.id ?? null,
      aiReviewsQueued: done.aiReviewsQueued,
      aiReviewsAlreadyQueued: done.aiReviewsAlreadyQueued,
    };
  }

  /** The latest applications of a rule, newest first, for the trace view. */
  async applications(
    userId: string,
    ruleId: string,
    limit: number = DEFAULT_RULE_APPLICATIONS_LIMIT,
  ): Promise<RuleApplicationRow[]> {
    const take = Math.min(
      Math.max(Math.trunc(limit), 1),
      MAX_RULE_APPLICATIONS_LIMIT,
    );
    return withScopedDb(this.dataSource, async (m) => {
      await this.rulesService.getOwnedRule(m, userId, ruleId);
      return loadRuleApplications(m, userId, ruleId, take);
    });
  }

  /** A saved rule the run can evaluate; a rule that no longer validates is refused. */
  private async usableRule(
    m: EntityManager,
    userId: string,
    ruleId: string,
    share: boolean,
  ): Promise<RunRule> {
    const rule: TransactionRule = await this.rulesService.getOwnedRule(
      m,
      userId,
      ruleId,
      { share },
    );
    const [view] = await toRuleResponses(m, userId, [rule]);
    if (view.invalid) {
      throw new BadRequestException({
        message: tr(
          "errors.transactionRules.ruleInvalid",
          "This rule is not valid, so it cannot be run. Open it and repair it first",
        ),
        errorCode: "INVALID_RULE",
        errors: view.invalidReasons,
      });
    }
    // A manual run is the user's explicit choice: a disabled rule runs too.
    return {
      id: rule.id,
      name: rule.name,
      enabled: true,
      stopProcessing: rule.stopProcessing,
      revision: rule.revision,
      condition: rule.condition,
      actions: rule.actions,
      activeFrom: rule.activeFrom,
      activeTo: rule.activeTo,
    };
  }

  private assertRange(filters: RuleRunFilters): void {
    if (
      filters.startDate &&
      filters.endDate &&
      filters.startDate > filters.endDate
    ) {
      throw new BadRequestException({
        message: tr(
          "errors.transactionRules.dateRangeInvalid",
          "The start date must not be after the end date",
        ),
        errorCode: "DATE_RANGE_INVALID",
      });
    }
  }

  /**
   * The one planning path. Facts are built from batch reads (candidates,
   * partners, tags, category chains) and evaluated by the applier's
   * `planWithChains`; nothing is written.
   */
  private async plan(
    m: EntityManager,
    userId: string,
    rule: RunRule,
    filters: RuleRunFilters,
    lock: boolean,
  ): Promise<Plan> {
    // INV-RULE-004: the window only narrows the scan; the planner still
    // decides every row. An empty intersection scans nothing.
    const scan = narrowToActiveWindow(filters, rule);
    // A rule that settles loan installments scans oldest first, so each row
    // is priced on the debt the rows before it leave (INV-RULE-005); every
    // other rule scans newest first, as it always has.
    const settles = rule.actions.some(
      (action) => action.type === SETTLE_LOAN_INSTALLMENT,
    );
    const { units, truncated } =
      scan === null
        ? { units: [], truncated: false }
        : await loadCandidateUnits(
            m,
            userId,
            { ...scan, limit: effectiveRunLimit(filters.limit) },
            { lock, direction: settles ? "ASC" : "DESC" },
          );
    const legIds = units.flatMap((unit) => unit.legs.map((leg) => leg.id));
    const tagsByRow =
      legIds.length > 0
        ? await this.applier.loadTagIds(m, legIds)
        : new Map<string, string[]>();
    // One query for every row's attachment presence (a scan pair counts once).
    const attached = await loadAttachmentPresence(
      m,
      userId,
      units.map((unit) => unit.primary.id),
    );
    const chains = await this.applier.chainsFor(
      m,
      userId,
      [rule],
      units.map((unit) => unit.primary.categoryId),
    );

    const accounts = await loadRuleTargetAccounts(m, userId, [rule]);
    const skipped: RuleRunSkippedRow[] = [];
    // Payee names looked up for this preview or commit; nothing is created here.
    const payeeLookups = new Map<string, PayeeResolution | null>();
    // Loan facts read for this preview or commit, once per loan for the batch.
    // The commit reads them under the schedule row and account locks, after
    // the candidate rows' locks (spec section 13), so the one plan it makes
    // is over the claims and debts its writes act on.
    const loans = newLoanFactsSource(m, userId, {
      rowIds: units.map((unit) => unit.primary.id),
      dates: units.map((unit) => unit.primary.transactionDate),
      lock,
    });
    // The settlements planned so far and not yet written, in scan order
    // (INV-RULE-005, spec section 7.2): a later row on the same loan is priced
    // on the debt they leave and is never offered a slot they claim. Nothing
    // is written while this plans, so every settlement here is unwritten and
    // none is subtracted twice; a row the strict lock keeps is not written
    // either, so it is not folded.
    const prior: PriorSettlement[] = [];
    // I6: a reconciled row is not altered while the strict lock is on. The
    // preference is read once, and only when a reconciled row would change.
    let strict: boolean | null = null;
    const strictLock = async (): Promise<boolean> =>
      (strict ??= await isReconciledLockEnabled(m, userId));
    const writable: PlannedUnit[] = [];
    let conditionMatchedCount = 0;
    const asking: PlannedUnit[] = [];
    for (const unit of units) {
      const { primary } = unit;
      const effects = await this.applier.planResolved(
        userId,
        unitRowInput(unit, tagsByRow, attached),
        [rule],
        chains,
        {
          crossOwnerTransferLeg: unit.crossOwnerTransferLeg,
          accounts,
          transactionId: primary.id,
          priorSettlements: prior,
        },
        payeeLookups,
        loans,
      );
      const entry = effects.trace[0];
      if (entry?.matched) conditionMatchedCount += 1;
      for (const refused of entry?.skipped ?? []) {
        const reason = runSkipReason(refused);
        if (reason) {
          skipped.push({
            transactionId: primary.id,
            reason,
            ...(refused.detail !== undefined ? { detail: refused.detail } : {}),
          });
        }
      }
      if (entry && Object.keys(entry.changes).length > 0) {
        const reconciled = unit.legs.some(
          (leg) => leg.status === TransactionStatus.RECONCILED,
        );
        if (reconciled && (await strictLock())) {
          skipped.push({
            transactionId: primary.id,
            reason: "reconciled_locked",
          });
        } else {
          writable.push({ unit, effects });
          const settlement = effects.changes.loanSettlement;
          if (settlement !== undefined) {
            prior.push({
              loanAccountId: settlement.loanAccountId,
              rowDate: primary.transactionDate,
              dueDate: settlement.dueDate,
              principal: settlement.principal,
              extraPrincipal: settlement.extraPrincipal,
            });
          }
        }
      }
      if (effects.aiReviewRequests.length > 0) asking.push({ unit, effects });
    }

    // A row that already holds this rule's open request gets no new one: the
    // preview counts, and the fingerprint covers, only the rows a run would
    // really add to the queue. The commit still enqueues them all so the
    // dedupe reports the open ones as already queued.
    const open = await this.applier.openAiReviewTransactionIds(
      m,
      userId,
      rule.id,
      asking.map(({ unit }) => unit.primary.id),
    );
    const adding = asking.filter(({ unit }) => !open.has(unit.primary.id));

    const accrualImpacts = await planRuleAccruals(
      m,
      userId,
      writable,
      tagsByRow,
    );
    const matched: RuleRunMatchedRow[] = writable.map(({ unit, effects }) => ({
      transactionId: unit.primary.id,
      date: unit.primary.transactionDate,
      payeeName: unit.primary.payeeName,
      amount: Number(unit.primary.amount),
      currencyCode: unit.primary.currencyCode,
      changes: effects.trace[0].changes as RuleRunChanges,
    }));
    const labels = await this.applier.labelsFor(
      m,
      userId,
      {
        changes: { addTagIds: [], removeTagIds: [] },
        trace: writable.flatMap(({ effects }) => effects.trace),
        aiReviewRequests: [],
      },
      [rule],
    );
    return {
      preview: {
        matched,
        skipped,
        scanned: units.length,
        scanOrder: settles ? "oldest_first" : "newest_first",
        conditionMatchedCount,
        truncated,
        scannedThrough:
          units.length > 0
            ? units[units.length - 1].primary.transactionDate
            : null,
        ...(accrualImpacts.length ? { accrualImpacts } : {}),
        fingerprint: ruleAccrualFingerprint(
          planFingerprint(
            rule.revision,
            writable.map(({ unit, effects }) => ({
              transactionId: unit.primary.id,
              changes: effects.trace[0].changes,
            })),
            adding.map(({ unit }) => unit.primary.id),
          ),
          accrualImpacts,
        ),
        labels,
        aiReviewRequests: adding.length,
      },
      writable,
      asking,
      tagsByRow,
    };
  }
}
