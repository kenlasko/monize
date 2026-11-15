import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetsService } from "@/budgets/budgets.service";
import { BudgetPeriodService } from "@/budgets/budget-period.service";
import { Budget, BudgetType } from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { getCurrentMonthPeriodDates } from "@/budgets/budget-date.utils";
import {
  queryCategorySpending,
  resolveCategorySpentOrNull,
  resolveOutsideTransferIncome,
} from "@/budgets/budget-spending.util";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Issue #2141 against PostgreSQL: the truth table of
 * `docs/specs/budget-transfer-income.md` section 3. Budget accounts are
 * Chequing and a credit card; HISA and RRSP are excluded. A "HISA" transfer
 * income line and the `transfersInAsIncome` toggle read the legs in a budget
 * account whose counterpart is the source, netted over both directions.
 */
describe("budget transfer income (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let budgets: BudgetsService;
  let userId: string;
  let chequingId: string;
  let cardId: string;
  let hisaId: string;
  let rrspId: string;
  let budget: Budget;
  let hisaLine: BudgetCategory;
  let groceriesLine: BudgetCategory;

  const { periodStart, periodEnd } = getCurrentMonthPeriodDates();

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule, BudgetsModule]);
    dataSource = module.get(DataSource);
    budgets = module.get(BudgetsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "budget_period_categories",
      "budget_periods",
      "budget_categories",
      "budgets",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('CAD', 'Canadian Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    const account = async (name: string) =>
      (
        await createTestAccount(dataSource, userId, {
          name,
          currencyCode: "CAD",
        })
      ).id;
    chequingId = await account("Chequing");
    cardId = await account("Credit card");
    hisaId = await account("HISA");
    rrspId = await account("RRSP");
    const groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;

    budget = await dataSource.manager.save(
      dataSource.manager.create(Budget, {
        userId,
        name: "This month",
        budgetType: BudgetType.MONTHLY,
        periodStart,
        currencyCode: "CAD",
        config: {
          excludedAccountIds: [hisaId, rrspId],
          transfersInAsIncome: false,
        },
      } as Partial<Budget>),
    );
    const line = (overrides: Partial<BudgetCategory>) =>
      dataSource.manager.save(
        dataSource.manager.create(BudgetCategory, {
          budgetId: budget.id,
          isIncome: false,
          isTransfer: false,
          ...overrides,
        } as Partial<BudgetCategory>),
      );
    hisaLine = await line({
      categoryId: null,
      isTransfer: true,
      isIncome: true,
      transferAccountId: hisaId,
      amount: 2000,
    });
    groceriesLine = await line({ categoryId: groceriesId, amount: 500 });
  });

  function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    return dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: chequingId,
        transactionDate: periodStart,
        amount: 0,
        currencyCode: "CAD",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        ...overrides,
      } as Partial<Transaction>),
    );
  }

  /** A whole-row transfer of `amount` from `from` to `to`, both legs linked. */
  async function transfer(
    from: string,
    to: string,
    amount: number,
    status = TransactionStatus.UNRECONCILED,
  ): Promise<void> {
    const inbound = await insertTransaction({
      accountId: to,
      amount,
      isTransfer: true,
      status,
    });
    const outbound = await insertTransaction({
      accountId: from,
      amount: -amount,
      isTransfer: true,
      linkedTransactionId: inbound.id,
      status,
    });
    inbound.linkedTransactionId = outbound.id;
    await dataSource.manager.save(inbound);
  }

  async function setToggle(on: boolean): Promise<void> {
    await dataSource.query(
      `UPDATE budgets SET config = config || jsonb_build_object('transfersInAsIncome', $2::boolean) WHERE id = $1`,
      [budget.id, on],
    );
  }

  function read(lines: BudgetCategory[] = [hisaLine, groceriesLine]) {
    return withUserContext(userId, () =>
      withScopedDb(dataSource, (m) =>
        queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          lines,
          periodStart,
          periodEnd,
        ),
      ),
    );
  }

  it("counts a transfer in from the line's source", async () => {
    await transfer(hisaId, chequingId, 2000);

    const spending = await read();

    expect(resolveCategorySpentOrNull(hisaLine, spending)).toBe(2000);
    // The HISA leg itself (-2000, counterpart Chequing) is never read.
    expect(spending.transferIncomeMap.get(hisaId)).toBe(2000);
  });

  it("nets a transfer back to the source, clamping a net outflow at zero", async () => {
    await transfer(hisaId, chequingId, 2000);
    await transfer(chequingId, hisaId, 500);

    expect(resolveCategorySpentOrNull(hisaLine, await read())).toBe(1500);

    await transfer(chequingId, hisaId, 2000);
    const spending = await read();
    expect(spending.transferIncomeMap.get(hisaId)).toBe(-500);
    expect(resolveCategorySpentOrNull(hisaLine, spending)).toBe(0);
  });

  it("ignores transfers inside the budget and between excluded accounts", async () => {
    await setToggle(true);
    await transfer(chequingId, cardId, 800);
    await transfer(hisaId, rrspId, 1000);

    const spending = await read();

    expect(resolveCategorySpentOrNull(hisaLine, spending)).toBe(0);
    expect(spending.outsideTransferIncome).toBe(0);
  });

  it("sweeps the excluded accounts no line names into the toggle's figure", async () => {
    await transfer(hisaId, chequingId, 2000);
    await transfer(rrspId, chequingId, 300);

    expect(resolveOutsideTransferIncome(await read())).toBe(0);

    await setToggle(true);
    const spending = await read();
    // HISA counts once, on its line; RRSP is the toggle's.
    expect(resolveCategorySpentOrNull(hisaLine, spending)).toBe(2000);
    expect(resolveOutsideTransferIncome(spending)).toBe(300);
    // A caller reading a subset of the lines (the savings rate leaves the
    // outgoing ones out) still has HISA named by the budget's own line.
    expect(resolveOutsideTransferIncome(await read([groceriesLine]))).toBe(300);
    // Without the line, the toggle sweeps HISA too.
    await dataSource.query(`DELETE FROM budget_categories WHERE id = $1`, [
      hisaLine.id,
    ]);
    expect(resolveOutsideTransferIncome(await read([groceriesLine]))).toBe(
      2300,
    );
  });

  it("never counts a VOID transfer", async () => {
    await setToggle(true);
    await transfer(hisaId, chequingId, 2000, TransactionStatus.VOID);
    await transfer(rrspId, chequingId, 300, TransactionStatus.VOID);

    const spending = await read();

    expect(resolveCategorySpentOrNull(hisaLine, spending)).toBe(0);
    expect(spending.outsideTransferIncome).toBe(0);
  });

  it("reads a split line naming the source, in both directions", async () => {
    // A Chequing deposit split: +600 from HISA, -100 back to it.
    const parent = await insertTransaction({ amount: 500, isSplit: true });
    const inLeg = await insertTransaction({
      accountId: hisaId,
      amount: -600,
      isTransfer: true,
      linkedTransactionId: parent.id,
    });
    const outLeg = await insertTransaction({
      accountId: hisaId,
      amount: 100,
      isTransfer: true,
      linkedTransactionId: parent.id,
    });
    await dataSource.manager.save([
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.TRANSFER,
        transferAccountId: hisaId,
        linkedTransactionId: inLeg.id,
        amount: 600,
      } as Partial<TransactionSplit>),
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.TRANSFER,
        transferAccountId: hisaId,
        linkedTransactionId: outLeg.id,
        amount: -100,
      } as Partial<TransactionSplit>),
    ]);

    expect(resolveCategorySpentOrNull(hisaLine, await read())).toBe(500);
  });

  it("puts both figures into the summary's income", async () => {
    await setToggle(true);
    await transfer(hisaId, chequingId, 2000);
    await transfer(rrspId, chequingId, 300);

    const summary = await withUserContext(userId, () =>
      budgets.getSummary(userId, budget.id),
    );

    expect(summary.outsideTransferIncome).toBe(300);
    expect(summary.totalIncome).toBe(2300);
    expect(
      summary.categoryBreakdown.find((c) => c.budgetCategoryId === hisaLine.id),
    ).toMatchObject({ isIncome: true, isTransfer: true, spent: 2000 });
  });

  it("counts the toggle on a budget with no line at all", async () => {
    await setToggle(true);
    await transfer(rrspId, chequingId, 300);
    await dataSource.query(
      `DELETE FROM budget_categories WHERE budget_id = $1`,
      [budget.id],
    );

    const summary = await withUserContext(userId, () =>
      budgets.getSummary(userId, budget.id),
    );

    expect(summary.categoryBreakdown).toEqual([]);
    expect(summary.outsideTransferIncome).toBe(300);
    expect(summary.totalIncome).toBe(300);
  });

  it("adds a transfer income line with a row in the open period, refusing a second for the account", async () => {
    const periods = module.get(BudgetPeriodService);
    await withUserContext(userId, () =>
      periods.getOrCreateCurrentPeriod(userId, budget.id),
    );

    const line = await withUserContext(userId, () =>
      budgets.addTransferIncomeLine(userId, budget.id, {
        transferAccountId: rrspId,
        amount: 300,
      }),
    );

    const rows: Array<{ budgeted_amount: string }> = await dataSource.query(
      `SELECT bpc.budgeted_amount FROM budget_period_categories bpc
         JOIN budget_periods bp ON bp.id = bpc.budget_period_id
        WHERE bpc.budget_category_id = $1 AND bp.status = 'OPEN'`,
      [line.id],
    );
    expect(rows.map((r) => Number(r.budgeted_amount))).toEqual([300]);

    await expect(
      withUserContext(userId, () =>
        budgets.addTransferIncomeLine(userId, budget.id, {
          transferAccountId: hisaId,
          amount: 100,
        }),
      ),
    ).rejects.toThrow("already has a transfer line");
  });
});
