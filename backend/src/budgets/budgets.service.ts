import { budgetFunding, isTransferFundingLine } from "./budget-funding.util";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Budget } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
} from "./entities/budget-category.entity";
import { CreateTransferIncomeLineDto } from "./dto/create-transfer-income-line.dto";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { assertTransferAccountsOwned } from "./budget-transfer-lines.util";
import {
  assertBucketAssignable,
  assertBucketsAssignable,
} from "./budget-bucket-membership.util";
import {
  Notification,
  NotificationType,
  NotificationSeverity,
} from "../notification-center/entities/notification.entity";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import {
  ScheduledOccurrenceService,
  nonTransferAmount,
} from "../scheduled-transactions/scheduled-occurrence.service";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";
import { CreateBudgetCategoryDto } from "./dto/create-budget-category.dto";
import { UpdateBudgetCategoryDto } from "./dto/update-budget-category.dto";
import { BulkCategoryAmountDto } from "./dto/bulk-update-budget-categories.dto";
import {
  effectiveLineBudget,
  loadExpenseRolloverIn,
} from "./budget-rollover.util";
import {
  getCurrentMonthPeriodDates,
  PeriodDateRange,
} from "./budget-date.utils";
import {
  budgetTransfersInAsIncome,
  queryCategorySpending,
  resolveCategoryProvisionalCount,
  resolveBudgetIncome,
  resolveBudgetLineBudgeted,
  resolveCategoryName,
  resolveCategorySpent,
  resolveOutsideTransferIncome,
  budgetExcludedAccountIds,
  transferCountsAgainstBudget,
} from "./budget-spending.util";
import {
  budgetPaceWindow,
  projectBudgetSpending,
  type BudgetPaceInput,
} from "./budget-velocity";
import { formatDateYMD, todayYMD } from "../common/date-utils";
import { overdueCarryFrom } from "../common/scheduled-occurrences";
import { roundMoney, sumMoney } from "../common/round.util";
import {
  convertingTotal,
  memoizedRateResolver,
} from "../common/converting-total";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { numberFormatterFor } from "../common/number-locale.util";

export interface UpcomingBill {
  id: string;
  name: string;
  /**
   * The positive magnitude this occurrence would actually cost today -- the
   * server-resolved effective amount, not the persisted snapshot (issue #1247).
   * `null` when a component of it (a current cross-currency settlement rate) is
   * unknown; the persisted `amount` is never substituted, because a budget that
   * quietly counts a stale figure understates or overstates what is available.
   */
  amount: number | null;
  /**
   * The currency `amount` is expressed in -- the occurrence's own, which for an
   * investment schedule is the settlement currency rather than the brokerage
   * account's, and which need not be the budget's.
   *
   * It travels with the amount because it is half of what the amount means: the
   * two were separated here and `getVelocity` subtracted a 1,350 CAD bill from a
   * USD budget as though it were 1,350 USD -- a 35% overstatement of that bill,
   * presented as a real figure in the reader's own currency.
   */
  currencyCode: string;
  /** `amount !== null`. */
  amountComplete: boolean;
  dueDate: string;
  categoryId: string | null;
}

/** One budget line's figures for the current period. */
export interface CategoryActualRow {
  /** Allocation before rollover, also used by the bucket plan. */
  planned?: number;
  budgetCategoryId: string;
  categoryId: string | null;
  categoryName: string;
  budgeted: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  isIncome: boolean;
  /** A transfer line: outgoing savings, or transfer income when `isIncome`. */
  isTransfer: boolean;
  /**
   * An income line whose actual is Transfer Funding: a transfer income line
   * or one on a Transfer category (`isTransferFundingLine`). False on every
   * outgoing line.
   */
  isTransferFunding: boolean;
  percentage: number | null;
  /**
   * Provisional transfer legs (an imported estimate) inside `spent`; 0 on a
   * category line, whose rows are never transfer legs.
   */
  provisionalCount: number;
}

/** The current period's line figures and the income no line carries. */
interface CategoryActuals {
  paceByLine?: ReadonlyMap<string, BudgetPaceInput>;
  lines: CategoryActualRow[];
  /**
   * `config.transfersInAsIncome`'s income, clamped at zero like a line's
   * (`resolveOutsideTransferIncome`); `0` with the toggle off (issue #2141).
   */
  outsideTransferIncome: number;
  /**
   * The distinct provisional transfer legs in any line's `spent` or in
   * `outsideTransferIncome` (`CategorySpending.provisionalCount`).
   */
  provisionalCount: number;
}

@Injectable()
export class BudgetsService {
  // Short-lived cache to dedup concurrent computeCategoryActuals calls
  // (e.g. getSummary + getVelocity fired in parallel from the frontend)
  private categoryActualsCache = new Map<
    string,
    {
      data: Promise<CategoryActuals>;
      timestamp: number;
    }
  >();

  constructor(
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
    // "Which occurrence is due, and what does it cost today" has one
    // server-side answer (issue #1247); the budget asks it rather than reading
    // the persisted snapshot or re-deciding which override applies, so its
    // figures cannot disagree with the cash-flow forecast or the register.
    private occurrences: ScheduledOccurrenceService,
    // An occurrence's amount is meaningful only in its own currency, and a
    // budget's figures are in the budget's: the two are reconciled here rather
    // than by dropping the currency and hoping they match (issue #1247).
    private exchangeRates: ExchangeRateService,
    // The bill-due producer fans out through the dispatch seam (still the one
    // write door beneath it, so the column bounds, conflict handling and period
    // default are not re-decided here) -- so a materialized BILL_DUE reaches the
    // user's push / notification-email per the PAYMENTS matrix, not only the
    // bell. Runs on the notification-list READ, so the fan-out is DETACHED from
    // the response (`fanOut: "detached"`): the row is awaited because the list
    // about to be served must hold it, the delivery is not, because one stalled
    // push endpoint would otherwise hold the bell past the client's timeout.
    // Dedup makes most reads create nothing at all.
    private dispatch: NotificationDispatchService,
  ) {}

  async create(
    userId: string,
    createBudgetDto: CreateBudgetDto,
  ): Promise<Budget> {
    const saved = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(Budget);
      return repo.save(repo.create({ ...createBudgetDto, userId }));
    });

    this.actionHistoryService.record(userId, {
      entityType: "budget",
      entityId: saved.id,
      action: "create",
      afterData: { ...saved },
      description: `Created budget "${saved.name}"`,
      descriptionKey: "createdBudget",
      descriptionParams: { name: saved.name },
    });

    return saved;
  }

  async findAll(userId: string): Promise<Budget[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Budget).find({
        where: { userId },
        order: { createdAt: "DESC" },
        relations: ["categories"],
      }),
    );
  }

  async findOne(userId: string, id: string): Promise<Budget> {
    const budget = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Budget).findOne({
        where: { id, userId },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
          "buckets",
        ],
        order: { buckets: { sortOrder: "ASC", name: "ASC" } },
      }),
    );

    if (!budget) {
      throw new NotFoundException(
        tr("errors.budgets.notFound", `Budget with ID ${id} not found`, { id }),
      );
    }

    return budget;
  }

  async update(
    userId: string,
    id: string,
    updateBudgetDto: UpdateBudgetDto,
  ): Promise<Budget> {
    const budget = await this.findOne(userId, id);
    const beforeData = { ...budget };

    if (updateBudgetDto.name !== undefined) budget.name = updateBudgetDto.name;
    if (updateBudgetDto.description !== undefined)
      budget.description = updateBudgetDto.description;
    if (updateBudgetDto.budgetType !== undefined)
      budget.budgetType = updateBudgetDto.budgetType;
    if (updateBudgetDto.periodStart !== undefined)
      budget.periodStart = updateBudgetDto.periodStart;
    if (updateBudgetDto.periodEnd !== undefined)
      budget.periodEnd = updateBudgetDto.periodEnd;
    if (updateBudgetDto.baseIncome !== undefined)
      budget.baseIncome = updateBudgetDto.baseIncome;
    if (updateBudgetDto.incomeLinked !== undefined)
      budget.incomeLinked = updateBudgetDto.incomeLinked;
    if (updateBudgetDto.strategy !== undefined)
      budget.strategy = updateBudgetDto.strategy;
    if (updateBudgetDto.isActive !== undefined)
      budget.isActive = updateBudgetDto.isActive;
    if (updateBudgetDto.config !== undefined)
      budget.config = updateBudgetDto.config;

    const saved = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Budget).save(budget),
    );
    // `config.transfersInAsIncome` changes what the summary counts.
    this.invalidateCategoryActuals(id);

    this.actionHistoryService.record(userId, {
      entityType: "budget",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { ...saved },
      description: `Updated budget "${saved.name}"`,
      descriptionKey: "updatedBudget",
      descriptionParams: { name: saved.name },
    });

    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const budget = await this.findOne(userId, id);
    const beforeData = { ...budget };
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Budget).remove(budget),
    );

    this.actionHistoryService.record(userId, {
      entityType: "budget",
      entityId: beforeData.id,
      action: "delete",
      beforeData,
      description: `Deleted budget "${beforeData.name}"`,
      descriptionKey: "deletedBudget",
      descriptionParams: { name: beforeData.name },
    });
  }

  async addCategory(
    userId: string,
    budgetId: string,
    dto: CreateBudgetCategoryDto,
  ): Promise<BudgetCategory> {
    const budget = await this.findOne(userId, budgetId);

    const category = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).findOne({
        where: { id: dto.categoryId, userId },
      }),
    );

    if (!category) {
      throw new NotFoundException(
        tr(
          "errors.budgets.categoryNotFound",
          `Category with ID ${dto.categoryId} not found`,
          { id: dto.categoryId },
        ),
      );
    }

    const existing = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetCategory).findOne({
        where: { budgetId: budget.id, categoryId: dto.categoryId },
      }),
    );

    if (existing) {
      throw new BadRequestException(
        tr(
          "errors.budgets.categoryAlreadyInBudget",
          "This category is already in the budget",
        ),
      );
    }

    const saved = await withScopedDb(this.dataSource, async (m) => {
      // INV-BUDGET-002: the membership check shares the write's transaction.
      await assertBucketAssignable(
        m,
        budget.id,
        dto.bucketId ?? null,
        dto.isIncome ?? false,
      );
      const repo = m.getRepository(BudgetCategory);
      return repo.save(
        repo.create({
          ...dto,
          bucketId: dto.bucketId ?? null,
          budgetId: budget.id,
        }),
      );
    });
    // After the commit: the cached actuals were computed from the old lines.
    this.invalidateCategoryActuals(budget.id);
    return saved;
  }

  /**
   * Adds a transfer income line (issue #2141). The budget, the account and
   * the one-line-per-account rule are checked in the write's own transaction,
   * under the budget row's lock, so two concurrent adds of one account cannot
   * both pass the duplicate check.
   */
  async addTransferIncomeLine(
    userId: string,
    budgetId: string,
    dto: CreateTransferIncomeLineDto,
  ): Promise<BudgetCategory> {
    const saved = await withScopedDb(this.dataSource, async (m) => {
      const budget = await m.getRepository(Budget).findOne({
        where: { id: budgetId, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!budget) {
        throw new NotFoundException(
          tr(
            "errors.budgets.notFound",
            `Budget with ID ${budgetId} not found`,
            {
              id: budgetId,
            },
          ),
        );
      }
      await assertTransferAccountsOwned(m, userId, [dto.transferAccountId]);
      const repo = m.getRepository(BudgetCategory);
      const existing = await repo.findOne({
        where: { budgetId, transferAccountId: dto.transferAccountId },
      });
      if (existing) {
        throw new BadRequestException(
          tr(
            "errors.budgets.transferAccountAlreadyInBudget",
            "This account already has a transfer line in the budget",
          ),
        );
      }
      const line = await repo.save(
        repo.create({
          budgetId,
          categoryId: null,
          transferAccountId: dto.transferAccountId,
          isTransfer: true,
          isIncome: true,
          amount: dto.amount,
          rolloverType: dto.rolloverType ?? RolloverType.NONE,
          notes: dto.notes ?? null,
        }),
      );
      // The open period's close freezes only the lines it has a row for, so a
      // line added mid-period gets its row here, or this period's income from
      // it would be left out of `actual_income`.
      const openPeriod = await m.getRepository(BudgetPeriod).findOne({
        where: { budgetId, status: PeriodStatus.OPEN },
      });
      if (openPeriod) {
        const periodCats = m.getRepository(BudgetPeriodCategory);
        await periodCats.save(
          periodCats.create({
            budgetPeriodId: openPeriod.id,
            budgetCategoryId: line.id,
            categoryId: null,
            budgetedAmount: dto.amount,
            rolloverIn: 0,
            effectiveBudget: dto.amount,
            actualAmount: 0,
            rolloverOut: 0,
          }),
        );
      }
      return line;
    });
    // After the commit: the page re-reads the summary straight after the add.
    this.invalidateCategoryActuals(budgetId);
    return saved;
  }

  async updateCategory(
    userId: string,
    budgetId: string,
    categoryId: string,
    dto: UpdateBudgetCategoryDto,
  ): Promise<BudgetCategory> {
    // The lookups, the refusal and the save share one transaction, so a
    // refused PATCH has written nothing.
    const saved = await withScopedDb(this.dataSource, async (m) => {
      await this.findOne(userId, budgetId);

      const repo = m.getRepository(BudgetCategory);
      const budgetCategory = await repo.findOne({
        where: { id: categoryId, budgetId },
      });

      if (!budgetCategory) {
        throw new NotFoundException(
          tr(
            "errors.budgets.budgetCategoryNotFound",
            `Budget category with ID ${categoryId} not found`,
            { id: categoryId },
          ),
        );
      }

      // A transfer line's direction is what it is: flipping `isIncome` would
      // turn "Transfer to HISA" (outgoing, counted as savings) into "Transfers
      // from HISA" (the net coming in, clamped at zero) under the same
      // account. Resending the value it already has is not a change.
      if (
        budgetCategory.isTransfer &&
        dto.isIncome !== undefined &&
        dto.isIncome !== budgetCategory.isIncome
      ) {
        throw new BadRequestException(
          tr(
            "errors.budgets.transferLineDirectionFixed",
            "A transfer line's direction cannot be changed. Remove it and add a new line instead.",
          ),
        );
      }

      this.applyCategoryUpdate(budgetCategory, dto);
      await assertBucketAssignable(
        m,
        budgetId,
        budgetCategory.bucketId ?? null,
        budgetCategory.isIncome,
      );
      return repo.save(budgetCategory);
    });
    this.invalidateCategoryActuals(budgetId);
    return saved;
  }

  private applyCategoryUpdate(
    budgetCategory: BudgetCategory,
    dto: UpdateBudgetCategoryDto,
  ): void {
    if (dto.categoryGroup !== undefined)
      budgetCategory.categoryGroup = dto.categoryGroup;
    if (dto.amount !== undefined) budgetCategory.amount = dto.amount;
    if (dto.isIncome !== undefined) budgetCategory.isIncome = dto.isIncome;
    if (dto.rolloverType !== undefined)
      budgetCategory.rolloverType = dto.rolloverType;
    if (dto.rolloverCap !== undefined)
      budgetCategory.rolloverCap = dto.rolloverCap;
    if (dto.flexGroup !== undefined) budgetCategory.flexGroup = dto.flexGroup;
    if (dto.alertWarnPercent !== undefined)
      budgetCategory.alertWarnPercent = dto.alertWarnPercent;
    if (dto.alertCriticalPercent !== undefined)
      budgetCategory.alertCriticalPercent = dto.alertCriticalPercent;
    if (dto.notes !== undefined) budgetCategory.notes = dto.notes;
    if (dto.sortOrder !== undefined) budgetCategory.sortOrder = dto.sortOrder;

    // Truth table D: absent = unchanged, null = cleared, a bucket id = set. The
    // check runs on the row as it would become (`updateCategory`), so flipping
    // a bucketed line to income is refused (unless the same request clears the
    // bucket).
    if (dto.bucketId !== undefined) budgetCategory.bucketId = dto.bucketId;
  }

  async removeCategory(
    userId: string,
    budgetId: string,
    categoryId: string,
  ): Promise<void> {
    await this.findOne(userId, budgetId);

    const budgetCategory = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetCategory).findOne({
        where: { id: categoryId, budgetId },
      }),
    );

    if (!budgetCategory) {
      throw new NotFoundException(
        tr(
          "errors.budgets.budgetCategoryNotFound",
          `Budget category with ID ${categoryId} not found`,
          { id: categoryId },
        ),
      );
    }

    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetCategory).remove(budgetCategory),
    );
    this.invalidateCategoryActuals(budgetId);
  }

  async bulkUpdateCategories(
    userId: string,
    budgetId: string,
    categories: BulkCategoryAmountDto[],
  ): Promise<BudgetCategory[]> {
    await this.findOne(userId, budgetId);

    // Load all targeted budget categories in a single query (avoids the prior
    // per-item N+1) and validate before any write.
    const ids = categories.map((item) => item.id);
    const existing = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetCategory).find({
        where: { id: In(ids), budgetId },
      }),
    );
    const byId = new Map(existing.map((bc) => [bc.id, bc]));

    for (const item of categories) {
      if (!byId.has(item.id)) {
        throw new NotFoundException(
          tr(
            "errors.budgets.budgetCategoryNotFound",
            `Budget category with ID ${item.id} not found`,
            { id: item.id },
          ),
        );
      }
    }

    // Apply all amount changes atomically so a partial failure cannot leave
    // some categories updated and others not.
    const saved = await withScopedDb(this.dataSource, async (m) => {
      // Membership (truth table D) is checked for every item before the first
      // write, in this same transaction; a refusal leaves nothing written.
      await assertBucketsAssignable(
        m,
        budgetId,
        categories.map((item) => {
          const line = byId.get(item.id)!;
          const bucketId =
            item.bucketId !== undefined ? item.bucketId : line.bucketId;
          return { bucketId: bucketId ?? null, isIncome: line.isIncome };
        }),
      );
      const results: BudgetCategory[] = [];
      for (const item of categories) {
        const budgetCategory = byId.get(item.id)!;
        budgetCategory.amount = item.amount;
        if (item.bucketId !== undefined)
          budgetCategory.bucketId = item.bucketId;
        results.push(await m.save(budgetCategory));
      }
      return results;
    });
    this.invalidateCategoryActuals(budgetId);
    return saved;
  }

  async getSummary(
    userId: string,
    budgetId: string,
  ): Promise<{
    budget: Budget;
    /** The period the figures were read for (`getCurrentPeriodDates`). */
    periodStart: string;
    periodEnd: string;
    totalBudgeted: number;
    totalSpent: number;
    totalIncome: number;
    remaining: number;
    percentUsed: number;
    incomeLinked: boolean;
    actualIncome: number | null;
    /**
     * Actual Income: the income lines on an Income or Expense category
     * (docs/specs/transfer-categories.md section 6.2). With `transferFunding`
     * it makes `totalIncome`, Total Budget Funding.
     */
    categoryIncome: number;
    /**
     * Transfer Funding: transfer income lines, income lines on a Transfer
     * category and `outsideTransferIncome`.
     */
    transferFunding: number;
    /** Included in `totalIncome`; `0` unless `config.transfersInAsIncome`. */
    outsideTransferIncome: number;
    categoryBreakdown: CategoryActualRow[];
    /**
     * Provisional transfer legs (an imported estimate) inside the transfer
     * lines' actuals and `outsideTransferIncome`, once each; above 0 the page
     * says its figures include estimated amounts.
     */
    provisionalCount: number;
  }> {
    const budget = await this.findOne(userId, budgetId);

    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const {
      lines: categoryBreakdown,
      outsideTransferIncome,
      provisionalCount,
    } = await this.getCachedCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
    );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);
    const incomeCategories = categoryBreakdown.filter((c) => c.isIncome);

    const totalBudgeted = sumMoney(expenseCategories.map((c) => c.budgeted));
    const totalSpent = sumMoney(expenseCategories.map((c) => c.spent));
    const { totalIncome, categoryIncome, transferFunding } = budgetFunding(
      incomeCategories.map((c) => ({
        actual: c.spent,
        isTransferFunding: c.isTransferFunding,
      })),
      outsideTransferIncome,
    );
    const remaining = roundMoney(totalBudgeted - totalSpent);
    const percentUsed =
      totalBudgeted > 0
        ? Math.round((totalSpent / totalBudgeted) * 10000) / 100
        : 0;

    let actualIncome: number | null = null;
    if (budget.incomeLinked) {
      actualIncome = totalIncome;
    }

    return {
      budget,
      periodStart,
      periodEnd,
      totalBudgeted,
      totalSpent,
      totalIncome,
      remaining,
      percentUsed,
      incomeLinked: budget.incomeLinked,
      actualIncome,
      categoryIncome,
      transferFunding,
      outsideTransferIncome,
      categoryBreakdown,
      provisionalCount,
    };
  }

  /**
   * The next occurrence of every outflow schedule due by `periodEnd`, priced at
   * what it would actually cost today. An occurrence that fell due in the last
   * `OVERDUE_CARRY_DAYS` and was neither posted nor skipped is still owed, so it
   * is the schedule's next one, listed on the date it was due: the balance
   * forecasts apply it too (discussion #1784), and safe-to-spend must not count
   * money a late bill will take.
   *
   * Both halves come from the one occurrence contract (issue #1247). The
   * occurrence matters as much as the amount: reading the schedule template meant
   * an occurrence the user had re-priced or moved was reported at the template's
   * figure on the template's date, and `getVelocity` subtracts this from what is
   * available to spend.
   */
  async getUpcomingBills(
    userId: string,
    periodEnd: string,
    budget: Pick<Budget, "categories" | "config">,
  ): Promise<UpcomingBill[]> {
    const occurrences = await this.occurrences.findOccurrences(
      userId,
      {
        from: overdueCarryFrom(todayYMD()),
        through: periodEnd,
        // One row per schedule, which is the shape this list has always had.
        maxOccurrences: 1,
      },
      { outflowsOnly: true },
    );

    // Only what the budget tracks is a bill: an occurrence out of an excluded
    // account is not, and a plain scheduled transfer is spending only where it
    // would count against this budget once posted (a line for its destination
    // account or its category). The bills page and calendar still list it.
    const excluded = new Set(budgetExcludedAccountIds(budget.config));
    return occurrences.flatMap((occurrence) => {
      const { schedule } = occurrence;
      if (excluded.has(schedule.accountId)) return [];
      if (
        schedule.isTransfer &&
        !transferCountsAgainstBudget(budget.categories ?? [], schedule)
      ) {
        return [];
      }
      // A split's transfer lines are not spending: the amount is the part that is.
      const spending = nonTransferAmount(occurrence);
      return [
        {
          id: occurrence.scheduledTransactionId,
          name: schedule.name,
          // Spending, so only where that part is an outflow: a refund beside a
          // larger transfer line is not a bill (the row's amount DUE is the whole).
          amount: spending === null ? null : spending < 0 ? -spending : 0,
          currencyCode: occurrence.currencyCode,
          amountComplete: spending !== null,
          dueDate: occurrence.dueDate,
          categoryId: schedule.categoryId,
        },
      ];
    });
  }

  async getVelocity(
    userId: string,
    budgetId: string,
  ): Promise<{
    projectionMissingRatePairs: string[];
    dailyBurnRate: number | null;
    projectedTotal: number | null;
    budgetTotal: number;
    projectedVariance: number | null;
    /** `null` when `trulyAvailable` is unknown -- it is derived from it. */
    safeDailySpend: number | null;
    daysElapsed: number;
    daysRemaining: number;
    totalDays: number;
    currentSpent: number;
    paceStatus: "under" | "on_track" | "over" | null;
    upcomingBills: UpcomingBill[];
    /**
     * `null` when any upcoming bill's current amount is unknown (issue #1247):
     * the partial sum then travels in `knownUpcomingBillsSubtotal`, and
     * `upcomingBillsComplete` is false.
     */
    totalUpcomingBills: number | null;
    knownUpcomingBillsSubtotal: number;
    upcomingBillsComplete: boolean;
    /**
     * The currency pairs a bill could not be converted through, so a withheld
     * total says why. Empty when every component converted -- including when the
     * shortfall was an occurrence with no resolvable amount at all, which has no
     * pair to name.
     */
    upcomingBillsMissingRates: string[];
    /** `null` when the upcoming-bills total is unknown. */
    trulyAvailable: number | null;
  }> {
    const budget = await this.findOne(userId, budgetId);
    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const todayStr = todayYMD();
    const { totalDays, daysElapsed, daysRemaining } = budgetPaceWindow(
      periodStart,
      periodEnd,
      todayStr,
    );

    const { lines: categoryBreakdown, paceByLine } =
      await this.getCachedCategoryActuals(
        userId,
        budget,
        periodStart,
        periodEnd,
        todayStr,
      );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);
    const projection = projectBudgetSpending(
      paceByLine?.values() ?? [],
      daysElapsed,
      daysRemaining,
    );
    const { currentSpent, dailyBurnRate, projectedTotal } = projection;
    const budgetTotal = sumMoney(expenseCategories.map((c) => c.budgeted));

    const upcomingBills = await this.getUpcomingBills(
      userId,
      periodEnd,
      budget,
    );
    // Today on the caller's own clock, so the rate is the one the bills list is
    // showing rather than one from the container's timezone.
    // Every bill converted into the budget's own currency before it joins the
    // total, because that is the currency `remaining` is in.
    //
    // Two separate ways a component goes missing, and both make the total
    // unknowable rather than smaller (issue #1247, `docs/financial-semantics.md`):
    // an occurrence whose current amount could not be resolved at all, and one
    // whose amount is known in a currency with no rate to the budget's. The
    // partial sum travels beside the total under its own name and never stands in
    // for it, and `upcomingBillsMissingRates` names the pairs so a withheld
    // figure comes with the reason (an unexplained blank is a dead end).
    // Through the one shared accumulator (`common/converting-total.ts`), which
    // owns the memoized per-pair lookup, the rejecting rate resolver, and both
    // ways a component goes missing. This block used to be written out here and
    // again in the AI/MCP rollup, comments included.
    const billsTotal = await convertingTotal(
      upcomingBills.map((bill) => ({
        amount: bill.amount,
        currency: bill.currencyCode,
      })),
      budget.currencyCode,
      memoizedRateResolver(this.exchangeRates, budget.currencyCode, todayStr),
    );
    const upcomingBillsComplete = billsTotal.total !== null;
    const knownUpcomingBillsSubtotal = billsTotal.knownSubtotal;
    const totalUpcomingBills = billsTotal.total;
    const upcomingBillsMissingRates = billsTotal.missingPairs;

    const projectedVariance =
      projectedTotal === null ? null : roundMoney(projectedTotal - budgetTotal);
    // Available funds still include transactions booked for the whole period.
    const periodSpent = sumMoney(expenseCategories.map((line) => line.spent));
    const remaining = roundMoney(budgetTotal - periodSpent);
    const trulyAvailable =
      totalUpcomingBills === null
        ? null
        : roundMoney(remaining - totalUpcomingBills);
    const safeDailySpend =
      trulyAvailable === null
        ? null
        : daysRemaining > 0
          ? Math.max(0, trulyAvailable / daysRemaining)
          : 0;

    let paceStatus: "under" | "on_track" | "over" | null;
    const paceRatio =
      projectedTotal === null
        ? null
        : budgetTotal > 0
          ? projectedTotal / budgetTotal
          : 0;
    if (paceRatio === null) {
      paceStatus = null;
    } else if (budgetTotal === 0 || paceRatio <= 0.95) {
      paceStatus = "under";
    } else if (paceRatio <= 1.05) {
      paceStatus = "on_track";
    } else {
      paceStatus = "over";
    }

    return {
      projectionMissingRatePairs: projection.missingRatePairs,
      dailyBurnRate,
      projectedTotal,
      budgetTotal,
      projectedVariance,
      safeDailySpend:
        safeDailySpend === null ? null : roundMoney(safeDailySpend),
      daysElapsed,
      daysRemaining,
      totalDays,
      currentSpent,
      paceStatus,
      upcomingBills,
      totalUpcomingBills,
      knownUpcomingBillsSubtotal,
      upcomingBillsComplete,
      upcomingBillsMissingRates,
      trulyAvailable,
    };
  }

  /**
   * Materialize a BILL_DUE notification for every upcoming bill that does not
   * have one yet.
   *
   * Called from the notification list endpoint rather than a cron, which is how
   * it has always worked: a reminder that appears the moment the user looks is
   * better than one that waits for 07:00, and the dedup below makes the read
   * idempotent. Public because the notification centre owns the endpoint and
   * budgets owns the producer.
   */
  async ensureBillDueNotifications(userId: string): Promise<void> {
    // Every figure below is read by this user -- on the bell, and in the email
    // `notificationImmediateTemplate` composes from the same string.
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const n = numberFormatterFor(prefs?.numberFormat, prefs?.language);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = todayYMD();

    // Use a 30-day cap, then filter per-bill by reminderDaysBefore
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + 30);
    const horizonStr = formatDateYMD(horizon);

    // Occurrences, not schedules (issue #1247). The alert is about one occurrence
    // -- what it will cost and when it falls -- and both answers come from the one
    // occurrence contract. Keying the override lookup on `overrideDate` here (the
    // identity is `originalDate`) meant a bill the user had MOVED silently fell
    // back to the template's amount, on the template's date.
    const manualOccurrences = await this.occurrences.findOccurrences(
      userId,
      { from: todayStr, through: horizonStr, maxOccurrences: 1 },
      { manualOnly: true },
    );
    if (manualOccurrences.length === 0) return;

    // Only those within their own reminder window, and not already paid ahead of
    // time. Measured from the date the occurrence actually falls on.
    const eligible = manualOccurrences.filter((occurrence) => {
      const bill = occurrence.schedule;
      const daysUntilDue = Math.ceil(
        (new Date(occurrence.dueDate).getTime() - today.getTime()) /
          (1000 * 60 * 60 * 24),
      );
      if (daysUntilDue > bill.reminderDaysBefore) return false;

      // Skip bills already posted for this cycle
      if (bill.lastPostedDate) {
        const lastPosted =
          typeof bill.lastPostedDate === "string"
            ? bill.lastPostedDate
            : formatDateYMD(bill.lastPostedDate as Date);
        // If lastPostedDate is within reminderDaysBefore of the due date,
        // the bill was already paid ahead of time
        const daysSincePosted = Math.ceil(
          (today.getTime() - new Date(lastPosted).getTime()) /
            (1000 * 60 * 60 * 24),
        );
        if (daysSincePosted <= bill.reminderDaysBefore) return false;
      }

      return true;
    });

    if (eligible.length === 0) return;

    // Fetch ALL existing BILL_DUE alerts (including dismissed) to prevent re-creation
    const existingAlerts = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Notification)
        .createQueryBuilder("ba")
        .where("ba.user_id = :userId", { userId })
        .andWhere("ba.alert_type = :type", {
          type: NotificationType.BILL_DUE,
        })
        .getMany(),
    );

    // An occurrence's identity is `(billId, originalDate)`, so that is what
    // decides "already alerted". `periodStart` is the date the alert announces,
    // which an override can move -- deduping on it alone would raise a second
    // alert for the same occurrence every time the user re-dated it. Rows written
    // before `originalDate` was recorded are still matched on their announced
    // date, so an upgrade does not re-alert everything once.
    const existingBillKeys = new Set(
      existingAlerts.flatMap((a) => {
        const data = (a.data ?? {}) as Record<string, unknown>;
        const keys = [`${data.billId}:${a.periodStart}`];
        if (typeof data.originalDate === "string") {
          keys.push(`${data.billId}:${data.originalDate}`);
        }
        return keys;
      }),
    );

    for (const occurrence of eligible) {
      const bill = occurrence.schedule;
      const dueDate = occurrence.dueDate;

      if (
        existingBillKeys.has(`${bill.id}:${occurrence.originalDate}`) ||
        existingBillKeys.has(`${bill.id}:${dueDate}`)
      ) {
        continue;
      }

      const payeeName = bill.payee?.name || bill.payeeName || bill.name;
      // An amount we cannot work out is stated as unavailable. Naming a stale
      // figure in an alert the user acts on is the defect; withholding the
      // alert entirely would hide a payment that is genuinely due.
      const amount =
        occurrence.amount === null ? null : Math.abs(occurrence.amount);
      const daysUntilDue = Math.ceil(
        (new Date(dueDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      const severity =
        daysUntilDue <= 1
          ? NotificationSeverity.WARNING
          : NotificationSeverity.INFO;

      // The ROW is awaited -- the list the caller is about to read must hold it.
      // The fan-out is detached: this runs on `GET /notifications`, and a push
      // delivery is bounded by PUSH_REQUEST_DEADLINE_MS per device, so awaiting
      // it here let one stalled endpoint hold the bell read past the client's
      // own timeout (a cron may wait for its pushes; a reader may not).
      await this.dispatch.notify(
        userId,
        {
          type: NotificationType.BILL_DUE,
          severity,
          // `title`/`message` are the English fallbacks for a reader with no
          // client to render them (an API consumer). The UI and the email
          // composer render `type` and `data` in the recipient's own language --
          // a stored sentence cannot be translated after the fact, and the
          // missing-rate case is exactly the one a non-English reader hits.
          //
          // The FIGURE in that fallback is still the recipient's to read, and
          // this one is not hypothetical: PAYMENTS supports `emailNotification`,
          // and `composeLocalizedNotificationCopy` falls back WHOLE to this
          // stored pair for a row it cannot rebuild (a legacy or restored
          // BILL_DUE carrying no `payeeName`, `dueDate` or `currencyCode`), so
          // `notificationImmediateTemplate` renders this very string into an
          // email built with the recipient's translator. Formatting it en-US put
          // `zl18,812.71` inside Polish copy -- issue #1316 on the one path whose
          // English prose is not a machine format.
          title: `${payeeName} due${daysUntilDue === 0 ? " today" : daysUntilDue === 1 ? " tomorrow" : ` in ${daysUntilDue} days`}`,
          message:
            amount === null
              ? `Amount unavailable (no current exchange rate), due on ${dueDate}`
              : `${n.formatCurrency(amount, occurrence.currencyCode)} due on ${dueDate}`,
          // Structured, so the UI can compose the copy in the reader's language
          // -- and deliberately without `daysUntilDue`: "due in 3 days" was true
          // when this row was written and stops being true the next morning,
          // while the row lives until it is dismissed. The client counts from
          // `dueDate` against its own clock.
          data: {
            billId: bill.id,
            payeeName,
            amount,
            amountComplete: amount !== null,
            dueDate,
            originalDate: occurrence.originalDate,
            currencyCode: occurrence.currencyCode,
          },
          // Where the bell sends the reader. `/bills` and not
          // `/scheduled-transactions/<id>`, which is not a route: the app router
          // has no such segment, and because a stored target WINS over the
          // client's type table, inventing one replaced a working destination
          // with the not-found page. There is no per-bill route to deep-link to;
          // `notification-target.contract.test.ts` checks every target a producer
          // writes against the router tree.
          target: "/bills",
          periodStart: dueDate,
          // The occurrence's identity, so the database arbitrates what the read
          // above only observes: two overlapping bell reads (a second tab, an
          // owner beside a delegate) both miss the row and both write; with
          // budget_id NULL the fingerprint index cannot refuse the second, and
          // each duplicate also pushed and emailed. The write door's ON CONFLICT
          // DO NOTHING hands the loser null, and null fans out nothing.
          dedupeKey: `BILL_DUE:${bill.id}:${occurrence.originalDate}`,
        },
        { fanOut: "detached" },
      );
    }
  }

  async getDashboardSummary(userId: string): Promise<{
    budgetId: string;
    budgetName: string;
    totalBudgeted: number;
    totalSpent: number;
    remaining: number;
    percentUsed: number;
    safeDailySpend: number;
    daysRemaining: number;
    topCategories: Array<{
      categoryName: string;
      budgeted: number;
      spent: number;
      remaining: number;
      percentUsed: number;
    }>;
  } | null> {
    const budget = await this.findNewestActiveBudget(userId);
    if (!budget) return null;

    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const { lines: categoryBreakdown } = await this.getCachedCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
    );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);

    const totalBudgeted = sumMoney(expenseCategories.map((c) => c.budgeted));
    const totalSpent = sumMoney(expenseCategories.map((c) => c.spent));
    const remaining = roundMoney(totalBudgeted - totalSpent);
    const percentUsed =
      totalBudgeted > 0
        ? Math.round((totalSpent / totalBudgeted) * 10000) / 100
        : 0;

    const today = new Date();
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);
    // periodEnd is the inclusive last day, so the period spans one more day.
    const totalDays =
      Math.ceil(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      ) + 1;
    const daysElapsed = Math.max(
      1,
      Math.ceil(
        (today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );
    const daysRemaining = Math.max(0, totalDays - daysElapsed);
    const safeDailySpend =
      daysRemaining > 0 ? Math.max(0, remaining / daysRemaining) : 0;

    const topCategories = [...expenseCategories]
      .sort((a, b) => b.percentUsed - a.percentUsed)
      .slice(0, 3)
      .map((c) => ({
        categoryName: c.categoryName,
        budgeted: c.budgeted,
        spent: c.spent,
        remaining: c.remaining,
        percentUsed: c.percentUsed,
      }));

    return {
      budgetId: budget.id,
      budgetName: budget.name,
      totalBudgeted,
      totalSpent,
      remaining,
      percentUsed,
      safeDailySpend: roundMoney(safeDailySpend),
      daysRemaining,
      topCategories,
    };
  }

  async getCategoryBudgetStatus(
    userId: string,
    categoryIds: string[],
  ): Promise<
    Map<
      string,
      {
        budgeted: number;
        spent: number;
        remaining: number;
        percentUsed: number;
      }
    >
  > {
    const result = new Map<
      string,
      {
        budgeted: number;
        spent: number;
        remaining: number;
        percentUsed: number;
      }
    >();

    if (categoryIds.length === 0) return result;
    const budget = await this.findNewestActiveBudget(userId);
    if (!budget) return result;

    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const { lines: categoryBreakdown } = await this.getCachedCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
    );

    for (const breakdown of categoryBreakdown) {
      if (
        breakdown.categoryId &&
        categoryIds.includes(breakdown.categoryId) &&
        !breakdown.isIncome
      ) {
        result.set(breakdown.categoryId, {
          budgeted: breakdown.budgeted,
          spent: breakdown.spent,
          remaining: breakdown.remaining,
          percentUsed: breakdown.percentUsed,
        });
      }
    }

    return result;
  }

  /**
   * The budget the dashboard widget and the category status read: the newest
   * active one, with the relations its actuals need. One budget is loaded,
   * not every active budget with its lines.
   */
  private findNewestActiveBudget(userId: string): Promise<Budget | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Budget).findOne({
        where: { userId, isActive: true },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
        ],
        order: { createdAt: "DESC" },
      }),
    );
  }

  private getCurrentPeriodDates(_budget: Budget): PeriodDateRange {
    return getCurrentMonthPeriodDates();
  }

  /** Drops cached figures after a budget edit or a period close commits. */
  invalidateCategoryActuals(budgetId: string): void {
    for (const key of this.categoryActualsCache.keys()) {
      if (key.startsWith(`${budgetId}:`)) this.categoryActualsCache.delete(key);
    }
  }

  private getCachedCategoryActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
    paceThrough?: string,
  ) {
    const key = `${budget.id}:${periodStart}:${periodEnd}:${paceThrough ?? ""}`;
    const cached = this.categoryActualsCache.get(key);
    const now = Date.now();

    if (cached && now - cached.timestamp < 10_000) {
      return cached.data;
    }

    // Store the promise itself so concurrent callers share the same in-flight request
    const promise = this.computeCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
      paceThrough,
    );
    this.categoryActualsCache.set(key, { data: promise, timestamp: now });

    // Clean up stale entries
    if (this.categoryActualsCache.size > 50) {
      for (const [k, v] of this.categoryActualsCache) {
        if (now - v.timestamp > 30_000) this.categoryActualsCache.delete(k);
      }
    }

    return promise;
  }

  private async computeCategoryActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
    paceThrough?: string,
  ): Promise<CategoryActuals> {
    const budgetCategories = budget.categories || [];

    // A budget with no line still counts transfers in from its excluded
    // accounts when the toggle is on (issue #2141).
    if (
      budgetCategories.length === 0 &&
      !budgetTransfersInAsIncome(budget.config)
    ) {
      return { lines: [], outsideTransferIncome: 0, provisionalCount: 0 };
    }

    // The two spending queries share one scoped transaction so the direct and
    // split halves of a category's total come from the same snapshot.
    const { spending, rolloverIn } = await withScopedDb(
      this.dataSource,
      async (m) => {
        const spending = await queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          budgetCategories,
          periodStart,
          periodEnd,
          budget.id,
          paceThrough,
        );
        const rolloverIn = await loadExpenseRolloverIn(m, budget, periodStart);
        return { spending, rolloverIn };
      },
    );

    // An income-linked budget derives its lines from the income the same
    // read converted into the budget's currency (issue #2155), transfers in
    // included (issue #2141).
    const actualIncome = budget.incomeLinked
      ? resolveBudgetIncome(budgetCategories, spending)
      : 0;

    const lines = budgetCategories.map((bc) => {
      const percentage =
        budget.incomeLinked && !bc.isIncome ? Number(bc.amount) : null;
      const planned = resolveBudgetLineBudgeted(
        bc,
        budget.incomeLinked,
        actualIncome,
      );
      const budgeted = effectiveLineBudget(planned, rolloverIn.get(bc.id));

      const spent = resolveCategorySpent(
        bc,
        spending.spendingMap,
        spending.transferSpendingMap,
        spending.transferIncomeMap,
      );
      const categoryName = resolveCategoryName(bc);
      const remaining = roundMoney(budgeted - spent);
      const percentUsed =
        budgeted > 0 ? Math.round((spent / budgeted) * 10000) / 100 : 0;

      return {
        budgetCategoryId: bc.id,
        categoryId: bc.categoryId,
        categoryName,
        planned,
        budgeted,
        spent,
        remaining,
        percentUsed,
        isIncome: bc.isIncome,
        isTransfer: bc.isTransfer,
        isTransferFunding: isTransferFundingLine(bc),
        percentage,
        provisionalCount: resolveCategoryProvisionalCount(bc, spending),
      };
    });

    return {
      lines,
      paceByLine: spending.paceByLine,
      outsideTransferIncome: resolveOutsideTransferIncome(spending),
      provisionalCount: spending.provisionalCount,
    };
  }
}
