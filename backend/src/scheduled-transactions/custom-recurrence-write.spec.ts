import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { CustomRecurrence } from "../common/custom-recurrence";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { PayrollDeductionRule } from "../payroll-deductions/entities/payroll-deduction-rule.entity";
import {
  assertCustomFrequencyAllowed,
  orphanedOverrides,
  resolveCustomRecurrence,
  sameCustomRecurrence,
  snapToCustomPattern,
} from "./custom-recurrence-write";

const MWF: CustomRecurrence = {
  unit: "WEEK",
  interval: 1,
  weekdays: [1, 3, 5],
  weekStartsOn: 1,
};

describe("sameCustomRecurrence", () => {
  it("compares canonical forms", () => {
    expect(
      sameCustomRecurrence(MWF, {
        unit: "WEEK",
        weekdays: [5, 3, 1, 1],
      } as CustomRecurrence),
    ).toBe(true);
    expect(sameCustomRecurrence(MWF, { ...MWF, weekdays: [1, 3] })).toBe(false);
    expect(sameCustomRecurrence(null, undefined)).toBe(true);
    expect(sameCustomRecurrence(MWF, null)).toBe(false);
  });
});

describe("resolveCustomRecurrence (section 5)", () => {
  it("stores the canonical rule with CUSTOM", () => {
    expect(
      resolveCustomRecurrence("CUSTOM", {
        unit: "MONTH",
        monthDays: [-1, 5],
      } as CustomRecurrence),
    ).toEqual({ unit: "MONTH", interval: 1, monthDays: [5, -1] });
  });

  it("requires a rule with CUSTOM", () => {
    expect(() => resolveCustomRecurrence("CUSTOM", undefined)).toThrow(
      BadRequestException,
    );
    expect(() => resolveCustomRecurrence("CUSTOM", null, MWF)).toThrow(
      /needs a recurrence rule/,
    );
  });

  it("keeps the stored rule when an update leaves the key out", () => {
    expect(resolveCustomRecurrence("CUSTOM", undefined, MWF)).toEqual(MWF);
  });

  it("refuses an invalid rule", () => {
    expect(() =>
      resolveCustomRecurrence("CUSTOM", {
        unit: "WEEK",
        interval: 1,
        weekdays: [9],
      }),
    ).toThrow(/not valid/);
  });

  it("refuses a new rule beside another frequency", () => {
    expect(() => resolveCustomRecurrence("MONTHLY", MWF)).toThrow(
      /only be set when the frequency is Custom/,
    );
    expect(() =>
      resolveCustomRecurrence("MONTHLY", { ...MWF, weekdays: [2] }, MWF),
    ).toThrow(BadRequestException);
  });

  it("clears the rule when leaving CUSTOM, even with the old rule echoed", () => {
    expect(resolveCustomRecurrence("MONTHLY", MWF, MWF)).toBeNull();
    expect(resolveCustomRecurrence("MONTHLY", null, MWF)).toBeNull();
    expect(resolveCustomRecurrence("MONTHLY", undefined, MWF)).toBeNull();
    expect(resolveCustomRecurrence("WEEKLY", undefined)).toBeNull();
  });
});

describe("snapToCustomPattern", () => {
  it("keeps a cursor already on the pattern", () => {
    expect(snapToCustomPattern("2026-11-13", "2026-11-13", MWF)).toBe(
      "2026-11-13",
    );
  });

  it("moves an off-pattern cursor to the first rule date on or after it", () => {
    // A new schedule: start and cursor are the same Saturday.
    expect(snapToCustomPattern("2026-11-14", "2026-11-14", MWF)).toBe(
      "2026-11-16",
    );
    // From the cursor, not the start date: Tuesday steps to Wednesday.
    expect(snapToCustomPattern("2026-11-10", "2026-11-14", MWF)).toBe(
      "2026-11-11",
    );
  });

  it("never moves a running schedule's cursor back to its start", () => {
    // Started a year ago; a rule change re-snaps forward from the cursor.
    expect(snapToCustomPattern("2026-11-14", "2025-11-01", MWF)).toBe(
      "2026-11-16",
    );
  });

  it("counts the interval's periods from the start date", () => {
    const rule: CustomRecurrence = {
      unit: "MONTH",
      interval: 3,
      monthDays: [15],
    };
    expect(snapToCustomPattern("2026-12-01", "2026-11-15", rule)).toBe(
      "2027-02-15",
    );
  });
});

describe("orphanedOverrides", () => {
  const override = (id: string, originalDate: string) => ({ id, originalDate });

  it("names the future overrides the new pattern no longer holds", () => {
    const orphans = orphanedOverrides(
      {
        frequency: "CUSTOM",
        nextDueDate: "2026-11-16",
        startDate: "2026-11-16",
        customRecurrence: MWF,
      },
      [
        override("past", "2026-11-03"),
        override("mon", "2026-11-16"),
        override("tue", "2026-11-17"),
        override("fri", "2026-11-20"),
        override("thu", "2026-12-03"),
      ],
    );
    expect(orphans.map((o) => o.id)).toEqual(["tue", "thu"]);
  });

  it("expands fixed frequencies through the same walker", () => {
    const orphans = orphanedOverrides(
      {
        frequency: "MONTHLY",
        nextDueDate: "2026-11-15",
        startDate: "2026-01-15",
        customRecurrence: null,
      },
      [override("on", "2027-01-15"), override("off", "2027-01-16")],
    );
    expect(orphans.map((o) => o.id)).toEqual(["off"]);
  });

  it("orphans every later slot of a one-time schedule", () => {
    const orphans = orphanedOverrides(
      {
        frequency: "ONCE",
        nextDueDate: "2026-11-15",
        startDate: "2026-11-15",
        customRecurrence: null,
      },
      [override("due", "2026-11-15"), override("later", "2026-12-15")],
    );
    expect(orphans.map((o) => o.id)).toEqual(["later"]);
  });

  it("keeps an override past a walk the guard cut short", () => {
    const orphans = orphanedOverrides(
      {
        frequency: "DAILY",
        nextDueDate: "2026-01-01",
        startDate: "2026-01-01",
        customRecurrence: null,
      },
      // 2000 daily steps end in 2031; nothing proves a 2040 slot orphaned.
      [override("far", "2040-01-01")],
    );
    expect(orphans).toEqual([]);
  });

  it("is empty without future overrides", () => {
    expect(
      orphanedOverrides(
        {
          frequency: "CUSTOM",
          nextDueDate: "2026-11-16",
          startDate: "2026-11-16",
          customRecurrence: MWF,
        },
        [override("past", "2026-11-03")],
      ),
    ).toEqual([]);
  });
});

describe("assertCustomFrequencyAllowed", () => {
  function managerWith(options: {
    loanPointers?: number;
    accounts?: Array<Pick<Account, "id" | "accountType">>;
    payrollRules?: number;
  }) {
    const accountRepo = {
      count: jest.fn().mockResolvedValue(options.loanPointers ?? 0),
      find: jest.fn().mockResolvedValue(options.accounts ?? []),
    };
    const ruleRepo = {
      count: jest.fn().mockResolvedValue(options.payrollRules ?? 0),
    };
    const m = {
      getRepository: jest.fn((entity: unknown) =>
        entity === Account
          ? accountRepo
          : entity === PayrollDeductionRule
            ? ruleRepo
            : undefined,
      ),
    } as unknown as EntityManager;
    return { m, accountRepo, ruleRepo };
  }

  it("refuses the schedule a loan account points at", async () => {
    const { m, accountRepo } = managerWith({ loanPointers: 1 });
    await expect(
      assertCustomFrequencyAllowed(m, "user-1", {
        id: "sched-1",
        splitTransferAccountIds: [],
      }),
    ).rejects.toThrow(/loan or mortgage payment/);
    expect(accountRepo.count).toHaveBeenCalledWith({
      where: { scheduledTransactionId: "sched-1", userId: "user-1" },
    });
  });

  it("refuses a split that transfers into a loan-like account", async () => {
    const { m } = managerWith({
      accounts: [
        { id: "chq", accountType: AccountType.CHEQUING },
        { id: "mtg", accountType: AccountType.MORTGAGE },
      ],
    });
    await expect(
      assertCustomFrequencyAllowed(m, "user-1", {
        id: null,
        splitTransferAccountIds: ["chq", "mtg", null],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses a payroll bill with deduction rules", async () => {
    const { m } = managerWith({ payrollRules: 2 });
    await expect(
      assertCustomFrequencyAllowed(m, "user-1", {
        id: "sched-1",
        splitTransferAccountIds: [],
      }),
    ).rejects.toThrow(/payroll bill/);
  });

  it("allows an ordinary schedule without touching the account lookup", async () => {
    const { m, accountRepo, ruleRepo } = managerWith({
      accounts: [{ id: "sav", accountType: AccountType.SAVINGS }],
    });
    await expect(
      assertCustomFrequencyAllowed(m, "user-1", {
        id: null,
        splitTransferAccountIds: [],
      }),
    ).resolves.toBeUndefined();
    expect(accountRepo.count).not.toHaveBeenCalled();
    expect(accountRepo.find).not.toHaveBeenCalled();
    expect(ruleRepo.count).not.toHaveBeenCalled();
  });
});
