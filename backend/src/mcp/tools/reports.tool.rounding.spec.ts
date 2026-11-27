import { DataSource } from "typeorm";
import { SharedReviewService } from "../../shared-expenses/shared-review.service";
import { sharedReviewMock } from "../../shared-expenses/__fixtures__/shared-review";
import { McpReportsTools } from "./reports.tool";
import { mcpTestCtx } from "../testing/mcp-test-context";
import { SpendingReportsService } from "../../built-in-reports/spending-reports.service";
import { ReportCurrencyService } from "../../built-in-reports/report-currency.service";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";
import { Category } from "../../categories/entities/category.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import {
  FIXTURE_TX_DATE,
  rateIndexOf,
} from "../../test-helpers/report-rate-testing";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

/**
 * The MCP `generate_report` tool hands out the report's own figures, so a
 * figure rounded once on the server at the reporting currency's places is the
 * figure the model reads (docs/specs/report-rounding-and-aggregation.md
 * section 6, issue #2410). Driven over the real Spending by Category rather
 * than a mock of it, so the figure is the service's own.
 */
describe("generate_report reads the report's figures at the currency's places (issue #2410)", () => {
  it("returns a 2.50498 USD category as 2.50, not through 2.5050 as 2.51", async () => {
    const { manager, dataSource } = createScopedDbMocks([
      [
        Category,
        {
          find: jest.fn().mockResolvedValue([
            {
              id: "cat-1",
              name: "Groceries",
              parentId: null,
              color: null,
              categoryType: "expense",
            },
          ]),
        },
      ],
      [
        UserPreference,
        { findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }) },
      ],
    ]);
    // 1.00 EUR spent at 2.50498 USD.
    manager.query.mockResolvedValue([
      {
        category_id: "cat-1",
        currency_code: "EUR",
        tx_date: FIXTURE_TX_DATE,
        total: "1.0000",
      },
    ]);
    const currency = new ReportCurrencyService(
      dataSource as unknown as DataSource,
      {
        getRateIndex: jest
          .fn()
          .mockResolvedValue(
            rateIndexOf([
              { fromCurrency: "EUR", toCurrency: "USD", rate: 2.50498 },
            ]),
          ),
      } as unknown as ExchangeRateService,
    );
    const spending = new SpendingReportsService(
      dataSource as unknown as DataSource,
      currency,
    );
    const sharedReview = sharedReviewMock();
    const tool = new McpReportsTools(
      sharedReview as unknown as SharedReviewService,
      {
        getSpendingByCategory: (
          ...args: Parameters<SpendingReportsService["getSpendingByCategory"]>
        ) => spending.getSpendingByCategory(...args),
      } as never,
      {} as never,
    );
    const handlers: Record<string, (...args: any[]) => any> = {};
    tool.register({
      registerTool: jest.fn((name, _opts, handler) => {
        handlers[name] = handler;
      }),
    } as never);
    const ctx = mcpTestCtx();
    ctx.setUser({ userId: "u1", scopes: "read" });

    const result = await handlers.generate_report(
      {
        type: "spending_by_category",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      },
      ctx,
    );

    expect(result.structuredContent).toMatchObject({
      data: [{ categoryId: "cat-1", total: 2.5 }],
      totalSpending: 2.5,
      currency: "USD",
    });
  });
});
