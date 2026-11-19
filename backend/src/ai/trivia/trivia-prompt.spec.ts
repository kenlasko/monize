import { TRIVIA_ANGLES } from "../context/prompt-templates";
import { buildTriviaPrompt, pickTriviaAngle } from "./trivia-prompt";
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

const options = { avoid: [] as string[], angle: "brief" as const };

describe("buildTriviaPrompt", () => {
  it("lists figures by placeholder and never sends a name", () => {
    const prompt = buildTriviaPrompt(facts, options);
    expect(prompt).toContain("{peakAmount}: money, 200 CAD");
    expect(prompt).toContain("{peakMonth}: month, 2025-02");
    expect(prompt).toContain("{largestName}: a name");
    expect(prompt).not.toContain("Secret RRSP");
  });

  it("describes a count to the model by its value", () => {
    expect(
      buildTriviaPrompt(
        [
          {
            id: "warrantiesCovered",
            topic: "warranties",
            figures: { warrantyCount: { kind: "count", value: 3 } },
          },
        ],
        options,
      ),
    ).toContain("{warrantyCount}: count, 3");
  });

  it("puts yesterday's sentences under their heading", () => {
    const prompt = buildTriviaPrompt(facts, {
      ...options,
      avoid: ["You peaked at {peakAmount}.", "  {peakMonth} was the top.  "],
    });
    const [, avoided] = prompt.split(
      "Sentences shown yesterday (do not reuse their wording; their placeholders belong to yesterday):\n",
    );
    expect(avoided).toBe(
      "- You peaked at {peakAmount}.\n- {peakMonth} was the top.",
    );
  });

  it("sends no heading without anything to avoid", () => {
    expect(buildTriviaPrompt(facts, options)).not.toContain("yesterday");
  });

  it("sends the templates, never a sentence holding a figure or a name", () => {
    const prompt = buildTriviaPrompt(facts, {
      ...options,
      avoid: [
        "You peaked at {peakAmount}.",
        "You peaked at $200.",
        "Secret RRSP held 9%.",
        "A stray brace {.",
      ],
    });
    expect(prompt).toContain("- You peaked at {peakAmount}.");
    expect(prompt).not.toContain("$200");
    expect(prompt).not.toContain("Secret RRSP");
    expect(prompt).not.toContain("stray brace");
  });

  it("sends at most ten sentences to avoid", () => {
    const avoid = Array.from(
      { length: 14 },
      (_, i) => `Line ${"x".repeat(i + 1)} {peakAmount}.`,
    );
    const prompt = buildTriviaPrompt(facts, { ...options, avoid });
    expect(prompt.match(/^- /gm)).toHaveLength(10);
  });

  it("states the angle of the day", () => {
    expect(buildTriviaPrompt(facts, options)).toContain(
      `Angle for today: ${TRIVIA_ANGLES.brief}`,
    );
  });

  it("tells the model not to write the unit after a days or years figure", () => {
    const prompt = buildTriviaPrompt(
      [
        {
          id: "spendingNoSpendStreak",
          topic: "spending",
          figures: {
            noSpendDays: { kind: "days", value: 3 },
            lastSpendDay: { kind: "day", value: "2026-11-15" },
          },
        },
        {
          id: "activityAnniversary",
          topic: "activity",
          figures: {
            anniversaryYears: { kind: "years", value: 2 },
            anniversaryFirstDate: { kind: "date", value: "2024-11-17" },
          },
        },
      ],
      options,
    );
    expect(prompt).toContain("so do not write the word days after it");
    expect(prompt).toContain("so do not write the word years after it");
    expect(prompt).toContain(
      "{lastSpendDay}: a recent day, 2026-11-15, shown with its weekday",
    );
    expect(prompt).toContain(
      "{anniversaryFirstDate}: a date, 2024-11-17, shown as a full date",
    );
  });

  it("gives a windowed fact its window in words, without a numeral", () => {
    const prompt = buildTriviaPrompt(
      [
        {
          id: "spendingTopCategoryWindow",
          topic: "spending",
          figures: { topCategoryName: { kind: "text", value: "Rent" } },
          params: { window: "d90" },
        },
      ],
      options,
    );
    expect(prompt).toContain("  window: the past quarter");
    expect(prompt).not.toContain("Rent");
    expect(prompt).not.toMatch(/window: .*\d/);
  });
});

describe("pickTriviaAngle", () => {
  it("is deterministic for a user and day, and varies across days", () => {
    expect(pickTriviaAngle("u1", "2026-11-19")).toBe(
      pickTriviaAngle("u1", "2026-11-19"),
    );
    const angles = new Set(
      Array.from({ length: 30 }, (_, i) =>
        pickTriviaAngle("u1", `2026-11-${String(i + 1).padStart(2, "0")}`),
      ),
    );
    expect(angles.size).toBeGreaterThan(1);
    for (const angle of angles) expect(TRIVIA_ANGLES).toHaveProperty(angle);
  });
});
