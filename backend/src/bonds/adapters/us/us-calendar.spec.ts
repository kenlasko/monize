import { EMPTY_CALENDAR_REGISTRY } from "../../domain/calendar-registry";
import { isUsBusinessDay, usCalendar, usHolidays } from "./us-calendar";

describe("US Federal Reserve Bank business days", () => {
  it("has the id the terms name", () => {
    expect(usCalendar.id).toBe("US");
    expect(EMPTY_CALENDAR_REGISTRY.size).toBe(0);
  });

  it("lists every holiday of 2026 (a Saturday Independence Day is not observed on Friday)", () => {
    expect([...usHolidays(2026)].sort()).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-05-25",
      "2026-06-19",
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
    ]);
    expect(isUsBusinessDay("2026-07-03")).toBe(true);
    expect(isUsBusinessDay("2026-07-04")).toBe(false);
  });

  it("lists every holiday of 2027 (Sunday 4 July is observed on Monday 5 July)", () => {
    expect([...usHolidays(2027)].sort()).toEqual([
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-05-31",
      "2027-07-05",
      "2027-09-06",
      "2027-10-11",
      "2027-11-11",
      "2027-11-25",
    ]);
  });

  it("does not observe a Saturday holiday on the Friday before", () => {
    // 19 June 2027 and 25 December 2027 are Saturdays.
    expect(isUsBusinessDay("2027-06-18")).toBe(true);
    expect(isUsBusinessDay("2027-06-19")).toBe(false);
    expect(isUsBusinessDay("2027-12-24")).toBe(true);
    expect(isUsBusinessDay("2027-12-31")).toBe(true);
  });

  it("observes a Sunday holiday on the Monday after", () => {
    // 19 June 2022 was a Sunday, the first Juneteenth.
    expect(isUsBusinessDay("2022-06-17")).toBe(true);
    expect(isUsBusinessDay("2022-06-20")).toBe(false);
    expect(isUsBusinessDay("2022-06-21")).toBe(true);
  });

  it("has no Juneteenth before 2022", () => {
    expect(isUsBusinessDay("2021-06-18")).toBe(true);
    expect(usHolidays(2021).has("2021-06-19")).toBe(false);
  });

  it("closes the weekends", () => {
    expect(isUsBusinessDay("2026-10-03")).toBe(false);
    expect(isUsBusinessDay("2026-10-04")).toBe(false);
    expect(isUsBusinessDay("2026-10-05")).toBe(true);
  });
});
