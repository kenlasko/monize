import { Account } from "@/accounts/entities/account.entity";
import { AccountsService } from "@/accounts/accounts.service";
import { ToolExecutorService } from "@/ai/query/tool-executor.service";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { withUserContext } from "@/common/db/with-context";
import { McpTransactionsTools } from "@/mcp/tools/transactions.tool";
import { mcpTestCtx } from "@/mcp/testing/mcp-test-context";
import { SharedReviewService } from "@/shared-expenses/shared-review.service";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { UserPreference } from "@/users/entities/user-preference.entity";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

describe("list_transactions grouped spending through MCP (USD)", () => {
  let module: TestingModule;
  let tools: TestingModule;
  let db: DataSource;
  let userId: string;
  let accountId: string;
  let categoryId: string;
  let payeeId: string;
  const registerTool = jest.fn();
  const startDate = "2026-11-01";
  const endDate = "2026-12-31";

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    db = module.get(DataSource);
    tools = await Test.createTestingModule({
      providers: [
        McpTransactionsTools,
        ToolExecutorService,
        {
          provide: AccountsService,
          useValue: module.get(AccountsService),
        },
        {
          provide: TransactionAnalyticsService,
          useValue: new TransactionAnalyticsService(db),
        },
        { provide: SharedReviewService, useValue: new SharedReviewService(db) },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    tools.get(McpTransactionsTools).register({ registerTool } as never);
  });
  afterAll(async () => {
    await tools?.close();
    await module?.close();
  });
  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountId = (await createTestAccount(db, userId, { currencyCode: "USD" }))
      .id;
    await db.manager.save(UserPreference, { userId, defaultCurrency: "USD" });
    categoryId = (await createTestCategory(db, userId, { name: "Groceries" }))
      .id;
    payeeId = (await createTestPayee(db, userId, { name: "Shop" })).id;
  });

  function post(amount: number, overrides: Partial<Transaction> = {}) {
    return db.manager.save(Transaction, {
      userId,
      accountId,
      categoryId,
      payeeId,
      amount,
      currencyCode: "USD",
      transactionDate: startDate,
      ...overrides,
    });
  }

  async function list(
    direction: "expenses" | "outgoing",
    groupBy: "category" | "payee" | "month" | "week" | "year",
    filters = {},
  ) {
    const [, config, handler] = registerTool.mock.calls.find(
      ([name]) => name === "list_transactions",
    )!;
    const args = config.inputSchema.parse({
      startDate,
      endDate,
      direction,
      groupBy,
      ...filters,
    });
    const result = await withUserContext<{ structuredContent: unknown }>(
      userId,
      () => handler(args, mcpTestCtx({ userId, scopes: "read" })),
    );
    expect(result).not.toHaveProperty("isError", true);
    return config.outputSchema.parse(result.structuredContent);
  }

  it("resolves closed accounts and requests an explicit ID for a reused name on both tools", async () => {
    await db.manager.update(Account, accountId, {
      name: "Household",
      currencyCode: "EUR",
    });
    await db.manager.update(
      UserPreference,
      { userId },
      { defaultCurrency: "EUR" },
    );
    const posting = { currencyCode: "EUR", transactionDate: "2026-03-01" };
    await post(-125, posting);

    async function read(accountNames?: string[]) {
      const input = {
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        direction: "expenses",
        groupBy: "month",
        accountNames,
      };
      const [, config, handler] = registerTool.mock.calls.find(
        ([name]) => name === "list_transactions",
      )!;
      const mcp = await withUserContext<{
        isError?: boolean;
        structuredContent?: unknown;
        content: { text: string }[];
      }>(userId, () =>
        handler(
          config.inputSchema.parse(input),
          mcpTestCtx({ userId, scopes: "read" }),
        ),
      );
      const ai = await withUserContext(userId, () =>
        tools
          .get(ToolExecutorService)
          .execute(userId, "list_transactions", input),
      );
      return { mcp, ai };
    }
    async function checkTotal(total: number, names?: string[]) {
      const { mcp, ai } = await read(names);
      const expected = {
        totalsCurrency: "EUR",
        breakdown: [{ month: "2026-03", total }],
      };
      expect(mcp.isError).toBeFalsy();
      expect(mcp.structuredContent).toMatchObject(expected);
      expect(ai.isError).toBeFalsy();
      expect(ai.data).toMatchObject(expected);
    }

    await checkTotal(125, ["household"]);
    await withUserContext(userId, () =>
      module.get(AccountsService).close(userId, accountId),
    );
    await checkTotal(125, ["Household"]);
    const replacement = await createTestAccount(db, userId, {
      name: "Household",
      currencyCode: "EUR",
    });
    await post(-24, { ...posting, accountId: replacement.id });
    const { mcp, ai } = await read(["Household"]);
    expect(mcp.isError).toBe(true);
    expect(ai.isError).toBe(true);
    for (const message of [mcp.content[0].text, ai.summary]) {
      expect(message).toContain(`Closed: ${accountId}`);
      expect(message).toContain(`Open: ${replacement.id}`);
    }
    await checkTotal(125, [accountId]);
    await checkTotal(24, [replacement.id]);
    await checkTotal(149);
  });

  it.each([30, 100, 150])(
    "nets a %i USD refund in every grouping and keeps cash flows separate",
    async (refund) => {
      // Three independent debits meet the payee disclosure threshold even in outgoing.
      for (const debit of [-30, -30, -40]) await post(debit);
      await post(refund);
      for (const groupBy of ["category", "payee", "month"] as const) {
        const label = {
          category: "Groceries",
          payee: "Shop",
          month: "2026-11",
        }[groupBy];
        for (const [direction, total, count] of [
          ["expenses", 100 - refund, 4],
          ["outgoing", 100, 3],
        ] as const) {
          const result = await list(direction, groupBy);
          const ai = await withUserContext(userId, () =>
            tools
              .get(ToolExecutorService)
              .execute(userId, "list_transactions", {
                startDate,
                endDate,
                direction,
                groupBy,
              }),
          );
          expect(ai.isError).toBeFalsy();
          expect(ai.data).toMatchObject({
            breakdown: result.breakdown,
            netCashFlow: refund - 100,
          });

          expect(result).toMatchObject({
            totalIncome: refund,
            totalExpenses: 100,
            netCashFlow: refund - 100,
            totalsCurrency: "USD",
            breakdown: [{ [groupBy]: label, total, count }],
          });
        }
      }
    },
  );

  it("keeps linked payees and free text separate when their stored names match", async () => {
    const secondId = (await createTestPayee(db, userId, { name: "Birch" })).id;
    for (const transactionDate of [startDate, "2026-11-02", "2026-11-03"]) {
      await post(-12, { payeeId, payeeName: "Shop", transactionDate });
      await post(-7, { payeeId: secondId, payeeName: "Shop", transactionDate });
      await post(-2, { payeeId: null, payeeName: "Shop", transactionDate });
    }
    for (const direction of ["expenses", "outgoing"] as const) {
      const result = await list(direction, "payee");
      expect(result.breakdown).toMatchObject([
        { payee: "Shop", payeeId, total: 36, count: 3 },
        { payee: "Birch", payeeId: secondId, total: 21, count: 3 },
        { payee: "Shop", payeeId: null, total: 6, count: 3 },
      ]);
      const ai = await withUserContext(userId, () =>
        tools.get(ToolExecutorService).execute(userId, "list_transactions", {
          startDate,
          endDate,
          direction,
          groupBy: "payee",
        }),
      );
      expect(ai.isError).toBeFalsy();
      expect(ai.data).toMatchObject({ breakdown: result.breakdown });
      for (const row of result.breakdown) {
        if (!row.payeeId) continue;
        const detail = await withUserContext(userId, () =>
          module
            .get(TransactionsService)
            .findAll(userId, undefined, startDate, endDate, undefined, [
              row.payeeId,
            ]),
        );
        expect(detail.data).toHaveLength(row.count);
        expect(
          -detail.data.reduce((sum, tx) => sum + Number(tx.amount), 0),
        ).toBe(row.total);
      }
    }
  });

  it("applies the disclosure threshold per payee before pooling small totals", async () => {
    const secondId = (await createTestPayee(db, userId, { name: "Birch" })).id;
    for (const id of [payeeId, secondId]) {
      await post(-4, { payeeId: id, payeeName: "Shared text" });
      await post(-6, { payeeId: id, payeeName: "Shared text" });
    }
    expect(await list("expenses", "payee")).toMatchObject({
      breakdown: [
        { payee: "Other (aggregated)", payeeId: null, total: 20, count: 4 },
      ],
    });
  });

  it("keeps the December refund signed when November holds the purchase", async () => {
    await post(-100);
    await post(30, { transactionDate: "2026-12-02" });
    expect(await list("expenses", "month")).toMatchObject({
      netCashFlow: -70,
      breakdown: [
        { month: "2026-11", total: 100 },
        { month: "2026-12", total: -30 },
      ],
    });
    expect(await list("expenses", "year")).toMatchObject({
      breakdown: [{ year: "2026", total: 70 }],
    });
    expect(await list("expenses", "week")).toMatchObject({
      breakdown: [
        { week: "2026-10-26", total: 100 },
        { week: "2026-11-30", total: -30 },
      ],
    });
    expect(await list("expenses", "payee")).toMatchObject({
      breakdown: [
        { payee: "Other (aggregated)", payeeId: null, total: 70, count: 2 },
      ],
    });
  });

  it("classifies splits before grouping and counts their payee once per transaction", async () => {
    const income = (
      await createTestCategory(db, userId, { name: "Salary", isIncome: true })
    ).id;
    const parent = await post(-100, { isSplit: true, categoryId: null });
    await db.manager.save(TransactionSplit, [
      { transactionId: parent.id, categoryId, amount: -40 },
      { transactionId: parent.id, categoryId, amount: -30 },
      { transactionId: parent.id, categoryId: income, amount: -30 },
    ]);
    await post(30);
    await post(-10, { categoryId: null });
    for (const direction of ["expenses", "outgoing"] as const) {
      const expected = direction === "expenses" ? 40 : 110;
      expect(await list(direction, "payee")).toMatchObject({
        breakdown: [
          {
            payee: "Other (aggregated)",
            payeeId: null,
            total: expected,
            count: 2,
          },
        ],
      });
      for (const categoryNames of [
        ["Groceries", "Salary"],
        ["Salary", "Groceries"],
      ]) {
        expect(await list(direction, "month", { categoryNames })).toMatchObject(
          { breakdown: [{ total: direction === "expenses" ? 40 : 100 }] },
        );
      }
    }
  });
});
