import { DataSource } from "typeorm";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AccountType } from "../../accounts/entities/account.entity";
import { withUserContext } from "../../common/db/with-context";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { TriviaPoolBuilder } from "./trivia-pool.builder";
import { emptyWindowedReads } from "./trivia-windowed-reads";
import {
  fullDailyInput,
  fullLedgerLoad,
} from "./__fixtures__/trivia-pool.fixture";
import { familyOf } from "./trivia-families";
import { TRIVIA_DAILY_COUNT } from "./trivia-rotation";
import type { TriviaFactId } from "./trivia.types";

const manager: Record<string, any> = {};
jest.mock("../../common/db/scoped-db", () => ({
  withScopedDb: (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
}));
let mockRequestLocale = "en";
jest.mock("../../i18n/request-locale", () => ({
  currentRequestLocale: () => mockRequestLocale,
}));
jest.mock("../../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: jest.fn((_id: string, fn: () => unknown) => fn()),
}));
jest.mock("../../common/users-by-timezone.util", () => ({
  getEffectiveTimezoneOfUser: jest.fn(),
}));

describe("DashboardTriviaService", () => {
  const userId = "user-1";
  const months = [
    { month: "2025-01-01", assets: 100, netWorth: 100, fxComplete: true },
    { month: "2025-02-01", assets: 200, netWorth: 200, fxComplete: true },
  ];
  let triviaRepo: Record<string, jest.Mock>;
  let insertQb: Record<string, jest.Mock>;
  let selectQb: Record<string, jest.Mock>;
  let accounts: Record<string, jest.Mock>;
  let netWorth: Record<string, jest.Mock>;
  let portfolio: Record<string, jest.Mock>;
  let ai: Record<string, jest.Mock>;
  let jobClaims: Record<string, jest.Mock>;
  let ledger: Record<string, jest.Mock>;
  let daily: Record<string, jest.Mock>;
  let service: DashboardTriviaService;
  let prefRepo: { findOne: jest.Mock };

  const aiReply = (text: string) =>
    JSON.stringify({ trivia: [{ topic: "netWorth", text }] });

  beforeEach(() => {
    prefRepo = {
      findOne: jest.fn().mockResolvedValue({
        defaultCurrency: "CAD",
        language: "fr",
        dashboardWidgets: ["trivia"],
      }),
    };
    triviaRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    insertQb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    selectQb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ userId }, { userId: "user-2" }]),
    };
    manager.getRepository = jest.fn((entity: unknown) =>
      entity === DashboardTrivia
        ? triviaRepo
        : entity === UserPreference
          ? prefRepo
          : {},
    );
    manager.createQueryBuilder = jest.fn(() => insertQb);
    accounts = { findAll: jest.fn().mockResolvedValue([]) };
    netWorth = { getMonthlyNetWorth: jest.fn().mockResolvedValue(months) };
    portfolio = { getPortfolioSummary: jest.fn().mockResolvedValue(null) };
    ai = {
      getStatus: jest
        .fn()
        .mockResolvedValue({ configured: true, relayActive: false }),
      complete: jest
        .fn()
        .mockResolvedValue({ content: aiReply("Peak {currentHigh}") }),
    };
    jobClaims = { claimOnce: jest.fn().mockResolvedValue(true) };
    // Nothing from the rest of the ledger unless a test asks for it.
    ledger = {
      load: jest.fn().mockResolvedValue({
        currency: "CAD",
        spendingByCategory: null,
        spendingByPayee: null,
        incomeVsExpenses: null,
        incomeBySource: null,
        windowed: emptyWindowedReads(),
        records: null,
        warranties: null,
      }),
    };
    daily = {
      load: jest.fn().mockResolvedValue({
        currency: "CAD",
        today: "2026-11-19",
        monthToDate: null,
        lastDay: null,
        lastSevenDays: null,
        biggestPurchase: null,
        lastSpendDate: null,
        sincePayee: null,
        bills: null,
        budget: null,
        topMover: null,
      }),
    };
    (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue("UTC");
    (withUserContext as jest.Mock).mockClear();
    const pool = new TriviaPoolBuilder(
      {} as DataSource,
      accounts as never,
      netWorth as never,
      portfolio as never,
      ledger as never,
      daily as never,
      {
        load: jest.fn().mockResolvedValue({
          accountFirstDates: null,
          transactionsRecordedBefore: null,
          yearAgoMonth: null,
        }),
      } as never,
    );
    service = new DashboardTriviaService(
      {} as DataSource,
      ai as never,
      jobClaims as never,
      pool,
    );
  });

  describe("getTrivia", () => {
    it("returns a stored list without touching the ledger or a provider", async () => {
      triviaRepo.findOne.mockResolvedValue({
        userId,
        items: [{ topic: "netWorth", source: "ai", text: "{x}" }],
        figures: { x: { kind: "percent", value: 1 } },
        language: "fr",
        generatedAt: new Date("2026-11-09T06:30:00Z"),
      });
      const result = await service.getTrivia(userId);
      expect(result.generatedAt).toBe("2026-11-09T06:30:00.000Z");
      expect(result.items).toHaveLength(1);
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
    });

    it("builds and stores a calculated list for a user with none, calling no model", async () => {
      const result = await service.getTrivia(userId);
      expect(ai.complete).not.toHaveBeenCalled();
      expect(result.items).toContainEqual({
        topic: "netWorth",
        source: "calculated",
        factId: "netWorthAtHighPoint",
      });
      expect(result.figures.currentHigh).toEqual({
        kind: "money",
        value: 200,
        currency: "CAD",
      });
      expect(insertQb.orIgnore).toHaveBeenCalled();
      expect(insertQb.execute).toHaveBeenCalled();
    });
  });

  describe("getTrivia in the reader's language", () => {
    const aiRow = (language: string | null) => ({
      userId,
      items: [{ topic: "netWorth", source: "ai", text: "{currentHigh}" }],
      figures: {},
      language,
      generatedAt: new Date(),
    });

    beforeEach(() => {
      mockRequestLocale = "en";
    });

    it("keeps a model's list in the language the reader uses", async () => {
      prefRepo.findOne.mockResolvedValue({ language: "fr" });
      triviaRepo.findOne.mockResolvedValue(aiRow("fr"));
      const result = await service.getTrivia(userId);
      expect(result.items[0].source).toBe("ai");
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
    });

    it("replaces a model's list worded in another language with calculated sentences", async () => {
      prefRepo.findOne.mockResolvedValue({ language: "fr" });
      triviaRepo.findOne.mockResolvedValue(aiRow("en"));
      const result = await service.getTrivia(userId);
      expect(result.items.every((i) => i.source === "calculated")).toBe(true);
      expect(triviaRepo.upsert.mock.calls[0][0].language).toBe("fr");
      expect(ai.complete).not.toHaveBeenCalled();
    });

    it("treats regional English as the same language", async () => {
      prefRepo.findOne.mockResolvedValue({ language: "en-GB" });
      triviaRepo.findOne.mockResolvedValue(aiRow("en"));
      const result = await service.getTrivia(userId);
      expect(result.items[0].source).toBe("ai");
      expect(triviaRepo.upsert).not.toHaveBeenCalled();
    });

    it("records the browser's language for a reader following it", async () => {
      prefRepo.findOne.mockResolvedValue({ language: "browser" });
      mockRequestLocale = "de";
      triviaRepo.findOne.mockResolvedValue({
        ...aiRow(null),
        items: [
          {
            topic: "netWorth",
            source: "calculated",
            factId: "netWorthAtHighPoint",
          },
        ],
      });
      await service.getTrivia(userId);
      expect(triviaRepo.update).toHaveBeenCalledWith(
        { userId },
        { language: "de" },
      );
    });
  });

  describe("getTrivia switched off", () => {
    it("returns nothing and reads neither the row nor the ledger", async () => {
      prefRepo.findOne.mockResolvedValue({ aiTriviaEnabled: false });
      const result = await service.getTrivia(userId);
      expect(result.items).toEqual([]);
      expect(triviaRepo.findOne).not.toHaveBeenCalled();
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
      expect(ledger.load).not.toHaveBeenCalled();
    });
  });

  describe("the rest of Monize", () => {
    const records = {
      transactions: 1234,
      firstTransactionDate: "2019-04-02",
      activePayees: 80,
      categories: 40,
      activeScheduled: 6,
    };

    it("adds the ledger's facts beside net worth's, in the reader's currency", async () => {
      ledger.load.mockResolvedValue({
        currency: "CAD",
        spendingByCategory: null,
        spendingByPayee: null,
        incomeVsExpenses: null,
        incomeBySource: null,
        windowed: emptyWindowedReads(),
        records,
        warranties: { covered: 2, nextExpiring: null },
      });
      const result = await service.getTrivia(userId);
      expect(ledger.load).toHaveBeenCalledWith(
        userId,
        "CAD",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.any(Object),
      );
      const ids = result.items.map((item) =>
        item.source === "calculated" ? item.factId : null,
      );
      expect(ids).toEqual(
        expect.arrayContaining([
          "netWorthAtHighPoint",
          "activityTransactions",
          "activityPayees",
          "activityScheduled",
          "warrantiesCovered",
        ]),
      );
      expect(result.figures.transactionCount).toEqual({
        kind: "count",
        value: 1234,
      });
    });

    it("keeps a model's sentence on a new topic, and the topic's calculated ones for a topic it skipped", async () => {
      ledger.load.mockResolvedValue({
        currency: "CAD",
        spendingByCategory: null,
        spendingByPayee: null,
        incomeVsExpenses: null,
        incomeBySource: null,
        windowed: emptyWindowedReads(),
        records,
        warranties: { covered: 1, nextExpiring: null },
      });
      ai.complete.mockResolvedValue({
        content: JSON.stringify({
          trivia: [
            {
              topic: "activity",
              text: "{transactionCount} rows since {firstTransactionMonth}.",
            },
          ],
        }),
      });
      await service.generateForUser(userId);
      const prompt = ai.complete.mock.calls[0][1];
      expect(prompt.systemPrompt).toContain('"warranties"');
      expect(prompt.messages[0].content).toContain("topic activity");
      const items = triviaRepo.upsert.mock.calls[0][0].items;
      expect(items).toContainEqual({
        topic: "activity",
        source: "ai",
        factIds: ["activityTransactions"],
        text: "{transactionCount} rows since {firstTransactionMonth}.",
      });
      // The model left net worth and warranties out; their sentences stay.
      expect(items).toContainEqual({
        topic: "warranties",
        source: "calculated",
        factId: "warrantiesCovered",
      });
      expect(items).not.toContainEqual(
        expect.objectContaining({ factId: "activityTransactions" }),
      );
    });
  });

  describe("getTrivia with nothing to say", () => {
    it("does not store an empty list, so a first import shows on the next load", async () => {
      netWorth.getMonthlyNetWorth.mockResolvedValue([]);
      const result = await service.getTrivia(userId);
      expect(result.items).toEqual([]);
      expect(insertQb.execute).not.toHaveBeenCalled();
    });
  });

  describe("generateForUser", () => {
    it("has the job write in the browser's language for a reader following it", async () => {
      prefRepo.findOne.mockResolvedValue({
        language: "browser",
        dashboardWidgets: ["trivia"],
      });
      triviaRepo.findOne.mockResolvedValue({ language: "ja" });
      await service.generateForUser(userId);
      expect(ai.complete.mock.calls[0][1].systemPrompt).toContain("Japanese");
      expect(triviaRepo.upsert.mock.calls[0][0].language).toBe("ja");
    });

    it("tells the model to keep placeholder names in English", async () => {
      await service.generateForUser(userId);
      expect(ai.complete.mock.calls[0][1].systemPrompt).toContain(
        "Placeholder names stay exactly as written",
      );
    });

    it("keeps the relay out of the provider fall-through", async () => {
      await service.generateForUser(userId);
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
        await service.generateForUser(userId);
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
        await service.generateForUser(userId);
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
        await service.generateForUser(userId);
        const first = triviaRepo.upsert.mock.calls[0][0];
        triviaRepo.findOne.mockResolvedValue(first);
        await service.generateForUser(userId);
        const second = triviaRepo.upsert.mock.calls[1][0];
        expect(second.items).toEqual(first.items);
      });

      it("never calls the relay", async () => {
        ai.getStatus.mockResolvedValue({ configured: true, relayActive: true });
        await service.generateForUser(userId);
        expect(ai.complete).not.toHaveBeenCalled();
      });
    });

    it("gives the model room for every fact", async () => {
      await service.generateForUser(userId);
      expect(ai.complete.mock.calls[0][1].maxTokens).toBe(4096);
    });

    it("builds nothing and calls no provider without the Trivia widget on the dashboard", async () => {
      for (const dashboardWidgets of [[], ["insights"]]) {
        prefRepo.findOne.mockResolvedValue({
          defaultCurrency: "CAD",
          dashboardWidgets,
        });
        triviaRepo.delete.mockClear();
        await service.generateForUser(userId);
        expect(triviaRepo.delete).toHaveBeenCalledWith({ userId });
      }
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
      expect(jobClaims.claimOnce).not.toHaveBeenCalled();
    });

    it("builds nothing and calls no provider with trivia switched off", async () => {
      prefRepo.findOne.mockResolvedValue({ aiTriviaEnabled: false });
      await service.generateForUser(userId);
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
      expect(jobClaims.claimOnce).not.toHaveBeenCalled();
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
      await service.generateForUser(userId);
      expect(
        triviaRepo.upsert.mock.calls[0][0].figures.investmentsPercent,
      ).toBeUndefined();
    });

    it("stores the model's sentences and asks in the reader's language", async () => {
      await service.generateForUser(userId);
      const [row, conflict] = triviaRepo.upsert.mock.calls[0];
      expect(conflict).toEqual(["userId"]);
      expect(row.items).toContainEqual({
        topic: "netWorth",
        source: "ai",
        text: "Peak {currentHigh}",
        factIds: ["netWorthAtHighPoint"],
      });
      expect(ai.complete.mock.calls[0][1].systemPrompt).toContain("French");
      expect(ai.complete.mock.calls[0][2]).toBe("dashboard_trivia");
    });

    it("does nothing when another replica holds the day's claim", async () => {
      jobClaims.claimOnce.mockResolvedValue(false);
      await service.generateForUser(userId);
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
      expect(triviaRepo.upsert).not.toHaveBeenCalled();
    });

    it("claims per user per UTC day", async () => {
      await service.generateForUser(userId);
      expect(jobClaims.claimOnce.mock.calls[0][2]).toMatch(
        /^daily:\d{4}-\d{2}-\d{2}$/,
      );
    });

    it.each([
      ["no provider", { configured: false, relayActive: false }],
      ["the relay", { configured: true, relayActive: true }],
    ])("uses calculated sentences with %s", async (_name, status) => {
      ai.getStatus.mockResolvedValue(status);
      await service.generateForUser(userId);
      expect(ai.complete).not.toHaveBeenCalled();
      expect(triviaRepo.upsert.mock.calls[0][0].items[0].source).toBe(
        "calculated",
      );
    });

    it("falls back to calculated sentences when the provider fails", async () => {
      ai.complete.mockRejectedValue(new Error("boom"));
      await service.generateForUser(userId);
      expect(triviaRepo.upsert.mock.calls[0][0].items[0].source).toBe(
        "calculated",
      );
    });

    it("falls back when every sentence fails validation", async () => {
      ai.complete.mockResolvedValue({
        content: aiReply("You have $5 and {currentHigh}"),
      });
      await service.generateForUser(userId);
      expect(triviaRepo.upsert.mock.calls[0][0].items[0].source).toBe(
        "calculated",
      );
    });

    it("skips the model and keeps no row when there are no facts", async () => {
      netWorth.getMonthlyNetWorth.mockResolvedValue([]);
      await service.generateForUser(userId);
      expect(ai.getStatus).not.toHaveBeenCalled();
      expect(triviaRepo.upsert).not.toHaveBeenCalled();
      expect(triviaRepo.delete).toHaveBeenCalledWith({ userId });
    });

    it("still builds net worth facts when the portfolio cannot be read", async () => {
      portfolio.getPortfolioSummary.mockRejectedValue(new Error("nope"));
      ai.getStatus.mockResolvedValue({ configured: false, relayActive: false });
      await service.generateForUser(userId);
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
      await service.generateForUser(userId);
      expect(triviaRepo.upsert.mock.calls[0][0].figures.assetName).toEqual({
        kind: "text",
        value: "Home",
      });

      triviaRepo.upsert.mockClear();
      accounts.findAll.mockResolvedValue([
        asset({}),
        asset({ name: "Cottage", currencyCode: "USD" }),
      ]);
      await service.generateForUser(userId);
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
      await service.generateForUser(userId);
      expect(accounts.findAll).toHaveBeenCalledWith(userId, true);
      expect(triviaRepo.upsert.mock.calls[0][0].figures.assetName).toEqual({
        kind: "text",
        value: "Cottage",
      });
    });
  });

  describe("handleDailyGeneration", () => {
    it("runs every active user and isolates one user's failure", async () => {
      manager.createQueryBuilder = jest.fn(() => selectQb);
      const spy = jest
        .spyOn(service, "generateForUser")
        .mockRejectedValueOnce(new Error("first fails"))
        .mockResolvedValue(undefined);
      await expect(service.handleDailyGeneration()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(selectQb.where).toHaveBeenCalledWith("u.is_active = true");
    });

    it("runs each user's body under that user's timezone", async () => {
      manager.createQueryBuilder = jest.fn(() => selectQb);
      (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue(
        "Pacific/Auckland",
      );
      jest.spyOn(service, "generateForUser").mockResolvedValue(undefined);
      await service.handleDailyGeneration();
      const bodyCalls = (withUserContext as jest.Mock).mock.calls.filter(
        (call) => call.length === 3,
      );
      expect(bodyCalls).toHaveLength(2);
      expect(bodyCalls[0][2]).toBe("Pacific/Auckland");
    });

    it("builds the pool for the reader's day, with bills, on the cron path", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-11-19T12:30:00Z"));
      (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue(
        "Pacific/Auckland",
      );
      try {
        await service.generateForUser(userId);
      } finally {
        jest.useRealTimers();
      }
      // 12:30 UTC on the 19th is already the 20th in Auckland (UTC+13).
      expect(ledger.load).toHaveBeenCalledWith(
        userId,
        "CAD",
        "2026-11-20",
        expect.any(Object),
      );
      expect(daily.load).toHaveBeenCalledWith(
        userId,
        "CAD",
        "2026-11-20",
        expect.objectContaining({ bills: true }),
      );
    });
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
      await service.generateForUser(userId);
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
        await service.generateForUser(userId);
        const first = triviaRepo.upsert.mock.calls[0][0];
        triviaRepo.findOne.mockResolvedValue(first);
        jest.setSystemTime(new Date("2026-11-20T07:00:00Z"));
        await service.generateForUser(userId);
      } finally {
        jest.useRealTimers();
      }
      const [first, second] = triviaRepo.upsert.mock.calls.map((c) => c[0]);
      const before = new Set(first.items.map(familyOfItem));
      expect(
        second.items.map(familyOfItem).filter((f) => before.has(f)),
      ).toEqual([]);
    });

    it("keeps the stored facts when a language change rewords the row", async () => {
      await service.generateForUser(userId);
      const stored = triviaRepo.upsert.mock.calls[0][0];
      triviaRepo.upsert.mockClear();
      const [first, ...rest] = stored.items;
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
      });
      prefRepo.findOne.mockResolvedValue({ language: "fr" });
      const result = await service.getTrivia(userId);
      const ids = (items: object[]) =>
        (items as { factId?: string }[]).map((i) => i.factId).filter(Boolean);
      const storedIds = ids(rest);
      expect(ids(result.items)).toEqual(expect.arrayContaining(storedIds));
      expect(result.items.every((i) => i.source === "calculated")).toBe(true);
      expect(result.items.length).toBeLessThanOrEqual(TRIVIA_DAILY_COUNT);
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
