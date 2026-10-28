import type { EntityManager, SelectQueryBuilder } from "typeorm";
import { reportingSummaryRows } from "./reporting-summary-money";

describe("cash summary native currency boundary", () => {
  it("keeps native buckets available without requiring an exchange rate", async () => {
    const rows = [
      {
        currencyCode: "USD",
        totalIncome: "0",
        totalExpenses: "1000",
        transactionCount: "1",
      },
      {
        currencyCode: "PLN",
        totalIncome: "0",
        totalExpenses: "4000",
        transactionCount: "1",
      },
    ];
    const manager = {
      getRepository: () => ({
        findOne: async () => ({ reportingBasis: "cash" }),
      }),
      query: jest.fn(),
    };
    const qb = {
      getRawMany: jest.fn().mockResolvedValue(rows),
      clone: jest.fn(),
    };
    // Nullable reporting totals belong to the analytics service's FxAggregate
    // fold. Refusing here used to prevent its known subtotal from being read.
    expect(
      await reportingSummaryRows(
        manager as unknown as EntityManager,
        "owner",
        qb as unknown as SelectQueryBuilder<any>,
        "PLN",
        "totalIncome",
        "totalExpenses",
        true,
      ),
    ).toEqual(rows);
    expect(qb.clone).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });
});
