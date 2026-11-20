import { useServiceHarness, userId } from "./dashboard-trivia.service.harness";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import {
  fullDailyInput,
  fullLedgerLoad,
} from "./__fixtures__/trivia-pool.fixture";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { familyOf } from "./trivia-families";
import { TRIVIA_DAILY_COUNT } from "./trivia-rotation";
import { TRIVIA_FACT_IDS, type TriviaFactId } from "./trivia.types";

describe("DashboardTriviaService", () => {
  const h = useServiceHarness();
  let prefRepo: { findOne: jest.Mock };
  let triviaRepo: Record<string, jest.Mock>;
  let insertQb: Record<string, jest.Mock>;
  let ai: Record<string, jest.Mock>;
  let ledger: Record<string, jest.Mock>;
  let daily: Record<string, jest.Mock>;
  let service: DashboardTriviaService;

  beforeEach(() => {
    ({ prefRepo, triviaRepo, insertQb, ai, ledger, daily, service } = h);
  });

  describe("the rotating subset", () => {
    const familyOfItem = (item: { source: string; factId?: string }) =>
      familyOf(item.factId as TriviaFactId);

    beforeEach(() => {
      ledger.load.mockResolvedValue(fullLedgerLoad());
      daily.load.mockResolvedValue(fullDailyInput());
      ai.getStatus.mockResolvedValue({ configured: false, relayActive: false });
    });

    it("stores at most the daily count, with figures only of the shown facts", async () => {
      await service.generateForUser(userId, "UTC");
      const row = triviaRepo.upsert.mock.calls[0][0];
      expect(row.items.length).toBeLessThanOrEqual(TRIVIA_DAILY_COUNT);
      expect(row.items.length).toBeGreaterThan(0);
      const shown = row.items.length;
      expect(new Set(row.items.map(familyOfItem)).size).toBe(shown);
      expect(Object.keys(row.figures).length).toBeGreaterThan(0);
    });

    it("stores lists on two dates that share no family", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-11-19T07:00:00Z"));
      try {
        await service.generateForUser(userId, "UTC");
        const first = triviaRepo.upsert.mock.calls[0][0];
        triviaRepo.findOne.mockResolvedValue(first);
        jest.setSystemTime(new Date("2026-11-20T07:00:00Z"));
        await service.generateForUser(userId, "UTC");
      } finally {
        jest.useRealTimers();
      }
      const [first, second] = triviaRepo.upsert.mock.calls.map((c) => c[0]);
      const before = new Set(first.items.map(familyOfItem));
      expect(
        second.items.map(familyOfItem).filter((f) => before.has(f)),
      ).toEqual([]);
    });

    describe("rewording on a language change", () => {
      const idsOf = (items: object[]) =>
        (items as { factId?: string }[]).map((i) => i.factId);
      const families = (items: object[]) =>
        new Set(
          (items as { factId: TriviaFactId }[]).map((i) => familyOf(i.factId)),
        );
      // The page's pool reads no bills, as in production.
      beforeEach(() => {
        daily.load.mockImplementation(
          (_u: string, _c: string, _t: string, opts: { bills: boolean }) =>
            Promise.resolve({
              ...fullDailyInput(),
              ...(opts.bills ? {} : { bills: null }),
            }),
        );
      });
      afterEach(() => jest.useRealTimers());

      const cronRow = async () => {
        await service.generateForUser(userId, "UTC");
        const calls = triviaRepo.upsert.mock.calls;
        const row = calls[calls.length - 1][0];
        triviaRepo.upsert.mockClear();
        return row;
      };

      it("keeps the stored facts, honouring a model's factIds, and keeps its generatedAt", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-11-19T07:00:00Z"));
        const stored = await cronRow();
        const [first, ...rest] = stored.items;
        const generatedAt = new Date("2026-11-19T03:00:00Z");
        triviaRepo.findOne.mockResolvedValue({
          ...stored,
          items: [
            {
              topic: first.topic,
              source: "ai",
              text: "{currentHigh}",
              factIds: [first.factId],
            },
            ...rest,
          ],
          language: "de",
          generatedAt,
        });
        prefRepo.findOne.mockResolvedValue({ language: "fr" });
        const result = await service.getTrivia(userId);
        expect(result.items.every((i) => i.source === "calculated")).toBe(true);
        // The model's sentence stood for the first fact, which is still shown.
        expect(idsOf(result.items)).toContain(first.factId);
        // The page's pool reads no bills: those drop out and others fill in.
        const kept = idsOf(rest).filter((id) => !String(id).includes("Bill"));
        expect(idsOf(result.items)).toEqual(expect.arrayContaining(kept));
        expect(result.items).toHaveLength(stored.items.length);
        const written = triviaRepo.upsert.mock.calls[0][0];
        expect(written.generatedAt).toBe(generatedAt);
        expect(result.generatedAt).toBe(generatedAt.toISOString());
        expect(written.language).toBe("fr");
      });

      it("lets the next day's cron see the reworded row as yesterday's list", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-11-19T07:00:00Z"));
        const stored = await cronRow();
        triviaRepo.findOne.mockResolvedValue({
          ...stored,
          items: stored.items.map((i: object) => ({
            topic: (i as { topic: string }).topic,
            source: "ai",
            text: "{currentHigh}",
            factIds: [(i as { factId: string }).factId],
          })),
          language: "de",
        });
        prefRepo.findOne.mockResolvedValue({
          language: "fr",
          dashboardWidgets: ["trivia"],
        });
        jest.setSystemTime(new Date("2026-11-19T20:00:00Z"));
        await service.getTrivia(userId);
        const reworded = triviaRepo.upsert.mock.calls[0][0];
        expect(reworded.generatedAt.toISOString()).toBe(
          "2026-11-19T07:00:00.000Z",
        );
        triviaRepo.upsert.mockClear();
        triviaRepo.findOne.mockResolvedValue(reworded);
        jest.setSystemTime(new Date("2026-11-20T07:00:00Z"));
        await service.generateForUser(userId, "UTC");
        const next = triviaRepo.upsert.mock.calls[0][0];
        const before = families(reworded.items);
        expect([...families(next.items)].filter((f) => before.has(f))).toEqual(
          [],
        );
      });

      it("tops the list up when a stored bill fact drops out of the page's pool", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-11-19T07:00:00Z"));
        const stored = await cronRow();
        const bill = {
          topic: "activity",
          source: "calculated",
          factId: "activityBillsDueThisWeek",
        };
        const items = [
          bill,
          ...stored.items.filter(
            (i: { factId: string }) =>
              familyOf(i.factId as TriviaFactId) !==
              familyOf("activityBillsDueThisWeek"),
          ),
        ].slice(0, TRIVIA_DAILY_COUNT);
        triviaRepo.findOne.mockResolvedValue({
          ...stored,
          items,
          language: "de",
          generatedAt: new Date("2026-11-19T03:00:00Z"),
        });
        // The reworded row has no model sentence, so only the language differs.
        triviaRepo.findOne.mockResolvedValueOnce({
          ...stored,
          items: [
            {
              topic: "netWorth",
              source: "ai",
              text: "{currentHigh}",
              factIds: ["netWorthHighPoint"],
            },
            ...items,
          ].slice(0, TRIVIA_DAILY_COUNT),
          language: "de",
          generatedAt: new Date("2026-11-19T03:00:00Z"),
        });
        prefRepo.findOne.mockResolvedValue({ language: "fr" });
        const result = await service.getTrivia(userId);
        expect(idsOf(result.items)).not.toContain("activityBillsDueThisWeek");
        expect(result.items).toHaveLength(items.length);
        expect(families(result.items).size).toBe(result.items.length);
      });

      it("caps a pre-rotation row of many items at the daily count", async () => {
        const many = TRIVIA_FACT_IDS.slice(0, 26).map((factId) => ({
          topic: "netWorth",
          source: "calculated",
          factId,
        }));
        triviaRepo.findOne.mockResolvedValue({
          userId,
          items: many,
          figures: {},
          language: "de",
          generatedAt: new Date(),
        });
        // An AI item makes the language mismatch matter.
        triviaRepo.findOne.mockResolvedValue({
          userId,
          items: [
            {
              topic: "netWorth",
              source: "ai",
              text: "{currentHigh}",
              factIds: many.map((m) => m.factId),
            },
          ],
          figures: {},
          language: "de",
          generatedAt: new Date(),
        });
        prefRepo.findOne.mockResolvedValue({ language: "fr" });
        const result = await service.getTrivia(userId);
        expect(result.items.length).toBeLessThanOrEqual(TRIVIA_DAILY_COUNT);
        expect(result.items.length).toBeGreaterThan(0);
      });
    });

    describe("a list from an earlier local day", () => {
      const familiesOf = (items: { factId?: string }[]) =>
        new Set(
          items.flatMap((i) =>
            i.factId ? [familyOf(i.factId as TriviaFactId)] : [],
          ),
        );
      afterEach(() => jest.useRealTimers());

      const yesterdaysRow = async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-11-18T07:00:00Z"));
        await service.generateForUser(userId, "UTC");
        const row = triviaRepo.upsert.mock.calls[0][0];
        triviaRepo.upsert.mockClear();
        triviaRepo.findOne.mockResolvedValue(row);
        return row;
      };

      it("is rebuilt on a page load as today's calculated list, rotated away from yesterday's, with no provider call or bills", async () => {
        const row = await yesterdaysRow();
        daily.load.mockClear();
        jest.setSystemTime(new Date("2026-11-19T01:00:00Z"));
        const result = await service.getTrivia(userId);
        expect(ai.complete).not.toHaveBeenCalled();
        expect(daily.load).toHaveBeenCalledWith(
          userId,
          "CAD",
          "2026-11-19",
          expect.objectContaining({ bills: false }),
        );
        expect(result.generatedAt).toBe("2026-11-19T01:00:00.000Z");
        expect(result.items.every((i) => i.source === "calculated")).toBe(true);
        const before = familiesOf(row.items);
        expect(
          [...familiesOf(result.items as { factId?: string }[])].filter((f) =>
            before.has(f),
          ),
        ).toEqual([]);
      });

      it("is not stored by the page load, so the cron still sees yesterday's row", async () => {
        await yesterdaysRow();
        jest.setSystemTime(new Date("2026-11-19T01:00:00Z"));
        await service.getTrivia(userId);
        expect(triviaRepo.upsert).not.toHaveBeenCalled();
        expect(insertQb.execute).not.toHaveBeenCalled();
      });

      it("leaves the cron the real yesterday: its list avoids yesterday's families and sentences", async () => {
        ai.getStatus.mockResolvedValue({
          configured: true,
          relayActive: false,
        });
        const row = await yesterdaysRow();
        const withAi = {
          ...row,
          items: [
            {
              topic: "netWorth",
              source: "ai",
              text: "Yesterday peak {currentHigh}",
              factIds: ["netWorthAtHighPoint"],
            },
            ...row.items,
          ],
        };
        triviaRepo.findOne.mockResolvedValue(withAi);
        jest.setSystemTime(new Date("2026-11-19T01:00:00Z"));
        await service.getTrivia(userId);
        await service.generateForUser(userId, "UTC");
        const today = triviaRepo.upsert.mock.calls[0][0];
        const calls = ai.complete.mock.calls;
        const content = calls[calls.length - 1][1].messages[0].content;
        expect(content).toContain("- Yesterday peak {currentHigh}");
        const before = familiesOf(row.items);
        expect(
          [...familiesOf(today.items)].filter((f) => before.has(f)),
        ).toEqual([]);
      });

      it("serves a row of the reader's own day as stored, and the cron then keeps it as today's", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-11-19T01:00:00Z"));
        await service.generateForUser(userId, "UTC");
        const row = triviaRepo.upsert.mock.calls[0][0];
        triviaRepo.upsert.mockClear();
        triviaRepo.findOne.mockResolvedValue(row);
        daily.load.mockClear();
        const result = await service.getTrivia(userId);
        expect(result.items).toEqual(row.items);
        expect(daily.load).not.toHaveBeenCalled();
      });

      it("counts the day in the reader's zone, not UTC's", async () => {
        (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue(
          "America/Los_Angeles",
        );
        // Built 19:00 on the 18th in Los Angeles (03:00Z on the 19th).
        const row = {
          userId,
          items: [
            {
              topic: "netWorth",
              source: "calculated",
              factId: "netWorthAtHighPoint",
            },
          ],
          figures: {},
          language: "fr",
          generatedAt: new Date("2026-11-19T03:00:00Z"),
        };
        triviaRepo.findOne.mockResolvedValue(row);
        // 07:00Z on the 19th is 23:00 on the 18th there: still the same day.
        jest.useFakeTimers().setSystemTime(new Date("2026-11-19T07:00:00Z"));
        daily.load.mockClear();
        await service.getTrivia(userId);
        expect(daily.load).not.toHaveBeenCalled();
        // 09:00Z is 01:00 on the 19th there: the row is yesterday's.
        jest.setSystemTime(new Date("2026-11-19T09:00:00Z"));
        await service.getTrivia(userId);
        expect(daily.load).toHaveBeenCalledWith(
          userId,
          "CAD",
          "2026-11-19",
          expect.any(Object),
        );
      });
    });

    it("selects afresh when the stored AI row names no fact", async () => {
      triviaRepo.findOne.mockResolvedValue({
        userId,
        items: [{ topic: "netWorth", source: "ai", text: "{currentHigh}" }],
        figures: {},
        language: "de",
        generatedAt: new Date(),
      });
      prefRepo.findOne.mockResolvedValue({ language: "fr" });
      const result = await service.getTrivia(userId);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.length).toBeLessThanOrEqual(TRIVIA_DAILY_COUNT);
    });
  });
});
