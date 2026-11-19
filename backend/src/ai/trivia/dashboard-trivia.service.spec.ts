import { DataSource } from "typeorm";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AccountType } from "../../accounts/entities/account.entity";
import { withUserContext } from "../../common/db/with-context";
import {
  getEffectiveTimezoneOfUser,
  getUsersByEffectiveTimezone,
} from "../../common/users-by-timezone.util";
import { TriviaPoolBuilder } from "./trivia-pool.builder";
import { emptyWindowedReads } from "./trivia-windowed-reads";
import {
  fullDailyInput,
  fullLedgerLoad,
} from "./__fixtures__/trivia-pool.fixture";
import { familyOf } from "./trivia-families";
import { TRIVIA_DAILY_COUNT } from "./trivia-rotation";
import { TRIVIA_FACT_IDS, type TriviaFactId } from "./trivia.types";

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
  getUsersByEffectiveTimezone: jest.fn(),
}));

/**
 * A fact a model sentence covers is shown once: no calculated item may stand
 * beside the sentence for the same fact id.
 */
function expectNoCalculatedBesideCoveringSentence(
  items: { source: string; factId?: string; factIds?: string[] }[],
): void {
  const covered = new Set(
    items.flatMap((i) => (i.source === "ai" ? (i.factIds ?? []) : [])),
  );
  expect(covered.size).toBeGreaterThan(0);
  expect(
    items.filter(
      (i) => i.source === "calculated" && covered.has(i.factId as string),
    ),
  ).toEqual([]);
}

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
    it("returns a stored list of the reader's day without touching the ledger or a provider", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-11-19T12:00:00Z"));
      triviaRepo.findOne.mockResolvedValue({
        userId,
        items: [{ topic: "netWorth", source: "ai", text: "{x}" }],
        figures: { x: { kind: "percent", value: 1 } },
        language: "fr",
        generatedAt: new Date("2026-11-19T06:30:00Z"),
      });
      let result;
      try {
        result = await service.getTrivia(userId);
      } finally {
        jest.useRealTimers();
      }
      expect(result.generatedAt).toBe("2026-11-19T06:30:00.000Z");
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
      await service.generateForUser(userId, "UTC");
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
      expectNoCalculatedBesideCoveringSentence(items);
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
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
      expect(ai.complete).not.toHaveBeenCalled();
    });

    it("builds nothing and calls no provider with trivia switched off", async () => {
      prefRepo.findOne.mockResolvedValue({ aiTriviaEnabled: false });
      await service.generateForUser(userId, "UTC");
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
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
      expect(netWorth.getMonthlyNetWorth).not.toHaveBeenCalled();
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
      netWorth.getMonthlyNetWorth.mockResolvedValue([]);
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

  describe("handleDailyGeneration", () => {
    const at = (iso: string) =>
      jest.useFakeTimers().setSystemTime(new Date(iso));
    beforeEach(() => {
      manager.createQueryBuilder = jest.fn(() => selectQb);
      jest.spyOn(service, "generateForUser").mockResolvedValue(undefined);
      (getEffectiveTimezoneOfUser as jest.Mock).mockClear();
    });
    afterEach(() => jest.useRealTimers());

    it("builds only for readers in the first hours of their local day", async () => {
      // 08:17Z: 00:17 in Los Angeles, 03:17 in Panama, 08:17 in UTC, 17:17 in Tokyo.
      at("2026-11-19T08:17:00Z");
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([
          ["America/Los_Angeles", [userId]],
          ["America/Panama", ["user-2"]],
          ["UTC", ["user-3"]],
          ["Asia/Tokyo", ["user-4"]],
        ]),
      );
      selectQb.getRawMany.mockResolvedValue(
        ["user-1", "user-2", "user-3", "user-4"].map((id) => ({ userId: id })),
      );
      await service.handleDailyGeneration();
      expect((service.generateForUser as jest.Mock).mock.calls.sort()).toEqual([
        ["user-1", "America/Los_Angeles"],
        ["user-2", "America/Panama"],
      ]);
    });

    it("reaches a UTC+13 reader at their local midnight, not mid-afternoon", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["Pacific/Auckland", [userId]]]),
      );
      // 06:17Z is 19:17 in Auckland: the old 06:30 UTC run built it here.
      at("2026-11-19T06:17:00Z");
      await service.handleDailyGeneration();
      expect(service.generateForUser).not.toHaveBeenCalled();
      // 11:17Z is 00:17 on the 20th there.
      at("2026-11-19T11:17:00Z");
      await service.handleDailyGeneration();
      expect(service.generateForUser).toHaveBeenCalledWith(
        userId,
        "Pacific/Auckland",
      );
    });

    it("does not build for US Pacific while it is still the previous local day", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["America/Los_Angeles", [userId]]]),
      );
      at("2026-11-19T06:17:00Z"); // 22:17 on the 18th in Los Angeles
      await service.handleDailyGeneration();
      expect(service.generateForUser).not.toHaveBeenCalled();
    });

    it("leaves out inactive users, and reads none when no zone is in its window", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["UTC", [userId, "user-2"]]]),
      );
      at("2026-11-19T12:17:00Z");
      await service.handleDailyGeneration();
      expect(selectQb.getRawMany).not.toHaveBeenCalled();
      at("2026-11-19T01:17:00Z");
      selectQb.getRawMany.mockResolvedValue([{ userId: "user-2" }]);
      await service.handleDailyGeneration();
      expect(selectQb.where).toHaveBeenCalledWith("u.is_active = true");
      expect(service.generateForUser).toHaveBeenCalledTimes(1);
      expect(service.generateForUser).toHaveBeenCalledWith("user-2", "UTC");
    });

    it("counts a zone it cannot resolve in UTC", async () => {
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["Not/AZone", [userId]]]),
      );
      selectQb.getRawMany.mockResolvedValue([{ userId }]);
      at("2026-11-19T02:17:00Z");
      await service.handleDailyGeneration();
      expect(service.generateForUser).toHaveBeenCalledTimes(1);
    });

    it("isolates one user's failure and runs each body under the bucket's zone", async () => {
      at("2026-11-19T01:17:00Z");
      (getUsersByEffectiveTimezone as jest.Mock).mockResolvedValue(
        new Map([["UTC", [userId, "user-2"]]]),
      );
      selectQb.getRawMany.mockResolvedValue([{ userId }, { userId: "user-2" }]);
      (service.generateForUser as jest.Mock)
        .mockRejectedValueOnce(new Error("first fails"))
        .mockResolvedValue(undefined);
      await expect(service.handleDailyGeneration()).resolves.toBeUndefined();
      expect(service.generateForUser).toHaveBeenCalledTimes(2);
      const bodyCalls = (withUserContext as jest.Mock).mock.calls;
      expect(bodyCalls).toHaveLength(2);
      expect(bodyCalls.every((call) => call[2] === "UTC")).toBe(true);
      // The zone comes from the bucket: no second lookup per user.
      expect(getEffectiveTimezoneOfUser).not.toHaveBeenCalled();
    });

    it("builds the pool for the reader's day, with bills, on the cron path", async () => {
      jest.restoreAllMocks();
      at("2026-11-19T11:17:00Z");
      await service.generateForUser(userId, "Pacific/Auckland");
      // 11:17 UTC on the 19th is the 20th in Auckland (UTC+13).
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
