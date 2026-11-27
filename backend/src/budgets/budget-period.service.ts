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
import { effectiveLineBudget } from "./budget-rollover.util";
import { BudgetBucket } from "./entities/budget-bucket.entity";
import { BudgetPeriodBucket } from "./entities/budget-period-bucket.entity";
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
  resolveBudgetIncome,
  resolveBudgetLineBudgeted,
  resolveCategorySpent,
  resolveOutsideTransferIncome,
} from "./budget-spending.util";
import { roundMoney, sumMoney } from "../common/round.util";
import {
  loadCurrencyPlaces,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import {
  buildBudgetBucketFiguresInput,
  computeBudgetBucketFigures,
} from "./budget-bucket-figures.util";

/** The close's actuals: per line, and the income an income-linked line reads. */
interface PeriodActuals {
  /** Signed net per budget line id, as `resolveCategorySpent` returns it. */
  lines: Map<string, number>;
  /** The income `config.transfersInAsIncome` adds (issue #2141); 0 when off. */
  outsideTransferIncome: number;
  /** `resolveBudgetIncome` over the same read (the summary's linked income). */
  linkedIncome: number;
}

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
          // A transfer line is named by its account (issue #2141).
          "periodCategories.budgetCategory.transferAccount",
          "periodCategories.category",
          "periodBuckets",
        ],
        order: { periodBuckets: { bucketName: "ASC" } },
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
    const closed = await withScopedDb(this.dataSource, async (manager) => {
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

      // `config.transfersInAsIncome` is income no line carries (issue #2141).
      const incomeParts: number[] = [actuals.outsideTransferIncome];
      const expenseParts: number[] = [];

      // An expense line can join the budget after this month was opened. Its first
      // close must still freeze its spending and carry the balance into next month.
      const openedLines = new Set(
        openPeriod.periodCategories.map((pc) => pc.budgetCategoryId),
      );
      for (const line of budget.categories ?? []) {
        if (
          !line.isIncome &&
          line.rolloverType !== RolloverType.NONE &&
          !openedLines.has(line.id)
        ) {
          openPeriod.periodCategories.push(
            manager.getRepository(BudgetPeriodCategory).create({
              budgetPeriodId: openPeriod.id,
              budgetCategoryId: line.id,
              budgetCategory: line,
              categoryId: line.categoryId,
              rolloverIn: 0,
            }),
          );
        }
      }

      for (const pc of openPeriod.periodCategories) {
        const actual = actuals.lines.get(pc.budgetCategoryId) || 0;
        pc.actualAmount = actual;

        const bcEntry = pc.budgetCategory;
        if (
          bcEntry &&
          !bcEntry.isIncome &&
          (bcEntry.rolloverType !== RolloverType.NONE ||
            Number(pc.rolloverIn) !== 0)
        ) {
          // Match the live allocation at close, including percentage-funded lines.
          pc.budgetedAmount = resolveBudgetLineBudgeted(
            bcEntry,
            budget.incomeLinked,
            actuals.linkedIncome,
          );
          pc.effectiveBudget = effectiveLineBudget(
            pc.budgetedAmount,
            Number(pc.rolloverIn),
          );
        }
        pc.rolloverOut = this.computeRollover(pc, actual);

        if (bcEntry?.isIncome) {
          incomeParts.push(actual);
        } else {
          expenseParts.push(actual);
        }

        await manager.save(BudgetPeriodCategory, pc);
      }

      openPeriod.actualIncome = sumMoney(incomeParts);
      openPeriod.actualExpenses = sumMoney(expenseParts);
      openPeriod.status = PeriodStatus.CLOSED;

      const closedPeriod = await manager.save(BudgetPeriod, openPeriod);

      const bucketCarry = await this.freezePeriodBuckets(
        manager,
        budget,
        openPeriod.id,
        actuals,
      );

      await this.createNextPeriod(budget, openPeriod, manager, bucketCarry);

      return closedPeriod;
    });
    // A read of the new month may already have cached figures before its carry was posted.
    this.budgetsService.invalidateCategoryActuals(budgetId);
    return closed;
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
   * @param bucketCarry each bucket's signed carry from the period the caller
   *   closed, by bucket id: the new period's `budget_period_buckets.carry_in`
   *   (INV-BUDGET-003). Only buckets with a nonzero carry get a row here; the
   *   close writes the rest.
   */
  async createPeriodForBudget(
    budget: Budget,
    rolloverMap?: Map<string, number>,
    manager?: EntityManager,
    dates: PeriodDateRange = getCurrentMonthPeriodDates(),
    bucketCarry?: ReadonlyMap<string, number>,
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
        const rolloverIn = rolloverMap?.get(bc.id) ?? 0;
        const budgetedAmount =
          budget.incomeLinked &&
          !bc.isIncome &&
          bc.rolloverType !== RolloverType.NONE
            ? 0
            : Number(bc.amount);
        const effectiveBudget = effectiveLineBudget(budgetedAmount, rolloverIn);

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

      // Like the category rows, written only by the call that won the claim
      // above: the loser returned before this point, so a carry is received
      // once. The name and target are the bucket's as they are now; the close
      // of this period overwrites them with the figures it freezes.
      const bucketRows = (budget.buckets ?? []).flatMap((bucket) => {
        const carryIn = bucketCarry?.get(bucket.id) ?? 0;
        return carryIn !== 0
          ? [
              {
                budgetPeriodId: savedPeriod.id,
                bucketId: bucket.id,
                bucketName: bucket.name,
                targetType: bucket.targetType,
                targetValue: bucket.targetValue,
                carryIn,
              },
            ]
          : [];
      });
      if (bucketRows.length > 0) {
        await m.getRepository(BudgetPeriodBucket).insert(bucketRows);
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

    const remaining = Number(periodCategory.effectiveBudget) - actualAmount;
    // Income lines retain their existing carry rule when receipts exceed the target.
    const carry = budgetCategory.isIncome ? Math.max(0, remaining) : remaining;
    return roundMoney(
      budgetCategory.rolloverCap == null
        ? carry
        : Math.min(carry, Number(budgetCategory.rolloverCap)),
    );
  }

  /**
   * Freezes one `budget_period_buckets` row per bucket the budget has now
   * (design 6.3) from the close's own line actuals, and returns each bucket's
   * nonzero `carryOut` for the next period's creation (INV-BUDGET-003).
   *
   * Runs inside the close's transaction, under its `FOR UPDATE` lock on the
   * period row. The rows are read, then each is updated by id or inserted:
   * not `ON CONFLICT (budget_period_id, bucket_id)`, because a deleted
   * bucket's rows carry a NULL `bucket_id` and NULLs are distinct in that key.
   * The read-then-write is safe because every writer of an OPEN period's
   * bucket rows is either this close, serialised by that lock (a second close
   * waits on it and then finds no OPEN period), or the creation of the period,
   * which committed before the period could be locked here. A row whose
   * bucket was deleted (`bucket_id` NULL) is left as it is. A budget without
   * buckets reads and writes nothing.
   */
  private async freezePeriodBuckets(
    manager: EntityManager,
    budget: Budget,
    periodId: string,
    actuals: PeriodActuals,
  ): Promise<Map<string, number>> {
    const carry = new Map<string, number>();
    if ((budget.buckets ?? []).length === 0) return carry;

    // The buckets as they are now, read inside the close's transaction with
    // FOR SHARE: `budget` was read before it, so a bucket deleted in between
    // would otherwise be inserted here against a vanished key and fail the whole
    // close; the lock keeps a delete from landing before the writes below.
    const buckets = await manager.getRepository(BudgetBucket).find({
      where: { budgetId: budget.id },
      order: { sortOrder: "ASC", name: "ASC" },
      lock: { mode: "pessimistic_read" },
    });
    if (buckets.length === 0) return carry;

    // A writer's read of the places (FOR KEY SHARE): the amounts below are
    // stored at them.
    const places = await loadCurrencyPlaces(manager, [budget.currencyCode]);
    const decimals = moneyDecimalsForCode(places, budget.currencyCode);

    const repo = manager.getRepository(BudgetPeriodBucket);
    const existing = await repo.find({ where: { budgetPeriodId: periodId } });
    const rowByBucket = new Map<string, BudgetPeriodBucket>();
    const carriedIn = new Map<string, number>();
    for (const row of existing) {
      if (row.bucketId === null) continue;
      rowByBucket.set(row.bucketId, row);
      carriedIn.set(row.bucketId, Number(row.carryIn));
    }

    // The rows the live summary would report for this period, built from the
    // figures this close is freezing: `spent` is each line's frozen actual,
    // `budgeted` the summary's (a percentage of the period's income for an
    // expense line of an income-linked budget), and the actual income the
    // summary's: its income lines plus what `transfersInAsIncome` adds.
    const rows = (budget.categories ?? []).map((bc) => ({
      budgetCategoryId: bc.id,
      isIncome: bc.isIncome,
      budgeted: resolveBudgetLineBudgeted(
        bc,
        budget.incomeLinked,
        actuals.linkedIncome,
      ),
      spent: actuals.lines.get(bc.id) ?? 0,
    }));
    const actualIncome = budget.incomeLinked
      ? sumMoney(
          [
            ...rows.filter((r) => r.isIncome).map((r) => r.spent),
            actuals.outsideTransferIncome,
          ],
          decimals,
        )
      : null;

    const figures = computeBudgetBucketFigures(
      buildBudgetBucketFiguresInput({
        budget: { ...budget, buckets },
        rows,
        actualIncome,
        carriedIn,
        decimals,
      }),
    );
    const figureByBucket = new Map(figures.buckets.map((f) => [f.bucketId, f]));

    for (const bucket of buckets) {
      const figure = figureByBucket.get(bucket.id);
      if (!figure) continue;
      const frozen = {
        bucketName: bucket.name,
        targetType: bucket.targetType,
        targetValue: bucket.targetValue,
        incomeBasis: figures.income,
        allocatedAmount: figure.allocated,
        actualAmount: figure.spent,
        carryOut: figure.carryOut,
      };
      const row = rowByBucket.get(bucket.id);
      if (row) {
        // The columns this path owns; carry_in stays what the creation wrote
        // (CONC-008: an update of named columns, not a save of the snapshot).
        // `bucketId` in the criteria leaves the row alone if its bucket was
        // deleted since the read.
        await repo.update({ id: row.id, bucketId: bucket.id }, frozen);
      } else {
        // A bucket created mid-period: it received no carry.
        await repo.insert({
          budgetPeriodId: periodId,
          bucketId: bucket.id,
          carryIn: 0,
          ...frozen,
        });
      }
      if (figure.carryOut !== 0) carry.set(bucket.id, figure.carryOut);
    }

    return carry;
  }

  private async createNextPeriod(
    budget: Budget,
    closedPeriod: BudgetPeriod,
    manager?: EntityManager,
    bucketCarry?: ReadonlyMap<string, number>,
  ): Promise<BudgetPeriod> {
    const rolloverMap = new Map<string, number>();

    if (closedPeriod.periodCategories) {
      for (const pc of closedPeriod.periodCategories) {
        const carry = Number(pc.rolloverOut);
        if (carry !== 0) rolloverMap.set(pc.budgetCategoryId, carry);
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
      bucketCarry,
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
   *
   * `linkedIncome` is `resolveBudgetIncome` over the same read, the income an
   * income-linked budget's percentage lines are budgeted against.
   */
  private async computePeriodActuals(
    manager: EntityManager,
    userId: string,
    budget: Budget,
    periodStart: string,
    periodEnd: string,
  ): Promise<PeriodActuals> {
    const budgetCategories = budget.categories || [];
    const spending = await queryCategorySpending(
      manager.getRepository(Transaction),
      manager.getRepository(TransactionSplit),
      userId,
      budgetCategories,
      periodStart,
      periodEnd,
      budget.id,
    );

    const lines = new Map<string, number>();
    for (const bc of budgetCategories) {
      if ((bc.isTransfer && bc.transferAccountId) || bc.categoryId) {
        lines.set(
          bc.id,
          resolveCategorySpent(
            bc,
            spending.spendingMap,
            spending.transferSpendingMap,
            spending.transferIncomeMap,
          ),
        );
      }
    }
    return {
      lines,
      outsideTransferIncome: resolveOutsideTransferIncome(spending),
      linkedIncome: resolveBudgetIncome(budgetCategories, spending),
    };
  }
}
