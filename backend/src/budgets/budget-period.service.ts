import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { Budget } from "./entities/budget.entity";
import { RolloverType } from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import { getCurrentMonthPeriodDates } from "./budget-date.utils";

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
    private dataSource: DataSource,
  ) {}

  async findAll(userId: string, budgetId: string): Promise<BudgetPeriod[]> {
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
      relations: [
        "periodCategories",
        "periodCategories.budgetCategory",
        "periodCategories.category",
      ],
    });

    if (!period) {
      throw new NotFoundException(
        `Budget period with ID ${periodId} not found`,
      );
    }

    return period;
  }

  async closePeriod(userId: string, budgetId: string): Promise<BudgetPeriod> {
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

    // M26: Wrap period close in QueryRunner transaction for atomicity
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
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

        await queryRunner.manager.save(BudgetPeriodCategory, pc);
      }

      openPeriod.actualIncome = totalIncome;
      openPeriod.actualExpenses = totalExpenses;
      openPeriod.status = PeriodStatus.CLOSED;

      const closedPeriod = await queryRunner.manager.save(
        BudgetPeriod,
        openPeriod,
      );

      await this.createNextPeriod(budget, openPeriod, queryRunner);

      await queryRunner.commitTransaction();
      return closedPeriod;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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
    queryRunner?: import("typeorm").QueryRunner,
  ): Promise<BudgetPeriod> {
    const { periodStart, periodEnd } = getCurrentMonthPeriodDates();

    const budgetCategories = budget.categories || [];

    const totalBudgeted = budgetCategories
      .filter((bc) => !bc.isIncome)
      .reduce((sum, bc) => sum + Number(bc.amount), 0);

    const periodsRepo = queryRunner
      ? queryRunner.manager.getRepository(BudgetPeriod)
      : this.periodsRepository;
    const periodCatsRepo = queryRunner
      ? queryRunner.manager.getRepository(BudgetPeriodCategory)
      : this.periodCategoriesRepository;

    const period = periodsRepo.create({
      budgetId: budget.id,
      periodStart,
      periodEnd,
      totalBudgeted,
      status: PeriodStatus.OPEN,
    });

    const savedPeriod = await periodsRepo.save(period);

    const periodCategories = budgetCategories.map((bc) => {
      const rolloverIn = rolloverMap?.get(bc.id) || 0;
      const budgetedAmount = Number(bc.amount);
      const effectiveBudget = budgetedAmount + rolloverIn;

      return periodCatsRepo.create({
        budgetPeriodId: savedPeriod.id,
        budgetCategoryId: bc.id,
        categoryId: bc.categoryId,
        budgetedAmount,
        rolloverIn,
        effectiveBudget,
        actualAmount: 0,
        rolloverOut: 0,
      });
    });

    if (periodCategories.length > 0) {
      await periodCatsRepo.save(periodCategories);
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

    if (
      budgetCategory.rolloverCap !== null &&
      budgetCategory.rolloverCap !== undefined
    ) {
      rollover = Math.min(rollover, Number(budgetCategory.rolloverCap));
    }

    return Math.round(rollover * 10000) / 10000;
  }

  private async createNextPeriod(
    budget: Budget,
    closedPeriod: BudgetPeriod,
    queryRunner?: import("typeorm").QueryRunner,
  ): Promise<BudgetPeriod> {
    const rolloverMap = new Map<string, number>();

    if (closedPeriod.periodCategories) {
      for (const pc of closedPeriod.periodCategories) {
        if (pc.rolloverOut > 0) {
          rolloverMap.set(pc.budgetCategoryId, Number(pc.rolloverOut));
        }
      }
    }

    return this.createPeriodForBudget(budget, rolloverMap, queryRunner);
  }

  private async computePeriodActuals(
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<Map<string, number>> {
    const budgetCategories = budget.categories || [];
    const categoryIds = budgetCategories
      .filter((bc) => bc.categoryId !== null && !bc.isTransfer)
      .map((bc) => bc.categoryId as string);

    const result = new Map<string, number>();

    const spendingByCategoryId = new Map<string, number>();

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
    }

    // Transfer actuals
    const transferBudgetCategories = budgetCategories.filter(
      (bc) => bc.isTransfer && bc.transferAccountId,
    );
    const transferSpendingMap = new Map<string, number>();

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

    for (const bc of budgetCategories) {
      if (bc.isTransfer && bc.transferAccountId) {
        const amount = transferSpendingMap.get(bc.transferAccountId) || 0;
        result.set(bc.id, amount);
      } else if (bc.categoryId) {
        const amount = spendingByCategoryId.get(bc.categoryId) || 0;
        result.set(bc.id, amount);
      }
    }

    return result;
  }
}
