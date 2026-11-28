import {
  QuickAddParseInput,
  QuickAddReading,
  readQuickAddText,
} from "./quick-add-parse.util";
import type { CategoryType } from "../../categories/category-type.util";
import { resolveQuickAddVocabulary } from "./quick-add-vocabulary";
import {
  QuickAddCandidateAccount,
  QuickAddCandidateCategory,
  QuickAddCandidatePayee,
} from "./quick-add.types";

/** A Friday. */
const TODAY = "2026-11-20";

const account = (
  id: string,
  name: string,
  currencyCode = "CAD",
): QuickAddCandidateAccount => ({ id, name, currencyCode, currentBalance: 0 });
const payee = (
  id: string,
  name: string,
  aliases: string[] = [],
): QuickAddCandidatePayee => ({ id, name, defaultCategoryId: null, aliases });
const category = (
  id: string,
  name: string,
  path = name,
  categoryType: CategoryType = "expense",
): QuickAddCandidateCategory => ({ id, name, path, categoryType });

const ACCOUNTS = [
  account("acc-chq", "Chequing"),
  account("acc-sav", "Savings"),
  account("acc-amex", "Amex"),
  account("acc-yen", "財布", "JPY"),
  account("acc-futsu", "普通預金", "JPY"),
  account("acc-chokin", "貯金", "JPY"),
  account("acc-ahorros", "Ahorros"),
];
const PAYEES = [
  payee("p-loblaws", "Loblaws"),
  payee("p-711", "7-Eleven"),
  payee("p-tim", "Tim Hortons"),
  payee("p-timbuktu", "Timbuktu Cafe"),
  payee("p-sbux", "Starbucks", ["SBUX*"]),
  payee("p-milano", "Café Milano"),
  payee("p-lawson", "ローソン"),
  payee("p-amex", "Amex"),
];
const CATEGORIES = [
  category("c-food", "Food"),
  category("c-groc", "Groceries", "Food: Groceries"),
  category("c-salary", "Salary", "Salary", "income"),
];

function read(
  text: string,
  over: Partial<QuickAddParseInput> = {},
): QuickAddReading {
  const locale = over.locale ?? "en";
  return readQuickAddText({
    text,
    today: TODAY,
    locale,
    numberFormat: "en-US",
    dateFormat: "YYYY-MM-DD",
    vocabulary: resolveQuickAddVocabulary(locale),
    accounts: ACCOUNTS,
    payees: PAYEES,
    categories: CATEGORIES,
    heldCurrencies: [
      { code: "CAD", symbol: "$" },
      { code: "JPY", symbol: "¥" },
    ],
    ...over,
  });
}

const ids = (items: ReadonlyArray<{ id: string }> | undefined) =>
  (items ?? []).map((item) => item.id);

describe("readQuickAddText", () => {
  describe("the plan's observed examples", () => {
    it("reads 84.37 loblaws groceries as amount, payee and category", () => {
      const r = read("84.37 loblaws groceries");
      expect(r.amount).toEqual({
        value: 84.37,
        sign: null,
        currency: null,
        places: 2,
      });
      expect(ids(r.payee?.candidates)).toEqual(["p-loblaws"]);
      expect(r.payee?.partial).toBe(false);
      expect(ids(r.category?.candidates)).toEqual(["c-groc"]);
      expect(r.kind).toBeNull();
      expect(r.date).toBeNull();
      expect(r.accounts).toEqual([]);
      expect(r.leftover).toBeNull();
    });

    it("reads 84.37 loblaws with no category, for the history to fill", () => {
      const r = read("84.37 loblaws");
      expect(ids(r.payee?.candidates)).toEqual(["p-loblaws"]);
      expect(r.category).toBeNull();
    });

    it("reads 500 chequing to savings as two accounts, the second to", () => {
      const r = read("500 chequing to savings");
      expect(r.amount?.value).toBe(500);
      expect(r.accounts.map((m) => [ids(m.candidates), m.direction])).toEqual([
        [["acc-chq"], null],
        [["acc-sav"], "to"],
      ]);
      expect(r.leftover).toBeNull();
    });

    it("reports the euro sign of 20 € cafe as the currency typed", () => {
      const r = read("20 € cafe");
      expect(r.amount?.value).toBe(20);
      expect(r.amount?.currency).toEqual({ text: "€", codes: ["EUR"] });
    });

    it("reads a German 12,50 bäckerei gestern as 12.50 yesterday", () => {
      const r = read("12,50 bäckerei gestern", {
        locale: "de",
        numberFormat: "de-DE",
        dateFormat: "DD.MM.YYYY",
      });
      expect(r.amount?.value).toBe(12.5);
      expect(r.date).toBe("2026-11-19");
      expect(r.leftover).toBe("bäckerei");
    });
  });

  describe("names", () => {
    it("finds a payee in Japanese text with no spaces (ローソンで500円)", () => {
      const r = read("ローソンで500円", { locale: "ja" });
      expect(ids(r.payee?.candidates)).toEqual(["p-lawson"]);
      expect(r.amount?.value).toBe(500);
      expect(r.amount?.currency?.codes).toEqual(["JPY"]);
      expect(r.leftover).toBeNull();
    });

    it("reads a payee holding digits as the payee, not the amount", () => {
      const r = read("7-eleven 12.50");
      expect(ids(r.payee?.candidates)).toEqual(["p-711"]);
      expect(r.amount?.value).toBe(12.5);
    });

    it("does not read a number inside an unknown word as the amount", () => {
      const r = read("7-eleven 12.50", { payees: [] });
      expect(r.amount?.value).toBe(12.5);
      expect(r.leftover).toBe("7-eleven");
    });

    it("folds diacritics for comparison only (cafe finds Café Milano)", () => {
      const r = read("4 cafe milano");
      expect(ids(r.payee?.candidates)).toEqual(["p-milano"]);
      expect(r.payee?.partial).toBe(false);
    });

    it("matches a name only on word boundaries in a spaced script", () => {
      const r = read("12 amexico", { payees: [] });
      expect(r.accounts).toEqual([]);
      expect(r.leftover).toBe("amexico");
    });

    it("matches an alias glob against whole words (SBUX*)", () => {
      const r = read("5.25 sbuxstore");
      expect(ids(r.payee?.candidates)).toEqual(["p-sbux"]);
      expect(r.leftover).toBeNull();
    });

    it("takes the smallest run of words an alias glob matches", () => {
      const r = read("5.25 sbux latte");
      expect(ids(r.payee?.candidates)).toEqual(["p-sbux"]);
      expect(r.leftover).toBe("latte");
    });

    it("reads the category path as well as the leaf", () => {
      const r = read("12 food: groceries");
      expect(ids(r.category?.candidates)).toEqual(["c-groc"]);
    });
  });

  describe("an account name that is also a payee name", () => {
    it("is the payee without a connector, the account offered instead", () => {
      const r = read("50 amex");
      expect(ids(r.payee?.candidates)).toEqual(["p-amex"]);
      expect(r.accounts).toEqual([]);
      expect(ids(r.accountAlternatives)).toEqual(["acc-amex"]);
    });

    it("is the account right after a connector, the payee offered instead", () => {
      const r = read("50 loblaws on amex");
      expect(r.accounts.map((m) => [ids(m.candidates), m.direction])).toEqual([
        [["acc-amex"], "on"],
      ]);
      expect(ids(r.payee?.candidates)).toEqual(["p-loblaws"]);
      expect(ids(r.payeeAlternatives)).toEqual(["p-amex"]);
      expect(r.leftover).toBeNull();
    });
  });

  describe("partial payee matches", () => {
    it("offers every payee a typed word of three letters starts", () => {
      const r = read("12 tim");
      expect(r.payee?.partial).toBe(true);
      expect(ids(r.payee?.candidates).sort()).toEqual(["p-tim", "p-timbuktu"]);
      expect(r.leftover).toBeNull();
    });

    it("extends the run while it still starts a name", () => {
      const r = read("12 tim hor coffee");
      expect(ids(r.payee?.candidates)).toEqual(["p-tim"]);
      expect(r.leftover).toBe("coffee");
    });

    it("never starts from fewer than three characters", () => {
      const r = read("12 ti");
      expect(r.payee).toBeNull();
      expect(r.leftover).toBe("ti");
    });

    it("keeps the words it took out of the leftover, whatever the pins say", () => {
      // A pinned payee replaces these words in the fill; the reader does not
      // know about pins, so they never fall through to the memo.
      const r = read("12 tim weekly");
      expect(ids(r.payee?.candidates).sort()).toEqual(["p-tim", "p-timbuktu"]);
      expect(r.leftover).toBe("weekly");
    });
  });

  describe("names typed without their punctuation", () => {
    const withZehrs = {
      payees: [...PAYEES, payee("p-zehrs", "Zehr’s Supermarket")],
      categories: [...CATEGORIES, category("c-kids", "Kid's Stuff")],
    };

    it("reads a whole payee name typed without its apostrophe", () => {
      const r = read("45.20 zehrs supermarket", withZehrs);
      expect(ids(r.payee?.candidates)).toEqual(["p-zehrs"]);
      expect(r.payee?.partial).toBe(false);
      expect(r.amount?.value).toBe(45.2);
      expect(r.leftover).toBeNull();
    });

    it("still reads the name typed with its apostrophe", () => {
      const r = read("45.20 zehr's supermarket", withZehrs);
      expect(ids(r.payee?.candidates)).toEqual(["p-zehrs"]);
      expect(r.payee?.partial).toBe(false);
    });

    it("infers the payee from its first word typed without the apostrophe", () => {
      const r = read("45.20 zehrs", withZehrs);
      expect(ids(r.payee?.candidates)).toEqual(["p-zehrs"]);
      expect(r.payee?.partial).toBe(true);
      expect(r.leftover).toBeNull();
    });

    it("reads a hyphenated payee and a category typed without punctuation", () => {
      const r = read("5 7eleven kids stuff", withZehrs);
      expect(ids(r.payee?.candidates)).toEqual(["p-711"]);
      expect(ids(r.category?.candidates)).toEqual(["c-kids"]);
    });
  });

  describe("dates", () => {
    it.each([
      ["2026-11-03", "2026-11-03"],
      ["yesterday", "2026-11-19"],
      ["today", "2026-11-20"],
      ["tomorrow", "2026-11-21"],
      // A weekday is the most recent one on or before today, today included.
      ["monday", "2026-11-16"],
      ["friday", "2026-11-20"],
      ["sat", "2026-11-14"],
      ["3 nov", "2026-11-03"],
      ["nov 3", "2026-11-03"],
      ["nov. 3", "2026-11-03"],
      ["3rd november", "2026-11-03"],
      // Up to seven days ahead stays this year; further is last year's.
      ["27 nov", "2026-11-27"],
      ["28 nov", "2025-11-28"],
      ["3 dec", "2025-12-03"],
      ["3 nov 2024", "2024-11-03"],
    ])("reads %s as %s", (word, date) => {
      const r = read(`12 coffee ${word}`);
      expect(r.date).toBe(date);
      expect(r.amount?.value).toBe(12);
      expect(r.leftover).toBe("coffee");
    });

    describe("a month name between two numbers, and a month name's only number", () => {
      it.each([
        // ISO and en-US formats put the month first: `nov 3` is the date.
        ["20 nov 3 coffee", "YYYY-MM-DD", "2026-11-03", 20, "coffee"],
        ["12 dec 25 gifts", "YYYY-MM-DD", "2025-12-25", 12, "gifts"],
        ["20 nov 3 coffee", "MM/DD/YYYY", "2026-11-03", 20, "coffee"],
        // A DD/MM reader writes the day first: `20 nov` is the date.
        ["20 nov 3 coffee", "DD/MM/YYYY", "2026-11-20", 3, "coffee"],
        ["12 dec 25 gifts", "DD.MM.YYYY", "2025-12-12", 25, "gifts"],
        // Only one side is a real day: it is the date, the other the amount.
        ["45 nov 3 coffee", "YYYY-MM-DD", "2026-11-03", 45, "coffee"],
        ["35 dec 24 gifts", "YYYY-MM-DD", "2025-12-24", 35, "gifts"],
        ["45 nov 3 coffee", "DD/MM/YYYY", "2026-11-03", 45, "coffee"],
        ["3 nov 45 coffee", "YYYY-MM-DD", "2026-11-03", 45, "coffee"],
      ])(
        "reads %s (%s) as %s, amount %d",
        (text, dateFormat, date, amount, rest) => {
          const r = read(text, { dateFormat });
          expect(r.date).toBe(date);
          expect(r.amount?.value).toBe(amount);
          expect(r.leftover).toBe(rest);
        },
      );

      it.each([
        ["20 may flowers", 20, "may flowers"],
        ["12 mar bakery", 12, "mar bakery"],
        ["nov 3 coffee", 3, "nov coffee"],
      ])(
        "reads %s as amount %d with no date: a month name's only number",
        (text, amount, rest) => {
          const r = read(text);
          expect(r.date).toBeNull();
          expect(r.amount?.value).toBe(amount);
          expect(r.leftover).toBe(rest);
        },
      );

      it.each([
        // A day beside a month and a year is a date, never the amount, whichever
        // side of the month the day is on.
        ["loblaws nov 3, 2025", "2025-11-03", null, null],
        ["coffee 3 nov 2024", "2024-11-03", null, "coffee"],
        ["20 may 2026 flowers", "2026-05-20", null, "flowers"],
        // The line's other number is the amount.
        ["loblaws nov 3, 2025 45", "2025-11-03", 45, null],
        ["12 coffee 3 nov 2024", "2024-11-03", 12, "coffee"],
      ])(
        "reads %s as dated %s, amount %p: a month-name date with a year",
        (text, date, amount, rest) => {
          const r = read(text);
          expect(r.date).toBe(date);
          expect(r.amount?.value ?? null).toBe(amount);
          expect(r.leftover).toBe(rest);
        },
      );

      it("keeps the date when its only number cannot be an amount", () => {
        const r = read("coffee 3rd nov");
        expect(r.date).toBe("2026-11-03");
        expect(r.amount).toBeNull();
      });

      it("falls back to the locale's order for a format without both fields", () => {
        expect(
          read("20 nov 3 kaffee", { locale: "de", dateFormat: "YYYY" }).date,
        ).toBe("2026-11-20");
        expect(read("20 nov 3 coffee", { dateFormat: "YYYY" }).date).toBe(
          "2026-11-03",
        );
      });
    });

    it("reads a day and month in the date format's order", () => {
      expect(read("12 3/11", { dateFormat: "DD/MM/YYYY" }).date).toBe(
        "2026-11-03",
      );
      expect(read("12 11/3", { dateFormat: "MM/DD/YYYY" }).date).toBe(
        "2026-11-03",
      );
      expect(read("12 03/11/2026", { dateFormat: "DD/MM/YYYY" }).date).toBe(
        "2026-11-03",
      );
    });

    it("never reads a decimal amount as a day and month", () => {
      const r = read("3.11 coffee", { dateFormat: "MM/DD/YYYY" });
      expect(r.date).toBeNull();
      expect(r.amount?.value).toBe(3.11);
    });

    it("reads month names in the reader's language and in English", () => {
      const es = {
        locale: "es",
        numberFormat: "es-ES",
        dateFormat: "DD/MM/YYYY",
      };
      expect(read("12 café 3 de noviembre", es).date).toBe("2026-11-03");
      expect(read("12 café 3 nov", es).date).toBe("2026-11-03");
      expect(read("12 кофе 3 ноября", { locale: "ru" }).date).toBe(
        "2026-11-03",
      );
    });

    it("reads a Japanese month and day", () => {
      expect(read("ローソン11月3日500円", { locale: "ja" }).date).toBe(
        "2026-11-03",
      );
    });
  });

  describe("amounts", () => {
    it("takes the first remaining number", () => {
      const r = read("2 coffees 8.50");
      expect(r.amount?.value).toBe(2);
      expect(r.leftover).toBe("coffees 8.50");
    });

    it("marks a + as a deposit and a - as a payment", () => {
      expect(read("+20 loblaws").kind).toBe("deposit");
      expect(read("+20 loblaws").amount?.sign).toBe("+");
      expect(read("-20 loblaws").kind).toBe("payment");
      expect(read("-$20 loblaws").amount).toEqual({
        value: 20,
        sign: "-",
        currency: { text: "$", codes: expect.arrayContaining(["CAD", "USD"]) },
        places: 0,
      });
    });

    it("reads grouped thousands in the reader's convention", () => {
      expect(read("1,234.56 rent").amount?.value).toBe(1234.56);
      expect(
        read("1.234,56 miete", { locale: "de", numberFormat: "de-DE" }).amount
          ?.value,
      ).toBe(1234.56);
      expect(
        read("1 234,50 loyer", { locale: "fr", numberFormat: "fr-FR" }).amount
          ?.value,
      ).toBe(1234.5);
    });

    it("keeps every place typed, for the precision check", () => {
      expect(read("12.34567 loblaws").amount?.value).toBe(12.34567);
      expect(read("12.34567 loblaws").amount?.places).toBe(5);
      // Past the column scale the value is rounded, the places still told.
      expect(read("0.000123456 loblaws").amount).toMatchObject({
        value: 0.00012346,
        places: 9,
      });
      expect(
        read("12,55 miete", { numberFormat: "de-DE" }).amount?.places,
      ).toBe(2);
      expect(read("1,234 rent").amount).toMatchObject({
        value: 1234,
        places: 0,
      });
      expect(read("12.500 rent").amount?.places).toBe(1);
    });

    it("reports a currency written apart, before or after", () => {
      expect(read("20 EUR loblaws").amount?.currency?.codes).toEqual(["EUR"]);
      expect(read("EUR 20 loblaws").amount?.currency?.codes).toEqual(["EUR"]);
      expect(read("20 cad loblaws").amount?.currency?.codes).toEqual(["CAD"]);
      expect(read("20$ loblaws").amount?.currency?.codes).toContain("CAD");
    });

    it("does not read a lower-case word as a currency the reader holds none of", () => {
      const r = read("20 top ramen");
      expect(r.amount?.currency).toBeNull();
      expect(r.leftover).toBe("top ramen");
    });
  });

  describe("keywords", () => {
    it("sets the kind from a deposit or transfer word", () => {
      expect(read("20 refund loblaws").kind).toBe("deposit");
      expect(read("paid 20 loblaws").kind).toBe("payment");
      expect(read("transfer 500 savings").kind).toBe("transfer");
    });

    it("prefers a transfer word to the sign", () => {
      expect(read("-500 transfer to savings").kind).toBe("transfer");
    });

    it("reads 500 to savings as one account on the to side", () => {
      const r = read("500 to savings");
      expect(r.accounts.map((m) => [ids(m.candidates), m.direction])).toEqual([
        [["acc-sav"], "to"],
      ]);
      expect(r.leftover).toBeNull();
    });

    it("reads from on the from side", () => {
      const r = read("500 from savings");
      expect(r.accounts[0].direction).toBe("from");
    });

    it("drops connector and filler words from the leftover", () => {
      expect(read("12 for the corner store").leftover).toBe("corner store");
    });

    it("reads a Spanish connector in the Spanish sense (a is to)", () => {
      const r = read("500 a ahorros", { locale: "es" });
      expect(r.accounts[0].direction).toBe("to");
    });

    it("reads Japanese connectors after the account (から, へ)", () => {
      const r = read("普通預金から貯金へ500", { locale: "ja" });
      expect(r.accounts.map((m) => [ids(m.candidates), m.direction])).toEqual([
        [["acc-futsu"], "from"],
        [["acc-chokin"], "to"],
      ]);
      expect(r.amount?.value).toBe(500);
      expect(r.leftover).toBeNull();
    });
  });

  describe("leftover words", () => {
    it("are the words nothing used, in typed order", () => {
      const r = read("84.37 loblaws weekly shop");
      expect(ids(r.payee?.candidates)).toEqual(["p-loblaws"]);
      expect(r.leftover).toBe("weekly shop");
    });

    it("keep the case they were typed in", () => {
      expect(read("12 Corner Store").leftover).toBe("Corner Store");
    });

    it("are null for an empty line", () => {
      const r = read("");
      expect(r).toEqual({
        kind: null,
        amount: null,
        date: null,
        accounts: [],
        accountAlternatives: [],
        payee: null,
        payeeAlternatives: [],
        category: null,
        categoryAlternatives: [],
        leftover: null,
      });
    });

    it("read a 200-character line", () => {
      const text = `12.50 ${"word ".repeat(39)}end`.slice(0, 200);
      expect(text).toHaveLength(200);
      const r = read(text);
      expect(r.amount?.value).toBe(12.5);
      expect(r.leftover?.startsWith("word word")).toBe(true);
    });
  });
});
