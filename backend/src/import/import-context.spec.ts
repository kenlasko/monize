import { EntityManager } from "typeorm";
import {
  recordSkippedRow,
  restoreRowCounters,
  snapshotRowCounters,
  updateAccountBalance,
} from "./import-context";
import { ImportResultDto, SKIPPED_ROWS_LIMIT } from "./dto/import.dto";

type MockManager = { query: jest.Mock; findOne: jest.Mock; update: jest.Mock };

const makeMockManager = (): MockManager => ({
  query: jest.fn().mockResolvedValue([[], 1]),
  findOne: jest.fn().mockResolvedValue(null),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
});

const asManager = (manager: MockManager): EntityManager =>
  manager as unknown as EntityManager;

/** Collapse whitespace so the assertions do not depend on the SQL's layout. */
const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

describe("updateAccountBalance", () => {
  it("moves the balance with one atomic delta statement, never a read-modify-write", async () => {
    // The regression: the helper used to `findOne` the account and write back an
    // absolute balance computed in JavaScript, so a concurrent delta committing
    // between the two statements was silently discarded
    // (docs/concurrency-and-idempotency.md section 2, row 1).
    const manager = makeMockManager();

    await updateAccountBalance(asManager(manager), "acc-1", 50);

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(normalize(sql)).toBe(
      "UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4) WHERE id = $2 AND is_closed = false RETURNING id",
    );
    expect(params).toEqual([50, "acc-1"]);
    // No SELECT of the account, and no absolute write.
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it("passes the delta parameterized rather than interpolated", async () => {
    const manager = makeMockManager();

    await updateAccountBalance(asManager(manager), "acc-1", -75);

    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("-75");
    expect(sql).not.toContain("acc-1");
    expect(params).toEqual([-75, "acc-1"]);
  });

  it("sums two deltas to one account within one import", async () => {
    // Two rows of the same imported file hitting the same account: each is its
    // own `+ $1`, so the account ends up moved by their sum even though neither
    // statement ever read the balance.
    const manager = makeMockManager();

    await updateAccountBalance(asManager(manager), "acc-1", 40.25);
    await updateAccountBalance(asManager(manager), "acc-1", -15.5);

    const deltas = manager.query.mock.calls.map(
      (call) => (call[1] as unknown[])[0],
    );
    expect(deltas).toEqual([40.25, -15.5]);
    expect(
      deltas.reduce<number>(
        (sum, value) => sum + Math.round(Number(value) * 10000),
        0,
      ) / 10000,
    ).toBe(24.75);
    for (const call of manager.query.mock.calls) {
      expect((call[1] as unknown[])[1]).toBe("acc-1");
    }
  });

  it("rounds the delta to the money precision of the column", async () => {
    const manager = makeMockManager();

    // 4dp is the `decimal(20,4)` precision; the old helper rounded the sum to
    // 2dp and lost the last two digits of every imported amount.
    await updateAccountBalance(asManager(manager), "acc-1", 10.12345);

    expect((manager.query.mock.calls[0][1] as unknown[])[0]).toBe(10.1235);
  });

  it("keeps a fraction of a cent instead of rounding it away", async () => {
    const manager = makeMockManager();

    await updateAccountBalance(asManager(manager), "acc-1", 0.0025);

    expect((manager.query.mock.calls[0][1] as unknown[])[0]).toBe(0.0025);
  });

  it("treats a non-numeric amount as zero rather than writing NaN", async () => {
    const manager = makeMockManager();

    await updateAccountBalance(
      asManager(manager),
      "acc-1",
      Number.NaN as number,
    );

    expect((manager.query.mock.calls[0][1] as unknown[])[0]).toBe(0);
  });

  it("targets the account it was given", async () => {
    const manager = makeMockManager();

    await updateAccountBalance(asManager(manager), "specific-acc", 50);

    expect((manager.query.mock.calls[0][1] as unknown[])[1]).toBe(
      "specific-acc",
    );
  });

  it("is a no-op in the database when no row matches", async () => {
    // The statement's own `WHERE id = $2` is what makes a missing account
    // harmless; the helper does not pre-check and does not throw.
    const manager = makeMockManager();
    manager.query.mockResolvedValue([[], 0]);

    await expect(
      updateAccountBalance(asManager(manager), "non-existent", 100),
    ).resolves.toBeUndefined();
    // Only the closed-account probe follows, and it finds nothing.
    expect(manager.query).toHaveBeenCalledTimes(2);
  });

  it("refuses to move the balance of a closed account", async () => {
    const manager = makeMockManager();
    manager.query
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([{ "?column?": 1 }]);

    await expect(
      updateAccountBalance(asManager(manager), "closed-acc", 100),
    ).rejects.toThrow("The account is closed");
  });
});

const makeImportResult = (): ImportResultDto => ({
  imported: 0,
  skipped: 0,
  skippedRows: [],
  errors: 0,
  errorMessages: [],
  categoriesCreated: 0,
  accountsCreated: 0,
  payeesCreated: 0,
  securitiesCreated: 0,
});

describe("recordSkippedRow", () => {
  const row = { date: "2026-01-15", amount: -10, payee: "Grocer" };

  it("counts every skipped row but names only the first SKIPPED_ROWS_LIMIT", () => {
    const result = makeImportResult();

    for (let i = 0; i < SKIPPED_ROWS_LIMIT + 5; i++) {
      recordSkippedRow(result, row, "duplicateTransfer", "CAD");
    }

    expect(result.skipped).toBe(SKIPPED_ROWS_LIMIT + 5);
    expect(result.skippedRows).toHaveLength(SKIPPED_ROWS_LIMIT);
  });

  it("names a row with its currency and an empty payee when it has none", () => {
    const result = makeImportResult();

    recordSkippedRow(
      result,
      { date: "2026-01-15", amount: -10 },
      "alreadyImported",
      "CAD",
    );

    expect(result.skippedRows).toEqual([
      {
        date: "2026-01-15",
        amount: -10,
        currencyCode: "CAD",
        payee: "",
        reason: "alreadyImported",
      },
    ]);
  });
});

describe("restoreRowCounters", () => {
  it("puts back what a rolled-back row raised and leaves the other fields alone", () => {
    const result = { ...makeImportResult(), payeesCreated: 2, imported: 3 };
    const snapshot = snapshotRowCounters(result);

    result.payeesCreated = 3;
    result.categoriesCreated = 1;
    result.transactionsChangedByRules = 1;
    result.bondRowsWithoutSeries = 1;
    result.imported = 4;
    restoreRowCounters(result, snapshot);

    expect(result.payeesCreated).toBe(2);
    expect(result.categoriesCreated).toBe(0);
    expect(result.imported).toBe(4);
    // The optional counters stay absent, as the result has them when zero.
    expect(result).not.toHaveProperty("transactionsChangedByRules");
    expect(result).not.toHaveProperty("bondRowsWithoutSeries");
  });
});
