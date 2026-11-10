import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { TriviaLedgerLoader, triviaWindow } from "./trivia-ledger.loader";

jest.mock("../../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("../../common/users-by-timezone.util", () => ({
  getEffectiveTimezoneOfUser: jest.fn(),
}));

describe("triviaWindow", () => {
  it("is the twelve whole months before this one", () => {
    expect(triviaWindow("2026-11-10")).toEqual({
      startDate: "2025-11-01",
      endDate: "2026-10-31",
    });
  });

  it("crosses a year from January, and ends February on its last day", () => {
    expect(triviaWindow("2026-01-31")).toEqual({
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    expect(triviaWindow("2024-03-01")).toEqual({
      startDate: "2023-03-01",
      endDate: "2024-02-29",
    });
  });
});

describe("TriviaLedgerLoader", () => {
  let query: jest.Mock;
  let reports: Record<string, jest.Mock>;
  let loader: TriviaLedgerLoader;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-11-10T12:00:00Z"));
    query = jest.fn();
    (withScopedDb as jest.Mock).mockImplementation(
      (_ds: DataSource, fn: (m: EntityManager) => unknown) =>
        fn({ query } as unknown as EntityManager),
    );
    (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue("UTC");
    reports = {
      getSpendingByCategory: jest.fn().mockResolvedValue({ id: "cat" }),
      getSpendingByPayee: jest.fn().mockResolvedValue({ id: "payee" }),
      getIncomeVsExpenses: jest.fn().mockResolvedValue({ id: "flows" }),
      getIncomeBySource: jest.fn().mockResolvedValue({ id: "income" }),
    };
    loader = new TriviaLedgerLoader({} as DataSource, reports as never);
  });

  afterEach(() => jest.useRealTimers());

  const answer = (
    counts: Record<string, unknown>,
    warranties: Record<string, unknown>[],
  ) =>
    query.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes("FROM warranties") ? warranties : [counts]),
    );

  it("reads each report over the window, and counts the records as the reader's own", async () => {
    answer(
      {
        transactions: 7,
        first_date: "2021-05-04",
        payees: 3,
        categories: 5,
        scheduled: 1,
      },
      [],
    );
    const input = await loader.load("user-1", "CAD");
    for (const read of Object.values(reports)) {
      expect(read).toHaveBeenCalledWith("user-1", "2025-11-01", "2026-10-31");
    }
    expect(input.spendingByCategory).toEqual({ id: "cat" });
    expect(input.records).toEqual({
      transactions: 7,
      firstTransactionDate: "2021-05-04",
      activePayees: 3,
      categories: 5,
      activeScheduled: 1,
    });
    const countSql = query.mock.calls.find(([sql]) => sql.includes("count(*)"));
    expect(countSql?.[1]).toEqual(["user-1"]);
    expect(countSql?.[0]).toContain("status IS DISTINCT FROM 'VOID'");
    expect(countSql?.[0]).toContain("parent_transaction_id IS NULL");
  });

  it("lets a failing report drop only its own facts", async () => {
    answer(
      {
        transactions: 0,
        first_date: null,
        payees: 0,
        categories: 0,
        scheduled: 0,
      },
      [],
    );
    reports.getSpendingByPayee.mockRejectedValue(new Error("boom"));
    const input = await loader.load("user-1", "CAD");
    expect(input.spendingByPayee).toBeNull();
    expect(input.spendingByCategory).toEqual({ id: "cat" });
    expect(input.records).not.toBeNull();
  });

  it("reads warranty cover by warrantyStatus's bounds: a warranty ending today is in cover", async () => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        !sql.includes("FROM warranties")
          ? [
              {
                transactions: 0,
                first_date: null,
                payees: 0,
                categories: 0,
                scheduled: 0,
              },
            ]
          : sql.includes("count(*)")
            ? [{ covered: 4 }]
            : [{ name: "Phone", expires_on: "2026-11-10" }],
      ),
    );
    const input = await loader.load("user-1", "CAD");
    expect(input.warranties).toEqual({
      covered: 4,
      nextExpiring: { name: "Phone", expiresOn: "2026-11-10" },
    });
    const warrantyCalls = query.mock.calls.filter(([sql]) =>
      sql.includes("FROM warranties"),
    );
    // Yesterday is the last day that reads `expired`.
    for (const [sql, params] of warrantyCalls) {
      expect(params).toEqual(["user-1", "2026-11-09"]);
      expect(sql).toContain("expires_on > $2");
      expect(sql).toContain("archived_at IS NULL");
    }
  });

  it("names no next warranty when none ends", async () => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        !sql.includes("FROM warranties")
          ? [
              {
                transactions: 0,
                first_date: null,
                payees: 0,
                categories: 0,
                scheduled: 0,
              },
            ]
          : sql.includes("count(*)")
            ? [{ covered: 1 }]
            : [],
      ),
    );
    const input = await loader.load("user-1", "CAD");
    expect(input.warranties).toEqual({ covered: 1, nextExpiring: null });
  });

  it("dates the window by the reader's own zone", async () => {
    // 20:00 UTC on 31 October is already 1 November in Kiritimati (UTC+14),
    // so October is a whole month there; in UTC it would still be running.
    jest.setSystemTime(new Date("2026-10-31T20:00:00Z"));
    (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue(
      "Pacific/Kiritimati",
    );
    answer(
      {
        transactions: 0,
        first_date: null,
        payees: 0,
        categories: 0,
        scheduled: 0,
      },
      [],
    );
    await loader.load("user-1", "CAD");
    expect(reports.getSpendingByCategory).toHaveBeenCalledWith(
      "user-1",
      "2025-11-01",
      "2026-10-31",
    );
  });
});
