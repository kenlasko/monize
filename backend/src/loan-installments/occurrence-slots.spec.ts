import {
  installmentNumberOf,
  occurrenceSlotsInRange,
  periodSpan,
  precedingSlotDate,
  scheduleCadenceMatchesLoan,
  selectOccurrenceSlot,
  settlementWindow,
  SlotCalendarSchedule,
  slotIsOccupiedBy,
} from "./occurrence-slots";

/**
 * The slot calendar and the selection of `docs/specs/loan-installment-settlement.md`
 * section 6: the truth table of 6.3, every row, and the calendar of 6.1 (a
 * moved cursor, periods, a claim off the calendar occupying its period, ONCE,
 * a step that does not advance, `end_date` and `occurrences_remaining`).
 * Dates are the spec's; a case that disagrees with the spec is wrong here.
 */
describe("occurrence slots", () => {
  const WIDE = { from: "2023-01-01", to: "2025-12-31" };

  const monthly = (
    overrides: Partial<SlotCalendarSchedule> = {},
  ): SlotCalendarSchedule => ({
    startDate: "2024-01-01",
    nextDueDate: "2024-01-01",
    frequency: "MONTHLY",
    endDate: null,
    occurrencesRemaining: null,
    ...overrides,
  });

  const dates = (schedule: SlotCalendarSchedule, range = WIDE) =>
    occurrenceSlotsInRange(schedule, range).map((s) => s.date);

  describe("the window", () => {
    it("is [t - daysAfter, t + daysBefore], inclusive (row 2 of 6.3)", () => {
      expect(
        settlementWindow("2024-01-04", { daysBefore: 3, daysAfter: 7 }),
      ).toEqual({
        from: "2023-12-28",
        to: "2024-01-07",
      });
    });

    it("a 0/0 window is the row's own date", () => {
      expect(
        settlementWindow("2024-01-04", { daysBefore: 0, daysAfter: 0 }),
      ).toEqual({
        from: "2024-01-04",
        to: "2024-01-04",
      });
    });
  });

  describe("the calendar (6.1)", () => {
    it("is the start calendar exactly when the cursor is on it", () => {
      const slots = occurrenceSlotsInRange(
        monthly({ nextDueDate: "2024-03-01" }),
        {
          from: "2024-01-01",
          to: "2024-05-01",
        },
      );
      expect(slots).toEqual([
        {
          date: "2024-01-01",
          ordinal: 1,
          periodStart: "2024-01-01",
          periodEnd: "2024-02-01",
          isCursor: false,
        },
        {
          date: "2024-02-01",
          ordinal: 2,
          periodStart: "2024-02-01",
          periodEnd: "2024-03-01",
          isCursor: false,
        },
        {
          date: "2024-03-01",
          ordinal: 3,
          periodStart: "2024-03-01",
          periodEnd: "2024-04-01",
          isCursor: true,
        },
        {
          date: "2024-04-01",
          ordinal: 4,
          periodStart: "2024-04-01",
          periodEnd: "2024-05-01",
          isCursor: false,
        },
        {
          date: "2024-05-01",
          ordinal: 5,
          periodStart: "2024-05-01",
          periodEnd: "2024-06-01",
          isCursor: false,
        },
      ]);
    });

    it("is built around a moved cursor: the installment it stands for is not a slot of its own (row 14)", () => {
      const slots = occurrenceSlotsInRange(
        monthly({ nextDueDate: "2024-03-28" }),
        {
          from: "2024-01-01",
          to: "2024-05-31",
        },
      );
      expect(slots.map((s) => s.date)).toEqual([
        "2024-01-01",
        "2024-02-01",
        "2024-03-28",
        "2024-04-28",
        "2024-05-28",
      ]);
      // The cursor answers for the gap the move left before it.
      expect(slots[2]).toEqual({
        date: "2024-03-28",
        ordinal: 3,
        periodStart: "2024-03-01",
        periodEnd: "2024-04-28",
        isCursor: true,
      });
    });

    it("keeps every start-calendar date whose next step stays on or before the cursor (row 19)", () => {
      expect(
        dates(monthly({ nextDueDate: "2024-05-28" }), {
          from: "2024-01-01",
          to: "2024-06-30",
        }),
      ).toEqual([
        "2024-01-01",
        "2024-02-01",
        "2024-03-01",
        "2024-04-01",
        "2024-05-28",
        "2024-06-28",
      ]);
    });

    it("has no history when the start date is after the cursor, and the cursor answers from itself", () => {
      const slots = occurrenceSlotsInRange(
        monthly({ startDate: "2024-06-01", nextDueDate: "2024-03-01" }),
        WIDE,
      );
      expect(slots[0]).toMatchObject({
        date: "2024-03-01",
        ordinal: 1,
        periodStart: "2024-03-01",
        isCursor: true,
      });
    });

    it("bounds the dates after the cursor by end_date (row 13)", () => {
      expect(
        dates(monthly({ nextDueDate: "2024-02-01", endDate: "2024-02-15" })),
      ).toEqual(["2024-01-01", "2024-02-01"]);
    });

    it("bounds the dates after the cursor by occurrences_remaining, the cursor counting as one", () => {
      expect(
        dates(monthly({ nextDueDate: "2024-02-01", occurrencesRemaining: 3 })),
      ).toEqual(["2024-01-01", "2024-02-01", "2024-03-01", "2024-04-01"]);
      expect(dates(monthly({ occurrencesRemaining: 1 }))).toEqual([
        "2024-01-01",
      ]);
    });

    it("emits nothing due for a schedule that has run out: the history stays, the cursor is no slot", () => {
      expect(
        dates(monthly({ nextDueDate: "2024-03-01", occurrencesRemaining: 0 })),
      ).toEqual(["2024-01-01", "2024-02-01"]);
      expect(
        dates(monthly({ nextDueDate: "2024-03-01", endDate: "2024-02-15" })),
      ).toEqual(["2024-01-01", "2024-02-01"]);
      expect(dates(monthly({ occurrencesRemaining: 0 }))).toEqual([]);
    });

    it("is the single slot next_due_date for ONCE (row 17)", () => {
      const slots = occurrenceSlotsInRange(
        monthly({
          frequency: "ONCE",
          startDate: "2024-05-01",
          nextDueDate: "2024-05-01",
        }),
        WIDE,
      );
      expect(slots).toEqual([
        {
          date: "2024-05-01",
          ordinal: 1,
          periodStart: "2024-05-01",
          periodEnd: "2024-05-02",
          isCursor: true,
        },
      ]);
    });

    it("ends the enumeration on a step that does not move forward", () => {
      // The frequency column is a bare VARCHAR; a value outside FrequencyType
      // hands its input back, which must not loop under a lock.
      expect(dates(monthly({ frequency: "FORTNIGHTLY" }))).toEqual([
        "2024-01-01",
      ]);
    });

    it("returns only the slots dated inside the range, ordinals counted from the first slot", () => {
      const slots = occurrenceSlotsInRange(
        monthly({ nextDueDate: "2024-06-01" }),
        {
          from: "2024-03-25",
          to: "2024-07-04",
        },
      );
      expect(slots.map((s) => [s.date, s.ordinal, s.isCursor])).toEqual([
        ["2024-04-01", 4, false],
        ["2024-05-01", 5, false],
        ["2024-06-01", 6, true],
        ["2024-07-01", 7, false],
      ]);
    });

    it("steps SEMIMONTHLY and BIWEEKLY with the recurrence engine", () => {
      expect(
        dates(monthly({ frequency: "SEMIMONTHLY" }), {
          from: "2024-01-01",
          to: "2024-02-29",
        }),
      ).toEqual(["2024-01-01", "2024-01-31", "2024-02-15", "2024-02-29"]);
      expect(
        dates(monthly({ frequency: "BIWEEKLY" }), {
          from: "2024-01-01",
          to: "2024-02-12",
        }),
      ).toEqual(["2024-01-01", "2024-01-15", "2024-01-29", "2024-02-12"]);
    });

    it("spans the periods for the claims read, exclusive at the end", () => {
      const slots = occurrenceSlotsInRange(
        monthly({ nextDueDate: "2024-03-28" }),
        {
          from: "2024-02-01",
          to: "2024-03-31",
        },
      );
      expect(periodSpan(slots)).toEqual({
        from: "2024-02-01",
        to: "2024-04-28",
      });
      expect(periodSpan([])).toBeNull();
    });
  });

  describe("the preceding slot, prev(D) (pricing spec 7.3)", () => {
    const loan = (overrides: Partial<SlotCalendarSchedule> = {}) =>
      monthly({
        startDate: "2023-02-03",
        nextDueDate: "2023-05-03",
        ...overrides,
      });

    it("is the slot before the cursor, from the history stepped off the start date", () => {
      expect(precedingSlotDate(loan(), "2023-05-03")).toBe("2023-04-03");
    });

    it("is none for the first slot, or a date before it", () => {
      expect(precedingSlotDate(loan(), "2023-02-03")).toBeNull();
      expect(precedingSlotDate(loan(), "2023-01-15")).toBeNull();
      expect(
        precedingSlotDate(loan({ nextDueDate: "2023-02-03" }), "2023-02-03"),
      ).toBeNull();
    });

    it("steps forward from the cursor for a later date, and reads the calendar for a date off it", () => {
      expect(precedingSlotDate(loan(), "2023-07-03")).toBe("2023-06-03");
      expect(precedingSlotDate(loan(), "2023-04-20")).toBe("2023-04-03");
    });

    it("keeps the history when the cursor has run past end_date", () => {
      expect(
        precedingSlotDate(loan({ endDate: "2023-04-30" }), "2023-05-03"),
      ).toBe("2023-04-03");
    });

    it("is none for a schedule without a calendar to read", () => {
      expect(
        precedingSlotDate(
          loan({ startDate: undefined as unknown as string }),
          "2023-05-03",
        ),
      ).toBeNull();
    });
  });

  describe("occupancy", () => {
    it("a claim occupies the slot whose period holds its date, not only one on the slot's date (row 16)", () => {
      const [, february] = occurrenceSlotsInRange(
        monthly({ nextDueDate: "2024-03-01" }),
        WIDE,
      );
      expect(february.date).toBe("2024-02-01");
      expect(slotIsOccupiedBy(february, "2024-02-15")).toBe(true);
      expect(slotIsOccupiedBy(february, "2024-02-01")).toBe(true);
      expect(slotIsOccupiedBy(february, "2024-03-01")).toBe(false);
      expect(slotIsOccupiedBy(february, "2024-01-31")).toBe(false);
    });
  });

  /**
   * Spec section 6.3. Monthly from 2024-01-01, the cursor on that calendar
   * unless the row says otherwise, window 3/7 unless it says otherwise.
   */
  describe("selection (6.3)", () => {
    const select = (
      rowDate: string,
      options: {
        schedule?: Partial<SlotCalendarSchedule>;
        claims?: string[];
        planned?: string[];
        window?: { daysBefore: number; daysAfter: number };
      } = {},
    ) => {
      const schedule = monthly(options.schedule);
      const window = settlementWindow(
        rowDate,
        options.window ?? { daysBefore: 3, daysAfter: 7 },
      );
      const slots = occurrenceSlotsInRange(schedule, window);
      return selectOccurrenceSlot(
        slots,
        rowDate,
        window,
        options.claims ?? [],
        new Set(options.planned ?? []),
      );
    };
    const chosen = (result: ReturnType<typeof select>) =>
      result.kind === "selected" ? result.slot.date : result.kind;

    it.each([
      ["1", "2024-01-01", {}, "2024-01-01"],
      ["2", "2024-01-04", {}, "2024-01-01"],
      ["3", "2024-01-08", {}, "2024-01-01"],
      ["4", "2024-01-09", {}, "none_in_window"],
      ["5", "2023-12-29", {}, "2024-01-01"],
      ["6", "2023-12-28", {}, "none_in_window"],
      ["7", "2024-01-05", { claims: ["2024-01-01"] }, "all_claimed"],
      ["8", "2024-01-29", {}, "2024-02-01"],
      ["9", "2024-01-05", { planned: ["2024-01-01"] }, "all_claimed"],
      ["10", "2024-01-07", { schedule: { frequency: "WEEKLY" } }, "2024-01-08"],
      [
        "11",
        "2024-01-07",
        { schedule: { frequency: "WEEKLY" }, claims: ["2024-01-08"] },
        "2024-01-01",
      ],
      [
        "12",
        "2024-01-08",
        {
          schedule: { frequency: "BIWEEKLY" },
          window: { daysBefore: 7, daysAfter: 7 },
        },
        "2024-01-01",
      ],
      [
        "13",
        "2024-03-01",
        { schedule: { nextDueDate: "2024-02-01", endDate: "2024-02-15" } },
        "none_in_window",
      ],
      [
        "14",
        "2024-03-29",
        {
          schedule: { nextDueDate: "2024-03-28" },
          claims: ["2024-01-01", "2024-02-01"],
        },
        "2024-03-28",
      ],
      [
        "15",
        "2024-03-02",
        {
          schedule: { nextDueDate: "2024-03-28" },
          claims: ["2024-01-01", "2024-02-01"],
        },
        "none_in_window",
      ],
      [
        "16",
        "2024-02-03",
        { schedule: { nextDueDate: "2024-03-01" }, claims: ["2024-02-15"] },
        "all_claimed",
      ],
      [
        "17",
        "2024-05-02",
        {
          schedule: {
            frequency: "ONCE",
            startDate: "2024-05-01",
            nextDueDate: "2024-05-01",
          },
        },
        "2024-05-01",
      ],
      [
        "19",
        "2024-03-29",
        {
          schedule: { nextDueDate: "2024-05-28" },
          claims: ["2024-01-01", "2024-02-01"],
        },
        "2024-04-01",
      ],
    ])(
      "row %s: a row dated %s answers %p",
      (_row, rowDate, options, expected) => {
        expect(chosen(select(rowDate, options))).toBe(expected);
      },
    );

    it("names the claimed slots when every candidate is taken (row 7)", () => {
      expect(select("2024-01-05", { claims: ["2024-01-01"] })).toEqual({
        kind: "all_claimed",
        dueDates: ["2024-01-01"],
      });
    });

    it("row 14 selects the cursor, so the claim is keyed on the cursor's own date", () => {
      const result = select("2024-03-29", {
        schedule: { nextDueDate: "2024-03-28" },
        claims: ["2024-01-01", "2024-02-01"],
      });
      expect(result.kind).toBe("selected");
      if (result.kind !== "selected") throw new Error("unreachable");
      expect(result.slot).toMatchObject({
        date: "2024-03-28",
        ordinal: 3,
        isCursor: true,
      });
    });

    it("row 19 selects a history slot, which does not advance the cursor", () => {
      const result = select("2024-03-29", {
        schedule: { nextDueDate: "2024-05-28" },
        claims: ["2024-01-01", "2024-02-01"],
      });
      if (result.kind !== "selected") throw new Error("unreachable");
      expect(result.slot).toMatchObject({
        date: "2024-04-01",
        ordinal: 4,
        isCursor: false,
      });
    });

    it("a 0/0 window matches only a slot on the row's own date", () => {
      expect(
        chosen(
          select("2024-01-01", { window: { daysBefore: 0, daysAfter: 0 } }),
        ),
      ).toBe("2024-01-01");
      expect(
        chosen(
          select("2024-01-02", { window: { daysBefore: 0, daysAfter: 0 } }),
        ),
      ).toBe("none_in_window");
    });

    it("a window around 2024-01-31 with 3/7 holds two slots and the nearest wins", () => {
      // 2024-01-01 is 30 days back; 2024-02-01 is 1 day ahead.
      const window = settlementWindow("2024-01-31", {
        daysBefore: 3,
        daysAfter: 7,
      });
      expect(window).toEqual({ from: "2024-01-24", to: "2024-02-03" });
      expect(chosen(select("2024-01-31"))).toBe("2024-02-01");
      // Pushed back far enough to reach both, the nearer still wins.
      const wide = settlementWindow("2024-01-31", {
        daysBefore: 3,
        daysAfter: 31,
      });
      const slots = occurrenceSlotsInRange(monthly(), wide);
      expect(slots.map((s) => s.date)).toEqual(["2024-01-01", "2024-02-01"]);
      const result = selectOccurrenceSlot(
        slots,
        "2024-01-31",
        wide,
        [],
        new Set(),
      );
      expect(chosen(result)).toBe("2024-02-01");
    });
  });

  describe("the cadence check (6.1 item 6, row 18)", () => {
    it.each([
      ["MONTHLY", "MONTHLY", true],
      ["MONTHLY", "BIWEEKLY", false],
      ["SEMI_MONTHLY", "SEMIMONTHLY", true],
      ["ACCELERATED_BIWEEKLY", "BIWEEKLY", true],
      [null, "BIWEEKLY", true],
      ["", "MONTHLY", true],
      ["FORTNIGHTLY", "MONTHLY", true],
      ["MONTHLY", "ONCE", true],
    ])("loan %p against schedule %p is %p", (loan, schedule, expected) => {
      expect(scheduleCadenceMatchesLoan(loan, schedule)).toBe(expected);
    });
  });

  describe("the installment number", () => {
    const terms = {
      paymentStartDate: "2024-01-01",
      paymentFrequency: "MONTHLY",
      amortizationMonths: 360,
      originalPrincipal: 300000,
    };
    const slots = occurrenceSlotsInRange(
      monthly({ startDate: "2024-03-01", nextDueDate: "2024-03-01" }),
      WIDE,
    );

    it("counts on the loan's own calendar when the account carries the terms", () => {
      // The schedule was set up two installments in: its ordinal 1 is the
      // loan's installment 3.
      expect(slots[0].date).toBe("2024-03-01");
      expect(installmentNumberOf(slots[0], terms)).toBe(3);
      expect(installmentNumberOf(slots[1], terms)).toBe(4);
    });

    it("falls back to the schedule's ordinal without terms", () => {
      expect(installmentNumberOf(slots[0], {})).toBe(1);
      expect(
        installmentNumberOf(slots[1], { paymentStartDate: "2024-01-01" }),
      ).toBe(2);
    });

    it("falls back to the ordinal for a slot before the loan's first payment", () => {
      expect(
        installmentNumberOf(slots[0], {
          ...terms,
          paymentStartDate: "2024-06-01",
        }),
      ).toBe(1);
    });
  });

  describe("a CUSTOM schedule (docs/specs/custom-recurrence.md section 5)", () => {
    it("never reaches the loan calendar silently", () => {
      // The write path refuses Custom on a loan payment; a row that got here
      // anyway is a defect, and a one-slot calendar would hide it.
      expect(() => dates(monthly({ frequency: "CUSTOM" }))).toThrow(/CUSTOM/);
      expect(() => scheduleCadenceMatchesLoan("MONTHLY", "CUSTOM")).toThrow(
        /CUSTOM/,
      );
    });
  });
});
