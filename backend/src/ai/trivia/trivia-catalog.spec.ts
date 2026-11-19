import * as fs from "fs";
import * as path from "path";
import {
  alternateCalendarInput,
  alternateDailyInput,
  fullCalendarInput,
  fullDailyInput,
  fullEquivalenceInput,
  alternateRankedInput,
  fullRankedInput,
} from "./__fixtures__/trivia-pool.fixture";
import { buildCalendarTriviaFacts } from "./trivia-calendar-facts";
import { buildDailyTriviaFacts } from "./trivia-daily-facts";
import { buildEquivalenceTriviaFacts } from "./trivia-equivalence-facts";
import { buildLedgerTriviaFacts } from "./trivia-ledger-facts";
import { buildRankedTriviaFacts } from "./trivia-ranked-facts";
import { TRIVIA_FACT_IDS, TRIVIA_TOPICS, TRIVIA_WINDOWS } from "./trivia.types";

/** A windowed sentence's `{window, select, ...}`, whose braces nest one deep. */
const WINDOW_SELECT = /\{window, select,(?:[^{}]|\{[^{}]*\})*\}/g;

/** The `{name}` placeholders of a sentence, its window select set aside. */
const quotedFigures = (sentence: string): string[] =>
  [
    ...new Set(
      [
        ...sentence.replace(WINDOW_SELECT, "").matchAll(/\{([A-Za-z0-9]+)\}/g),
      ].map((m) => m[1]),
    ),
  ].sort();

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/**
 * The calculated sentences live in the frontend's catalog, keyed by the fact
 * id the server stores. A fact or topic added here without its sentence
 * renders as a missing message on every dashboard that draws it.
 */
describe("trivia catalog", () => {
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "frontend/src/i18n/messages/en/dashboard.json"),
      "utf8",
    ),
  ) as {
    trivia: { topics: Record<string, string>; facts: Record<string, string> };
  };

  it.each(TRIVIA_FACT_IDS)("has a sentence for %s", (id) => {
    expect(typeof catalog.trivia.facts[id]).toBe("string");
  });

  it.each(TRIVIA_TOPICS)("has a label for the %s topic", (topic) => {
    expect(typeof catalog.trivia.topics[topic]).toBe("string");
  });

  it("quotes in each new sentence exactly the figures its fact carries", () => {
    const facts = buildLedgerTriviaFacts({
      currency: "CAD",
      spendingByCategory: {
        data: [{ categoryId: "c", categoryName: "C", color: null, total: 5 }],
        totalSpending: 5,
        knownSpending: 5,
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      },
      spendingByPayee: {
        data: [{ payeeId: "p", payeeName: "P", total: 5 }],
        totalSpending: 5,
        knownSpending: 5,
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      },
      incomeVsExpenses: {
        data: ["2026-01", "2026-02", "2026-03"].map((period) => ({
          period,
          periodStart: `${period}-01`,
          periodEnd: `${period}-28`,
          income: 10,
          expenses: 4,
          net: 6,
        })),
        totals: {
          income: 30,
          expenses: 12,
          net: 18,
          knownIncome: 30,
          knownExpenses: 12,
          knownNet: 18,
        },
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      },
      incomeBySource: {
        data: [{ categoryId: "s", categoryName: "S", color: null, total: 30 }],
        totalIncome: 30,
        knownIncome: 30,
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      },
      records: {
        transactions: 2,
        firstTransactionDate: "2020-01-01",
        activePayees: 1,
        categories: 1,
        activeScheduled: 1,
      },
      warranties: {
        covered: 1,
        nextExpiring: { name: "W", expiresOn: "2027-01-01" },
      },
    });
    // Every ledger fact is produced, so none escapes the check.
    expect(new Set(facts.map((f) => f.id)).size).toBe(8);
    for (const f of facts) {
      expect({
        id: f.id,
        figures: quotedFigures(catalog.trivia.facts[f.id]),
      }).toEqual({
        id: f.id,
        figures: Object.keys(f.figures).sort(),
      });
    }
  });

  it("quotes in each daily sentence exactly the figures its fact carries", () => {
    const facts = [
      ...buildDailyTriviaFacts(fullDailyInput()),
      ...buildDailyTriviaFacts(alternateDailyInput()),
    ];
    // Every daily id is produced, so none escapes the check.
    expect(new Set(facts.map((f) => f.id)).size).toBe(12);
    for (const f of facts) {
      expect({
        id: f.id,
        figures: quotedFigures(catalog.trivia.facts[f.id]),
      }).toEqual({
        id: f.id,
        figures: Object.keys(f.figures).sort(),
      });
    }
  });

  it("quotes in each calendar sentence exactly the figures its fact carries", () => {
    const facts = [
      ...buildCalendarTriviaFacts(fullCalendarInput()),
      ...buildCalendarTriviaFacts(alternateCalendarInput()),
    ];
    // Every calendar id is produced, so none escapes the check.
    expect(new Set(facts.map((f) => f.id)).size).toBe(8);
    for (const f of facts) {
      expect({
        id: f.id,
        figures: quotedFigures(catalog.trivia.facts[f.id]),
      }).toEqual({
        id: f.id,
        figures: Object.keys(f.figures).sort(),
      });
    }
  });

  it("quotes in each equivalence sentence exactly the figures its fact carries", () => {
    const facts = buildEquivalenceTriviaFacts(fullEquivalenceInput());
    // Every equivalence id is produced, so none escapes the check.
    expect(new Set(facts.map((f) => f.id)).size).toBe(4);
    for (const f of facts) {
      expect({
        id: f.id,
        figures: quotedFigures(catalog.trivia.facts[f.id]),
      }).toEqual({
        id: f.id,
        figures: Object.keys(f.figures).sort(),
      });
    }
  });

  describe("the windowed and ranked sentences", () => {
    const facts = [
      ...buildRankedTriviaFacts(fullRankedInput()),
      ...buildRankedTriviaFacts(alternateRankedInput()),
    ];

    it("quotes in each ranked sentence exactly the figures its fact carries", () => {
      // Every ranked and top id is produced, so none escapes the check.
      expect(new Set(facts.map((f) => f.id)).size).toBe(9);
      for (const f of facts) {
        expect({
          id: f.id,
          figures: quotedFigures(catalog.trivia.facts[f.id]),
        }).toEqual({ id: f.id, figures: Object.keys(f.figures).sort() });
      }
    });

    it("holds the window select, with exactly its branches, in every windowed sentence", () => {
      const windowed = facts.filter((f) => f.params?.window);
      expect(windowed.length).toBeGreaterThan(0);
      for (const f of windowed) {
        const select = catalog.trivia.facts[f.id].match(WINDOW_SELECT);
        expect({ id: f.id, selects: select?.length }).toEqual({
          id: f.id,
          selects: 1,
        });
        const branches = [
          ...(select as string[])[0].matchAll(/ (\w+) \{/g),
        ].map((m) => m[1]);
        expect(branches).toEqual([...TRIVIA_WINDOWS, "other"]);
      }
    });
  });
});
