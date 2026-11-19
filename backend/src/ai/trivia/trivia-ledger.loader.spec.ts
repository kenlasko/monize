import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { TriviaLedgerLoader, triviaWindow } from "./trivia-ledger.loader";
import { WINDOWED_FAMILIES, type TriviaPicks } from "./trivia-windowed-reads";
import type { TriviaWindow } from "./trivia.types";

jest.mock("../../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));

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

const TODAY = "2026-11-10";

const picksOf = (
  window: TriviaWindow,
  over: Partial<Record<(typeof WINDOWED_FAMILIES)[number], TriviaWindow>> = {},
): TriviaPicks =>
  Object.fromEntries(
    WINDOWED_FAMILIES.map((f) => [f, { window: over[f] ?? window, rank: 2 }]),
  ) as TriviaPicks;
const M12 = picksOf("m12");

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
    const input = await loader.load("user-1", "CAD", TODAY, M12);
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
    const input = await loader.load("user-1", "CAD", TODAY, M12);
    expect(input.spendingByPayee).toBeNull();
    expect(input.spendingByCategory).toEqual({ id: "cat" });
    expect(input.records).not.toBeNull();
  });

  describe("the windowed reads", () => {
    beforeEach(() =>
      answer(
        {
          transactions: 0,
          first_date: null,
          payees: 0,
          categories: 0,
          scheduled: 0,
        },
        [],
      ),
    );

    it("reads only the m12 windows when every pick is m12", async () => {
      const input = await loader.load("user-1", "CAD", TODAY, M12);
      expect(reports.getSpendingByCategory).toHaveBeenCalledTimes(1);
      expect(reports.getSpendingByPayee).toHaveBeenCalledTimes(1);
      expect(reports.getIncomeBySource).toHaveBeenCalledTimes(1);
      expect(input.windowed.spendingByCategory.size).toBe(0);
    });

    it("reads a window once for two families that picked it", async () => {
      const input = await loader.load("user-1", "CAD", TODAY, picksOf("d90"));
      // One m12 read, plus one d90 read, however many families picked d90.
      expect(reports.getSpendingByCategory).toHaveBeenCalledTimes(2);
      expect(reports.getSpendingByCategory).toHaveBeenCalledWith(
        "user-1",
        "2026-08-12",
        "2026-11-09",
      );
      expect(input.windowed.spendingByCategory.get("d90")).toEqual({
        id: "cat",
      });
      expect(input.windowed.spendingByPayee.get("d90")).toEqual({
        id: "payee",
      });
      expect(input.windowed.incomeBySource.get("d90")).toEqual({
        id: "income",
      });
    });

    it("reads all time from no start date, and each report on its own pick", async () => {
      await loader.load(
        "user-1",
        "CAD",
        TODAY,
        picksOf("m12", {
          spendingTopPayee: "all",
          spendingRankedCategory: "d30",
        }),
      );
      expect(reports.getSpendingByPayee).toHaveBeenCalledWith(
        "user-1",
        undefined,
        "2026-11-09",
      );
      expect(reports.getSpendingByCategory).toHaveBeenCalledWith(
        "user-1",
        "2026-10-11",
        "2026-11-09",
      );
      expect(reports.getIncomeBySource).toHaveBeenCalledTimes(1);
    });

    it("lets one failing windowed read drop only its own window", async () => {
      reports.getSpendingByPayee.mockImplementation(
        (_u: string, start: string | undefined) =>
          start === "2026-08-12"
            ? Promise.reject(new Error("boom"))
            : Promise.resolve({ id: "payee" }),
      );
      const input = await loader.load("user-1", "CAD", TODAY, picksOf("d90"));
      expect(input.windowed.spendingByPayee.get("d90")).toBeNull();
      expect(input.windowed.spendingByCategory.get("d90")).toEqual({
        id: "cat",
      });
    });
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
    const input = await loader.load("user-1", "CAD", TODAY, M12);
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
    const input = await loader.load("user-1", "CAD", TODAY, M12);
    expect(input.warranties).toEqual({ covered: 1, nextExpiring: null });
  });

  it("dates every window by the day it is given, not by the clock", async () => {
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
    // The system clock says 10 November; the reader's day is 1 November.
    await loader.load("user-1", "CAD", "2026-11-01", M12);
    expect(reports.getSpendingByCategory).toHaveBeenCalledWith(
      "user-1",
      "2025-11-01",
      "2026-10-31",
    );
  });
});
