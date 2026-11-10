import { DataSource } from "typeorm";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AccountType } from "../../accounts/entities/account.entity";

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
  withUserContext: (_id: string, fn: () => unknown) => fn(),
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
    service = new DashboardTriviaService(
      {} as DataSource,
      accounts as never,
      netWorth as never,
      portfolio as never,
      ai as never,
      jobClaims as never,
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
      expect(row.items).toEqual([
        { topic: "netWorth", source: "ai", text: "Peak {currentHigh}" },
      ]);
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

    it("ranks only open, counted assets, and none across currencies", async () => {
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
        asset({ name: "Sold", isClosed: true, currencyCode: "USD" }),
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
  });
});
