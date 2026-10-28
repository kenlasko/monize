import { beforeEach, expect, it, vi } from "vitest";
import apiClient from "./api";
import { builtInReportsApi } from "./built-in-reports";
import { transactionsApi } from "./transactions";
import { netWorthApi } from "./net-worth";
import { categoriesApi } from "./categories";
import { payeesApi } from "./payees";
vi.mock("./api", () => ({ default: { get: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
});
it.each(["cash", "accrual"] as const)(
  "serializes %s on period and scalar report requests",
  async (basis) => {
    await builtInReportsApi.getSpendingByCategory({
      basis,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      accountIds: ["a", "b"],
    });
    expect(apiClient.get).toHaveBeenLastCalledWith(
      "/built-in-reports/spending-by-category",
      {
        params: {
          basis,
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          accountIds: "a,b",
        },
      },
    );
    await builtInReportsApi.getYearOverYear(3, basis);
    expect(apiClient.get).toHaveBeenLastCalledWith(
      "/built-in-reports/year-over-year",
      { params: { yearsToCompare: 3, basis } },
    );
    await builtInReportsApi.getMonthlyComparison("2026-06", basis);
    expect(apiClient.get).toHaveBeenLastCalledWith(
      "/built-in-reports/monthly-comparison",
      { params: { month: "2026-06", basis } },
    );
    await netWorthApi.getMonthly({ basis, endDate: "2026-12-31" });
    expect(apiClient.get).toHaveBeenLastCalledWith("/net-worth/monthly", {
      params: { basis, endDate: "2026-12-31" },
    });
  },
);
it.each(["cash", "accrual"] as const)(
  "carries %s through every detail analytics query builder",
  async (basis) => {
    for (const read of [
      () => transactionsApi.getSummary({ basis, payeeIds: ["payee"] }),
      () =>
        transactionsApi.getMonthlyTotals({ basis, categoryIds: ["category"] }),
      () =>
        transactionsApi.getGroupedTotals({
          basis,
          groupBy: "category",
          payeeIds: ["payee"],
        }),
      () => transactionsApi.getTagKeyBreakdown({ basis, key: "project" }),
    ]) {
      await read();
      expect(apiClient.get).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ params: expect.objectContaining({ basis }) }),
      );
    }
  },
);
it("keeps source identity/detail endpoints explicitly cash-based", async () => {
  await categoriesApi.getDetail("category");
  expect(apiClient.get).toHaveBeenLastCalledWith(
    "/categories/category/detail",
    { params: { basis: "cash" } },
  );
  await payeesApi.getDetail("payee");
  expect(apiClient.get).toHaveBeenLastCalledWith("/payees/payee/detail", {
    params: { basis: "cash" },
  });
});
