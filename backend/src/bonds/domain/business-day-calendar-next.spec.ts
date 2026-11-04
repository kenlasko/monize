import {
  BusinessDayCalendar,
  nextBusinessDayOnOrAfter,
} from "./business-day-calendar";
import { dayOfWeek } from "./calendar-date";

describe("nextBusinessDayOnOrAfter", () => {
  const weekdays: BusinessDayCalendar = {
    id: "TEST",
    isBusinessDay: (ymd) => ![0, 6].includes(dayOfWeek(ymd)),
  };

  it("keeps a business day", () => {
    expect(nextBusinessDayOnOrAfter(weekdays, "2026-10-16")).toBe("2026-10-16");
  });

  it.each([
    ["2026-10-17", "Saturday"],
    ["2026-10-18", "Sunday"],
  ])("moves %s (%s) to the Monday", (day) => {
    expect(nextBusinessDayOnOrAfter(weekdays, day)).toBe("2026-10-19");
  });

  it("refuses a calendar that has no business day", () => {
    expect(() =>
      nextBusinessDayOnOrAfter(
        { id: "NEVER", isBusinessDay: () => false },
        "2026-10-17",
      ),
    ).toThrow(RangeError);
  });
});
