import { AccountsController } from "../accounts/accounts.controller";
import { BudgetsController } from "../budgets/budgets.controller";
import { BuiltInReportsController } from "../built-in-reports/built-in-reports.controller";
import { TransactionsController } from "../transactions/transactions.controller";
import { NetWorthController } from "../net-worth/net-worth.controller";
import { CategoriesController } from "../categories/categories.controller";
import { PayeesController } from "../payees/payees.controller";
import { ReportingBasisInterceptor } from "./reporting-basis.interceptor";

/** These semantics matter even where services delegate to identity/cash readers:
 * a documented selectable basis must never quietly return another basis's data.
 */
describe("Reporting surface accounting contracts", () => {
  const cases: [
    { prototype: object; name: string },
    string[],
    "cash" | undefined,
  ][] = [
    [
      AccountsController,
      [
        "summary",
        "daily-balances",
        "daily-balance-totals",
        "balances-as-of",
        ":id/balance",
        ":id/balance-forecast",
      ],
      "cash",
    ],
    [BudgetsController, [":id/periods", ":id/periods/:periodId"], "cash"],
    [CategoriesController, [":id/detail"], "cash"],
    [PayeesController, [":id/detail"], "cash"],
    [
      NetWorthController,
      [
        "investments-monthly",
        "investments-daily",
        "investments-period-result",
        "investments-period-results",
        "investments-breakdown",
      ],
      "cash",
    ],
    [
      BuiltInReportsController,
      [
        "cash-flow",
        "cash-flow-sankey",
        "weekend-vs-weekday",
        "spending-anomalies",
        "tax-summary",
        "recurring-expenses",
        "bill-payment-history",
        "uncategorized-transactions",
        "duplicate-transactions",
      ],
      "cash",
    ],
    [TransactionsController, ["recurring-charges", "fx-fee-summary"], "cash"],
    [
      TransactionsController,
      ["summary", "monthly-totals", "grouped-totals", "tag-key-breakdown"],
      undefined,
    ],
    [
      BudgetsController,
      [
        ":id/summary",
        ":id/reports/trend",
        ":id/reports/category-trend",
        "category-budget-status",
      ],
      undefined,
    ],
    [
      BuiltInReportsController,
      [
        "spending-by-category",
        "spending-by-payee",
        "income-by-source",
        "monthly-spending-trend",
        "income-vs-expenses",
        "year-over-year",
        "monthly-comparison",
        "monthly-category-breakdown",
      ],
      undefined,
    ],
    [NetWorthController, ["monthly"], undefined],
  ];
  for (const [controller, paths, basis] of cases)
    it(`${controller.name} exposes the correct basis for ${paths.join(", ")}`, () => {
      for (const path of paths) {
        const method = Object.getOwnPropertyNames(controller.prototype)
          .map(
            (name) => (controller.prototype as Record<string, unknown>)[name],
          )
          .find(
            (fn) =>
              typeof fn === "function" &&
              Reflect.getMetadata("path", fn) === path,
          );
        expect(method).toBeDefined();
        if (typeof method !== "function")
          throw new Error(`Missing reporting endpoint ${path}`);
        expect(Reflect.getMetadata("reportingFixedBasis", method)).toBe(basis);
        expect(Reflect.getMetadata("__interceptors__", method)).toContain(
          ReportingBasisInterceptor,
        );
      }
    });
});
