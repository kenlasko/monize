import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { Budget } from "./entities/budget.entity";
import { RolloverType } from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetsService } from "./budgets.service";
import {
  getCurrentMonthPeriodDates,
  getFollowingMonthPeriodDates,
  PeriodDateRange,
} from "./budget-date.utils";
import {
  queryCategorySpending,
  resolveCategorySpent,
} from "./budget-spending.util";
import { roundMoney, sumMoney } from "../common/round.util";

/**
 * "There is no OPEN period to close."
 *
 * A `BadRequestException` still -- the HTTP surface answers 400 with the same
 * translated message as before -- but a *named* one, because the monthly cron
 * has to tell this apart from a genuine failure. It is what the loser of the
 * row lock above sees when another replica closed the period first, and
 * counting a normal two-process tick as an error is the gap F3 recorded.
 *
 * The distinction is carried by the type rather than by the message: `tr`
 * translates, so matching on the text would be matching on copy.
 */
export class NoOpenPeriodError extends BadRequestException {
  constructor() {
    super(tr("errors.budgets.noOpenPeriod", "No open period to close"));
  }
}

@Injectable()
export class BudgetPeriodService {
  constructor(
    private budgetsService: BudgetsService,
    private dataSource: DataSource,
  ) {}

  async findAll(userId: string, budgetId: string): Promise<BudgetPeriod[]> {
    await this.budgetsService.findOne(userId, budgetId);

    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).find({
        where: { budgetId },
        order: { periodStart: "DESC" },
      }),
    );
  }

  async findOne(
    userId: string,
    budgetId: string,
    periodId: string,
  ): Promise<BudgetPeriod> {
    await this.budgetsService.findOne(userId, budgetId);

    const period = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(BudgetPeriod).findOne({
        where: { id: periodId, budgetId },
        relations: [
          "periodCategories",
          "periodCategories.budgetCategory",
          "periodCategories.category",
        ],
      }),
    );

    if (!period) {
      throw new NotFoundException(
        tr(
          "errors.budgets.periodNotFound",
          `Budget period with ID ${periodId} not found`,
          { id: periodId },
        ),
      );
    }

    return period;
  }

  async closePeriod(userId: string, budgetId: string): Promise<BudgetPeriod> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    // M26: the whole period close is one transaction, so a partial failure can
    // never leave a period half-closed.
    //
    // And it is one transaction from the *read* onwards, not just from the write.
    // The open period, the ledger the actuals come from, and the write that
    // freezes them used to be three separate transactions: a transaction
    // committing into the period's date range between the second and the third
    // was left out of the closing figures for good, since a closed period is
    // never recomputed. The period row is locked first so a second close cannot
    // interleave -- the monthly cron fires on every replica, and both replicas
    // find the same OPEN period.
    return withScopedDb(this.dataSource, async (manager) => {
      const periods = manager.getRepository(BudgetPeriod);
      // Two queries, not one, and deliberately so: TypeORM turns `relations`
      // into a LEFT JOIN, and PostgreSQL rejects `FOR UPDATE` over the nullable
      // side of an outer join ("FOR UPDATE cannot be applied to the nullable
      // side of an outer join"). Asking for both in a single `findOne` made
      // every close fail, cron and manual alike. Lock the period row by itself,
      // then load its categories inside the same transaction -- the lock is
      // already held, so the second read cannot see a different period.
      const locked = await periods.findOne({
        where: { budgetId, status: PeriodStatus.OPEN },
        lock: { mode: "pessimistic_write" },
      });

      if (!locked) {
        // Either there never was one, or another replica closed it while this
        // call was waiting for the lock. Both are "nothing to do here", and the
        // caller reports it as a skip rather than an error.
        throw new NoOpenPeriodError();
      }

      // `periodCategories.budgetCategory` carries the line's rollover setting,
      // which `computeRollover` reads: without it every close wrote a zero
      // rollover (audit A26-M32). No lock on this read, so the join is allowed.
      const openPeriod = await periods.findOne({
        where: { id: locked.id },
        relations: ["periodCategories", "periodCategories.budgetCategory"],
      });
      if (!openPeriod) {
        // The row was locked a statement ago, so this cannot happen without the
        // period being deleted underneath the lock. Refuse rather than carry on
        // with the unhydrated copy: `periodCategories` would be undefined and
        // the close would silently write a period with no category actuals.
        throw new NoOpenPeriodError();
      }

      const actuals = await this.computePeriodActuals(
        manager,
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

        await manager.save(BudgetPeriodCategory, pc);
      }

      openPeriod.actualIncome = totalIncome;
      openPeriod.actualExpenses = totalExpenses;
      openPeriod.status = PeriodStatus.CLOSED;

      const closedPeriod = await manager.save(BudgetPeriod, openPeriod);

      await this.createNextPeriod(budget, openPeriod, manager);

      return closedPeriod;
    });
  }

  async getOrCreateCurrentPeriod(
    userId: string,
    budgetId: string,
  ): Promise<BudgetPeriod> {
    const budget = await this.budgetsService.findOne(userId, budgetId);

    // "Find one, and create it if absent" is a check-then-act, and this one is
    // reached by an ordinary page load: opening the Budgets screen for the first
    // time this month fires several requests, they all find no open period, and
    // they all insert. `UNIQUE(budget_id, period_start)` stops the duplicate row,
    // but the loser used to surface as a 500 on a screen that was simply being
    // opened. One transaction, and the insert tolerates losing.
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(BudgetPeriod);
      const existingOpen = await repo.findOne({
        where: { budgetId, status: PeriodStatus.OPEN },
        relations: ["periodCategories"],
      });

      if (existingOpen) {
        return existingOpen;
      }

      return this.createPeriodForBudget(budget, undefined, manager);
    });
  }

  /**
   * @param manager the caller's transaction when the new period must commit
   *   with the close that produced it; otherwise a scoped one is opened here.
   * @param dates the period to create; the current calendar month unless the
   *   caller derives it from the period it closed.
   */
  async createPeriodForBudget(
    budget: Budget,
    rolloverMap?: Map<string, number>,
    manager?: EntityManager,
    dates: PeriodDateRange = getCurrentMonthPeriodDates(),
  ): Promise<BudgetPeriod> {
    const { periodStart, periodEnd } = dates;

    const budgetCategories = budget.categories || [];

    const totalBudgeted = sumMoney(
      budgetCategories
        .filter((bc) => !bc.isIncome)
        .map((bc) => Number(bc.amount)),
    );

    const write = async (m: EntityManager): Promise<BudgetPeriod> => {
      const periodsRepo = m.getRepository(BudgetPeriod);
      const periodCatsRepo = m.getRepository(BudgetPeriodCategory);

      // `UNIQUE(budget_id, period_start)` decides who creates this month's
      // period, and the loser must be able to carry on: inside a transaction a
      // unique violation aborts everything, so a plain insert would turn a lost
      // race into a failed request rather than into "somebody else made it".
      const claimed: unknown = await m.query(
        `INSERT INTO budget_periods
           (budget_id, period_start, period_end, total_budgeted, status)
         VALUES ($1, $2::DATE, $3::DATE, $4, $5)
         ON CONFLICT (budget_id, period_start) DO NOTHING
         RETURNING id`,
        [budget.id, periodStart, periodEnd, totalBudgeted, PeriodStatus.OPEN],
      );

      if (returnedRows<{ id: string }>(claimed).length === 0) {
        // Somebody else created it. Return theirs, categories included, rather
        // than a period this call believes it made -- and do not write category
        // rows, which they have already written.
        const existing = await periodsRepo.findOne({
          where: { budgetId: budget.id, periodStart },
          relations: ["periodCategories"],
        });
        if (!existing) {
          throw new Error(
            `budget_periods insert for budget ${budget.id} conflicted but no row exists for ${periodStart}`,
          );
        }
        return existing;
      }

      const savedPeriod = await periodsRepo.findOneOrFail({
        where: { budgetId: budget.id, periodStart },
      });

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
    };

    return manager ? write(manager) : withScopedDb(this.dataSource, write);
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

    return roundMoney(rollover);
  }

  private async createNextPeriod(
    budget: Budget,
    closedPeriod: BudgetPeriod,
    manager?: EntityManager,
  ): Promise<BudgetPeriod> {
    const rolloverMap = new Map<string, number>();

    if (closedPeriod.periodCategories) {
      for (const pc of closedPeriod.periodCategories) {
        if (pc.rolloverOut > 0) {
          rolloverMap.set(pc.budgetCategoryId, Number(pc.rolloverOut));
        }
      }
    }

    // The month after the closed one, not the current month: a close before
    // the period ends would otherwise "create" the month it just closed, hit
    // ON CONFLICT, and leave the budget with no OPEN period (audit A26-L38).
    return this.createPeriodForBudget(
      budget,
      rolloverMap,
      manager,
      getFollowingMonthPeriodDates(closedPeriod.periodEnd),
    );
  }

  /**
   * The period's actuals per budget line, through the same query as the live
   * budget page (`queryCategorySpending`): converted into the budget's
   * currency, without the accounts the budget excludes, and read on the
   * close's own transaction so the frozen figures are the ones it locked.
   *
   * A line with a row that had no rate freezes its converted part; the
   * `actual_amount` column has no "unknown" (residual of A26-H12).
   */
  private async computePeriodActuals(
    manager: EntityManager,
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<Map<string, number>> {
    const budgetCategories = budget.categories || [];
    const { spendingMap, transferSpendingMap } = await queryCategorySpending(
      manager.getRepository(Transaction),
      manager.getRepository(TransactionSplit),
      userId,
      budgetCategories,
      periodStart,
      periodEnd,
      undefined,
      "cash",
    );

    const result = new Map<string, number>();
    for (const bc of budgetCategories) {
      if ((bc.isTransfer && bc.transferAccountId) || bc.categoryId) {
        result.set(
          bc.id,
          resolveCategorySpent(bc, spendingMap, transferSpendingMap),
        );
      }
    }
    return result;
  }
}
