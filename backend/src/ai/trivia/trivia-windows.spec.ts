import {
  asOfDay,
  dayIndex,
  pickRank,
  pickWindow,
  seedHash,
  weekIndex,
  windowRange,
} from "./trivia-windows";
import { triviaWindow } from "./trivia-ledger.loader";
import { TRIVIA_WINDOWS } from "./trivia.types";

describe("trivia windows", () => {
  it("hashes a fixed input to a stable value", () => {
    expect(seedHash("user-1", "spendingTopCategory", "window")).toBe(
      seedHash("user-1", "spendingTopCategory", "window"),
    );
    expect(seedHash("a", "b")).not.toBe(seedHash("ab"));
    expect(seedHash("abc")).toBe(0xba7816bf);
  });

  it("counts days since the epoch", () => {
    expect(dayIndex("1970-01-01")).toBe(0);
    expect(dayIndex("1970-01-02")).toBe(1);
    expect(weekIndex("1970-01-08")).toBe(1);
  });

  it("ends daily windows at the last complete day", () => {
    expect(asOfDay("2026-03-01")).toBe("2026-02-28");
  });

  describe("windowRange", () => {
    const today = "2026-11-19";
    it("spans 30 and 90 days ending at the last complete day", () => {
      expect(windowRange("d30", today)).toEqual({
        startDate: "2026-10-20",
        endDate: "2026-11-18",
      });
      expect(windowRange("d90", today)).toEqual({
        startDate: "2026-08-21",
        endDate: "2026-11-18",
      });
    });
    it("starts the year so far on January 1", () => {
      expect(windowRange("ytd", today)).toEqual({
        startDate: "2026-01-01",
        endDate: "2026-11-18",
      });
    });
    it("delegates twelve months to triviaWindow", () => {
      expect(windowRange("m12", today)).toEqual(triviaWindow(today));
    });
    it("leaves the start of all time undefined", () => {
      expect(windowRange("all", today)).toEqual({
        startDate: undefined,
        endDate: "2026-11-18",
      });
    });
  });

  describe("pickRank", () => {
    it("is 2 or 3", () => {
      for (let d = 1; d <= 60; d++) {
        const day = `2026-${d <= 30 ? "05" : "06"}-${String(((d - 1) % 30) + 1).padStart(2, "0")}`;
        expect([2, 3]).toContain(pickRank("u", "spendingTopCategory", day));
      }
    });
  });

  describe("pickWindow", () => {
    it("is stable within a week and one of the windows", () => {
      // 2026-11-16 is a Monday; the epoch week starts on a Thursday.
      const start = dayIndex("2026-11-16");
      const weekStart = start - (start % 7);
      const base = new Date(weekStart * 86_400_000);
      const days = Array.from({ length: 7 }, (_, i) =>
        new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10),
      );
      const picks = days.map((d) => pickWindow("u", "spendingTopPayee", d));
      expect(new Set(picks).size).toBe(1);
      expect(TRIVIA_WINDOWS).toContain(picks[0]);
    });

    it("never picks the year so far before January 8", () => {
      for (let year = 2020; year < 2060; year++) {
        for (const day of ["01", "04", "07"]) {
          expect(
            pickWindow(`u${year}`, "incomeTopSource", `${year}-01-${day}`),
          ).not.toBe("ytd");
        }
      }
    });

    it("can pick the year so far from January 8", () => {
      const picked = new Set<string>();
      for (let year = 2020; year < 2100; year++) {
        picked.add(pickWindow(`u${year}`, "incomeTopSource", `${year}-01-20`));
      }
      expect(picked.has("ytd")).toBe(true);
    });
  });
});
