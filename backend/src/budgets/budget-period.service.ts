import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory, RolloverType } from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";

@Injectable()
export class BudgetPeriodService {
  constructor(
    @InjectRepository(BudgetPeriod)
    private periodsRepository: Repository<BudgetPeriod>,
    @InjectRepository(BudgetPeriodCategory)
    private periodCategoriesRepository: Repository<BudgetPeriodCategory>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    private budgetsService: BudgetsService,
  ) {}

  async findAll(
    userId: string,
    budgetId: string,
  ): Promise<BudgetPeriod[]> {
    await this.budgetsService.findOne(userId, budgetId);

    return this.periodsRepository.find({
      where: { budgetId },
      order: { periodStart: "DESC" },
    });
  }

  async findOne(
    userId: string,
    budgetId: string,
    periodId: string,
  ): Promise<BudgetPeriod> {
    await this.budgetsService.findOne(userId, budgetId);

    const period = await this.periodsRepository.findOne({
      where: { id: periodId, budgetId },
      relations: ["periodCategories", "periodCategories.budgetCategory", "periodCategories.category"],
    });

    if (!period) {
      throw new NotFoundException(
        `Budget period with ID ${periodId} not found`,
      );
    }

    return period;
  }

  async closePeriod(
    userId: string,
    budgetId: string,
  ): Promise<BudgetPeriod> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const openPeriod = await this.periodsRepository.findOne({
      where: { budgetId, status: PeriodStatus.OPEN },
      relations: ["periodCategories"],
    });

    if (!openPeriod) {
      throw new BadRequestException("No open period to close");
    }

    const actuals = await this.computePeriodActuals(
      userId,
      budget,
      openPeriod.periodStart,
      openPeriod.periodEnd,
    );

    let totalIncome = 0;
    let totalExpenses = 0;

    for (const pc of openPeriod.periodCategories) {
      const actual = actuals.get(pc.budgetCategoryId) || 0;
      pc.actualAmount = actual;

      const rollover = this.computeRollover(pc, actual);
      pc.rolloverOut = rollover;

      const bcEntry = budget.categories?.find(
        (c) => c.id === pc.budgetCategoryId,
      );
      if (bcEntry?.isIncome) {
        totalIncome += actual;
      } else {
        totalExpenses += actual;
      }

      await this.periodCategoriesRepository.save(pc);
    }

    openPeriod.actualIncome = totalIncome;
    openPeriod.actualExpenses = totalExpenses;
    openPeriod.status = PeriodStatus.CLOSED;

    const closedPeriod = await this.periodsRepository.save(openPeriod);

    await this.createNextPeriod(budget, openPeriod);

    return closedPeriod;
  }

  async getOrCreateCurrentPeriod(
    userId: string,
    budgetId: string,
  ): Promise<BudgetPeriod> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    const existingOpen = await this.periodsRepository.findOne({
      where: { budgetId, status: PeriodStatus.OPEN },
      relations: ["periodCategories"],
    });

    if (existingOpen) {
      return existingOpen;
    }

    return this.createPeriodForBudget(budget);
  }

  async createPeriodForBudget(
    budget: Budget,
    rolloverMap?: Map<string, number>,
  ): Promise<BudgetPeriod> {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();

    const periodStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const periodEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const budgetCategories = budget.categories || [];

    const totalBudgeted = budgetCategories
      .filter((bc) => !bc.isIncome)
      .reduce((sum, bc) => sum + Number(bc.amount), 0);

    const period = this.periodsRepository.create({
      budgetId: budget.id,
      periodStart,
      periodEnd,
      totalBudgeted,
      status: PeriodStatus.OPEN,
    });

    const savedPeriod = await this.periodsRepository.save(period);

    for (const bc of budgetCategories) {
      const rolloverIn = rolloverMap?.get(bc.id) || 0;
      const budgetedAmount = Number(bc.amount);
      const effectiveBudget = budgetedAmount + rolloverIn;

      const periodCategory = this.periodCategoriesRepository.create({
        budgetPeriodId: savedPeriod.id,
        budgetCategoryId: bc.id,
        categoryId: bc.categoryId,
        budgetedAmount,
        rolloverIn,
        effectiveBudget,
        actualAmount: 0,
        rolloverOut: 0,
      });

      await this.periodCategoriesRepository.save(periodCategory);
    }

    return savedPeriod;
  }

  computeRollover(
    periodCategory: BudgetPeriodCategory,
    actualAmount: number,
  ): number {
    const budgetCategory = periodCategory.budgetCategory;
    if (!budgetCategory || budgetCategory.rolloverType === RolloverType.NONE) {
      return 0;
    }

    const effectiveBudget = Number(periodCategory.effectiveBudget);
    const unused = effectiveBudget - actualAmount;

    if (unused <= 0) {
      return 0;
    }

    let rollover = unused;

    if (budgetCategory.rolloverCap !== null && budgetCategory.rolloverCap !== undefined) {
      rollover = Math.min(rollover, Number(budgetCategory.rolloverCap));
    }

    return Math.round(rollover * 10000) / 10000;
  }

  private async createNextPeriod(
    budget: Budget,
    closedPeriod: BudgetPeriod,
  ): Promise<BudgetPeriod> {
    const rolloverMap = new Map<string, number>();

    if (closedPeriod.periodCategories) {
      for (const pc of closedPeriod.periodCategories) {
        if (pc.rolloverOut > 0) {
          rolloverMap.set(pc.budgetCategoryId, Number(pc.rolloverOut));
        }
      }
    }

    return this.createPeriodForBudget(budget, rolloverMap);
  }

  private async computePeriodActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<Map<string, number>> {
    const budgetCategories = budget.categories || [];
    const categoryIds = budgetCategories
      .filter((bc) => bc.categoryId !== null)
      .map((bc) => bc.categoryId as string);

    const result = new Map<string, number>();

    if (categoryIds.length === 0) {
      return result;
    }

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

    const spendingByCategoryId = new Map<string, number>();
    for (const row of directSpending) {
      spendingByCategoryId.set(row.categoryId, parseFloat(row.total || "0"));
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
      const existing = spendingByCategoryId.get(row.categoryId) || 0;
      spendingByCategoryId.set(
        row.categoryId,
        existing + parseFloat(row.total || "0"),
      );
    }

    for (const bc of budgetCategories) {
      if (bc.categoryId) {
        const amount = spendingByCategoryId.get(bc.categoryId) || 0;
        result.set(bc.id, amount);
      }
    }

    return result;
  }
}
