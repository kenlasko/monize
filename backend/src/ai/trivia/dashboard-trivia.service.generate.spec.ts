import {
  aiReply,
  expectNoCalculatedBesideCoveringSentence,
  useServiceHarness,
  userId,
} from "./dashboard-trivia.service.harness";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { AccountType } from "../../accounts/entities/account.entity";
import {
  fullDailyInput,
  fullLedgerLoad,
} from "./__fixtures__/trivia-pool.fixture";

describe("DashboardTriviaService", () => {
  const h = useServiceHarness();
  let prefRepo: { findOne: jest.Mock };
  let triviaRepo: Record<string, jest.Mock>;
  let accounts: Record<string, jest.Mock>;
  let netWorth: Record<string, jest.Mock>;
  let portfolio: Record<string, jest.Mock>;
  let ai: Record<string, jest.Mock>;
  let jobClaims: Record<string, jest.Mock>;
  let ledger: Record<string, jest.Mock>;
  let daily: Record<string, jest.Mock>;
  let service: DashboardTriviaService;

  beforeEach(() => {
    ({
      prefRepo,
      triviaRepo,
      accounts,
      netWorth,
      portfolio,
      ai,
      jobClaims,
      ledger,
      daily,
      service,
    } = h);
  });

  describe("generateForUser", () => {
    it("has the job write in the browser's language for a reader following it", async () => {
      prefRepo.findOne.mockResolvedValue({
        language: "browser",
        dashboardWidgets: ["trivia"],
      });
      triviaRepo.findOne.mockResolvedValue({ language: "ja" });
      await service.generateForUser(userId, "UTC");
      expect(ai.complete.mock.calls[0][1].systemPrompt).toContain("Japanese");
      expect(triviaRepo.upsert.mock.calls[0][0].language).toBe("ja");
    });

    it("tells the model to keep placeholder names in English", async () => {
      await service.generateForUser(userId, "UTC");
      expect(ai.complete.mock.calls[0][1].systemPrompt).toContain(
        "Placeholder names stay exactly as written",
      );
    });

    it("keeps the relay out of the provider fall-through", async () => {
      await service.generateForUser(userId, "UTC");
      expect(ai.complete.mock.calls[0][3]).toEqual({ skipRelay: true });
    });

    describe("yesterday's wording and the angle of the day", () => {
      const yesterdayRow = (generatedAt: Date) => ({
        userId,
        items: [
          {
            topic: "netWorth",
            source: "ai",
            text: "Your peak was {peakAmount}.",
            factIds: ["netWorthHighPoint"],
          },
          {
            topic: "spending",
            source: "calculated",
            factId: "spendingLastDay",
          },
        ],
        figures: {
          peakAmount: { kind: "money", value: 987654, currency: "CAD" },
          lastDayDate: { kind: "day", value: "2026-11-17" },
        },
        language: "fr",
        generatedAt,
      });

      beforeEach(() => {
        jest.useFakeTimers().setSystemTime(new Date("2026-11-19T07:00:00Z"));
      });
      afterEach(() => jest.useRealTimers());

      it("sends yesterday's stored templates as wording not to reuse, with an angle", async () => {
        triviaRepo.findOne.mockResolvedValue(
          yesterdayRow(new Date("2026-11-18T07:00:00Z")),
        );
        await service.generateForUser(userId, "UTC");
        const content = ai.complete.mock.calls[0][1].messages[0].content;
        expect(content).toContain("Angle for today: ");
        expect(content).toContain(
          "Sentences shown yesterday (do not reuse their wording; their placeholders belong to yesterday):\n- Your peak was {peakAmount}.",
        );
        // Templates only: no stored figure value reaches the provider.
        expect(content).not.toContain("987654");
        expect(ai.complete.mock.calls[0][3]).toEqual({ skipRelay: true });
      });

      it("sends no avoid list for a row a page load wrote earlier today", async () => {
        triviaRepo.findOne.mockResolvedValue(
          yesterdayRow(new Date("2026-11-19T01:00:00Z")),
        );
        await service.generateForUser(userId, "UTC");
        const content = ai.complete.mock.calls[0][1].messages[0].content;
        expect(content).not.toContain("Sentences shown yesterday");
      });

      it("does not treat a row written earlier today as yesterday for the rotation", async () => {
        ledger.load.mockResolvedValue(fullLedgerLoad());
        daily.load.mockResolvedValue(fullDailyInput());
        ai.getStatus.mockResolvedValue({
          configured: false,
          relayActive: false,
        });
        await service.generateForUser(userId, "UTC");
        const first = triviaRepo.upsert.mock.calls[0][0];
        triviaRepo.findOne.mockResolvedValue(first);
        await service.generateForUser(userId, "UTC");
        const second = triviaRepo.upsert.mock.calls[1][0];
        expect(second.items).toEqual(first.items);
      });

      it("never calls the relay", async () => {
        ai.getStatus.mockResolvedValue({ configured: true, relayActive: true });
        await service.generateForUser(userId, "UTC");
        expect(ai.complete).not.toHaveBeenCalled();
      });
    });

    it("gives the model room for every fact", async () => {
      await service.generateForUser(userId, "UTC");
      expect(ai.complete.mock.calls[0][1].maxTokens).toBe(4096);
    });

    it("builds nothing and calls no provider without the Trivia widget on the dashboard", async () => {
      for (const dashboardWidgets of [[], ["insights"]]) {
        prefRepo.findOne.mockResolvedValue({
          defaultCurrency: "CAD",
          dashboardWidgets,
        });
        triviaRepo.delete.mockClear();
        await service.generateForUser(userId, "UTC");
        expect(triviaRepo.delete).toHaveBeenCalledWith({ userId });
      }
      expect(netWorth.getMonthlyNetWorthWithAggregates).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
    });

    it("builds nothing and calls no provider with trivia switched off", async () => {
      prefRepo.findOne.mockResolvedValue({ aiTriviaEnabled: false });
      await service.generateForUser(userId, "UTC");
      expect(netWorth.getMonthlyNetWorthWithAggregates).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
      expect(triviaRepo.delete).toHaveBeenCalledWith({ userId });
    });

    it("withholds the share of assets when an investment account is left out of net worth", async () => {
      ai.getStatus.mockResolvedValue({ configured: false, relayActive: false });
      portfolio.getPortfolioSummary.mockResolvedValue({
        valuationComplete: true,
        totalPortfolioValue: 150,
        totalHoldingsValue: 150,
        totalGainLoss: 0,
        gainCostBasis: 0,
        cagr: null,
        holdingsByAccount: [],
      });
      accounts.findAll.mockResolvedValue([
        {
          accountType: AccountType.INVESTMENT,
          excludeFromNetWorth: true,
          currencyCode: "CAD",
        },
      ]);
      await service.generateForUser(userId, "UTC");
      expect(
        triviaRepo.upsert.mock.calls[0][0].figures.investmentsPercent,
      ).toBeUndefined();
    });

    it("stores the model's sentences and asks in the reader's language", async () => {
      await service.generateForUser(userId, "UTC");
      const [row, conflict] = triviaRepo.upsert.mock.calls[0];
      expect(conflict).toEqual(["userId"]);
      expect(row.items).toContainEqual({
        topic: "netWorth",
        source: "ai",
        text: "Peak {currentHigh}",
        factIds: ["netWorthAtHighPoint"],
      });
      expectNoCalculatedBesideCoveringSentence(row.items);
      expect(ai.complete.mock.calls[0][1].systemPrompt).toContain("French");
      expect(ai.complete.mock.calls[0][2]).toBe("dashboard_trivia");
    });

    it("does nothing when another replica holds the day's claim", async () => {
      jobClaims.claimOnce.mockResolvedValue(false);
      await service.generateForUser(userId, "UTC");
      // The claim comes first: a tick that finds the day taken reads nothing else.
      expect(prefRepo.findOne).not.toHaveBeenCalled();
      expect(triviaRepo.findOne).not.toHaveBeenCalled();
      expect(netWorth.getMonthlyNetWorthWithAggregates).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
      expect(triviaRepo.upsert).not.toHaveBeenCalled();
    });

    it("claims per user per local day, whichever tick reaches them", async () => {
      // 08:17Z is 00:17 on the 19th in Los Angeles and 17:17 on it in Tokyo.
      jest.useFakeTimers().setSystemTime(new Date("2026-11-19T08:17:00Z"));
      try {
        await service.generateForUser(userId, "America/Los_Angeles");
        await service.generateForUser(userId, "Asia/Tokyo");
      } finally {
        jest.useRealTimers();
      }
      expect(jobClaims.claimOnce.mock.calls.map((c) => c[2])).toEqual([
        "daily:2026-11-19",
        "daily:2026-11-19",
      ]);
      // The same instant is the 20th for UTC+13.
      jest.useFakeTimers().setSystemTime(new Date("2026-11-19T11:17:00Z"));
      try {
        await service.generateForUser(userId, "Pacific/Auckland");
        await service.generateForUser(userId, "America/Los_Angeles");
      } finally {
        jest.useRealTimers();
      }
      expect(jobClaims.claimOnce.mock.calls.slice(2).map((c) => c[2])).toEqual([
        "daily:2026-11-20",
        "daily:2026-11-19",
      ]);
    });

    it.each([
      ["no provider", { configured: false, relayActive: false }],
      ["the relay", { configured: true, relayActive: true }],
    ])("uses calculated sentences with %s", async (_name, status) => {
      ai.getStatus.mockResolvedValue(status);
      await service.generateForUser(userId, "UTC");
      expect(ai.complete).not.toHaveBeenCalled();
      expect(triviaRepo.upsert.mock.calls[0][0].items[0].source).toBe(
        "calculated",
      );
    });

    it("falls back to calculated sentences when the provider fails", async () => {
      ai.complete.mockRejectedValue(new Error("boom"));
      await service.generateForUser(userId, "UTC");
      expect(triviaRepo.upsert.mock.calls[0][0].items[0].source).toBe(
        "calculated",
      );
    });

    it("falls back when every sentence fails validation", async () => {
      ai.complete.mockResolvedValue({
        content: aiReply("You have $5 and {currentHigh}"),
      });
      await service.generateForUser(userId, "UTC");
      expect(triviaRepo.upsert.mock.calls[0][0].items[0].source).toBe(
        "calculated",
      );
    });

    it("skips the model and keeps no row when there are no facts", async () => {
      netWorth.getMonthlyNetWorthWithAggregates.mockResolvedValue([]);
      await service.generateForUser(userId, "UTC");
      expect(ai.getStatus).not.toHaveBeenCalled();
      expect(triviaRepo.upsert).not.toHaveBeenCalled();
      expect(triviaRepo.delete).toHaveBeenCalledWith({ userId });
    });

    it("still builds net worth facts when the portfolio cannot be read", async () => {
      portfolio.getPortfolioSummary.mockRejectedValue(new Error("nope"));
      ai.getStatus.mockResolvedValue({ configured: false, relayActive: false });
      await service.generateForUser(userId, "UTC");
      expect(triviaRepo.upsert.mock.calls[0][0].items).toHaveLength(2);
    });

    it("ranks only open or still-valued, counted assets, and none across currencies", async () => {
      ai.getStatus.mockResolvedValue({ configured: false, relayActive: false });
      const asset = (over: object) => ({
        name: "Home",
        accountType: AccountType.ASSET,
        isClosed: false,
        excludeFromNetWorth: false,
        currencyCode: "CAD",
        currentBalance: "150",
        ...over,
      });
      accounts.findAll.mockResolvedValue([
        asset({}),
        asset({
          name: "Sold",
          isClosed: true,
          currentBalance: "0",
          currencyCode: "USD",
        }),
        asset({
          name: "Hidden",
          excludeFromNetWorth: true,
          currencyCode: "USD",
        }),
        asset({
          name: "Chequing",
          accountType: AccountType.CHEQUING,
          currencyCode: "USD",
        }),
      ]);
      await service.generateForUser(userId, "UTC");
      expect(triviaRepo.upsert.mock.calls[0][0].figures.assetName).toEqual({
        kind: "text",
        value: "Home",
      });

      triviaRepo.upsert.mockClear();
      accounts.findAll.mockResolvedValue([
        asset({}),
        asset({ name: "Cottage", currencyCode: "USD" }),
      ]);
      await service.generateForUser(userId, "UTC");
      expect(
        triviaRepo.upsert.mock.calls[0][0].figures.assetName,
      ).toBeUndefined();
    });

    it("loads closed accounts and ranks a closed asset that still carries a value", async () => {
      ai.getStatus.mockResolvedValue({ configured: false, relayActive: false });
      accounts.findAll.mockResolvedValue([
        {
          name: "Home",
          accountType: AccountType.ASSET,
          isClosed: false,
          excludeFromNetWorth: false,
          currencyCode: "CAD",
          currentBalance: "150",
        },
        {
          name: "Cottage",
          accountType: AccountType.ASSET,
          isClosed: true,
          excludeFromNetWorth: false,
          currencyCode: "CAD",
          currentBalance: "900",
        },
      ]);
      await service.generateForUser(userId, "UTC");
      expect(accounts.findAll).toHaveBeenCalledWith(userId, true);
      expect(triviaRepo.upsert.mock.calls[0][0].figures.assetName).toEqual({
        kind: "text",
        value: "Cottage",
      });
    });
  });
});
