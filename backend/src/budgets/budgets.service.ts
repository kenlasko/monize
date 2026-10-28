import { BudgetPeriod } from "./entities/budget-period.entity";
import { reportingMoneyOne } from "../accruals/reporting-money";
import { ReportingRead } from "../accruals/reporting-basis";
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import {
  Notification,
  NotificationType,
  NotificationSeverity,
} from "../notification-center/entities/notification.entity";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";
import { CreateBudgetCategoryDto } from "./dto/create-budget-category.dto";
import { UpdateBudgetCategoryDto } from "./dto/update-budget-category.dto";
import { BulkCategoryAmountDto } from "./dto/bulk-update-budget-categories.dto";
import {
  getCurrentMonthPeriodDates,
  PeriodDateRange,
} from "./budget-date.utils";
import {
  budgetExcludedAccountIds,
  excludeBudgetAccounts,
  queryCategorySpending,
  resolveCategoryName,
  resolveCategorySpent,
} from "./budget-spending.util";
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

@Injectable()
export class BudgetsService {
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
        ],
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

    return withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(BudgetCategory);
      return repo.save(repo.create({ ...dto, budgetId: budget.id }));
    });
  }

  async updateCategory(
    userId: string,
    budgetId: string,
    categoryId: string,
    dto: UpdateBudgetCategoryDto,
  ): Promise<BudgetCategory> {
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

    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetCategory).save(budgetCategory),
    );
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
    return withScopedDb(this.dataSource, async (m) => {
      const results: BudgetCategory[] = [];
      for (const item of categories) {
        const budgetCategory = byId.get(item.id)!;
        budgetCategory.amount = item.amount;
        results.push(await m.save(budgetCategory));
      }
      return results;
    });
  }

  @ReportingRead()
  async getSummary(
    userId: string,
    budgetId: string,
    period?: PeriodDateRange,
  ): Promise<{
    budget: Budget;
    totalBudgeted: number;
    totalSpent: number;
    totalIncome: number;
    remaining: number;
    percentUsed: number;
    incomeLinked: boolean;
    actualIncome: number | null;
    categoryBreakdown: Array<{
      budgetCategoryId: string;
      categoryId: string | null;
      categoryName: string;
      budgeted: number;
      spent: number;
      remaining: number;
      percentUsed: number;
      isIncome: boolean;
      percentage: number | null;
    }>;
  }> {
    const budget = await this.findOne(userId, budgetId);

    const { periodStart, periodEnd } =
      period ?? this.getCurrentPeriodDates(budget);

    let reportingBudget = budget;
    if (
      period &&
      periodStart !== this.getCurrentPeriodDates(budget).periodStart
    ) {
      const snapshot = await withScopedDb(this.dataSource, (m) =>
        m.getRepository(BudgetPeriod).findOne({
          where: { budgetId, periodStart, periodEnd },
          relations: [
            "periodCategories",
            "periodCategories.budgetCategory",
            "periodCategories.category",
          ],
        }),
      );
      if (snapshot) {
        reportingBudget = {
          ...budget,
          incomeLinked: false,
          categories: snapshot.periodCategories.map((pc) => ({
            ...pc.budgetCategory,
            id: pc.budgetCategoryId,
            categoryId: pc.categoryId,
            category: pc.category,
            amount: Number(pc.effectiveBudget),
          })),
        };
      }
    }
    const categoryBreakdown = await this.getCachedCategoryActuals(
      userId,
      reportingBudget,
      periodStart,
      periodEnd,
    );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);
    const incomeCategories = categoryBreakdown.filter((c) => c.isIncome);

    const totalBudgeted = sumMoney(expenseCategories.map((c) => c.budgeted));
    const totalSpent = sumMoney(expenseCategories.map((c) => c.spent));
    const totalIncome = sumMoney(incomeCategories.map((c) => c.spent));
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
      totalBudgeted,
      totalSpent,
      totalIncome,
      remaining,
      percentUsed,
      incomeLinked: budget.incomeLinked,
      actualIncome,
      categoryBreakdown,
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

    return occurrences.map((occurrence) => ({
      id: occurrence.scheduledTransactionId,
      name: occurrence.schedule.name,
      amount: occurrence.amount === null ? null : Math.abs(occurrence.amount),
      currencyCode: occurrence.currencyCode,
      amountComplete: occurrence.complete,
      dueDate: occurrence.dueDate,
      categoryId: occurrence.schedule.categoryId,
    }));
  }

  @ReportingRead()
  async getVelocity(
    userId: string,
    budgetId: string,
  ): Promise<{
    dailyBurnRate: number;
    projectedTotal: number;
    budgetTotal: number;
    projectedVariance: number;
    /** `null` when `trulyAvailable` is unknown -- it is derived from it. */
    safeDailySpend: number | null;
    daysElapsed: number;
    daysRemaining: number;
    totalDays: number;
    currentSpent: number;
    paceStatus: "under" | "on_track" | "over";
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

    const categoryBreakdown = await this.getCachedCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
    );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);
    const currentSpent = sumMoney(expenseCategories.map((c) => c.spent));
    const budgetTotal = sumMoney(expenseCategories.map((c) => c.budgeted));

    const upcomingBills = await this.getUpcomingBills(userId, periodEnd);
    // Today on the caller's own clock, so the rate is the one the bills list is
    // showing rather than one from the container's timezone.
    const todayStr = todayYMD();
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

    const dailyBurnRate = currentSpent / daysElapsed;
    const projectedTotal = dailyBurnRate * totalDays;
    const projectedVariance = projectedTotal - budgetTotal;
    const remaining = roundMoney(budgetTotal - currentSpent);
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

    let paceStatus: "under" | "on_track" | "over";
    const paceRatio = budgetTotal > 0 ? projectedTotal / budgetTotal : 0;
    if (budgetTotal === 0 || paceRatio <= 0.95) {
      paceStatus = "under";
    } else if (paceRatio <= 1.05) {
      paceStatus = "on_track";
    } else {
      paceStatus = "over";
    }

    return {
      dailyBurnRate: roundMoney(dailyBurnRate),
      projectedTotal: roundMoney(projectedTotal),
      budgetTotal,
      projectedVariance: roundMoney(projectedVariance),
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

  @ReportingRead()
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
    const budgets = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Budget).find({
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

    if (budgets.length === 0) {
      return null;
    }

    const budget = budgets[0];
    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const categoryBreakdown = await this.getCachedCategoryActuals(
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

  @ReportingRead()
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
    const budgets = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Budget).find({
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

    const result = new Map<
      string,
      {
        budgeted: number;
        spent: number;
        remaining: number;
        percentUsed: number;
      }
    >();

    if (budgets.length === 0 || categoryIds.length === 0) return result;

    const budget = budgets[0];
    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const categoryBreakdown = await this.getCachedCategoryActuals(
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

  private getCurrentPeriodDates(_budget: Budget): PeriodDateRange {
    return getCurrentMonthPeriodDates();
  }

  private getCachedCategoryActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ) {
    // Recognition is retroactive. Read current facts rather than a cross-request TTL cache.
    return this.computeCategoryActuals(userId, budget, periodStart, periodEnd);
  }

  @ReportingRead()
  async computeActualIncome(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<number> {
    const incomeCategories = (budget.categories || []).filter(
      (bc) => bc.isIncome && bc.categoryId !== null,
    );

    if (incomeCategories.length === 0) return 0;

    const incomeCategoryIds = incomeCategories.map(
      (bc) => bc.categoryId as string,
    );

    const excludedAccountIds = budgetExcludedAccountIds(budget.config);
    const [directResult, splitResult] = await Promise.all([
      withScopedDb(this.dataSource, (m) =>
        reportingMoneyOne(
          m,
          userId,
          excludeBudgetAccounts(
            m
              .getRepository(Transaction)
              .createQueryBuilder("t")
              .select("COALESCE(SUM(t.amount), 0)", "total")
              .where("t.user_id = :userId", { userId })
              .andWhere("t.category_id IN (:...incomeCategoryIds)", {
                incomeCategoryIds,
              })
              .andWhere("t.transaction_date >= :periodStart", { periodStart })
              .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
              .andWhere("t.status != :void", { void: "VOID" })
              .andWhere("t.is_split = false"),
            excludedAccountIds,
          ),
          budget.currencyCode,
          false,
        ),
      ),
      withScopedDb(this.dataSource, (m) =>
        reportingMoneyOne(
          m,
          userId,
          excludeBudgetAccounts(
            m
              .getRepository(TransactionSplit)
              .createQueryBuilder("s")
              .innerJoin("s.transaction", "t")
              .select("COALESCE(SUM(s.amount), 0)", "total")
              .where("t.user_id = :userId", { userId })
              .andWhere("s.category_id IN (:...incomeCategoryIds)", {
                incomeCategoryIds,
              })
              .andWhere("t.transaction_date >= :periodStart", { periodStart })
              .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
              .andWhere("t.status != :void", { void: "VOID" }),
            excludedAccountIds,
          ),
          budget.currencyCode,
          false,
        ),
      ),
    ]);

    return Math.max(
      parseFloat(directResult?.total || "0") +
        parseFloat(splitResult?.total || "0"),
      0,
    );
  }

  private async computeCategoryActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<
    Array<{
      budgetCategoryId: string;
      categoryId: string | null;
      categoryName: string;
      budgeted: number;
      spent: number;
      remaining: number;
      percentUsed: number;
      isIncome: boolean;
      percentage: number | null;
    }>
  > {
    const budgetCategories = budget.categories || [];

    if (budgetCategories.length === 0) {
      return [];
    }

    // If income-linked, compute actual income to derive effective budgets
    let actualIncome = 0;
    if (budget.incomeLinked) {
      actualIncome = await this.computeActualIncome(
        userId,
        budget,
        periodStart,
        periodEnd,
      );
    }

    // The two spending queries share one scoped transaction so the direct and
    // split halves of a category's total come from the same snapshot.
    const { spendingMap, transferSpendingMap } = await withScopedDb(
      this.dataSource,
      (m) =>
        queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          budgetCategories,
          periodStart,
          periodEnd,
          budget.currencyCode,
        ),
    );

    return budgetCategories.map((bc) => {
      const rawAmount = Number(bc.amount);
      let budgeted: number;
      let percentage: number | null = null;

      if (budget.incomeLinked && !bc.isIncome) {
        percentage = rawAmount;
        budgeted = roundMoney((actualIncome * rawAmount) / 100);
      } else {
        budgeted = rawAmount;
      }

      const spent = resolveCategorySpent(bc, spendingMap, transferSpendingMap);
      const categoryName = resolveCategoryName(bc);
      const remaining = roundMoney(budgeted - spent);
      const percentUsed =
        budgeted > 0 ? Math.round((spent / budgeted) * 10000) / 100 : 0;

      return {
        budgetCategoryId: bc.id,
        categoryId: bc.categoryId,
        categoryName,
        budgeted,
        spent,
        remaining,
        percentUsed,
        isIncome: bc.isIncome,
        percentage,
      };
    });
  }
}
