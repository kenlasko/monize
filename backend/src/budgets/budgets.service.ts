import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import {
  BudgetAlert,
  AlertType,
  AlertSeverity,
} from "./entities/budget-alert.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";
import { CreateBudgetCategoryDto } from "./dto/create-budget-category.dto";
import { UpdateBudgetCategoryDto } from "./dto/update-budget-category.dto";
import { BulkCategoryAmountDto } from "./dto/bulk-update-budget-categories.dto";
import {
  getCurrentMonthPeriodDates,
  PeriodDateRange,
} from "./budget-date.utils";

export interface UpcomingBill {
  id: string;
  name: string;
  amount: number;
  dueDate: string;
  categoryId: string | null;
}

@Injectable()
export class BudgetsService {
  constructor(
    @InjectRepository(Budget)
    private budgetsRepository: Repository<Budget>,
    @InjectRepository(BudgetCategory)
    private budgetCategoriesRepository: Repository<BudgetCategory>,
    @InjectRepository(BudgetAlert)
    private budgetAlertsRepository: Repository<BudgetAlert>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
  ) {}

  async create(
    userId: string,
    createBudgetDto: CreateBudgetDto,
  ): Promise<Budget> {
    const budget = this.budgetsRepository.create({
      ...createBudgetDto,
      userId,
    });

    return this.budgetsRepository.save(budget);
  }

  async findAll(userId: string): Promise<Budget[]> {
    return this.budgetsRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
      relations: ["categories"],
    });
  }

  async findOne(userId: string, id: string): Promise<Budget> {
    const budget = await this.budgetsRepository.findOne({
      where: { id, userId },
      relations: [
        "categories",
        "categories.category",
        "categories.category.parent",
        "categories.transferAccount",
      ],
    });

    if (!budget) {
      throw new NotFoundException(`Budget with ID ${id} not found`);
    }

    return budget;
  }

  async update(
    userId: string,
    id: string,
    updateBudgetDto: UpdateBudgetDto,
  ): Promise<Budget> {
    const budget = await this.findOne(userId, id);

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

    return this.budgetsRepository.save(budget);
  }

  async remove(userId: string, id: string): Promise<void> {
    const budget = await this.findOne(userId, id);
    await this.budgetsRepository.remove(budget);
  }

  async addCategory(
    userId: string,
    budgetId: string,
    dto: CreateBudgetCategoryDto,
  ): Promise<BudgetCategory> {
    const budget = await this.findOne(userId, budgetId);

    const category = await this.categoriesRepository.findOne({
      where: { id: dto.categoryId, userId },
    });

    if (!category) {
      throw new NotFoundException(
        `Category with ID ${dto.categoryId} not found`,
      );
    }

    const existing = await this.budgetCategoriesRepository.findOne({
      where: { budgetId: budget.id, categoryId: dto.categoryId },
    });

    if (existing) {
      throw new BadRequestException("This category is already in the budget");
    }

    const budgetCategory = this.budgetCategoriesRepository.create({
      ...dto,
      budgetId: budget.id,
    });

    return this.budgetCategoriesRepository.save(budgetCategory);
  }

  async updateCategory(
    userId: string,
    budgetId: string,
    categoryId: string,
    dto: UpdateBudgetCategoryDto,
  ): Promise<BudgetCategory> {
    await this.findOne(userId, budgetId);

    const budgetCategory = await this.budgetCategoriesRepository.findOne({
      where: { id: categoryId, budgetId },
    });

    if (!budgetCategory) {
      throw new NotFoundException(
        `Budget category with ID ${categoryId} not found`,
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

    return this.budgetCategoriesRepository.save(budgetCategory);
  }

  async removeCategory(
    userId: string,
    budgetId: string,
    categoryId: string,
  ): Promise<void> {
    await this.findOne(userId, budgetId);

    const budgetCategory = await this.budgetCategoriesRepository.findOne({
      where: { id: categoryId, budgetId },
    });

    if (!budgetCategory) {
      throw new NotFoundException(
        `Budget category with ID ${categoryId} not found`,
      );
    }

    await this.budgetCategoriesRepository.remove(budgetCategory);
  }

  async bulkUpdateCategories(
    userId: string,
    budgetId: string,
    categories: BulkCategoryAmountDto[],
  ): Promise<BudgetCategory[]> {
    await this.findOne(userId, budgetId);

    const results: BudgetCategory[] = [];

    for (const item of categories) {
      const budgetCategory = await this.budgetCategoriesRepository.findOne({
        where: { id: item.id, budgetId },
      });

      if (!budgetCategory) {
        throw new NotFoundException(
          `Budget category with ID ${item.id} not found`,
        );
      }

      budgetCategory.amount = item.amount;
      results.push(await this.budgetCategoriesRepository.save(budgetCategory));
    }

    return results;
  }

  async getSummary(
    userId: string,
    budgetId: string,
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

    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const categoryBreakdown = await this.computeCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
    );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);
    const incomeCategories = categoryBreakdown.filter((c) => c.isIncome);

    const totalBudgeted = expenseCategories.reduce(
      (sum, c) => sum + c.budgeted,
      0,
    );
    const totalSpent = expenseCategories.reduce((sum, c) => sum + c.spent, 0);
    const totalIncome = incomeCategories.reduce((sum, c) => sum + c.spent, 0);
    const remaining = totalBudgeted - totalSpent;
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

  async getUpcomingBills(
    userId: string,
    periodEnd: string,
  ): Promise<UpcomingBill[]> {
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    const scheduledTransactions = await this.scheduledTransactionsRepository
      .createQueryBuilder("st")
      .where("st.user_id = :userId", { userId })
      .andWhere("st.is_active = true")
      .andWhere("st.amount < 0")
      .andWhere("st.next_due_date >= :todayStr", { todayStr })
      .andWhere("st.next_due_date <= :periodEnd", { periodEnd })
      .orderBy("st.next_due_date", "ASC")
      .getMany();

    return scheduledTransactions.map((st) => ({
      id: st.id,
      name: st.name,
      amount: Math.abs(Number(st.amount)),
      dueDate:
        typeof st.nextDueDate === "string"
          ? st.nextDueDate
          : (st.nextDueDate as Date).toISOString().split("T")[0],
      categoryId: st.categoryId,
    }));
  }

  async getVelocity(
    userId: string,
    budgetId: string,
  ): Promise<{
    dailyBurnRate: number;
    projectedTotal: number;
    budgetTotal: number;
    projectedVariance: number;
    safeDailySpend: number;
    daysElapsed: number;
    daysRemaining: number;
    totalDays: number;
    currentSpent: number;
    paceStatus: "under" | "on_track" | "over";
    upcomingBills: UpcomingBill[];
    totalUpcomingBills: number;
    trulyAvailable: number;
  }> {
    const budget = await this.findOne(userId, budgetId);
    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const today = new Date();
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);

    const totalDays = Math.ceil(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const daysElapsed = Math.max(
      1,
      Math.ceil(
        (today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );
    const daysRemaining = Math.max(0, totalDays - daysElapsed);

    const categoryBreakdown = await this.computeCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
    );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);
    const currentSpent = expenseCategories.reduce((sum, c) => sum + c.spent, 0);
    const budgetTotal = expenseCategories.reduce(
      (sum, c) => sum + c.budgeted,
      0,
    );

    const upcomingBills = await this.getUpcomingBills(userId, periodEnd);
    const totalUpcomingBills = upcomingBills.reduce(
      (sum, b) => sum + b.amount,
      0,
    );

    const dailyBurnRate = currentSpent / daysElapsed;
    const projectedTotal = dailyBurnRate * totalDays;
    const projectedVariance = projectedTotal - budgetTotal;
    const remaining = budgetTotal - currentSpent;
    const trulyAvailable = remaining - totalUpcomingBills;
    const safeDailySpend =
      daysRemaining > 0 ? Math.max(0, trulyAvailable / daysRemaining) : 0;

    let paceStatus: "under" | "on_track" | "over";
    const paceRatio = projectedTotal / budgetTotal;
    if (budgetTotal === 0 || paceRatio <= 0.95) {
      paceStatus = "under";
    } else if (paceRatio <= 1.05) {
      paceStatus = "on_track";
    } else {
      paceStatus = "over";
    }

    return {
      dailyBurnRate: Math.round(dailyBurnRate * 100) / 100,
      projectedTotal: Math.round(projectedTotal * 100) / 100,
      budgetTotal,
      projectedVariance: Math.round(projectedVariance * 100) / 100,
      safeDailySpend: Math.round(safeDailySpend * 100) / 100,
      daysElapsed,
      daysRemaining,
      totalDays,
      currentSpent,
      paceStatus,
      upcomingBills,
      totalUpcomingBills: Math.round(totalUpcomingBills * 100) / 100,
      trulyAvailable: Math.round(trulyAvailable * 100) / 100,
    };
  }

  async getAlerts(userId: string, unreadOnly = false): Promise<BudgetAlert[]> {
    const where: Record<string, unknown> = { userId };
    if (unreadOnly) {
      where.isRead = false;
    }

    const budgetAlerts = await this.budgetAlertsRepository.find({
      where,
      order: { createdAt: "DESC" },
      take: 50,
    });

    // Include upcoming manual bills (not auto-paid) due within 7 days
    if (!unreadOnly) {
      const billAlerts = await this.getUpcomingBillAlerts(userId);
      const combined = [...billAlerts, ...budgetAlerts];
      combined.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      return combined.slice(0, 50);
    }

    return budgetAlerts;
  }

  private async getUpcomingBillAlerts(userId: string): Promise<BudgetAlert[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split("T")[0];

    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + 7);
    const horizonStr = horizon.toISOString().split("T")[0];

    const manualBills = await this.scheduledTransactionsRepository
      .createQueryBuilder("st")
      .leftJoinAndSelect("st.payee", "payee")
      .where("st.user_id = :userId", { userId })
      .andWhere("st.is_active = true")
      .andWhere("st.auto_post = false")
      .andWhere("st.next_due_date >= :todayStr", { todayStr })
      .andWhere("st.next_due_date <= :horizonStr", { horizonStr })
      .orderBy("st.next_due_date", "ASC")
      .getMany();

    return manualBills.map((bill) => {
      const dueDate =
        typeof bill.nextDueDate === "string"
          ? bill.nextDueDate
          : (bill.nextDueDate as Date).toISOString().split("T")[0];
      const payeeName = bill.payee?.name || bill.payeeName || bill.name;
      const amount = Math.abs(Number(bill.amount));
      const daysUntilDue = Math.ceil(
        (new Date(dueDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      const severity =
        daysUntilDue <= 1 ? AlertSeverity.WARNING : AlertSeverity.INFO;

      const alert = new BudgetAlert();
      alert.id = `bill-${bill.id}`;
      alert.userId = userId;
      alert.budgetId = "";
      alert.budgetCategoryId = null;
      alert.alertType = AlertType.BILL_DUE;
      alert.severity = severity;
      alert.title = `${payeeName} due${daysUntilDue === 0 ? " today" : daysUntilDue === 1 ? " tomorrow" : ` in ${daysUntilDue} days`}`;
      alert.message = `${bill.currencyCode} ${amount.toFixed(2)} due on ${dueDate}`;
      alert.data = {
        billId: bill.id,
        payeeName,
        amount,
        dueDate,
        currencyCode: bill.currencyCode,
      };
      alert.isRead = false;
      alert.isEmailSent = false;
      alert.periodStart = todayStr;
      alert.createdAt = new Date();
      return alert;
    });
  }

  async markAlertRead(userId: string, alertId: string): Promise<BudgetAlert> {
    const alert = await this.budgetAlertsRepository.findOne({
      where: { id: alertId, userId },
    });

    if (!alert) {
      throw new NotFoundException(`Alert with ID ${alertId} not found`);
    }

    alert.isRead = true;
    return this.budgetAlertsRepository.save(alert);
  }

  async deleteAlert(userId: string, alertId: string): Promise<void> {
    const alert = await this.budgetAlertsRepository.findOne({
      where: { id: alertId, userId },
    });

    if (!alert) {
      throw new NotFoundException(`Alert with ID ${alertId} not found`);
    }

    await this.budgetAlertsRepository.remove(alert);
  }

  async markAllAlertsRead(userId: string): Promise<{ updated: number }> {
    const result = await this.budgetAlertsRepository.update(
      { userId, isRead: false },
      { isRead: true },
    );

    return { updated: result.affected || 0 };
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
    const budgets = await this.budgetsRepository.find({
      where: { userId, isActive: true },
      relations: [
        "categories",
        "categories.category",
        "categories.category.parent",
        "categories.transferAccount",
      ],
      order: { createdAt: "DESC" },
    });

    if (budgets.length === 0) {
      return null;
    }

    const budget = budgets[0];
    const { periodStart, periodEnd } = this.getCurrentPeriodDates(budget);

    const categoryBreakdown = await this.computeCategoryActuals(
      userId,
      budget,
      periodStart,
      periodEnd,
    );

    const expenseCategories = categoryBreakdown.filter((c) => !c.isIncome);

    const totalBudgeted = expenseCategories.reduce(
      (sum, c) => sum + c.budgeted,
      0,
    );
    const totalSpent = expenseCategories.reduce((sum, c) => sum + c.spent, 0);
    const remaining = totalBudgeted - totalSpent;
    const percentUsed =
      totalBudgeted > 0
        ? Math.round((totalSpent / totalBudgeted) * 10000) / 100
        : 0;

    const today = new Date();
    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);
    const totalDays = Math.ceil(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
    );
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
      safeDailySpend: Math.round(safeDailySpend * 100) / 100,
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
    const budgets = await this.budgetsRepository.find({
      where: { userId, isActive: true },
      relations: [
        "categories",
        "categories.category",
        "categories.category.parent",
        "categories.transferAccount",
      ],
      order: { createdAt: "DESC" },
    });

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

    const categoryBreakdown = await this.computeCategoryActuals(
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

    const directResult = await this.transactionsRepository
      .createQueryBuilder("t")
      .select("COALESCE(SUM(ABS(t.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.category_id IN (:...incomeCategoryIds)", {
        incomeCategoryIds,
      })
      .andWhere("t.transaction_date >= :periodStart", { periodStart })
      .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("t.is_split = false")
      .getRawOne();

    const splitResult = await this.splitsRepository
      .createQueryBuilder("s")
      .innerJoin("s.transaction", "t")
      .select("COALESCE(SUM(ABS(s.amount)), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("s.category_id IN (:...incomeCategoryIds)", {
        incomeCategoryIds,
      })
      .andWhere("t.transaction_date >= :periodStart", { periodStart })
      .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
      .andWhere("t.status != :void", { void: "VOID" })
      .getRawOne();

    return (
      parseFloat(directResult?.total || "0") +
      parseFloat(splitResult?.total || "0")
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

    const categoryIds = budgetCategories
      .filter((bc) => bc.categoryId !== null)
      .map((bc) => bc.categoryId as string);

    const spendingMap = new Map<string, number>();

    if (categoryIds.length > 0) {
      const directSpending = await this.transactionsRepository
        .createQueryBuilder("t")
        .select("t.category_id", "categoryId")
        .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .andWhere("t.is_split = false")
        .groupBy("t.category_id")
        .getRawMany();

      for (const row of directSpending) {
        spendingMap.set(row.categoryId, parseFloat(row.total || "0"));
      }

      const splitSpending = await this.splitsRepository
        .createQueryBuilder("s")
        .innerJoin("s.transaction", "t")
        .select("s.category_id", "categoryId")
        .addSelect("COALESCE(SUM(ABS(s.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .groupBy("s.category_id")
        .getRawMany();

      for (const row of splitSpending) {
        const existing = spendingMap.get(row.categoryId) || 0;
        spendingMap.set(
          row.categoryId,
          existing + parseFloat(row.total || "0"),
        );
      }
    }

    // Transfer actuals
    const transferSpendingMap = new Map<string, number>();
    const transferBudgetCategories = budgetCategories.filter(
      (bc) => bc.isTransfer && bc.transferAccountId,
    );

    if (transferBudgetCategories.length > 0) {
      const transferAccountIds = transferBudgetCategories.map(
        (bc) => bc.transferAccountId as string,
      );

      const transferActuals = await this.transactionsRepository
        .createQueryBuilder("t")
        .innerJoin("t.linkedTransaction", "lt")
        .select("lt.account_id", "destinationAccountId")
        .addSelect("COALESCE(SUM(ABS(t.amount)), 0)", "total")
        .where("t.user_id = :userId", { userId })
        .andWhere("t.is_transfer = true")
        .andWhere("t.amount < 0")
        .andWhere("lt.account_id IN (:...transferAccountIds)", {
          transferAccountIds,
        })
        .andWhere("t.transaction_date >= :periodStart", { periodStart })
        .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
        .andWhere("t.status != :void", { void: "VOID" })
        .groupBy("lt.account_id")
        .getRawMany();

      for (const row of transferActuals) {
        transferSpendingMap.set(
          row.destinationAccountId,
          parseFloat(row.total || "0"),
        );
      }
    }

    return budgetCategories.map((bc) => {
      const rawAmount = Number(bc.amount);
      let budgeted: number;
      let percentage: number | null = null;

      if (budget.incomeLinked && !bc.isIncome) {
        percentage = rawAmount;
        budgeted = Math.round(((actualIncome * rawAmount) / 100) * 100) / 100;
      } else {
        budgeted = rawAmount;
      }

      let spent = 0;
      let categoryName: string;

      if (bc.isTransfer && bc.transferAccountId) {
        spent = transferSpendingMap.get(bc.transferAccountId) || 0;
        categoryName = bc.transferAccount?.name || "Transfer";
      } else {
        spent = bc.categoryId ? spendingMap.get(bc.categoryId) || 0 : 0;
        const cat = bc.category;
        categoryName = cat
          ? cat.parent
            ? `${cat.parent.name} > ${cat.name}`
            : cat.name
          : "Uncategorized";
      }

      const remaining = budgeted - spent;
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
