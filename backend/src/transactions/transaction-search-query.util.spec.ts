import { BadRequestException } from "@nestjs/common";

import {
  MAX_SEARCH_LENGTH,
  MAX_SEARCH_TERMS,
  parseTransactionSearch,
  SearchTerm,
} from "./transaction-search-query.util";

const EN = { numberFormat: "en-US", dateFormat: "YYYY-MM-DD" };
const DE = { numberFormat: "de-DE", dateFormat: "DD.MM.YYYY" };

/** The parts of a term the grammar decides; `raw` and `interpreted` are checked separately. */
type Shape = Pick<SearchTerm, "field" | "op" | "value" | "negated"> &
  Partial<Pick<SearchTerm, "valueTo" | "ignored">>;

function shapes(input: string, formats = EN): Shape[] {
  return parseTransactionSearch(input, formats).terms.map((term) => {
    const shape: Shape = {
      field: term.field,
      op: term.op,
      value: term.value,
      negated: term.negated,
    };
    if (term.valueTo !== undefined) shape.valueTo = term.valueTo;
    if (term.ignored !== undefined) shape.ignored = term.ignored;
    return shape;
  });
}

const any = (value: string, negated = false): Shape => ({
  field: "any",
  op: "contains",
  value,
  negated,
});

const malformed = (value: string, negated = false): Shape => ({
  ...any(value, negated),
  ignored: "malformed",
});

describe("parseTransactionSearch", () => {
  describe("grammar (plan section 4.1)", () => {
    it.each<[string, Shape[]]>([
      ["", []],
      ["   ", []],
      ["costco", [any("costco")]],
      ["costco gas", [any("costco"), any("gas")]],
      ["  costco \t  gas  ", [any("costco"), any("gas")]],
      ['"costco gas"', [any("costco gas")]],
      ['"costco gas', [any("costco gas")]],
      ['"say \\"hi\\" \\\\ now"', [any('say "hi" \\ now')]],
      ['"a\\b"', [any("a\\b")]],
      ['"foo"bar', [any("foo"), any("bar")]],
      ['foo"bar', [any('foo"bar')]],
      ["-refund", [any("refund", true)]],
      ['-"gift card"', [any("gift card", true)]],
      ["-10", [any("-10")]],
      ["-.5", [any("-.5")]],
      ["-,5", [any("-,5")]],
      ["-", [any("-")]],
      ["--foo", [any("--foo")]],
      ["-école", [any("école", true)]],
      // A prototype property is not a reserved field.
      ["constructor:2026", [any("constructor:2026")]],
      ["toString:x", [any("toString:x")]],
      ["10", [any("10")]],
      ["OR", [any("OR")]],
    ])("%j", (input, expected) => {
      expect(shapes(input)).toEqual(expected);
    });

    it("keeps an empty phrase for the echo and marks it empty", () => {
      expect(shapes('""')).toEqual([{ ...any(""), ignored: "empty" }]);
    });

    it("records each term as typed, negation included", () => {
      const raws = parseTransactionSearch('-cat:gas "a b" #10', EN).terms.map(
        (t) => t.raw,
      );
      expect(raws).toEqual(["-cat:gas", '"a b"', "#10"]);
    });
  });

  describe("the # shorthand", () => {
    it.each<[string, Shape[]]>([
      ["#10", [{ field: "ref", op: "exact", value: "10", negated: false }]],
      ["-#10", [{ field: "ref", op: "exact", value: "10", negated: true }]],
      ["#10*", [{ field: "ref", op: "glob", value: "10*", negated: false }]],
      [
        '#"A 10"',
        [{ field: "ref", op: "exact", value: "A 10", negated: false }],
      ],
      ["#", [any("#")]],
      ["# 10", [any("#"), any("10")]],
      [
        '#""',
        [
          {
            field: "ref",
            op: "contains",
            value: "",
            negated: false,
            ignored: "empty",
          },
        ],
      ],
    ])("%j", (input, expected) => {
      expect(shapes(input)).toEqual(expected);
    });
  });

  describe("text fields (plan sections 4.2 and 4.3)", () => {
    it.each<[string, Shape[]]>([
      [
        "ref:10",
        [{ field: "ref", op: "contains", value: "10", negated: false }],
      ],
      ["ref:=10", [{ field: "ref", op: "exact", value: "10", negated: false }]],
      ["ref:10*", [{ field: "ref", op: "glob", value: "10*", negated: false }]],
      [
        "ref:=10*",
        [{ field: "ref", op: "glob", value: "10*", negated: false }],
      ],
      [
        "payee:*hydro",
        [{ field: "payee", op: "glob", value: "*hydro", negated: false }],
      ],
      [
        'payee:="Costco Gas Bar"',
        [
          {
            field: "payee",
            op: "exact",
            value: "Costco Gas Bar",
            negated: false,
          },
        ],
      ],
      [
        'payee:"costco gas"',
        [
          {
            field: "payee",
            op: "contains",
            value: "costco gas",
            negated: false,
          },
        ],
      ],
      [
        "memo:rent",
        [{ field: "memo", op: "contains", value: "rent", negated: false }],
      ],
      [
        "desc:rent",
        [{ field: "memo", op: "contains", value: "rent", negated: false }],
      ],
      [
        "cat:gas",
        [{ field: "cat", op: "contains", value: "gas", negated: false }],
      ],
      [
        "category:gas",
        [{ field: "cat", op: "contains", value: "gas", negated: false }],
      ],
      [
        "CAT:Gas",
        [{ field: "cat", op: "contains", value: "Gas", negated: false }],
      ],
      [
        "-cat:gas",
        [{ field: "cat", op: "contains", value: "gas", negated: true }],
      ],
      [
        "tag:country:usa",
        [
          {
            field: "tag",
            op: "contains",
            value: "country:usa",
            negated: false,
          },
        ],
      ],
      [
        "account:chequing",
        [
          {
            field: "account",
            op: "contains",
            value: "chequing",
            negated: false,
          },
        ],
      ],
      ["ref:>10", [malformed("ref:>10")]],
      ["-payee:<=x", [malformed("payee:<=x", true)]],
    ])("%j", (input, expected) => {
      expect(shapes(input)).toEqual(expected);
    });

    it("keeps an unknown qualifier as a plain term, so tag key:value still matches", () => {
      expect(shapes("country:usa")).toEqual([any("country:usa")]);
    });

    it("quoting a reserved name makes it literal text", () => {
      expect(shapes('"payee:x"')).toEqual([any("payee:x")]);
    });

    it.each([
      "ref:",
      "ref:=",
      'ref:""',
      "payee:",
      "amount:",
      "date:",
      "status:",
    ])("%j is dropped and marked empty", (input) => {
      const [term] = parseTransactionSearch(input, EN).terms;
      expect(term.ignored).toBe("empty");
      expect(term.value).toBe("");
    });
  });

  describe("enum fields", () => {
    it.each<[string, Shape[]]>([
      [
        "status:cleared",
        [{ field: "status", op: "eq", value: "cleared", negated: false }],
      ],
      [
        "status:=VOID",
        [{ field: "status", op: "eq", value: "void", negated: false }],
      ],
      [
        "-status:reconciled",
        [{ field: "status", op: "eq", value: "reconciled", negated: true }],
      ],
      [
        "status:unreconciled",
        [{ field: "status", op: "eq", value: "unreconciled", negated: false }],
      ],
      [
        "is:transfer",
        [{ field: "is", op: "eq", value: "transfer", negated: false }],
      ],
      ["is:split", [{ field: "is", op: "eq", value: "split", negated: false }]],
      [
        "is:uncategorized",
        [{ field: "is", op: "eq", value: "uncategorized", negated: false }],
      ],
      [
        "is:provisional",
        [{ field: "is", op: "eq", value: "provisional", negated: false }],
      ],
      [
        "-is:provisional",
        [{ field: "is", op: "eq", value: "provisional", negated: true }],
      ],
      [
        "has:attachment",
        [{ field: "has", op: "eq", value: "attachment", negated: false }],
      ],
      [
        "has:warranty",
        [{ field: "has", op: "eq", value: "warranty", negated: false }],
      ],
      ["has:ref", [{ field: "has", op: "eq", value: "ref", negated: false }]],
      ["has:memo", [{ field: "has", op: "eq", value: "memo", negated: false }]],
      ["has:tag", [{ field: "has", op: "eq", value: "tag", negated: false }]],
      ["status:pending", [malformed("status:pending")]],
      ["is:clear*", [malformed("is:clear*")]],
      ["has:>ref", [malformed("has:>ref")]],
    ])("%j", (input, expected) => {
      expect(shapes(input)).toEqual(expected);
    });
  });

  describe("amount (plan section 7, decision 8)", () => {
    it.each<[string, Shape[]]>([
      [
        "amount:12.34",
        [{ field: "amount", op: "eq", value: "12.34", negated: false }],
      ],
      [
        "amount:=12.34",
        [{ field: "amount", op: "eq", value: "12.34", negated: false }],
      ],
      [
        "amount:-12.34",
        [{ field: "amount", op: "eq", value: "12.34", negated: false }],
      ],
      [
        "amount:1,234.50",
        [{ field: "amount", op: "eq", value: "1234.5", negated: false }],
      ],
      [
        "amount:>100",
        [{ field: "amount", op: "gt", value: "100", negated: false }],
      ],
      [
        "amount:>=100",
        [{ field: "amount", op: "gte", value: "100", negated: false }],
      ],
      [
        "amount:<100",
        [{ field: "amount", op: "lt", value: "100", negated: false }],
      ],
      [
        "amount:<=100",
        [{ field: "amount", op: "lte", value: "100", negated: false }],
      ],
      [
        "amount:50..100",
        [
          {
            field: "amount",
            op: "between",
            value: "50",
            valueTo: "100",
            negated: false,
          },
        ],
      ],
      [
        "amount:50..",
        [{ field: "amount", op: "gte", value: "50", negated: false }],
      ],
      [
        "amount:..100",
        [{ field: "amount", op: "lte", value: "100", negated: false }],
      ],
      [
        'amount:"1 234.50"',
        [{ field: "amount", op: "eq", value: "1234.5", negated: false }],
      ],
      ["amount:abc", [malformed("amount:abc")]],
      ["amount:>abc", [malformed("amount:>abc")]],
      ["amount:..", [malformed("amount:..")]],
      ["amount:100..50", [malformed("amount:100..50")]],
      [
        "amount:-100..-50",
        [
          {
            field: "amount",
            op: "between",
            value: "50",
            valueTo: "100",
            negated: false,
          },
        ],
      ],
      ["amount:>50..100", [malformed("amount:>50..100")]],
      ["amount:10*", [malformed("amount:10*")]],
    ])("%j", (input, expected) => {
      expect(shapes(input)).toEqual(expected);
    });

    it("reads the user's number format", () => {
      expect(shapes("amount:1.234,50", DE)).toEqual([
        { field: "amount", op: "eq", value: "1234.5", negated: false },
      ]);
      expect(shapes("amount:12,5..20", DE)).toEqual([
        {
          field: "amount",
          op: "between",
          value: "12.5",
          valueTo: "20",
          negated: false,
        },
      ]);
    });
  });

  describe("date (plan section 7)", () => {
    it.each<[string, Shape[]]>([
      [
        "date:2026-03-15",
        [{ field: "date", op: "eq", value: "2026-03-15", negated: false }],
      ],
      [
        "date:2026-03",
        [
          {
            field: "date",
            op: "between",
            value: "2026-03-01",
            valueTo: "2026-03-31",
            negated: false,
          },
        ],
      ],
      [
        "date:2024-2",
        [
          {
            field: "date",
            op: "between",
            value: "2024-02-01",
            valueTo: "2024-02-29",
            negated: false,
          },
        ],
      ],
      [
        "date:2026",
        [
          {
            field: "date",
            op: "between",
            value: "2026-01-01",
            valueTo: "2026-12-31",
            negated: false,
          },
        ],
      ],
      [
        "date:>=2026-03",
        [{ field: "date", op: "gte", value: "2026-03-01", negated: false }],
      ],
      [
        "date:>2026-03",
        [{ field: "date", op: "gt", value: "2026-03-31", negated: false }],
      ],
      [
        "date:<2026-03",
        [{ field: "date", op: "lt", value: "2026-03-01", negated: false }],
      ],
      [
        "date:<=2026-03",
        [{ field: "date", op: "lte", value: "2026-03-31", negated: false }],
      ],
      [
        "date:2026-01..2026-03",
        [
          {
            field: "date",
            op: "between",
            value: "2026-01-01",
            valueTo: "2026-03-31",
            negated: false,
          },
        ],
      ],
      [
        "date:2026..",
        [{ field: "date", op: "gte", value: "2026-01-01", negated: false }],
      ],
      [
        "date:..2026-03",
        [{ field: "date", op: "lte", value: "2026-03-31", negated: false }],
      ],
      ["date:2026-13", [malformed("date:2026-13")]],
      ["date:2026-02-30", [malformed("date:2026-02-30")]],
      ["date:2026-03..2026-01", [malformed("date:2026-03..2026-01")]],
      ["date:yesterday", [malformed("date:yesterday")]],
    ])("%j", (input, expected) => {
      expect(shapes(input)).toEqual(expected);
    });

    it("reads a full date in the user's format", () => {
      expect(shapes("date:15.03.2026", DE)).toEqual([
        { field: "date", op: "eq", value: "2026-03-15", negated: false },
      ]);
    });

    it("refuses a partial date in the user's own format as ambiguous", () => {
      expect(shapes("date:03.2026", DE)).toEqual([malformed("date:03.2026")]);
    });
  });

  describe("bare-term interpretation", () => {
    it("carries the amount and date reading a bare term has always had", () => {
      const [amount, date, word] = parseTransactionSearch(
        "12.34 2026-03-15 groceries",
        EN,
      ).terms;
      expect(amount.interpreted).toEqual({ amount: 12.34, date: null });
      expect(date.interpreted).toEqual({ amount: null, date: "2026-03-15" });
      expect(word.interpreted).toEqual({ amount: null, date: null });
    });

    it("keeps a no-break or narrow no-break space inside one term", () => {
      // fr-FR formats 1234,56 as "1\u202f234,56"; a pasted figure stays one
      // term and reads as one amount.
      for (const pasted of ["1\u202f234,56", "1\u00a0234,56"]) {
        const { terms } = parseTransactionSearch(pasted, EN);
        expect(terms).toHaveLength(1);
        expect(terms[0].interpreted?.amount).toBe(1234.56);
      }
    });

    it("reads a quoted amount with a space group separator as one amount", () => {
      const [term] = parseTransactionSearch('"1 234,56"', EN).terms;
      expect(term.interpreted?.amount).toBe(1234.56);
    });

    it("gives qualified terms no interpretation", () => {
      const [term] = parseTransactionSearch("ref:10", EN).terms;
      expect(term.interpreted).toBeUndefined();
    });
  });

  describe("limits", () => {
    it(`accepts ${MAX_SEARCH_TERMS} terms`, () => {
      const input = Array.from(
        { length: MAX_SEARCH_TERMS },
        (_, i) => `w${i}`,
      ).join(" ");
      expect(parseTransactionSearch(input, EN).terms).toHaveLength(
        MAX_SEARCH_TERMS,
      );
    });

    it(`refuses ${MAX_SEARCH_TERMS + 1} terms with a 400`, () => {
      const input = Array.from(
        { length: MAX_SEARCH_TERMS + 1 },
        (_, i) => `w${i}`,
      ).join(" ");
      expect(() => parseTransactionSearch(input, EN)).toThrow(
        BadRequestException,
      );
    });

    it(`cuts the input at ${MAX_SEARCH_LENGTH} characters before reading it`, () => {
      const [term] = parseTransactionSearch(
        "x".repeat(MAX_SEARCH_LENGTH + 50),
        EN,
      ).terms;
      expect(term.value).toHaveLength(MAX_SEARCH_LENGTH);
    });

    it("counts terms after the cut", () => {
      // 13 terms, but the 13th starts past the cut.
      const input = `${"a ".repeat(12)}${" ".repeat(MAX_SEARCH_LENGTH)}b`;
      expect(parseTransactionSearch(input, EN).terms).toHaveLength(12);
    });

    it("tolerates a null input", () => {
      expect(
        parseTransactionSearch(null as unknown as string, EN).terms,
      ).toEqual([]);
    });
  });
});
