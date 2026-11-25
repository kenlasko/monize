import {
  expectNoCalculatedBesideCoveringSentence,
  requestLocale,
  useServiceHarness,
  userId,
} from "./dashboard-trivia.service.harness";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { emptyWindowedReads } from "./trivia-windowed-reads";

describe("DashboardTriviaService", () => {
  const h = useServiceHarness();
  let prefRepo: { findOne: jest.Mock };
  let triviaRepo: Record<string, jest.Mock>;
  let insertQb: Record<string, jest.Mock>;
  let netWorth: Record<string, jest.Mock>;
  let ai: Record<string, jest.Mock>;
  let ledger: Record<string, jest.Mock>;
  let service: DashboardTriviaService;

  beforeEach(() => {
    ({ prefRepo, triviaRepo, insertQb, netWorth, ai, ledger, service } = h);
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
      expect(netWorth.getMonthlyNetWorthWithAggregates).not.toHaveBeenCalled();
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
      requestLocale.current = "en";
    });

    it("keeps a model's list in the language the reader uses", async () => {
      prefRepo.findOne.mockResolvedValue({ language: "fr" });
      triviaRepo.findOne.mockResolvedValue(aiRow("fr"));
      const result = await service.getTrivia(userId);
      expect(result.items[0].source).toBe("ai");
      expect(netWorth.getMonthlyNetWorthWithAggregates).not.toHaveBeenCalled();
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
      requestLocale.current = "de";
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
      expect(netWorth.getMonthlyNetWorthWithAggregates).not.toHaveBeenCalled();
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
      netWorth.getMonthlyNetWorthWithAggregates.mockResolvedValue([]);
      const result = await service.getTrivia(userId);
      expect(result.items).toEqual([]);
      expect(insertQb.execute).not.toHaveBeenCalled();
    });
  });
});
