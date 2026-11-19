import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import { TriviaCalendarLoader } from "./trivia-calendar.loader";

jest.mock("../../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));

const USER = "user-1";

describe("TriviaCalendarLoader", () => {
  let query: jest.Mock;
  let reports: jest.Mocked<
    Pick<BuiltInReportsService, "getSpendingByCategory">
  >;
  let loader: TriviaCalendarLoader;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
    (withScopedDb as jest.Mock).mockImplementation(
      (_ds: DataSource, fn: (m: EntityManager) => unknown) =>
        fn({ query } as unknown as EntityManager),
    );
    reports = {
      getSpendingByCategory: jest.fn().mockResolvedValue({ totalSpending: 1 }),
    };
    loader = new TriviaCalendarLoader(
      {} as DataSource,
      reports as unknown as BuiltInReportsService,
    );
  });

  it("reads the whole month a year before today's", async () => {
    await loader.load(USER, "2026-01-15");
    expect(reports.getSpendingByCategory).toHaveBeenCalledWith(
      USER,
      "2025-01-01",
      "2025-01-31",
    );
  });

  it("strips the brokerage suffix from account names and keeps the dates", async () => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes("first_date")
          ? [
              { name: "TFSA - Brokerage", first_date: "2022-11-16" },
              { name: "Chequing", first_date: "2021-11-15" },
            ]
          : [{ recorded_before: "990" }],
      ),
    );
    const input = await loader.load(USER, "2026-11-19");
    expect(input.accountFirstDates).toEqual([
      { name: "TFSA", firstDate: "2022-11-16" },
      { name: "Chequing", firstDate: "2021-11-15" },
    ]);
    expect(input.transactionsRecordedBefore).toBe(990);
  });

  it("reads open accounts' non-VOID top-level rows, scoped to the reader", async () => {
    await loader.load(USER, "2026-11-19");
    const [sql, params] = query.mock.calls.find(([s]) =>
      s.includes("first_date"),
    );
    expect(sql).toContain("TO_CHAR(MIN(t.transaction_date), 'YYYY-MM-DD')");
    expect(sql).toContain("a.is_closed IS NOT TRUE");
    expect(sql).toContain("t.parent_transaction_id IS NULL");
    expect(sql).toContain("IS DISTINCT FROM 'VOID'");
    expect(params).toEqual([USER]);
  });

  it("counts rows created before the last 30 days", async () => {
    await loader.load(USER, "2026-11-19");
    const [sql, params] = query.mock.calls.find(([s]) =>
      s.includes("recorded_before"),
    );
    expect(sql).toContain("created_at < now()");
    expect(params).toEqual([USER, "30"]);
  });

  it("counts none as zero, not as unknown", async () => {
    query.mockResolvedValue([]);
    const input = await loader.load(USER, "2026-11-19");
    expect(input.transactionsRecordedBefore).toBe(0);
  });

  describe("one failing source", () => {
    it("nulls only the accounts", async () => {
      query.mockImplementation((sql: string) =>
        sql.includes("first_date")
          ? Promise.reject(new Error("boom"))
          : Promise.resolve([{ recorded_before: 5 }]),
      );
      const input = await loader.load(USER, "2026-11-19");
      expect(input.accountFirstDates).toBeNull();
      expect(input.transactionsRecordedBefore).toBe(5);
      expect(input.yearAgoMonth).not.toBeNull();
    });

    it("nulls only the recorded count", async () => {
      query.mockImplementation((sql: string) =>
        sql.includes("recorded_before")
          ? Promise.reject(new Error("boom"))
          : Promise.resolve([]),
      );
      const input = await loader.load(USER, "2026-11-19");
      expect(input.transactionsRecordedBefore).toBeNull();
      expect(input.accountFirstDates).toEqual([]);
      expect(input.yearAgoMonth).not.toBeNull();
    });

    it("nulls only the year-ago report", async () => {
      reports.getSpendingByCategory.mockRejectedValue(new Error("boom"));
      const input = await loader.load(USER, "2026-11-19");
      expect(input.yearAgoMonth).toBeNull();
      expect(input.accountFirstDates).toEqual([]);
      expect(input.transactionsRecordedBefore).toBe(0);
    });
  });
});
