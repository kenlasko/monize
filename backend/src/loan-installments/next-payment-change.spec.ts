import { nextPaymentChangeAfter } from "./next-payment-change";
import { SlotCalendarSchedule } from "./occurrence-slots";
import { RateTimelineRow } from "./price-installment";

/**
 * `nextPaymentChange` of the rate-change sync's preview
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 7.5): the first
 * due date after the priced installment at which a stated payment newly
 * applies, and the total there. Fixture 5.1 with Timeline A, every row of
 * table 7.5's last column, plus the bounds the search relies on.
 */
describe("nextPaymentChangeAfter", () => {
  const row = (
    effectiveDate: string,
    newPaymentAmount: number | null,
    source: "initial" | "manual" | "inferred" = "manual",
  ): RateTimelineRow =>
    ({
      effectiveDate,
      annualRate: "4.5000",
      newPaymentAmount:
        newPaymentAmount === null ? null : newPaymentAmount.toFixed(4),
      source,
    }) as unknown as RateTimelineRow;

  const initial = row("2023-02-03", 584.59, "initial");
  const timelineA = [initial, row("2023-04-15", 560)];

  const schedule = (
    nextDueDate: string,
    overrides: Partial<SlotCalendarSchedule> = {},
  ): SlotCalendarSchedule => ({
    startDate: "2023-02-03",
    nextDueDate,
    frequency: "MONTHLY",
    endDate: null,
    occurrencesRemaining: null,
    ...overrides,
  });

  it("Timeline A at D = 2023-02-03: the bill becomes 560.00 from 2023-05-03, the first slot on or after the change", () => {
    expect(
      nextPaymentChangeAfter(
        timelineA,
        schedule("2023-02-03"),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toEqual({ dueDate: "2023-05-03", paymentAmount: 560 });
  });

  it("Timeline A at D = 2023-04-03 (the raised-template row): still 2023-05-03", () => {
    expect(
      nextPaymentChangeAfter(
        timelineA,
        schedule("2023-04-03"),
        "2023-04-03",
        0,
        584.59,
      ),
    ).toEqual({ dueDate: "2023-05-03", paymentAmount: 560 });
  });

  it("Timeline A at D = 2023-06-03: no row is dated after D", () => {
    expect(
      nextPaymentChangeAfter(
        timelineA,
        schedule("2023-06-03"),
        "2023-06-03",
        0,
        584.59,
      ),
    ).toBeNull();
  });

  it("the initial row alone (Timeline A deleted): null", () => {
    expect(
      nextPaymentChangeAfter(
        [initial],
        schedule("2023-02-03"),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toBeNull();
  });

  it("adds the standing extra on top of a stated base (the A14 loan): 560.00 + 50.00", () => {
    expect(
      nextPaymentChangeAfter(
        [row("2023-02-03", 634.59, "initial"), row("2023-04-15", 560)],
        schedule("2023-02-03"),
        "2023-02-03",
        50,
        634.59,
      ),
    ).toEqual({ dueDate: "2023-05-03", paymentAmount: 610 });
  });

  it("a change dated on D itself is already in force at D, not a later change", () => {
    expect(
      nextPaymentChangeAfter(
        [initial, row("2023-05-03", 560)],
        schedule("2023-05-03"),
        "2023-05-03",
        0,
        584.59,
      ),
    ).toBeNull();
  });

  it("a row stating a rate and no payment does not make a later change", () => {
    expect(
      nextPaymentChangeAfter(
        [initial, row("2023-04-15", null)],
        schedule("2023-02-03"),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toBeNull();
  });

  it("the payment at the slot is the latest row by then: two changes between two slots state the later one", () => {
    expect(
      nextPaymentChangeAfter(
        [initial, row("2023-04-10", 572), row("2023-04-20", 560)],
        schedule("2023-02-03"),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toEqual({ dueDate: "2023-05-03", paymentAmount: 560 });
  });

  it("is null when the schedule runs out before the change's first slot", () => {
    expect(
      nextPaymentChangeAfter(
        timelineA,
        schedule("2023-02-03", { endDate: "2023-04-03" }),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toBeNull();
    expect(
      nextPaymentChangeAfter(
        timelineA,
        schedule("2023-02-03", { occurrencesRemaining: 3 }),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toBeNull();
    expect(
      nextPaymentChangeAfter(
        timelineA,
        schedule("2023-02-03", { occurrencesRemaining: 4 }),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toEqual({ dueDate: "2023-05-03", paymentAmount: 560 });
  });

  it("steps a yearly cadence to the first slot on or after the change", () => {
    expect(
      nextPaymentChangeAfter(
        [initial, row("2023-04-15", 7000)],
        schedule("2023-02-03", { frequency: "YEARLY" }),
        "2023-02-03",
        0,
        6500,
      ),
    ).toEqual({ dueDate: "2024-02-03", paymentAmount: 7000 });
  });

  it("is null for a cadence that does not step", () => {
    expect(
      nextPaymentChangeAfter(
        timelineA,
        schedule("2023-02-03", { frequency: "ONCE" }),
        "2023-02-03",
        0,
        584.59,
      ),
    ).toBeNull();
  });
});
