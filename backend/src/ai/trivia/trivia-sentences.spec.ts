import {
  buildTriviaPrompt,
  mergeTriviaItems,
  parseTriviaSentences,
} from "./trivia-sentences";
import type { TriviaFact } from "./trivia.types";

const facts: TriviaFact[] = [
  {
    id: "netWorthHighPoint",
    topic: "netWorth",
    figures: {
      peakAmount: { kind: "money", value: 200, currency: "CAD" },
      peakMonth: { kind: "month", value: "2025-02" },
    },
  },
  {
    id: "investmentsLargestAccount",
    topic: "investments",
    figures: {
      largestName: { kind: "text", value: "Secret RRSP" },
      largestValue: { kind: "money", value: 9, currency: "CAD" },
    },
  },
];

const reply = (...trivia: unknown[]) => JSON.stringify({ trivia });

describe("buildTriviaPrompt", () => {
  it("lists figures by placeholder and never sends a name", () => {
    const prompt = buildTriviaPrompt(facts);
    expect(prompt).toContain("{peakAmount}: money, 200 CAD");
    expect(prompt).toContain("{peakMonth}: month, 2025-02");
    expect(prompt).toContain("{largestName}: a name");
    expect(prompt).not.toContain("Secret RRSP");
  });
});

describe("parseTriviaSentences", () => {
  it("keeps a sentence built from its topic's placeholders", () => {
    expect(
      parseTriviaSentences(
        reply({
          topic: "netWorth",
          text: "You peaked at {peakAmount} in {peakMonth}.",
        }),
        facts,
      ),
    ).toEqual([
      {
        topic: "netWorth",
        source: "ai",
        text: "You peaked at {peakAmount} in {peakMonth}.",
      },
    ]);
  });

  it("reads a fenced reply", () => {
    const fenced =
      "```json\n" +
      reply({ topic: "netWorth", text: "{peakAmount}!" }) +
      "\n```";
    expect(parseTriviaSentences(fenced, facts)).toHaveLength(1);
  });

  it.each([
    ["a digit outside a placeholder", "You peaked at $200 and {peakAmount}."],
    ["a non-latin digit", "You peaked at ٣ and {peakAmount}."],
    ["a CJK numeral run", "二〇二四 was {peakAmount}."],
    ["a percent sign beside a placeholder", "You peaked at {peakAmount}%."],
    ["a currency sign beside a placeholder", "You peaked at ${peakAmount}."],
    ["a malformed placeholder", "You peaked at {peakAmount} in {peak_month}."],
    [
      "a placeholder with spaces",
      "You peaked at {peakAmount} in { peakMonth }.",
    ],
    ["an unknown placeholder", "You peaked at {madeUp}."],
    ["the other topic's figure", "You hold {largestValue}."],
    ["no placeholder at all", "You are doing great."],
    ["an empty sentence", "   "],
    ["an over-long sentence", `{peakAmount} ${"x".repeat(400)}`],
  ])("drops %s", (_name, text) => {
    expect(
      parseTriviaSentences(reply({ topic: "netWorth", text }), facts),
    ).toEqual([]);
  });

  it("keeps a CJK word that merely holds one numeral", () => {
    const text = "一番の高値は{peakAmount}でした。";
    expect(
      parseTriviaSentences(reply({ topic: "netWorth", text }), facts),
    ).toHaveLength(1);
  });

  it("drops an unknown topic, a non-string and a repeat", () => {
    expect(
      parseTriviaSentences(
        reply(
          { topic: "spending", text: "{peakAmount}" },
          { topic: "netWorth", text: 5 },
          null,
          { topic: "netWorth", text: "{peakAmount}" },
          { topic: "netWorth", text: "{peakAmount}" },
        ),
        facts,
      ),
    ).toHaveLength(1);
  });

  it("returns nothing for a reply that is not the contract", () => {
    expect(parseTriviaSentences("no json here", facts)).toEqual([]);
    expect(parseTriviaSentences('{"other": []}', facts)).toEqual([]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      topic: "netWorth",
      text: `{peakAmount} ${"a".repeat(i + 1)}`,
    }));
    expect(parseTriviaSentences(reply(...many), facts)).toHaveLength(40);
  });

  it("takes the newer topics, each held to its own figures", () => {
    const wider: TriviaFact[] = [
      ...facts,
      {
        id: "activityTransactions",
        topic: "activity",
        figures: {
          transactionCount: { kind: "count", value: 12 },
          firstTransactionMonth: { kind: "month", value: "2020-01" },
        },
      },
      {
        id: "warrantiesCovered",
        topic: "warranties",
        figures: { warrantyCount: { kind: "count", value: 3 } },
      },
    ];
    const parsed = parseTriviaSentences(
      reply(
        {
          topic: "activity",
          text: "{transactionCount} since {firstTransactionMonth}.",
        },
        { topic: "warranties", text: "{warrantyCount} covered." },
        // Another topic's figure is refused, as for the first two topics.
        {
          topic: "warranties",
          text: "{warrantyCount} and {transactionCount}.",
        },
        { topic: "budgets", text: "{warrantyCount} budgets." },
      ),
      wider,
    );
    expect(parsed.map((item) => item.topic)).toEqual([
      "activity",
      "warranties",
    ]);
  });

  it("describes a count to the model by its value", () => {
    expect(
      buildTriviaPrompt([
        {
          id: "warrantiesCovered",
          topic: "warranties",
          figures: { warrantyCount: { kind: "count", value: 3 } },
        },
      ]),
    ).toContain("{warrantyCount}: count, 3");
  });
});

describe("mergeTriviaItems", () => {
  it("uses every calculated sentence with no model", () => {
    expect(mergeTriviaItems(facts, [])).toEqual([
      { topic: "netWorth", source: "calculated", factId: "netWorthHighPoint" },
      {
        topic: "investments",
        source: "calculated",
        factId: "investmentsLargestAccount",
      },
    ]);
  });

  it("keeps calculated sentences only for a topic the model did not answer", () => {
    const ai = {
      topic: "netWorth" as const,
      source: "ai" as const,
      text: "{peakAmount}",
    };
    expect(mergeTriviaItems(facts, [ai])).toEqual([
      ai,
      {
        topic: "investments",
        source: "calculated",
        factId: "investmentsLargestAccount",
      },
    ]);
  });
});
