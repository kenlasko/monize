import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { BudgetsModule } from "@/budgets/budgets.module";
import { Budget } from "@/budgets/entities/budget.entity";
import {
  BudgetCategory,
  CategoryGroup,
} from "@/budgets/entities/budget-category.entity";
import {
  BudgetPeriod,
  PeriodStatus,
} from "@/budgets/entities/budget-period.entity";
import { BudgetPeriodCategory } from "@/budgets/entities/budget-period-category.entity";
import { BudgetTrendReportsService } from "@/budgets/budget-trend-reports.service";
import { BudgetHealthReportsService } from "@/budgets/budget-health-reports.service";
import { withReportingRead } from "@/accruals/reporting-basis";

describe("Accrual budget reporting through real services and enforced RLS", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture([BudgetsModule]);
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());

  async function closedBudget() {
    const budget = await f.h.owner.getRepository(Budget).save({
      userId: f.user,
      name: "Recognition",
      periodStart: "2026-06-01",
      currencyCode: "USD",
    });
    const category = await f.h.owner.getRepository(BudgetCategory).save({
      budgetId: budget.id,
      categoryId: f.root,
      amount: 150,
      categoryGroup: CategoryGroup.NEED,
    });
    const period = await f.h.owner.getRepository(BudgetPeriod).save({
      budgetId: budget.id,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      status: PeriodStatus.CLOSED,
      totalBudgeted: 150,
      actualExpenses: 999,
    });
    await f.h.owner.getRepository(BudgetPeriodCategory).save({
      budgetPeriodId: period.id,
      budgetCategoryId: category.id,
      categoryId: f.root,
      budgetedAmount: 150,
      effectiveBudget: 150,
      actualAmount: 999,
    });
    return budget;
  }

  it("closed category/overall trends and health follow fresh recognition while cash reads the original payment", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const budget = await closedBudget();
    const trends = f.h.module.get(BudgetTrendReportsService),
      health = f.h.module.get(BudgetHealthReportsService);
    const read = () =>
      f.as(async () => ({
        overall: await trends.getTrend(f.user, budget.id, 12),
        categories: await trends.getCategoryTrend(f.user, budget.id, 12),
        health: await health.getHealthScoreHistory(f.user, budget.id, 12),
      }));
    const initial = await read();
    expect(initial.overall[0].actual).toBe(100);
    expect(initial.categories[0].data[0].actual).toBe(100);
    expect(initial.health[0].score).toBe(100);
    const cash = await f.as(() =>
      withReportingRead(
        f.h.app,
        f.user,
        () => trends.getCategoryTrend(f.user, budget.id, 12),
        "cash",
      ),
    );
    expect(cash[0].data[0].actual).toBe(1200.0001);
    const patch = { amount: -2400.0001 };
    const preview = await f.as(() =>
      f.accruals.previewSourceEdit(f.user, tx.id, patch),
    );
    await f.as(() =>
      f.transactions.update(f.user, tx.id, {
        ...patch,
        accrualImpactFingerprint: preview.fingerprint!,
      }),
    );
    const edited = await read();
    expect(edited.overall[0].actual).toBe(200);
    expect(edited.categories[0].data[0].actual).toBe(200);
    expect(edited.health[0].score).toBeLessThan(initial.health[0].score);
    const stored = await f.h.owner
      .getRepository(BudgetPeriod)
      .findOneByOrFail({ budgetId: budget.id });
    expect(Number(stored.actualExpenses)).toBe(999);
  });
});
