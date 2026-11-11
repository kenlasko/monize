import { Logger } from "@nestjs/common";
import { calculateNextDueDate } from "./recurrence";
import {
  OCCURRENCE_WALK_GUARD,
  OVERDUE_CARRY_DAYS,
  expandOccurrenceSlots,
  overdueCarryFrom,
} from "./scheduled-occurrences";

/** A monthly schedule due on the 15th, with no end. */
const monthly = (overrides: Record<string, unknown> = {}) => ({
  frequency: "MONTHLY" as const,
  nextDueDate: "2026-03-15",
  endDate: null,
  occurrencesRemaining: null,
  ...overrides,
});

const override = (originalDate: string, overrideDate: string, id = "ovr") => ({
  id,
  originalDate,
  overrideDate,
});

describe("overdueCarryFrom", () => {
  it(`opens the carry window ${OVERDUE_CARRY_DAYS} days before today`, () => {
    expect(OVERDUE_CARRY_DAYS).toBe(31);
    expect(overdueCarryFrom("2026-03-15")).toBe("2026-02-12");
    expect(overdueCarryFrom("2024-03-01")).toBe("2024-01-30");
  });
});

describe("expandOccurrenceSlots", () => {
  it("walks the recurrence and reports each occurrence on its own slot", () => {
    const found = expandOccurrenceSlots(monthly(), [], {
      through: "2026-06-30",
    });

    expect(found.map((o) => o.dueDate)).toEqual([
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
      "2026-06-15",
    ]);
    expect(found.every((o) => o.originalDate === o.dueDate)).toBe(true);
    expect(found.every((o) => o.override === null && !o.moved)).toBe(true);
  });

  it("includes an occurrence already overdue when no lower bound is given", () => {
    const found = expandOccurrenceSlots(
      monthly({ nextDueDate: "2026-01-10" }),
      [],
      {
        through: "2026-02-28",
      },
    );

    expect(found.map((o) => o.dueDate)).toEqual(["2026-01-10", "2026-02-10"]);
  });

  it("excludes occurrences before `from`", () => {
    const found = expandOccurrenceSlots(
      monthly({ nextDueDate: "2026-01-10" }),
      [],
      {
        from: "2026-02-01",
        through: "2026-03-31",
      },
    );

    expect(found.map((o) => o.dueDate)).toEqual(["2026-02-10", "2026-03-10"]);
  });

  /**
   * The identity is `originalDate`. Matching on `overrideDate` is the mistake the
   * budget alert path made, and it is invisible until the two differ.
   */
  it("matches an override on the slot it replaces, not on the date it moved to", () => {
    const moved = override("2026-03-15", "2026-03-28");
    const found = expandOccurrenceSlots(monthly(), [moved], {
      through: "2026-04-30",
    });

    expect(found[0]).toMatchObject({
      originalDate: "2026-03-15",
      dueDate: "2026-03-28",
      override: moved,
      moved: true,
    });
    // The following occurrence is untouched.
    expect(found[1]).toMatchObject({
      originalDate: "2026-04-15",
      dueDate: "2026-04-15",
      override: null,
      moved: false,
    });
  });

  it("drops an occurrence an override moved out of the window", () => {
    const found = expandOccurrenceSlots(
      monthly(),
      [override("2026-03-15", "2026-07-01")],
      { through: "2026-04-30" },
    );

    expect(found.map((o) => o.dueDate)).toEqual(["2026-04-15"]);
  });

  /**
   * The recurrence slot can sit beyond `through` while the occurrence itself
   * lands inside it. Stopping the walk at `through` -- which every hand-rolled
   * expansion did -- loses the occurrence entirely.
   */
  it("finds an occurrence an override moved INTO the window from beyond it", () => {
    const pulledIn = override("2026-08-15", "2026-04-02");
    const found = expandOccurrenceSlots(monthly(), [pulledIn], {
      from: "2026-04-01",
      through: "2026-04-30",
    });

    expect(found).toEqual([
      {
        originalDate: "2026-08-15",
        dueDate: "2026-04-02",
        override: pulledIn,
        moved: true,
      },
      {
        originalDate: "2026-04-15",
        dueDate: "2026-04-15",
        override: null,
        moved: false,
      },
    ]);
  });

  it("orders by the date the occurrence falls on, so `maxOccurrences: 1` is the next one to happen", () => {
    const pulledIn = override("2026-08-15", "2026-04-02");
    const found = expandOccurrenceSlots(monthly(), [pulledIn], {
      from: "2026-04-01",
      through: "2026-04-30",
      maxOccurrences: 1,
    });

    expect(found).toHaveLength(1);
    expect(found[0].dueDate).toBe("2026-04-02");
    expect(found[0].originalDate).toBe("2026-08-15");
  });

  it("stops at the schedule's end date", () => {
    const found = expandOccurrenceSlots(
      monthly({ endDate: "2026-05-01" }),
      [],
      { through: "2026-12-31" },
    );

    expect(found.map((o) => o.dueDate)).toEqual(["2026-03-15", "2026-04-15"]);
  });

  it("stops after the remaining occurrence count", () => {
    const found = expandOccurrenceSlots(
      monthly({ occurrencesRemaining: 2 }),
      [],
      { through: "2026-12-31" },
    );

    expect(found.map((o) => o.dueDate)).toEqual(["2026-03-15", "2026-04-15"]);
  });

  it("emits exactly one occurrence for a one-off schedule", () => {
    const found = expandOccurrenceSlots(monthly({ frequency: "ONCE" }), [], {
      through: "2027-12-31",
    });

    expect(found.map((o) => o.dueDate)).toEqual(["2026-03-15"]);
  });

  it("accepts Date columns as the driver returns them", () => {
    const found = expandOccurrenceSlots(
      monthly({ nextDueDate: new Date(Date.UTC(2026, 2, 15)) }),
      [
        {
          id: "ovr",
          originalDate: new Date(Date.UTC(2026, 2, 15)),
          overrideDate: new Date(Date.UTC(2026, 2, 20)),
        },
      ],
      { through: "2026-03-31" },
    );

    expect(found).toEqual([
      {
        originalDate: "2026-03-15",
        dueDate: "2026-03-20",
        override: expect.objectContaining({ id: "ovr" }),
        moved: true,
      },
    ]);
  });

  it("caps a long daily expansion at the walk guard rather than looping", () => {
    const found = expandOccurrenceSlots(
      { frequency: "DAILY", nextDueDate: "2020-01-01" },
      [],
      { through: "2099-12-31" },
    );

    expect(found).toHaveLength(OCCURRENCE_WALK_GUARD);
  });
});

describe("expandOccurrenceSlots: CUSTOM (docs/specs/custom-recurrence.md)", () => {
  const rule = {
    unit: "WEEK" as const,
    interval: 2,
    weekdays: [2, 4],
    weekStartsOn: 1,
  };

  it("walks the rule, its periods counted from the start date", () => {
    const found = expandOccurrenceSlots(
      {
        frequency: "CUSTOM",
        customRecurrence: rule,
        startDate: "2026-11-11",
        nextDueDate: "2026-11-12",
      },
      [],
      { through: "2026-12-10" },
    );
    expect(found.map((o) => o.originalDate)).toEqual([
      "2026-11-12",
      "2026-11-24",
      "2026-11-26",
      "2026-12-08",
      "2026-12-10",
    ]);
  });

  describe("a Custom row whose rule is missing or invalid", () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    });
    afterEach(() => warn.mockRestore());

    it.each([
      ["missing", undefined],
      ["invalid", { unit: "WEEK", interval: 1, weekdays: [] }],
    ])(
      "yields its cursor slot alone, as a one-time schedule, and warns (%s)",
      (_label, customRecurrence) => {
        // One broken row must not take a user's forecast, or the cross-user
        // bill-reminder run, down with it.
        const found = expandOccurrenceSlots(
          {
            id: "st-broken",
            frequency: "CUSTOM",
            customRecurrence: customRecurrence as never,
            nextDueDate: "2026-11-12",
          },
          [{ originalDate: "2026-11-12", overrideDate: "2026-11-13" }],
          { through: "2026-12-10" },
        );
        expect(found.map((o) => [o.originalDate, o.dueDate])).toEqual([
          ["2026-11-12", "2026-11-13"],
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        // The schedule id only: no rule, amount or payee in the log line.
        expect(String(warn.mock.calls[0][0])).toContain("st-broken");
      },
    );

    it("is still refused by the stepper a post or skip goes through", () => {
      expect(() =>
        calculateNextDueDate("2026-11-12", "CUSTOM", undefined, {
          rule: null,
        }),
      ).toThrow(/CUSTOM/);
    });
  });
});
