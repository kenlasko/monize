import * as aliasMatch from "../../payees/alias-match.util";
import { ALIAS_GLOB_BUDGET, ALIAS_MAX_SPANS } from "./quick-add-names.util";
import { QuickAddParseInput, readQuickAddText } from "./quick-add-parse.util";
import {
  QUICK_ADD_MAX_WORDS,
  QUICK_ADD_TEXT_MAX_LENGTH,
  buildQuickAddText,
  foldForComparison,
} from "./quick-add-text.util";
import { resolveQuickAddVocabulary } from "./quick-add-vocabulary";
import type { QuickAddCandidatePayee } from "./quick-add.types";

/**
 * One reading's work is bounded whatever the reader has stored
 * (`docs/future-plans/quick-add.md`, "Bounds"): the line is read after NFKC
 * and cut to a fixed number of words, and wildcard aliases share a fixed
 * budget of glob evaluations.
 */
const payee = (
  id: string,
  name: string,
  aliases: string[] = [],
): QuickAddCandidatePayee => ({ id, name, defaultCategoryId: null, aliases });

function read(text: string, over: Partial<QuickAddParseInput> = {}) {
  return readQuickAddText({
    text,
    today: "2026-11-20",
    locale: "en",
    numberFormat: "en-US",
    dateFormat: "YYYY-MM-DD",
    vocabulary: resolveQuickAddVocabulary("en"),
    accounts: [],
    payees: [],
    categories: [],
    heldCurrencies: [{ code: "CAD", symbol: "$" }],
    ...over,
  });
}

/** Distinct globs over the letters `a` and `b` that each match every word `ab`. */
function overlappingAliases(count: number): string[] {
  return Array.from(
    { length: count },
    (_v, n) =>
      `*a${[...n.toString(2)].map((b) => (b === "1" ? "**" : "*")).join("")}b*`,
  );
}

describe("Quick Add reading bounds", () => {
  describe("the line", () => {
    it("is held to the cap after NFKC, where one character can become eighteen", () => {
      const text = buildQuickAddText("\uFDFA".repeat(200), "en");
      expect(text.units.length).toBeLessThanOrEqual(QUICK_ADD_TEXT_MAX_LENGTH);
    });

    it(`is read to its first ${QUICK_ADD_MAX_WORDS} words`, () => {
      const words = Array.from({ length: 60 }, (_v, i) => `w${i}`);
      const r = read(`12 ${words.join(" ")}`);
      expect(r.amount?.value).toBe(12);
      const leftover = r.leftover?.split(" ") ?? [];
      expect(leftover).toHaveLength(QUICK_ADD_MAX_WORDS - 1);
      expect(leftover[leftover.length - 1]).toBe(`w${QUICK_ADD_MAX_WORDS - 2}`);
      const text = buildQuickAddText("a ".repeat(100), "en");
      expect(text.units.filter((u) => !u.space)).toHaveLength(
        QUICK_ADD_MAX_WORDS,
      );
    });
  });

  describe("folding a candidate name", () => {
    it.each(["en", "tr", "lt", "de", "el", "xx-invalid-locale"])(
      "gives the same answer on the ASCII path as unit by unit (%s)",
      (locale) => {
        const names = [
          "Tim HORTONS #123",
          "IKEA Istanbul",
          "  Corner\tStore  ",
          "O'Brien's Pub",
          "7-ELEVEN",
        ];
        for (const name of names) {
          // A non-ASCII character on the end forces the unit-by-unit fold.
          const slow = foldForComparison(
            `${name.trimEnd()}\u00e9`,
            locale,
          ).slice(0, -1);
          expect(foldForComparison(name, locale)).toBe(slow);
        }
      },
    );
  });

  describe("wildcard aliases", () => {
    let calls: jest.SpyInstance;

    beforeEach(() => {
      calls = jest.spyOn(aliasMatch, "matchesAliasPattern");
    });

    afterEach(() => {
      calls.mockRestore();
    });

    it("spend at most the glob budget, however many match the line", () => {
      const line = `12 ${"ab ".repeat(39).trim()}`;
      const payees = overlappingAliases(3000).map((alias, i) =>
        payee(`p${i}`, `zz payee ${i}`, [alias]),
      );
      const r = read(line, { payees });
      expect(calls.mock.calls.length).toBeLessThanOrEqual(ALIAS_GLOB_BUDGET);
      expect(calls.mock.calls.length).toBeGreaterThan(0);
      // The reading stands: the amount, and a payee from the aliases tried.
      expect(r.amount?.value).toBe(12);
      expect(r.payee?.partial).toBe(false);
    });

    it("leave the names and plain aliases read once the budget is spent", () => {
      const payees = [
        payee("p-sbux", "Starbucks", ["SBUX*"]),
        payee("p-loblaws", "Loblaws", ["LOBLAWS STORE"]),
      ];
      const r = read("12 loblaws store sbuxlatte", {
        payees,
        aliasGlobBudget: 0,
      });
      expect(calls).not.toHaveBeenCalled();
      expect(r.payee?.candidates.map((p) => p.id)).toEqual(["p-loblaws"]);
      expect(r.leftover).toBe("sbuxlatte");
      const funded = read("12 sbuxlatte", { payees });
      expect(funded.payee?.candidates.map((p) => p.id)).toEqual(["p-sbux"]);
    });

    it("are skipped without a glob when their literals do not occur in order", () => {
      const r = read("12 latte sbux", {
        payees: [payee("p-x", "Elsewhere", ["*latte*sbux*", "*sbux*latte*"])],
      });
      expect(r.payee?.candidates.map((p) => p.id)).toEqual(["p-x"]);
      const tried = calls.mock.calls.filter(([, pattern]) =>
        String(pattern).startsWith("*sbux*latte"),
      );
      expect(tried).toEqual([]);
    });

    it(`still find their payee when an alias matches past ${ALIAS_MAX_SPANS} words`, () => {
      // One alias matching every word, its spans capped: the payee found is
      // that alias's, at its earliest span, and the rest is leftover.
      const r = read(`5 ${"ab ".repeat(20).trim()}`, {
        payees: [payee("p-ab", "Zed", ["*ab*"])],
      });
      expect(r.payee?.candidates.map((p) => p.id)).toEqual(["p-ab"]);
      expect(r.leftover?.split(" ")).toHaveLength(19);
    });
  });
});
