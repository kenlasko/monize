import type { EntityManager } from "typeorm";
import { ConflictException } from "@nestjs/common";
import type { ImportContext } from "./import-context";
import {
  prepareImportAccrualSources,
  assertImportAccrualIds,
  assertImportAccrualEntry,
  rememberImportedAccrualSource,
} from "./import-accrual-guard";

function setup(scheduled = false) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes("FROM accrual_schedules"))
      return scheduled ? [{ id: "schedule" }] : [];
    if (sql.includes("transaction_date=$2"))
      return [{ id: "parent", linked: "leg" }];
    return sql.includes("AND NOT EXISTS")
      ? [{ id: "parent" }]
      : [{ id: "leg" }];
  });
  const manager = { query } as unknown as EntityManager;
  const ctx = {
    manager,
    userId: "owner",
    loanCategoryMap: new Map([["Loan", "loan-id"]]),
  } as unknown as ImportContext;
  return { query, manager, ctx };
}

describe("import accrual source protection", () => {
  it("freezes parents and legs once per manager and refuses a different owner", async () => {
    const { manager, query } = setup();
    expect(await prepareImportAccrualSources(manager, "owner")).toEqual(
      new Set(["parent", "leg"]),
    );
    await prepareImportAccrualSources(manager, "owner");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE");
    expect(query.mock.calls[1][0]).toContain("FOR UPDATE");
    await expect(
      prepareImportAccrualSources(manager, "other"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("ignores empty references but refuses an unfrozen existing match", async () => {
    const { manager, query } = setup();
    await assertImportAccrualIds(manager, "owner", [null, undefined]);
    expect(query).toHaveBeenCalledTimes(2);
    await expect(
      assertImportAccrualIds(manager, "owner", ["unknown"]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("deduplicates the parent/leg matches and refuses their existing schedule", async () => {
    const { manager, query } = setup(true);
    await expect(
      assertImportAccrualIds(manager, "owner", ["leg", "parent", "leg"]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("FROM accrual_schedules"),
      ["owner", ["leg", "parent"]],
    );
  });

  it("remembers a newly saved source only in the same owner's prepared import", async () => {
    const { manager } = setup();
    rememberImportedAccrualSource(manager, "owner", "before-prepare");
    await prepareImportAccrualSources(manager, "owner");
    rememberImportedAccrualSource(manager, "other", "foreign");
    rememberImportedAccrualSource(manager, "owner", "new");
    await expect(
      assertImportAccrualIds(manager, "owner", ["new"]),
    ).resolves.toBeUndefined();
    await expect(
      assertImportAccrualIds(manager, "owner", ["foreign"]),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      assertImportAccrualIds(manager, "owner", ["before-prepare"]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("does no matching for an ordinary expense", async () => {
    const { ctx, query } = setup();
    await assertImportAccrualEntry(ctx, {
      date: "2026-10-15",
      category: "Food",
      splits: [{ category: "Food" }],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    { isTransfer: true },
    { category: "Loan" },
    { splits: [{ isTransfer: true }] },
    { splits: [{ transferAccount: "Bank" }] },
    { splits: [{ category: "Loan" }] },
  ])(
    "checks both transfer match legs before import writes: %j",
    async (row) => {
      const { ctx, query } = setup(true);
      await expect(
        assertImportAccrualEntry(ctx, { date: "2026-10-15", ...row }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("transaction_date=$2"),
        ["owner", "2026-10-15"],
      );
    },
  );
});
