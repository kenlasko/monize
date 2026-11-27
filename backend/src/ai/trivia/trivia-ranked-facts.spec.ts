import { rankedInput } from "./__fixtures__/trivia-pool.fixture";
import {
  buildRankedTriviaFacts,
  type TriviaRankedInput,
} from "./trivia-ranked-facts";
import type { TriviaWindow } from "./trivia.types";

const factsOf = (input: TriviaRankedInput) => buildRankedTriviaFacts(input);
const byId = (input: TriviaRankedInput, id: string) =>
  factsOf(input).find((f) => f.id === id);

/** Replaces one report the window reads, wherever the window keeps it. */
function withReport(
  input: TriviaRankedInput,
  window: TriviaWindow,
  patch: {
    category?: Partial<
      NonNullable<TriviaRankedInput["m12"]["spendingByCategory"]>
    >;
    payee?: Partial<NonNullable<TriviaRankedInput["m12"]["spendingByPayee"]>>;
    source?: Partial<NonNullable<TriviaRankedInput["m12"]["incomeBySource"]>>;
  },
): TriviaRankedInput {
  const next = rankedInput(window, input.picks.spendingRankedCategory.rank);
  const merge = <T extends object>(base: T | null | undefined, p: object) =>
    ({ ...base, ...p }) as T;
  if (window === "m12") {
    const m12 = next.m12;
    return {
      ...next,
      m12: {
        spendingByCategory: merge(m12.spendingByCategory, patch.category ?? {}),
        spendingByPayee: merge(m12.spendingByPayee, patch.payee ?? {}),
        incomeBySource: merge(m12.incomeBySource, patch.source ?? {}),
      },
    };
  }
  const w = next.windowed;
  w.spendingByCategory.set(
    window,
    merge(w.spendingByCategory.get(window), patch.category ?? {}),
  );
  w.spendingByPayee.set(
    window,
    merge(w.spendingByPayee.get(window), patch.payee ?? {}),
  );
  w.incomeBySource.set(
    window,
    merge(w.incomeBySource.get(window), patch.source ?? {}),
  );
  return next;
}

describe("buildRankedTriviaFacts", () => {
  it("gives the legacy ids, with no params, for the twelve whole months", () => {
    const facts = factsOf(rankedInput("m12"));
    expect(facts.map((f) => f.id)).toEqual([
      "spendingTopCategory",
      "spendingTopPayee",
      "spendingRankedCategory",
      "spendingRankedPayee",
      "incomeTopSource",
      "incomeRankedSource",
    ]);
    const legacy = facts.filter((f) => !f.id.startsWith("spendingRanked"));
    for (const f of legacy.filter((f) => !f.id.endsWith("Source"))) {
      expect(f.params).toBeUndefined();
    }
    expect(byId(rankedInput("m12"), "spendingTopCategory")?.figures).toEqual({
      topCategoryName: { kind: "text", value: "Rent" },
      topCategoryAmount: { kind: "money", value: 60, currency: "CAD" },
      topCategoryPercent: { kind: "percent", value: 60 },
    });
    // A ranked fact always says its window.
    expect(byId(rankedInput("m12"), "spendingRankedCategory")?.params).toEqual({
      window: "m12",
    });
  });

  it("gives the windowed ids, with the window, for any other window", () => {
    const facts = factsOf(rankedInput("d90"));
    expect(facts.map((f) => [f.id, f.params])).toEqual([
      ["spendingTopCategoryWindow", { window: "d90" }],
      ["spendingTopPayeeWindow", { window: "d90" }],
      ["spendingRankedCategory", { window: "d90" }],
      ["spendingRankedPayee", { window: "d90" }],
      ["incomeTopSourceWindow", { window: "d90" }],
      ["incomeRankedSource", { window: "d90" }],
    ]);
  });

  it.each([["d30"], ["ytd"], ["all"]] as const)(
    "reads the %s window from its own report",
    (window) => {
      expect(
        factsOf(rankedInput(window)).every((f) => f.params?.window === window),
      ).toBe(true);
    },
  );

  it("picks the second or third row by rank, with its share of the total", () => {
    expect(
      byId(rankedInput("d90", 2), "spendingRankedCategory")?.figures,
    ).toEqual({
      rankedCategoryName: { kind: "text", value: "Food" },
      rankedCategoryRank: { kind: "count", value: 2 },
      rankedCategoryAmount: { kind: "money", value: 30, currency: "CAD" },
      rankedCategoryPercent: { kind: "percent", value: 30 },
    });
    expect(byId(rankedInput("d90", 3), "incomeRankedSource")?.figures).toEqual({
      rankedSourceName: { kind: "text", value: "Gifts" },
      rankedSourceRank: { kind: "count", value: 3 },
      rankedSourcePercent: { kind: "percent", value: 5 },
    });
    expect(byId(rankedInput("d90", 3), "spendingRankedPayee")?.figures).toEqual(
      {
        rankedPayeeName: { kind: "text", value: "Cafe" },
        rankedPayeeRank: { kind: "count", value: 3 },
        rankedPayeeAmount: { kind: "money", value: 10, currency: "CAD" },
      },
    );
  });

  it("states a source's share as the report divides it, not its reading over the income's (issue #2414)", () => {
    // Two equal sources of 1.2474 read 1.25 each over 2.49: 50.2% each by the
    // readings, half each by the report's unrounded share.
    const equal = withReport(rankedInput("d90", 2), "d90", {
      source: {
        data: [
          {
            categoryId: "s1",
            categoryName: "Salary",
            color: null,
            total: 1.25,
            percentage: 50,
          },
          {
            categoryId: "s2",
            categoryName: "Bonus",
            color: null,
            total: 1.25,
            percentage: 50,
          },
        ],
        totalIncome: 2.49,
        knownIncome: 2.49,
      },
    });
    expect(
      byId(equal, "incomeTopSourceWindow")?.figures.topSourcePercent,
    ).toEqual({ kind: "percent", value: 50 });
    expect(
      byId(equal, "incomeRankedSource")?.figures.rankedSourcePercent,
    ).toEqual({ kind: "percent", value: 50 });
  });

  it("reads the category share computed before rounding", () => {
    const input = withReport(rankedInput("d90", 2), "d90", {
      category: {
        netSpending: true,
        totalSpending: 2.49,
        data: [
          {
            categoryId: "a",
            categoryName: "Rent",
            color: null,
            total: 1.25,
            percentage: 50,
          },
          {
            categoryId: "b",
            categoryName: "Food",
            color: null,
            total: 1.25,
            percentage: 50,
          },
        ],
      },
    });
    expect(
      byId(input, "spendingTopCategoryWindow")?.figures.topCategoryPercent
        .value,
    ).toBe(50);
    expect(
      byId(input, "spendingRankedCategory")?.figures.rankedCategoryPercent
        .value,
    ).toBe(50);
  });

  it("omits ranked percentage facts for a mix of spending and refunds", () => {
    const input = withReport(rankedInput("d90", 2), "d90", {
      category: {
        netSpending: true,
        totalSpending: 100,
        data: [
          { categoryId: "a", categoryName: "Rent", color: null, total: 120 },
          { categoryId: "b", categoryName: "Food", color: null, total: 10 },
          { categoryId: "c", categoryName: "Clothes", color: null, total: -30 },
        ],
      },
    });
    expect(byId(input, "spendingTopCategoryWindow")).toBeUndefined();
    expect(byId(input, "spendingRankedCategory")).toBeUndefined();
  });

  it("gives no rank 3 fact when only two rows exist", () => {
    const two = withReport(rankedInput("d90", 3), "d90", {
      category: {
        data: [
          { categoryId: "c1", categoryName: "Rent", color: null, total: 60 },
          { categoryId: "c2", categoryName: "Food", color: null, total: 30 },
        ],
      },
    });
    const ids = factsOf(two).map((f) => f.id);
    expect(ids).not.toContain("spendingRankedCategory");
    expect(ids).toContain("spendingTopCategoryWindow");
  });

  it("never ranks the Unknown payee bucket", () => {
    const unknown = withReport(rankedInput("d90", 2), "d90", {
      payee: {
        data: [
          { payeeId: null, payeeName: "Unknown", total: 500 },
          { payeeId: "p1", payeeName: "Landlord", total: 60 },
          { payeeId: "p2", payeeName: "Grocer", total: 30 },
        ],
        totalSpending: 590,
      },
    });
    expect(byId(unknown, "spendingTopPayeeWindow")?.figures).toMatchObject({
      topPayeeName: { value: "Landlord" },
    });
    // Rank 2 is the second real payee, not the Unknown bucket.
    expect(byId(unknown, "spendingRankedPayee")?.figures).toMatchObject({
      rankedPayeeName: { value: "Grocer" },
    });
  });

  it("gives no ranked category without a complete total", () => {
    const partial = withReport(rankedInput("d90"), "d90", {
      category: { totalSpending: null },
    });
    const ids = factsOf(partial).map((f) => f.id);
    expect(ids).not.toContain("spendingRankedCategory");
    expect(ids).not.toContain("spendingTopCategoryWindow");
    expect(ids).toContain("spendingTopPayeeWindow");
  });

  it("gives no income fact without a complete total, and none from an unread report", () => {
    const partial = withReport(rankedInput("m12"), "m12", {
      source: { totalIncome: null },
    });
    const ids = factsOf(partial).map((f) => f.id);
    expect(ids).not.toContain("incomeRankedSource");
    expect(ids).not.toContain("incomeTopSource");
    const unread = rankedInput("d90");
    unread.windowed.spendingByPayee.set("d90", null);
    expect(factsOf(unread).map((f) => f.id)).not.toContain(
      "spendingTopPayeeWindow",
    );
  });
});
