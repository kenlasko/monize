import * as aliasMatch from "../../payees/alias-match.util";
import {
  ALIAS_GLOB_BUDGET,
  NAME_MAX_SPANS,
  NAME_SPAN_BUDGET,
  NamesInput,
  readNames,
} from "./quick-add-names.util";
import { QuickAddParseInput, readQuickAddText } from "./quick-add-parse.util";
import * as textUtil from "./quick-add-text.util";
import {
  QUICK_ADD_MAX_WORDS,
  QUICK_ADD_TEXT_MAX_LENGTH,
  UnitSpan,
  buildQuickAddText,
  findOccurrences,
  foldForComparison,
} from "./quick-add-text.util";
import { resolveQuickAddVocabulary } from "./quick-add-vocabulary";
import type { QuickAddCandidatePayee } from "./quick-add.types";

/**
 * One reading's work is bounded whatever the reader has stored
 * (`docs/future-plans/quick-add.md`, "Bounds"): the line is read after NFKC
 * and cut to a fixed number of words, wildcard aliases share a fixed budget
 * of glob evaluations, and every name's spans are capped, per name and per
 * reading.
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
          // The typed line's fold, one unit at a time.
          const unitByUnit = buildQuickAddText(name, locale).folded;
          expect(foldForComparison(name, locale)).toBe(unitByUnit);
          // A non-ASCII character on the end forces the whole-string fold.
          const whole = foldForComparison(`${name.trimEnd()}\u00e9`, locale);
          expect(whole.slice(0, -1)).toBe(unitByUnit);
        }
      },
    );

    /** Code points around every rule of the fold, astral ones included. */
    const FOLD_RANGES: ReadonlyArray<readonly [number, number]> = [
      [0x00a0, 0x058f], // Latin-1 to Armenian: diacritics, Greek, Cyrillic, IPA
      [0x1ab0, 0x1aff], // combining marks, extended
      [0x1d00, 0x1fff], // phonetic, Latin and Greek extended, more marks
      [0x2000, 0x206f], // spaces and typographic apostrophes
      [0x2c60, 0x2c7f], // Latin extended-C
      [0x2de0, 0x2dff], // Cyrillic combining letters (marks of a foldable script)
      [0x3040, 0x30ff], // kana, with the combining voiced marks
      [0xa640, 0xa69f], // Cyrillic extended-B, more Cyrillic marks
      [0xa720, 0xa7ff], // Latin extended-D
      [0xac00, 0xac40], // Hangul syllables (NFD splits them)
      [0xfb00, 0xfb4f], // ligatures NFKC expands
      [0xfe20, 0xfe2f], // half marks, two of them Cyrillic
      [0xff00, 0xffef], // full-width forms
      [0x1d400, 0x1d4ff], // mathematical letters NFKC makes Latin and Greek
      [0x1e000, 0x1e08f], // Glagolitic and Cyrillic combining letters
    ];

    it.each(["en", "tr", "lt", "ru", "ja"])(
      "folds a whole name exactly as the typed line folds it unit by unit (%s)",
      (locale) => {
        const mismatches: string[] = [];
        for (const [from, to] of FOLD_RANGES) {
          for (let point = from; point <= to; point++) {
            const ch = String.fromCodePoint(point);
            for (const sample of [
              ch,
              `A${ch}\u0301`,
              `\u30a2${ch}\u0301`,
              `I${ch}\u0307`,
              `ΣΑ${ch}Σ ΟΣ`,
              `\uac00${ch}\u0483\u0301`,
            ]) {
              const whole = foldForComparison(sample, locale);
              if (whole !== buildQuickAddText(sample, locale).folded) {
                mismatches.push(`U+${point.toString(16)} in ${sample}`);
              }
            }
          }
        }
        expect(mismatches).toEqual([]);
      },
    );

    it.each([
      ["en", "Café Crème "],
      ["ru", "Ёлка Йогурт "],
      ["tr", "İstanbul Işık "],
      ["ja", "ファミリーマート店 "],
    ])(
      "folds each candidate name once per reading, whole, whatever its length (%s)",
      (locale, word) => {
        const payees = (repeat: number) =>
          Array.from({ length: 50 }, (_v, i) =>
            payee(`p${i}`, `${word.repeat(repeat)}${i}`),
          );
        /** Lower-casing calls one reading makes; a fold lower-cases once. */
        const lowerCasings = (list: QuickAddCandidatePayee[]) => {
          const over = {
            payees: list,
            locale,
            vocabulary: resolveQuickAddVocabulary(locale),
          };
          read("12 zzzq unmatched", over);
          const lower = jest.spyOn(String.prototype, "toLowerCase");
          const localeLower = jest.spyOn(String.prototype, "toLocaleLowerCase");
          try {
            // `zzzq` starts no name, so the partial match reads every one.
            read("12 zzzq unmatched", over);
            return lower.mock.calls.length + localeLower.mock.calls.length;
          } finally {
            lower.mockRestore();
            localeLower.mockRestore();
          }
        };
        const withoutPayees = lowerCasings([]);
        const short = lowerCasings(payees(1)) - withoutPayees;
        const long = lowerCasings(payees(8)) - withoutPayees;
        // Once per name for the whole reading, the names step and the partial
        // match sharing it, never once per character.
        expect(short).toBeLessThanOrEqual(50);
        expect(long).toBe(short);
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

    it(`still find their payee when an alias matches past ${NAME_MAX_SPANS} words`, () => {
      // One alias matching every word, its spans capped: the payee found is
      // that alias's, at its earliest span, and the rest is leftover.
      const r = read(`5 ${"ab ".repeat(20).trim()}`, {
        payees: [payee("p-ab", "Zed", ["*ab*"])],
      });
      expect(r.payee?.candidates.map((p) => p.id)).toEqual(["p-ab"]);
      expect(r.leftover?.split(" ")).toHaveLength(19);
    });
  });

  describe("names", () => {
    /** The spans `readNames` hands to the longest-wins selection. */
    function selectedFrom(line: string, over: Partial<NamesInput>) {
      const text = buildQuickAddText(line, "ja");
      const used = text.units.map(() => false);
      const select = jest.spyOn(textUtil, "selectLongest");
      try {
        const names = readNames(text, used, {
          locale: "ja",
          accounts: [],
          payees: [],
          categories: [],
          connectors: [],
          ...over,
        });
        const spans = select.mock.calls[0][0] as ReadonlyArray<{
          span: UnitSpan;
          item: { id: string };
        }>;
        return { names, spans };
      } finally {
        select.mockRestore();
      }
    }

    const overlapping = (spans: readonly UnitSpan[]) =>
      spans.some((a, i) =>
        spans.some((b, j) => i !== j && a.start < b.end && b.start < a.end),
      );

    it.each([
      ["a plain alias", { payees: [payee("p", "店", ["ああ"])] }],
      ["a payee's name", { payees: [payee("p", "ああ")] }],
      [
        "an account's name",
        {
          accounts: [
            { id: "p", name: "ああ", currencyCode: "JPY", currentBalance: 0 },
          ],
        },
      ],
      [
        "a category's name and path",
        {
          categories: [
            {
              id: "p",
              name: "ああ",
              path: "ああ: ああ",
              categoryType: "expense" as const,
            },
          ],
        },
      ],
    ])(
      `contribute at most ${NAME_MAX_SPANS} spans, never overlapping, from %s`,
      (_label, over: Partial<NamesInput>) => {
        // Every position of the line starts `ああ`: 199 overlapping places.
        const { names, spans } = selectedFrom("あ".repeat(200), over);
        expect(spans.length).toBeGreaterThan(0);
        expect(spans.length).toBeLessThanOrEqual(NAME_MAX_SPANS);
        expect(overlapping(spans.map((s) => s.span))).toBe(false);
        // The earliest occurrence is still the one read.
        const read = names.payee ?? names.category ?? names.accounts[0];
        expect(read?.span).toEqual({ start: 0, end: 2 });
      },
    );

    it("collect at most the span budget in one reading, and the reading stands", () => {
      const line = `12 ${"あ".repeat(QUICK_ADD_TEXT_MAX_LENGTH - 3)}`;
      const payees = Array.from({ length: 400 }, (_v, i) =>
        payee(`p${i}`, `店${i}`, ["あ", "ああ", "あああ"]),
      );
      const { names, spans } = selectedFrom(line, { payees });
      expect(spans.length).toBeLessThanOrEqual(NAME_SPAN_BUDGET);
      expect(spans.length).toBeGreaterThan(NAME_SPAN_BUDGET / 2);
      // Every payee is still folded for the partial match.
      expect(names.foldedPayeeNames).toHaveLength(payees.length);
      const r = read(line, {
        payees,
        locale: "ja",
        vocabulary: resolveQuickAddVocabulary("ja"),
      });
      expect(r.amount?.value).toBe(12);
      expect(r.payee?.partial).toBe(false);
      expect(r.payee?.candidates.length).toBeGreaterThan(0);
    });

    it("find a name's leftmost occurrences that do not overlap, free and on word boundaries", () => {
      const cjk = buildQuickAddText("あ".repeat(200), "ja");
      const free = cjk.units.map(() => false);
      const all = findOccurrences(cjk, "ああ", free, Infinity);
      expect(all).toHaveLength(100);
      expect(overlapping(all)).toBe(false);
      expect(findOccurrences(cjk, "ああ", free, 3)).toEqual([
        { start: 0, end: 2 },
        { start: 2, end: 4 },
        { start: 4, end: 6 },
      ]);
      // A used unit moves the first occurrence past it, one unit at a time.
      const usedFirst = free.map((_v, i) => i === 0);
      expect(findOccurrences(cjk, "ああ", usedFirst, 1)).toEqual([
        { start: 1, end: 3 },
      ]);
      const latin = buildQuickAddText("abab ab x ab", "en");
      expect(
        findOccurrences(
          latin,
          "ab",
          latin.units.map(() => false),
          4,
        ),
      ).toEqual([
        { start: 5, end: 7 },
        { start: 10, end: 12 },
      ]);
    });
  });
});
