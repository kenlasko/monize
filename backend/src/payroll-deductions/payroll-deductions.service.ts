import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { todayYMD } from "../common/date-utils";
import { returnedRows } from "../common/db/query-result";
import { withScopedDb } from "../common/db/scoped-db";
import { roundMoney } from "../common/round.util";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { tr } from "../i18n/translate";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import {
  CreatePayrollDeductionRuleDto,
  CreatePayrollDeductionRulesDto,
  PayrollDeductionLineDto,
  UpdatePayrollDeductionRuleDto,
} from "./dto/create-payroll-deduction-rule.dto";
import { PayrollDeductionRule } from "./entities/payroll-deduction-rule.entity";
import {
  PayrollDeductionFigures,
  queryCategoryPeriodPaid,
  resolveExpectedPerPaycheque,
  resolvePayrollDeductionFigures,
} from "./payroll-deduction-cap";
import {
  DeductionPeriod,
  deductionPeriod,
  subtractMonths,
} from "./payroll-deduction-period";
import { addDaysYMD } from "../common/date-utils";
import {
  assemblePayrollReport,
  DeductionTransaction,
  groupReportRules,
  PayrollDeductionReport,
  PayrollReportGroup,
  queryDeductionTransactions,
} from "./payroll-deduction-report";

/**
 * How far back the suggestion reads the ledger. Deduction rates change once
 * a year, so a year of paycheques holds one rate more often than any other;
 * a longer window would let last year's rate outvote this year's.
 */
export const SUGGESTION_WINDOW_MONTHS = 12;

/** A rule as the page reads it: the row, its names and today's figures. */
export type PayrollDeductionRuleView = PayrollDeductionRule &
  PayrollDeductionFigures & {
    categoryName: string;
    scheduledTransactionName: string;
  };

/** How many closed periods `GET /payroll-deductions/history` looks back over. */
export const HISTORY_PERIODS = 5;

/** One category's collected totals over its closed periods, newest first. */
export interface PayrollDeductionHistoryView {
  categoryId: string;
  categoryName: string;
  currencyCode: string;
  periods: {
    periodStart: string;
    periodEnd: string;
    paidToDate: number;
    foreignCurrencyRows: number;
  }[];
}

/**
 * What `GET /payroll-deductions/suggest` answers (decision 3): `line` is the
 * bill's own figure, `ledger` the magnitude the category's deduction rows
 * most often carry in the last `SUGGESTION_WINDOW_MONTHS`.
 */
export interface ExpectedAmountSuggestion {
  expectedPerPaycheque: number | null;
  expectedSource: "line" | "ledger" | null;
  /**
   * An estimate of the maximum from what the category has already collected:
   * the last full period's total (a capped deduction stops exactly there), or
   * the current period's when that is already higher; `null` when nothing was
   * collected or no reset date was given.
   */
  yearlyMaximum: number | null;
  yearlyMaximumSource:
    "previousPeriod" | "currentPeriod" | "currentPeriodCapped" | null;
}

/**
 * Payroll deduction rules (docs/specs/payroll-deductions.md). Every method
 * takes the owner's id first and reads only that owner's rows; the ledger is
 * read for the year-to-date figure and never written (INV-PAYROLL-001).
 */
@Injectable()
export class PayrollDeductionsService {
  constructor(private readonly dataSource: DataSource) {}

  /** The owner's rules with their figures as of today, oldest first. */
  async findAll(userId: string): Promise<PayrollDeductionRuleView[]> {
    const today = todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const rules = await m.getRepository(PayrollDeductionRule).find({
        where: { userId },
        relations: [
          "category",
          "scheduledTransaction",
          "scheduledTransaction.splits",
        ],
        order: { createdAt: "ASC" },
      });
      const views: PayrollDeductionRuleView[] = [];
      for (const rule of rules) {
        views.push(await this.toView(m, userId, rule, today));
      }
      return views;
    });
  }

  /**
   * What each ruled category collected in each of its last `HISTORY_PERIODS`
   * closed periods, one entry per category and currency (two paycheques on
   * one category share the figure, as paid is category-wide), periods
   * anchored on the earliest rule's reset date. Oldest periods with nothing
   * in them are dropped: the history starts where the ledger does.
   */
  async history(userId: string): Promise<PayrollDeductionHistoryView[]> {
    const today = todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const rules = await m.getRepository(PayrollDeductionRule).find({
        where: { userId },
        relations: ["category", "scheduledTransaction"],
        order: { createdAt: "ASC" },
      });
      const groups = new Map<
        string,
        Omit<PayrollDeductionHistoryView, "periods"> & { resetDate: string }
      >();
      for (const rule of rules) {
        const currencyCode = rule.scheduledTransaction?.currencyCode ?? "";
        const key = `${rule.categoryId}|${currencyCode}`;
        if (!groups.has(key)) {
          groups.set(key, {
            categoryId: rule.categoryId,
            categoryName: rule.category?.name ?? "",
            currencyCode,
            resetDate: rule.resetDate,
          });
        }
      }
      const views: PayrollDeductionHistoryView[] = [];
      for (const { resetDate, ...group } of groups.values()) {
        let period = deductionPeriod(resetDate, today);
        const periods: PayrollDeductionHistoryView["periods"] = [];
        for (let i = 0; i < HISTORY_PERIODS; i++) {
          period = deductionPeriod(
            resetDate,
            addDaysYMD(period.periodStart, -1),
          );
          const paid = await queryCategoryPeriodPaid(
            m,
            userId,
            group.categoryId,
            period,
            group.currencyCode,
          );
          periods.push({
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            paidToDate: paid.paidToDate,
            foreignCurrencyRows: paid.foreignCurrencyRows,
          });
        }
        while (
          periods.length > 0 &&
          periods[periods.length - 1].paidToDate === 0 &&
          periods[periods.length - 1].foreignCurrencyRows === 0
        ) {
          periods.pop();
        }
        views.push({ ...group, periods });
      }
      return views;
    });
  }

  /**
   * The payroll deductions report for `year` (docs/specs/payroll-deductions.md
   * section 10): per ruled category and currency, the period starting in that
   * year, its paycheques, and every period the ledger holds. One ledger read
   * per category, shared by the category's currencies.
   */
  async report(userId: string, year?: number): Promise<PayrollDeductionReport> {
    const today = todayYMD();
    const selectedYear = year ?? Number(today.slice(0, 4));
    return withScopedDb(this.dataSource, async (m) => {
      const rules = await m.getRepository(PayrollDeductionRule).find({
        where: { userId },
        relations: ["category", "scheduledTransaction"],
        order: { createdAt: "ASC" },
      });
      const byCategory = new Map<string, DeductionTransaction[]>();
      const entries: {
        group: PayrollReportGroup;
        transactions: DeductionTransaction[];
      }[] = [];
      for (const group of groupReportRules(rules)) {
        let transactions = byCategory.get(group.categoryId);
        if (!transactions) {
          transactions = await queryDeductionTransactions(
            m,
            userId,
            group.categoryId,
          );
          byCategory.set(group.categoryId, transactions);
        }
        entries.push({ group, transactions });
      }
      return assemblePayrollReport(entries, selectedYear, today);
    });
  }

  /**
   * The expected amount a new rule could start from: the bill's line for the
   * category, else the magnitude the category's deduction rows most often
   * carry over the last year (ties go to the more recently seen figure), else
   * nothing (the form then insists on a figure). A single row is one paycheque;
   * the mode is the figure the paycheque usually deducts, which the latest row
   * is not once the line has been capped or a rate has changed.
   */
  async suggestExpected(
    userId: string,
    scheduledTransactionId: string,
    categoryId: string,
    resetDate?: string,
  ): Promise<ExpectedAmountSuggestion> {
    const today = todayYMD();
    const since = subtractMonths(today, SUGGESTION_WINDOW_MONTHS);
    return withScopedDb(this.dataSource, async (m) => {
      const schedule = await this.ownedSchedule(
        m,
        userId,
        scheduledTransactionId,
      );
      const maximum = await this.estimateMaximum(
        m,
        userId,
        schedule,
        categoryId,
        resetDate,
        today,
      );
      const fromLine = resolveExpectedPerPaycheque(
        { categoryId, expectedPerPaycheque: null },
        schedule.splits ?? [],
      );
      if (fromLine.expectedSource === "line") {
        return {
          expectedPerPaycheque: fromLine.expectedPerPaycheque,
          expectedSource: "line",
          ...maximum,
        };
      }
      const rows = returnedRows<{ amount: string }>(
        await m.query(
          `SELECT x.amount
             FROM (
               SELECT t.amount, t.transaction_date, t.created_at
                 FROM transactions t
                WHERE t.user_id = $1 AND t.category_id = $2
                  AND t.is_split = false AND t.status <> 'VOID'
                  AND t.currency_code = $3
               UNION ALL
               SELECT s.amount, t.transaction_date, t.created_at
                 FROM transaction_splits s
                 JOIN transactions t ON t.id = s.transaction_id
                WHERE t.user_id = $1 AND s.category_id = $2
                  AND t.status <> 'VOID'
                  AND t.currency_code = $3
             ) x
            WHERE x.amount < 0 AND x.transaction_date >= $4
            GROUP BY x.amount
            ORDER BY COUNT(*) DESC, MAX(x.transaction_date) DESC
            LIMIT 1`,
          [userId, categoryId, schedule.currencyCode, since],
        ),
      );
      const usual = rows[0] ? roundMoney(-Number(rows[0].amount)) : null;
      return {
        expectedPerPaycheque: usual,
        expectedSource: usual === null ? null : "ledger",
        ...maximum,
      };
    });
  }

  /**
   * The maximum the ledger suggests, since a capped deduction stops exactly
   * at its maximum. In order: the current period's total when the bill's own
   * postings show the deduction stopped (a later paycheque in the period
   * carries no line for the category after one that did); the current
   * period's total when it is already above the last full period's (a rate
   * rose); else the last full period's total. Paid is category-wide, so two
   * paycheques on one category estimate the one maximum they share. Nothing
   * collected, or no reset date, suggests nothing.
   */
  private async estimateMaximum(
    m: EntityManager,
    userId: string,
    schedule: Pick<ScheduledTransaction, "id" | "currencyCode">,
    categoryId: string,
    resetDate: string | undefined,
    today: string,
  ): Promise<
    Pick<ExpectedAmountSuggestion, "yearlyMaximum" | "yearlyMaximumSource">
  > {
    if (!resetDate) return { yearlyMaximum: null, yearlyMaximumSource: null };
    const { currencyCode } = schedule;
    const current = deductionPeriod(resetDate, today);
    const previous = deductionPeriod(
      resetDate,
      addDaysYMD(current.periodStart, -1),
    );
    const before = await queryCategoryPeriodPaid(
      m,
      userId,
      categoryId,
      previous,
      currencyCode,
    );
    const sofar = await queryCategoryPeriodPaid(
      m,
      userId,
      categoryId,
      current,
      currencyCode,
    );
    if (
      sofar.paidToDate > 0 &&
      (await this.deductionStopped(m, userId, schedule.id, categoryId, current))
    ) {
      return {
        yearlyMaximum: roundMoney(sofar.paidToDate),
        yearlyMaximumSource: "currentPeriodCapped",
      };
    }
    if (sofar.paidToDate > before.paidToDate && sofar.paidToDate > 0) {
      return {
        yearlyMaximum: roundMoney(sofar.paidToDate),
        yearlyMaximumSource: "currentPeriod",
      };
    }
    if (before.paidToDate > 0) {
      return {
        yearlyMaximum: roundMoney(before.paidToDate),
        yearlyMaximumSource: "previousPeriod",
      };
    }
    return { yearlyMaximum: null, yearlyMaximumSource: null };
  }

  /**
   * Whether the bill's postings in the period show the deduction reached its
   * maximum: its latest posted paycheque carries no deduction line for the
   * category while an earlier one in the period did. A line the posting
   * capped to zero is "no deduction line" here, as is one the user removed.
   */
  private async deductionStopped(
    m: EntityManager,
    userId: string,
    scheduledTransactionId: string,
    categoryId: string,
    period: Pick<DeductionPeriod, "periodStart" | "periodEnd">,
  ): Promise<boolean> {
    const rows = returnedRows<{ deducted: boolean }>(
      await m.query(
        `SELECT (
                  (t.is_split = false AND t.category_id = $3 AND t.amount < 0)
                  OR EXISTS (
                    SELECT 1 FROM transaction_splits s
                     WHERE s.transaction_id = t.id
                       AND s.category_id = $3 AND s.amount < 0
                  )
                ) AS deducted
           FROM scheduled_transaction_postings p
           JOIN transactions t ON t.id = p.transaction_id
          WHERE p.scheduled_transaction_id = $2
            AND t.user_id = $1 AND t.status <> 'VOID'
            AND t.transaction_date BETWEEN $4 AND $5
          ORDER BY t.transaction_date DESC, t.created_at DESC`,
        [
          userId,
          scheduledTransactionId,
          categoryId,
          period.periodStart,
          period.periodEnd,
        ],
      ),
    );
    if (rows.length < 2 || rows[0].deducted) return false;
    return rows.some((row) => row.deducted);
  }

  /** One rule: the single-line form of `createMany`. */
  async create(
    userId: string,
    dto: CreatePayrollDeductionRuleDto,
  ): Promise<PayrollDeductionRuleView> {
    const [view] = await this.createMany(userId, {
      scheduledTransactionId: dto.scheduledTransactionId,
      resetPeriod: dto.resetPeriod,
      resetDate: dto.resetDate,
      lines: [
        {
          categoryId: dto.categoryId,
          yearlyMaximum: dto.yearlyMaximum,
          expectedPerPaycheque: dto.expectedPerPaycheque,
        },
      ],
    });
    return view;
  }

  /**
   * Several categories of one bill in one transaction: every ownership,
   * duplicate and expected-amount check runs before the first row is saved,
   * so a refused line leaves no sibling behind (AGENTS.md, "Transactions").
   */
  async createMany(
    userId: string,
    dto: CreatePayrollDeductionRulesDto,
  ): Promise<PayrollDeductionRuleView[]> {
    const today = todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const schedule = await this.ownedSchedule(
        m,
        userId,
        dto.scheduledTransactionId,
      );
      await this.assertFiatBill(m, schedule);
      const repo = m.getRepository(PayrollDeductionRule);
      const seen = new Set<string>();
      const rows: Partial<PayrollDeductionRule>[] = [];
      for (const line of dto.lines) {
        if (seen.has(line.categoryId)) throw this.duplicate();
        seen.add(line.categoryId);
        rows.push(await this.prepareLine(m, userId, schedule, dto, line));
      }
      const views: PayrollDeductionRuleView[] = [];
      for (const row of rows) {
        const saved = await repo.save(repo.create(row));
        views.push(
          await this.toView(
            m,
            userId,
            await this.reload(m, userId, saved.id),
            today,
          ),
        );
      }
      return views;
    });
  }

  /** The row one line becomes, after every check that can refuse it. */
  private async prepareLine(
    m: EntityManager,
    userId: string,
    schedule: ScheduledTransaction,
    shared: Pick<
      CreatePayrollDeductionRulesDto,
      "scheduledTransactionId" | "resetPeriod" | "resetDate"
    >,
    line: PayrollDeductionLineDto,
  ): Promise<Partial<PayrollDeductionRule>> {
    await this.ownedCategory(m, userId, line.categoryId);
    const duplicate = await m.getRepository(PayrollDeductionRule).findOne({
      where: {
        userId,
        scheduledTransactionId: shared.scheduledTransactionId,
        categoryId: line.categoryId,
      },
    });
    if (duplicate) throw this.duplicate();
    return {
      userId,
      scheduledTransactionId: shared.scheduledTransactionId,
      categoryId: line.categoryId,
      yearlyMaximum: roundMoney(line.yearlyMaximum),
      resetPeriod: shared.resetPeriod ?? "YEARLY",
      resetDate: shared.resetDate,
      expectedPerPaycheque: this.expectedOrRefuse(
        schedule,
        line.categoryId,
        line.expectedPerPaycheque,
      ),
    };
  }

  private duplicate(): ConflictException {
    return new ConflictException(
      tr(
        "errors.payrollDeductions.duplicate",
        "This bill already has a rule for that category",
      ),
    );
  }

  async update(
    userId: string,
    id: string,
    dto: UpdatePayrollDeductionRuleDto,
  ): Promise<PayrollDeductionRuleView> {
    const today = todayYMD();
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(PayrollDeductionRule);
      const rule = await repo.findOne({ where: { id, userId } });
      if (!rule) throw this.notFound(id);
      const scheduledTransactionId =
        dto.scheduledTransactionId ?? rule.scheduledTransactionId;
      const categoryId = dto.categoryId ?? rule.categoryId;
      const schedule = await this.ownedSchedule(
        m,
        userId,
        scheduledTransactionId,
      );
      await this.assertFiatBill(m, schedule);
      if (dto.categoryId !== undefined) {
        await this.ownedCategory(m, userId, categoryId);
      }
      if (
        scheduledTransactionId !== rule.scheduledTransactionId ||
        categoryId !== rule.categoryId
      ) {
        const duplicate = await repo.findOne({
          where: { userId, scheduledTransactionId, categoryId },
        });
        if (duplicate && duplicate.id !== id) throw this.duplicate();
      }
      const expected = this.expectedOrRefuse(
        schedule,
        categoryId,
        dto.expectedPerPaycheque === undefined
          ? rule.expectedPerPaycheque
          : dto.expectedPerPaycheque,
      );
      await repo.update(
        { id },
        {
          scheduledTransactionId,
          categoryId,
          yearlyMaximum:
            dto.yearlyMaximum === undefined
              ? rule.yearlyMaximum
              : roundMoney(dto.yearlyMaximum),
          resetPeriod: dto.resetPeriod ?? rule.resetPeriod,
          resetDate: dto.resetDate ?? rule.resetDate,
          expectedPerPaycheque: expected,
        },
      );
      return this.toView(m, userId, await this.reload(m, userId, id), today);
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const result = await m
        .getRepository(PayrollDeductionRule)
        .delete({ id, userId });
      if (!result.affected) throw this.notFound(id);
    });
  }

  private notFound(id: string): NotFoundException {
    return new NotFoundException(
      tr(
        "errors.payrollDeductions.notFound",
        `Payroll deduction rule ${id} not found`,
        { id },
      ),
    );
  }

  /**
   * The expected figure to store: `null` when the bill's own line supplies it
   * (decision 3), the entered magnitude otherwise, refused when neither says.
   */
  private expectedOrRefuse(
    schedule: Pick<ScheduledTransaction, "splits">,
    categoryId: string,
    entered: number | null | undefined,
  ): number | null {
    const fromLine = resolveExpectedPerPaycheque(
      { categoryId, expectedPerPaycheque: null },
      schedule.splits ?? [],
    );
    if (fromLine.expectedSource === "line") return null;
    if (entered === null || entered === undefined) {
      throw new BadRequestException(
        tr(
          "errors.payrollDeductions.expectedRequired",
          "The bill has no line for this category; enter the amount expected per paycheque",
        ),
      );
    }
    return roundMoney(entered);
  }

  private async ownedSchedule(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<ScheduledTransaction> {
    const schedule = await m.getRepository(ScheduledTransaction).findOne({
      where: { id, userId },
      relations: ["splits"],
    });
    if (!schedule) {
      throw new NotFoundException(
        tr(
          "errors.scheduled.notFound",
          `Scheduled transaction with ID ${id} not found`,
          { id },
        ),
      );
    }
    return schedule;
  }

  /**
   * A rule's maximum and expected amount are fiat figures held at four places,
   * so a bill paid from a cryptocurrency account is refused rather than
   * tracked at the wrong precision (`docs/specs/money-precision.md` section
   * 10). Runs inside the rule write's transaction, before the first write.
   */
  private async assertFiatBill(
    m: EntityManager,
    schedule: ScheduledTransaction,
  ): Promise<void> {
    const account = await m.getRepository(Account).findOne({
      where: { id: schedule.accountId },
      select: { id: true, accountType: true, currencyCode: true },
    });
    if (account?.accountType !== AccountType.CRYPTO) return;
    const code = account.currencyCode;
    throw new BadRequestException(
      tr(
        "errors.payrollDeductions.billAccountMustBeFiat",
        `A payroll deduction rule tracks a bill paid in a fiat currency; this bill's account holds the cryptocurrency ${code}. Choose a bill paid from a fiat account.`,
        { code },
      ),
    );
  }

  private async ownedCategory(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<Category> {
    const category = await m
      .getRepository(Category)
      .findOne({ where: { id, userId } });
    if (!category) {
      throw new NotFoundException(
        tr("errors.categories.notFound", `Category with ID ${id} not found`, {
          id,
        }),
      );
    }
    return category;
  }

  private async reload(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<PayrollDeductionRule> {
    const rule = await m.getRepository(PayrollDeductionRule).findOne({
      where: { id, userId },
      relations: [
        "category",
        "scheduledTransaction",
        "scheduledTransaction.splits",
      ],
    });
    if (!rule) throw this.notFound(id);
    return rule;
  }

  private async toView(
    m: EntityManager,
    userId: string,
    rule: PayrollDeductionRule,
    asOf: string,
  ): Promise<PayrollDeductionRuleView> {
    const lines: ScheduledTransactionSplit[] =
      rule.scheduledTransaction?.splits ?? [];
    const figures = await resolvePayrollDeductionFigures(
      m,
      userId,
      rule,
      lines,
      rule.scheduledTransaction?.currencyCode ?? "",
      asOf,
    );
    const { scheduledTransaction, category, ...row } = rule;
    return {
      ...row,
      yearlyMaximum: roundMoney(Number(rule.yearlyMaximum)),
      ...figures,
      categoryName: category?.name ?? "",
      scheduledTransactionName: scheduledTransaction?.name ?? "",
    } as PayrollDeductionRuleView;
  }
}
