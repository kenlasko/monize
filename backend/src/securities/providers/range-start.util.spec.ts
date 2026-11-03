import { rangeToStartDate } from "./range-start.util";

describe("rangeToStartDate", () => {
  const to = new Date(Date.UTC(2026, 10, 2));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  it.each([
    ["5d", "2026-10-28"],
    ["1mo", "2026-10-02"],
    ["6mo", "2026-05-02"],
    ["1y", "2025-11-02"],
    ["5y", "2021-11-02"],
    [" MAX ", "1996-11-02"],
  ])("starts %j on %s", (range, expected) => {
    expect(ymd(rangeToStartDate(range, to))).toBe(expected);
  });

  it.each(["", "nonsense", "1wk", "ytd"])(
    "reads %j, which it does not know, as one year",
    (range) => {
      expect(ymd(rangeToStartDate(range, to))).toBe("2025-11-02");
    },
  );

  it("does not change the date it is given", () => {
    rangeToStartDate("5d", to);
    expect(ymd(to)).toBe("2026-11-02");
  });
});
