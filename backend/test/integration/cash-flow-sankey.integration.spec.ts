import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CashFlowSankeyService } from "@/built-in-reports/cash-flow-sankey.service";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import type { CashFlowSankeyResponse } from "@/built-in-reports/dto";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
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
 * The Cash Flow Sankey against real PostgreSQL: the design's numerical example
 * (`docs/specs/sankey-cash-flow.md` section 8), with and without the
 * USD rate, and the scope widening that turns a transfer internal.
 *
 * The unit specs mock `manager.query` and can only assert the SQL's text; which
 * legs the transfer queries read (SANKEY-002), and that VOID rows and
 * investment-linked legs stay out (SANKEY-003), is only proven by running it.
 * Every case runs over the same noise rows (a VOID purchase, a VOID transfer
 * pair to savings, a BUY's generated cash leg, an investment-linked transfer
 * leg to a brokerage sleeve, a row outside the window), and the expected
 * figures are the design's, so a branch that admitted any of them would move
 * a figure: the categorized branch the purchase and the BUY leg (as
 * uncategorized spending), the whole-transfer branch the VOID pair and the
 * investment-linked leg (as savings outflows).
 *
 * Row 7 of the example (Dining, 50.00 USD) sits in a USD chequing account in
 * scope, since a row's currency is its account's.
 */
describe("Cash Flow Sankey (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: CashFlowSankeyService;

  let userId: string;
  let chequingId: string;
  let usChequingId: string;
  let savingsId: string;
  let mortgageId: string;
  let salaryId: string;
  let groceriesId: string;
  let interestId: string;
  let diningId: string;

  const START = "2026-09-01";
  const END = "2026-09-30";

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    // The service reads the ledger and the rate history with raw SQL and takes
    // only the default currency from the currency service, so it is
    // constructed directly; no latest-rate map is consulted.
    const currency = new ReportCurrencyService(dataSource, {
      getRateIndex: async () => new Map(),
    } as never);
    service = new CashFlowSankeyService(dataSource, currency);
  });

  afterAll(async () => {
    await module.close();
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    const tx = dataSource.manager.create(Transaction, {
      userId,
      accountId: chequingId,
      transactionDate: "2026-09-10",
      amount: -1,
      currencyCode: "CAD",
      status: TransactionStatus.UNRECONCILED,
      isTransfer: false,
      isSplit: false,
      ...overrides,
    } as Partial<Transaction>);
    return dataSource.manager.save(tx);
  }

  /** Two linked legs, as `createTransfer` writes them. */
  async function insertTransfer(
    fromAccountId: string,
    toAccountId: string,
    amount: number,
    date = "2026-09-15",
  ): Promise<[Transaction, Transaction]> {
    const from = await insertTransaction({
      accountId: fromAccountId,
      transactionDate: date,
      amount: -amount,
      isTransfer: true,
    });
    const to = await insertTransaction({
      accountId: toAccountId,
      transactionDate: date,
      amount,
      isTransfer: true,
      linkedTransactionId: from.id,
    });
    await dataSource.manager.update(Transaction, from.id, {
      linkedTransactionId: to.id,
    });
    return [from, to];
  }

  async function insertUsdCadRate(): Promise<void> {
    // Stored in the canonical orientation (CAD sorts before USD), as
    // `canonicalRateRow` writes it; the resolver reads either direction.
    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('CAD', 'USD', '2026-09-01'::DATE, 0.7407407407, 'test')`,
    );
  }

  const sankey = (
    options: { accountIds?: string[]; depth?: 1 | 2 } = {},
  ): Promise<CashFlowSankeyResponse> =>
    withUserContext(userId, () =>
      service.getCashFlowSankey(userId, START, END, {
        accountIds: options.accountIds ?? [chequingId, usChequingId],
        depth: options.depth,
      }),
    );

  const node = (result: CashFlowSankeyResponse, id: string) =>
    result.nodes.find((n) => n.id === id);

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "investment_transactions",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('CAD', 'Canadian Dollar', '$', 2),
         ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );

    userId = (await createTestUserDirect(dataSource)).id;
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'CAD')`,
      [userId],
    );

    chequingId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        accountType: "CHEQUING",
        currencyCode: "CAD",
      })
    ).id;
    usChequingId = (
      await createTestAccount(dataSource, userId, {
        name: "US Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
      })
    ).id;
    savingsId = (
      await createTestAccount(dataSource, userId, {
        name: "Savings",
        accountType: "SAVINGS",
        currencyCode: "CAD",
      })
    ).id;
    mortgageId = (
      await createTestAccount(dataSource, userId, {
        name: "Mortgage",
        accountType: "MORTGAGE",
        currencyCode: "CAD",
      })
    ).id;

    salaryId = (
      await createTestCategory(dataSource, userId, {
        name: "Salary",
        isIncome: true,
      })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
    interestId = (
      await createTestCategory(dataSource, userId, { name: "Interest" })
    ).id;
    diningId = (
      await createTestCategory(dataSource, userId, { name: "Dining" })
    ).id;

    // 1. Salary.
    await insertTransaction({ amount: 5000, categoryId: salaryId });
    // 2-3. Groceries and a refund.
    await insertTransaction({ amount: -620, categoryId: groceriesId });
    await insertTransaction({ amount: 20, categoryId: groceriesId });

    // 4. Mortgage payment: principal to the mortgage (a split transfer line),
    // interest to a category. The mortgage side's leg links to the parent.
    const payment = await insertTransaction({
      amount: -1600,
      isSplit: true,
      categoryId: null,
    });
    const mortgageLeg = await insertTransaction({
      accountId: mortgageId,
      amount: 900,
      isTransfer: true,
      linkedTransactionId: payment.id,
    });
    await dataSource.manager.save([
      dataSource.manager.create(TransactionSplit, {
        transactionId: payment.id,
        kind: SplitKind.TRANSFER,
        transferAccountId: mortgageId,
        linkedTransactionId: mortgageLeg.id,
        amount: -900,
      } as Partial<TransactionSplit>),
      dataSource.manager.create(TransactionSplit, {
        transactionId: payment.id,
        kind: SplitKind.CATEGORY,
        categoryId: interestId,
        amount: -700,
      } as Partial<TransactionSplit>),
    ]);

    // 5. To savings.
    await insertTransfer(chequingId, savingsId, 1000);
    // 6. Uncategorized.
    await insertTransaction({ amount: -45, categoryId: null });
    // 7. Dining, in US dollars.
    await insertTransaction({
      accountId: usChequingId,
      amount: -50,
      currencyCode: "USD",
      categoryId: diningId,
    });

    // Noise that must change nothing: a VOID purchase, a VOID transfer pair, a
    // BUY's generated cash leg and an investment-linked transfer leg, and a
    // row outside the window.
    await insertTransaction({
      amount: -999,
      categoryId: groceriesId,
      status: TransactionStatus.VOID,
    });
    const voided = await insertTransfer(chequingId, savingsId, 444);
    for (const leg of voided) {
      await dataSource.manager.update(Transaction, leg.id, {
        status: TransactionStatus.VOID,
      });
    }

    const brokerageId = (
      await createTestAccount(dataSource, userId, {
        name: "Brokerage",
        currencyCode: "CAD",
      })
    ).id;
    await dataSource.manager.update(Account, brokerageId, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    // A BUY funded from chequing: the generated cash row carries no category
    // and no transfer flag, so only the linkage keeps it out of spending.
    const buyLeg = await insertTransaction({ amount: -250, categoryId: null });
    // An investment action whose cash leg was posted as a transfer: only the
    // linkage keeps it out of "Savings & investments".
    const [linkedLeg] = await insertTransfer(chequingId, brokerageId, 300);
    for (const cashRow of [buyLeg, linkedLeg]) {
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, transaction_id, action, transaction_date, total_amount)
         VALUES ($1, $2, $3, 'BUY', '2026-09-10'::DATE, $4)`,
        [userId, brokerageId, cashRow.id, Math.abs(Number(cashRow.amount))],
      );
    }
    await insertTransaction({
      amount: -333,
      categoryId: groceriesId,
      transactionDate: "2026-10-01",
    });
  });

  it("draws the numerical example and closes on the residual (SANKEY-001)", async () => {
    await insertUsdCadRate();

    const result = await sankey();

    expect(node(result, `income:${salaryId}`)?.total).toBe(5000);
    expect(node(result, `expense:${groceriesId}`)?.total).toBe(600);
    expect(node(result, `expense:${interestId}`)?.total).toBe(700);
    expect(node(result, `expense:${diningId}`)?.total).toBe(67.5);
    expect(node(result, "uncategorized:expense")?.total).toBe(45);
    expect(node(result, "class:debt")?.total).toBe(900);
    expect(node(result, "class:savings")?.total).toBe(1000);
    expect(node(result, "residual:unspent")?.total).toBe(1687.5);
    expect(result.totals).toEqual({
      income: 5000,
      inflows: 0,
      expenses: 1412.5,
      outflows: 1900,
      unspent: 1687.5,
      deficit: 0,
    });
    expect(result.missingCurrencies).toEqual([]);
    expect(result.excludedCount).toBe(0);
    // A transfer is a named flow, never income or an expense (INV-REPORT-003).
    expect(node(result, "uncategorized:income")).toBeUndefined();
  });

  it("nulls the Dining link, the expenses total and the residual without the USD rate (SANKEY-004)", async () => {
    const result = await sankey();

    const dining = node(result, `expense:${diningId}`);
    expect(dining?.total).toBeNull();
    expect(dining?.knownTotal).toBe(0);
    expect(result.totals.expenses).toBeNull();
    expect(result.knownTotals.expenses).toBe(1345);
    expect(result.totals.unspent).toBeNull();
    expect(result.totals.deficit).toBeNull();
    expect(result.missingCurrencies).toEqual(["USD"]);
    expect(result.excludedCount).toBe(1);
  });

  it("makes the chequing-to-savings leg internal once savings is in scope (SANKEY-002)", async () => {
    await insertUsdCadRate();

    const result = await sankey({
      accountIds: [chequingId, usChequingId, savingsId],
    });

    // Neither leg is read: no outflow to savings, and no inflow from chequing.
    expect(node(result, "class:savings")).toBeUndefined();
    expect(node(result, "inflow:other_accounts")).toBeUndefined();
    expect(node(result, "class:debt")?.total).toBe(900);
    expect(result.totals.outflows).toBe(900);
    expect(result.totals.inflows).toBe(0);
    expect(result.totals.unspent).toBe(2687.5);
  });

  it("defaults the scope to the open cash-flow accounts, savings included", async () => {
    await insertUsdCadRate();
    const closed = await createTestAccount(dataSource, userId, {
      name: "Old chequing",
      accountType: "CHEQUING",
      currencyCode: "CAD",
      isClosed: true,
    });

    const result = await withUserContext(userId, () =>
      service.getCashFlowSankey(userId, START, END),
    );

    expect([...result.scopeAccountIds].sort()).toEqual(
      [chequingId, usChequingId, savingsId].sort(),
    );
    expect(result.scopeAccountIds).not.toContain(closed.id);
    expect(result.scopeAccountIds).not.toContain(mortgageId);
    expect(node(result, "class:savings")).toBeUndefined();
    expect(result.totals.unspent).toBe(2687.5);
  });

  it("counts a leg by its own account's scope, so the mortgage side is read only without chequing", async () => {
    await insertUsdCadRate();

    // With the mortgage in scope its +900 leg would be read; with chequing in
    // scope too, the payment is internal on both sides.
    const both = await sankey({
      accountIds: [chequingId, usChequingId, mortgageId],
    });
    expect(node(both, "class:debt")).toBeUndefined();
    expect(node(both, "inflow:other_accounts")).toBeUndefined();

    // The mortgage alone: its leg is an inflow from an out-of-scope chequing.
    const mortgageOnly = await sankey({ accountIds: [mortgageId] });
    expect(node(mortgageOnly, "inflow:other_accounts")?.total).toBe(900);
    expect(mortgageOnly.totals.unspent).toBe(900);
  });

  it("lists the counterpart accounts under each class at depth 2", async () => {
    await insertUsdCadRate();
    const account = await dataSource.manager.findOneByOrFail(Account, {
      id: savingsId,
    });

    const result = await sankey({ depth: 2 });

    const savings = node(result, `account:${savingsId}`);
    expect(savings?.label).toBe(account.name);
    expect(savings?.total).toBe(1000);
    expect(node(result, `account:${mortgageId}`)?.total).toBe(900);
  });
});
