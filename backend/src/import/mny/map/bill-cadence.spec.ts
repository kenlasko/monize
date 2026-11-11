import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import {
  CADENCE_DAYS,
  cadenceForGap,
  inferFrequencyFromDueDates,
} from "./bill-cadence";

/** `count` dates from `start`, stepped by whole days. */
function everyDays(start: string, days: number, count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + days);
  }
  return dates;
}

/** `count` dates from `start`, stepped by whole months (day clamped). */
function everyMonths(start: string, months: number, count: number): string[] {
  const [year, month, day] = start.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const total = month - 1 + i * months;
    const y = year + Math.floor(total / 12);
    const m = (total % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(day, last);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  });
}

describe("cadenceForGap", () => {
  it.each([
    [1, FrequencyType.DAILY],
    [7, FrequencyType.WEEKLY],
    [14, FrequencyType.BIWEEKLY],
    [15, FrequencyType.SEMIMONTHLY],
    [16, FrequencyType.SEMIMONTHLY],
    [28, FrequencyType.EVERY4WEEKS],
    [30, FrequencyType.MONTHLY],
    [31, FrequencyType.MONTHLY],
    [61, FrequencyType.EVERY2MONTHS],
    [91, FrequencyType.QUARTERLY],
    [92, FrequencyType.QUARTERLY],
    [122, FrequencyType.EVERY4MONTHS],
    [182, FrequencyType.SEMIANNUAL],
    [365, FrequencyType.YEARLY],
    [366, FrequencyType.YEARLY],
    [730, FrequencyType.EVERY2YEARS],
  ])("reads a %p day gap as %s", (days, expected) => {
    expect(cadenceForGap(days)).toBe(expected);
  });

  it("keeps four weeks and a calendar month apart", () => {
    // 28 vs 30.44 is 8%, the closest pair in the table. A tolerance that
    // matched both would make every four-weekly bill monthly.
    expect(cadenceForGap(28)).toBe(FrequencyType.EVERY4WEEKS);
    expect(cadenceForGap(31)).toBe(FrequencyType.MONTHLY);
  });

  // 120 days used to be on this list and is now EVERY4MONTHS: adding a type
  // for a cadence narrows the gaps that match nothing, which is the point.
  it.each([[45], [220], [500]])(
    "refuses a %p day gap that matches nothing",
    (days) => {
      expect(cadenceForGap(days)).toBeNull();
    },
  );

  it.each([[0], [-30], [Number.NaN]])(
    "refuses the nonsensical gap %p",
    (days) => {
      expect(cadenceForGap(days)).toBeNull();
    },
  );

  it("never answers CUSTOM, whose rule has no fixed cycle", () => {
    expect(CADENCE_DAYS.CUSTOM).toBe(0);
    for (const days of [0.5, 1, 3, 7, 10, 45, 400, 10_000]) {
      expect(cadenceForGap(days)).not.toBe(FrequencyType.CUSTOM);
    }
  });

  it("never answers ONCE, which has no spacing", () => {
    expect(CADENCE_DAYS.ONCE).toBe(0);
    for (const days of [0.5, 1, 7, 400, 10_000]) {
      expect(cadenceForGap(days)).not.toBe(FrequencyType.ONCE);
    }
  });
});

describe("inferFrequencyFromDueDates", () => {
  it("reads a yearly series as YEARLY (issue #1150)", () => {
    // The file says so in its own dates, whatever `BILL.frq` is taken to mean.
    expect(inferFrequencyFromDueDates(everyMonths("2019-03-15", 12, 8))).toBe(
      FrequencyType.YEARLY,
    );
  });

  it.each([
    [everyMonths("2024-01-31", 1, 14), FrequencyType.MONTHLY],
    [everyMonths("2024-01-15", 2, 8), FrequencyType.EVERY2MONTHS],
    [everyMonths("2024-01-15", 3, 8), FrequencyType.QUARTERLY],
    [everyMonths("2024-01-15", 4, 8), FrequencyType.EVERY4MONTHS],
    [everyMonths("2024-01-15", 6, 6), FrequencyType.SEMIANNUAL],
    [everyMonths("2024-01-15", 24, 5), FrequencyType.EVERY2YEARS],
    [everyDays("2024-01-15", 7, 10), FrequencyType.WEEKLY],
    [everyDays("2024-01-15", 14, 10), FrequencyType.BIWEEKLY],
    [everyDays("2024-01-15", 28, 10), FrequencyType.EVERY4WEEKS],
    [everyDays("2024-01-15", 1, 10), FrequencyType.DAILY],
  ])("reads a regular series as %#: %s", (dates, expected) => {
    expect(inferFrequencyFromDueDates(dates)).toBe(expected);
  });

  it("reads month-end and mid-month instances as SEMIMONTHLY", () => {
    const dates = [
      "2025-01-15",
      "2025-01-31",
      "2025-02-15",
      "2025-02-28",
      "2025-03-15",
      "2025-03-31",
      "2025-04-15",
    ];
    expect(inferFrequencyFromDueDates(dates)).toBe(FrequencyType.SEMIMONTHLY);
  });

  it("survives a skipped occurrence", () => {
    const dates = everyMonths("2024-01-15", 1, 12).filter(
      (date) => date !== "2024-06-15",
    );
    expect(inferFrequencyFromDueDates(dates)).toBe(FrequencyType.MONTHLY);
  });

  it("reads the newest instances, so a changed cadence imports as it is now", () => {
    const dates = [
      ...everyMonths("2018-01-15", 12, 5),
      ...everyMonths("2024-01-15", 1, 12),
    ];
    expect(inferFrequencyFromDueDates(dates)).toBe(FrequencyType.MONTHLY);
  });

  it.each([[[]], [["2025-01-15"]], [["2025-01-15", "2025-02-15"]]])(
    "refuses %p -- two instances is a coincidence",
    (dates) => {
      expect(inferFrequencyFromDueDates(dates)).toBeNull();
    },
  );

  it("refuses a series whose repeated date carries no spacing", () => {
    expect(
      inferFrequencyFromDueDates(["2025-01-15", "2025-01-15", "2025-01-15"]),
    ).toBeNull();
  });

  it("refuses an irregular series rather than averaging it", () => {
    expect(
      inferFrequencyFromDueDates([
        "2025-01-02",
        "2025-01-09",
        "2025-03-30",
        "2025-04-04",
        "2025-09-17",
      ]),
    ).toBeNull();
  });

  it("ignores instances with no date", () => {
    const dates = everyMonths("2024-01-15", 1, 6);
    expect(inferFrequencyFromDueDates([...dates, null, null])).toBe(
      FrequencyType.MONTHLY,
    );
  });

  it("reads instances stored newest first", () => {
    const dates = [...everyMonths("2024-01-15", 12, 5)].reverse();
    expect(inferFrequencyFromDueDates(dates)).toBe(FrequencyType.YEARLY);
  });
});
