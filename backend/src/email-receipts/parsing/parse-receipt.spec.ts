import { normalizeReceiptLines, parseReceipt } from "./parse-receipt";
import {
  MAX_ITEMS,
  MAX_LINE_LENGTH,
  MAX_PARSE_LINES,
  ParsedReceiptReason,
  ReceiptParserDefinition,
} from "./receipt-parser.types";

const CAT_CABLE = "11111111-1111-4111-8111-111111111111";
const CAT_CASE = "22222222-2222-4222-8222-222222222222";
const CAT_DEFAULT = "33333333-3333-4333-8333-333333333333";
const CAT_SHIPPING = "44444444-4444-4444-8444-444444444444";
const CAT_PAYEE = "55555555-5555-4555-8555-555555555555";

// A glob capture stops at the first occurrence of the literal after it, so an
// item pattern needs a delimiter that the name never contains: here " $".
const DEFINITION: ReceiptParserDefinition = {
  version: 1,
  orderId: ["*order #{orderid}", "Order number: {orderid}"],
  total: ["Order total: ${amount}"],
  shipping: ["Shipping: ${amount}"],
  discount: ["Discount: ${amount}"],
  items: {
    startAfter: "Items in your order",
    stopAt: "Subtotal",
    patterns: ["{qty} x {name} ${amount}", "{name} ${amount}"],
  },
  categoryRules: [
    { match: "*cable*", categoryId: CAT_CABLE },
    { match: "*case*", categoryId: CAT_CASE },
  ],
  defaultCategoryId: CAT_DEFAULT,
  shippingCategoryId: CAT_SHIPPING,
};

const RECEIPT = [
  "Thanks for shopping with Example Shop",
  "Confirmation of your order #EX-20931",
  "Items in your order",
  "2 x USB-C cable $19.98",
  "Phone case $15.00",
  "Subtotal $34.98",
  "Shipping: $4.99",
  "Discount: $2.00",
  "Order total: $37.97",
].join("\n");

const parse = (
  def: ReceiptParserDefinition,
  body: string,
  subject = "",
  fallback: string | null = null,
) => parseReceipt(def, subject, body, fallback);

describe("normalizeReceiptLines", () => {
  it("splits on LF and CRLF, collapses whitespace, trims and drops empty lines", () => {
    const text = "  one   two \r\n\r\n\t three\tfour\t\n   \nfive";
    expect(normalizeReceiptLines(text)).toEqual([
      "one two",
      "three four",
      "five",
    ]);
  });

  it("folds non-breaking spaces like any other whitespace", () => {
    expect(normalizeReceiptLines("a\xa0\xa0b\xa0")).toEqual(["a b"]);
  });

  it("cuts a line to 500 characters without a trailing space", () => {
    const long = `${"a".repeat(MAX_LINE_LENGTH - 1)} ${"b".repeat(50)}`;
    const [line] = normalizeReceiptLines(long);
    expect(line).toBe("a".repeat(MAX_LINE_LENGTH - 1));
    expect(normalizeReceiptLines("c".repeat(900))[0]).toHaveLength(
      MAX_LINE_LENGTH,
    );
  });

  it("keeps at most 2000 lines, counting only the non-empty ones", () => {
    const text = Array.from({ length: 5000 }, (_, i) =>
      i % 2 === 0 ? `line ${i}` : "",
    ).join("\n");
    const lines = normalizeReceiptLines(text);
    expect(lines).toHaveLength(MAX_PARSE_LINES);
    expect(lines[0]).toBe("line 0");
    expect(lines[MAX_PARSE_LINES - 1]).toBe(
      `line ${(MAX_PARSE_LINES - 1) * 2}`,
    );
  });

  it("returns nothing for empty or non-string input", () => {
    expect(normalizeReceiptLines("")).toEqual([]);
    expect(normalizeReceiptLines(" \n \r\n ")).toEqual([]);
    expect(normalizeReceiptLines(undefined as unknown as string)).toEqual([]);
  });
});

describe("parseReceipt: the spec section 5 receipt", () => {
  it("reads every field, and the receipt is complete", () => {
    const parsed = parse(DEFINITION, RECEIPT);
    expect(parsed).toEqual({
      orderId: "EX-20931",
      total: 379700,
      shipping: 49900,
      discount: 20000,
      items: [
        { name: "USB-C cable", qty: 2, amount: 199800, categoryId: CAT_CABLE },
        { name: "Phone case", qty: 1, amount: 150000, categoryId: CAT_CASE },
      ],
      shippingCategoryId: CAT_SHIPPING,
      discountCategoryId: CAT_DEFAULT,
      complete: true,
      reason: null,
    });
  });

  it("returns nothing but nulls for an empty definition", () => {
    expect(parse({ version: 1 }, RECEIPT)).toEqual({
      orderId: null,
      total: null,
      shipping: null,
      discount: null,
      items: [],
      shippingCategoryId: null,
      discountCategoryId: null,
      complete: false,
      reason: "no_total",
    });
  });

  it("does not throw on a non-string subject or body", () => {
    const parsed = parseReceipt(
      DEFINITION,
      undefined as unknown as string,
      undefined as unknown as string,
      null,
    );
    expect(parsed.complete).toBe(false);
    expect(parsed.orderId).toBeNull();
  });
});

describe("parseReceipt: the order id", () => {
  const def: ReceiptParserDefinition = {
    version: 1,
    orderId: ["Order number: {orderid}", "*order #{orderid}"],
  };

  it("prefers the subject over the body", () => {
    const parsed = parse(def, "Order number: BODY-1", "Your order #SUBJ-9");
    expect(parsed.orderId).toBe("SUBJ-9");
  });

  it("falls back to the body lines when the subject has none", () => {
    expect(parse(def, "hello\nOrder number: BODY-1", "Receipt").orderId).toBe(
      "BODY-1",
    );
  });

  it("takes the first matching line, then the first pattern on it", () => {
    const body = "Your order #LATE-2\nOrder number: FIRST-1\nOrder number: X";
    // Line one matches the second pattern; line two would match the first.
    expect(parse(def, body).orderId).toBe("LATE-2");
    expect(parse(def, "Order number: A1\nOrder number: B2").orderId).toBe("A1");
  });

  it("keeps only the first token of the capture (an order number has no spaces)", () => {
    const star: ReceiptParserDefinition = {
      version: 1,
      orderId: ["*order #{orderid}*"],
    };
    expect(parse(star, "Your order #12345 has shipped").orderId).toBe("12345");
    expect(parse(def, "Order number: AB-12 (web)").orderId).toBe("AB-12");
  });

  it("skips a match whose capture is empty", () => {
    const empty: ReceiptParserDefinition = {
      version: 1,
      orderId: ["Order #{orderid}", "Ref {orderid}"],
    };
    expect(parse(empty, "Order #\nRef REF-7").orderId).toBe("REF-7");
    expect(parse(empty, "Order #").orderId).toBeNull();
    expect(parse(def, "Order number:    ").orderId).toBeNull();
  });

  it("normalises the subject the way a line is", () => {
    expect(parse(def, "", "  Your   order\xa0#AB-12  ").orderId).toBe("AB-12");
  });

  it("is null without patterns or without a match", () => {
    expect(parse({ version: 1 }, "Order number: A1", "s").orderId).toBeNull();
    expect(parse(def, "nothing here", "nothing").orderId).toBeNull();
  });
});

describe("parseReceipt: total, shipping and discount", () => {
  const def: ReceiptParserDefinition = {
    version: 1,
    total: ["Grand total: ${amount}", "Total ${amount}"],
    shipping: ["Shipping: ${amount}"],
    discount: ["Discount: ${amount}"],
  };

  it("takes the first line that matches any pattern", () => {
    const body = "Total $10.00\nGrand total: $20.00";
    expect(parse(def, body).total).toBe(100000);
  });

  it("takes the first pattern on that line", () => {
    const both: ReceiptParserDefinition = {
      version: 1,
      total: ["Total: ${amount}", "*Total*${amount}"],
    };
    expect(parse(both, "Grand Total: $9.00").total).toBe(90000);
  });

  it("skips a line whose amount does not parse and keeps looking", () => {
    const body = "Grand total: soon\nGrand total: -$5.00\nGrand total: $7.25";
    expect(parse(def, body).total).toBe(72500);
  });

  it("keeps a zero amount (it is a value, not a missing one)", () => {
    const parsed = parse(def, "Shipping: $0.00\nTotal $1.00");
    expect(parsed.shipping).toBe(0);
    expect(parsed.total).toBe(10000);
  });

  it("is null when no line matches or there is no pattern", () => {
    const parsed = parse(def, "nothing to see");
    expect([parsed.total, parsed.shipping, parsed.discount]).toEqual([
      null,
      null,
      null,
    ]);
    expect(parse({ version: 1 }, "Total $1.00").total).toBeNull();
  });

  it("does not read a capture the pattern does not hold", () => {
    const odd: ReceiptParserDefinition = { version: 1, total: ["Total {x}"] };
    expect(parse(odd, "Total 5.00").total).toBeNull();
  });

  it("does not look past the 500 characters of a line", () => {
    const far = `Grand total: ${"x".repeat(MAX_LINE_LENGTH + 20)} $12.99`;
    expect(parse(def, far).total).toBeNull();
  });

  it("reads 2000 lines and no more", () => {
    const filler = Array.from(
      { length: MAX_PARSE_LINES - 1 },
      (_, i) => `f${i}`,
    );
    expect(parse(def, [...filler, "Total $1.00"].join("\n")).total).toBe(10000);
    expect(
      parse(def, [...filler, "f-last", "Total $1.00"].join("\n")).total,
    ).toBeNull();
  });
});

describe("parseReceipt: the item section", () => {
  const patterns = ["{name} ${amount}"];
  const body = [
    "Header $1.00",
    "Items in your order",
    "Alpha $2.00",
    "Beta $3.00",
    "SUBTOTAL $5.00",
    "Gamma $4.00",
    "Items in your order",
    "Delta $6.00",
  ].join("\n");
  const names = (def: ReceiptParserDefinition, text = body) =>
    parse(def, text).items.map((item) => item.name);

  it("reads the whole text without markers", () => {
    expect(names({ version: 1, items: { patterns } })).toEqual([
      "Header",
      "Alpha",
      "Beta",
      "SUBTOTAL",
      "Gamma",
      "Delta",
    ]);
  });

  it("starts on the line after the first startAfter line, case-insensitively", () => {
    const def: ReceiptParserDefinition = {
      version: 1,
      items: { startAfter: "ITEMS IN", patterns },
    };
    // The later repeat of the marker is a plain line and is read as an item.
    expect(names(def)).toEqual(["Alpha", "Beta", "SUBTOTAL", "Gamma", "Delta"]);
  });

  it("ends before the first stopAt line, case-insensitively", () => {
    const def: ReceiptParserDefinition = {
      version: 1,
      items: { stopAt: "subtotal", patterns },
    };
    expect(names(def)).toEqual(["Header", "Alpha", "Beta"]);
  });

  it("applies both bounds", () => {
    const def: ReceiptParserDefinition = {
      version: 1,
      items: {
        startAfter: "items in your order",
        stopAt: "Subtotal",
        patterns,
      },
    };
    expect(names(def)).toEqual(["Alpha", "Beta"]);
  });

  it("looks for stopAt only after the start", () => {
    const text = "Subtotal $9.00\nStart\nAlpha $1.00\nBeta $2.00";
    const def: ReceiptParserDefinition = {
      version: 1,
      items: { startAfter: "start", stopAt: "subtotal", patterns },
    };
    expect(names(def, text)).toEqual(["Alpha", "Beta"]);
  });

  it("reads nothing when startAfter never appears", () => {
    const def: ReceiptParserDefinition = {
      version: 1,
      items: { startAfter: "no such marker", patterns },
    };
    expect(names(def)).toEqual([]);
  });

  it("reads nothing when stopAt is on the line right after the start", () => {
    const def: ReceiptParserDefinition = {
      version: 1,
      items: { startAfter: "Start", stopAt: "Stop", patterns },
    };
    expect(names(def, "Start\nStop\nAlpha $1.00")).toEqual([]);
  });

  it("reads no items without an items definition", () => {
    expect(parse({ version: 1 }, body).items).toEqual([]);
  });
});

describe("parseReceipt: item lines", () => {
  const item = (patterns: string[], line: string) =>
    parse({ version: 1, items: { patterns } }, line).items;

  it("tries the patterns in order and takes the first that reads the line", () => {
    const patterns = ["{qty} x {name} ${amount}", "{name} ${amount}"];
    expect(item(patterns, "3 x Pen $6.00")).toEqual([
      { name: "Pen", qty: 3, amount: 60000, categoryId: null },
    ]);
    expect(item(patterns, "Pen $6.00")).toEqual([
      { name: "Pen", qty: 1, amount: 60000, categoryId: null },
    ]);
  });

  it("falls to the next pattern when a value of the first does not parse", () => {
    const patterns = ["{qty} x {name} ${amount}", "{name} ${amount}"];
    // "many" is not a quantity, so the first pattern does not read this line.
    expect(item(patterns, "many x Pen $6.00")).toEqual([
      { name: "many x Pen", qty: 1, amount: 60000, categoryId: null },
    ]);
    expect(
      item(["{name} ${amount}", "{name} EUR {amount}"], "Pen EUR 5"),
    ).toEqual([{ name: "Pen", qty: 1, amount: 50000, categoryId: null }]);
  });

  it("skips a line whose amount does not parse", () => {
    expect(item(["{name} ${amount}"], "Pen $free")).toEqual([]);
    expect(item(["{name} ${amount}"], "Pen $-3.00")).toEqual([]);
  });

  it("skips a line with an empty name", () => {
    expect(item(["{name}${amount}"], "$4.00")).toEqual([]);
  });

  it("multiplies price by qty in integer units", () => {
    expect(item(["{qty}x {name} @{price}"], "3x Pen @1.10")).toEqual([
      { name: "Pen", qty: 3, amount: 33000, categoryId: null },
    ]);
    // 0.1 * 3 is 0.30000000000000004 in floats; units are exact.
    expect(item(["{qty}x {name} @{price}"], "3x Pen @0.10")[0].amount).toBe(
      3000,
    );
  });

  it("defaults qty to 1 for a price without a qty capture", () => {
    expect(item(["{name} @{price}"], "Pen @2.50")[0]).toMatchObject({
      qty: 1,
      amount: 25000,
    });
  });

  it("keeps the amount capture as the line total when a qty is also captured", () => {
    expect(
      item(["{name} x{qty} = {amount}"], "Pen x3 = 9.00")[0],
    ).toMatchObject({
      qty: 3,
      amount: 90000,
    });
  });

  it("accepts a qty with a pcs or x suffix", () => {
    expect(
      item(["{qty} | {name} | {amount}"], "4 pcs | Pen | 8")[0],
    ).toMatchObject({
      qty: 4,
      amount: 80000,
    });
  });

  it("skips a line whose price times qty is not a safe integer", () => {
    expect(
      item(["{qty}x {name} @{price}"], "9999x Gold bar @500000000000"),
    ).toEqual([]);
  });

  it("skips a pattern that captures neither amount nor price", () => {
    expect(item(["{name}"], "Pen")).toEqual([]);
  });

  it("skips a line that matches no pattern", () => {
    expect(item(["{name} ${amount}"], "just words")).toEqual([]);
  });

  it("keeps at most 100 items", () => {
    const lines = Array.from(
      { length: MAX_ITEMS + 50 },
      (_, i) => `Item${i} $1.00`,
    );
    const parsed = parse(
      { version: 1, items: { patterns: ["{name} ${amount}"] } },
      lines.join("\n"),
    );
    expect(parsed.items).toHaveLength(MAX_ITEMS);
    expect(parsed.items[MAX_ITEMS - 1].name).toBe(`Item${MAX_ITEMS - 1}`);
  });

  it("does not read past the 500 characters of an item line", () => {
    const name = "n".repeat(MAX_LINE_LENGTH + 20);
    const parsed = parse(
      { version: 1, items: { patterns: ["{name} ${amount}"] } },
      `${name} $1.00`,
    );
    expect(parsed.items).toEqual([]);
  });
});

describe("parseReceipt: item categories", () => {
  const base: ReceiptParserDefinition = {
    version: 1,
    items: { patterns: ["{name} ${amount}"] },
    categoryRules: [
      { match: "*cable*", categoryId: CAT_CABLE },
      { match: "*usb*", categoryId: CAT_CASE },
      { match: "Exact Name", categoryId: CAT_SHIPPING },
    ],
  };
  const category = (
    def: ReceiptParserDefinition,
    line: string,
    fallback = null as string | null,
  ) => parse(def, line, "", fallback).items[0].categoryId;

  it("takes the first rule whose glob matches the name", () => {
    expect(category(base, "USB-C Cable $1.00")).toBe(CAT_CABLE);
    expect(category(base, "USB hub $1.00")).toBe(CAT_CASE);
  });

  it("matches a rule without a wildcard exactly and case-insensitively", () => {
    expect(category(base, "exact name $1.00")).toBe(CAT_SHIPPING);
    expect(category(base, "exact names $1.00")).toBeNull();
  });

  it("uses the default category when no rule matches", () => {
    const def = { ...base, defaultCategoryId: CAT_DEFAULT };
    expect(category(def, "Mug $1.00")).toBe(CAT_DEFAULT);
    expect(category(def, "Mug $1.00", CAT_PAYEE)).toBe(CAT_DEFAULT);
  });

  it("uses the payee's default category after the parser's default", () => {
    expect(category(base, "Mug $1.00", CAT_PAYEE)).toBe(CAT_PAYEE);
  });

  it("lets a rule win over both defaults", () => {
    const def = { ...base, defaultCategoryId: CAT_DEFAULT };
    expect(category(def, "Cable $1.00", CAT_PAYEE)).toBe(CAT_CABLE);
  });

  it("leaves the category null when nothing applies", () => {
    expect(category(base, "Mug $1.00")).toBeNull();
    expect(category({ version: 1, items: base.items }, "Mug $1.00")).toBeNull();
  });
});

describe("parseReceipt: the shipping and discount categories", () => {
  it("categorises shipping by shippingCategoryId alone", () => {
    const withDefault = parse(
      { version: 1, defaultCategoryId: CAT_DEFAULT },
      "",
      "",
      CAT_PAYEE,
    );
    expect(withDefault.shippingCategoryId).toBeNull();
    expect(
      parse({ version: 1, shippingCategoryId: CAT_SHIPPING }, "")
        .shippingCategoryId,
    ).toBe(CAT_SHIPPING);
  });

  it("categorises the discount by the default, then the payee's default", () => {
    expect(
      parse({ version: 1, defaultCategoryId: CAT_DEFAULT }, "", "", CAT_PAYEE)
        .discountCategoryId,
    ).toBe(CAT_DEFAULT);
    expect(parse({ version: 1 }, "", "", CAT_PAYEE).discountCategoryId).toBe(
      CAT_PAYEE,
    );
    expect(parse({ version: 1 }, "").discountCategoryId).toBeNull();
  });
});

describe("parseReceipt: the spec section 4 completeness table", () => {
  const def: ReceiptParserDefinition = {
    version: 1,
    total: ["Total ${amount}"],
    shipping: ["Shipping ${amount}"],
    discount: ["Discount ${amount}"],
    items: {
      startAfter: "Items",
      stopAt: "---",
      patterns: ["{name} ${amount}"],
    },
    categoryRules: [{ match: "*", categoryId: CAT_DEFAULT }],
    shippingCategoryId: CAT_SHIPPING,
  };
  /** The item lines sit between the markers, the totals after them. */
  const outcome = (
    itemLines: string[],
    rest: string[],
    definition: ReceiptParserDefinition = def,
    fallback: string | null = null,
  ) => {
    const text = ["Items", ...itemLines, "---", ...rest].join("\n");
    const parsed = parse(definition, text, "", fallback);
    return [parsed.complete, parsed.reason] as [
      boolean,
      ParsedReceiptReason | null,
    ];
  };

  it("no total: false, no_total (whatever else is found)", () => {
    expect(outcome(["Pen $1.00"], [])).toEqual([false, "no_total"]);
    expect(outcome([], [])).toEqual([false, "no_total"]);
  });

  it("total, no items: false, no_items", () => {
    expect(outcome([], ["Total $1.00"])).toEqual([false, "no_items"]);
  });

  it("total and items that do not add up: false, items_unbalanced", () => {
    expect(outcome(["Pen $1.00"], ["Total $1.01"])).toEqual([
      false,
      "items_unbalanced",
    ]);
    // Shipping and discount count: 1.00 + 2.00 - 0.50 = 2.50, not 3.00.
    expect(
      outcome(
        ["Pen $1.00"],
        ["Shipping $2.00", "Discount $0.50", "Total $3.00"],
      ),
    ).toEqual([false, "items_unbalanced"]);
  });

  it("balanced but an item has no category: false, items_uncategorized", () => {
    const noRules: ReceiptParserDefinition = { ...def, categoryRules: [] };
    expect(outcome(["Pen $1.00"], ["Total $1.00"], noRules)).toEqual([
      false,
      "items_uncategorized",
    ]);
    const partial: ReceiptParserDefinition = {
      ...def,
      categoryRules: [{ match: "Pen", categoryId: CAT_DEFAULT }],
    };
    expect(
      outcome(["Pen $1.00", "Ink $2.00"], ["Total $3.00"], partial),
    ).toEqual([false, "items_uncategorized"]);
  });

  it("balanced, items categorised, shipping not: false, shipping_uncategorized", () => {
    const noShipping: ReceiptParserDefinition = {
      ...def,
      shippingCategoryId: undefined,
    };
    expect(
      outcome(["Pen $1.00"], ["Shipping $2.00", "Total $3.00"], noShipping),
    ).toEqual([false, "shipping_uncategorized"]);
  });

  it("everything known and categorised: true, no reason", () => {
    expect(
      outcome(
        ["Pen $1.00", "Ink $2.00"],
        ["Shipping $2.00", "Discount $1.00", "Total $4.00"],
        { ...def, defaultCategoryId: CAT_DEFAULT },
      ),
    ).toEqual([true, null]);
    expect(outcome(["Pen $1.00"], ["Total $1.00"])).toEqual([true, null]);
  });

  it("checks the rows in the table's order", () => {
    const bare: ReceiptParserDefinition = {
      ...def,
      categoryRules: [],
      shippingCategoryId: undefined,
    };
    // Unbalanced beats uncategorised; uncategorised beats shipping.
    expect(
      outcome(["Pen $1.00"], ["Shipping $1.00", "Total $9.00"], bare),
    ).toEqual([false, "items_unbalanced"]);
    expect(
      outcome(["Pen $1.00"], ["Shipping $1.00", "Total $2.00"], bare),
    ).toEqual([false, "items_uncategorized"]);
  });

  it("a discount is a line of its own under the default category", () => {
    const noDefault: ReceiptParserDefinition = {
      ...def,
      categoryRules: [{ match: "*", categoryId: CAT_CABLE }],
    };
    const rest = ["Discount $1.00", "Total $2.00"];
    // The item has its rule's category; the discount has neither a default nor the payee's.
    expect(outcome(["Pen $3.00"], rest, noDefault)).toEqual([
      false,
      "items_uncategorized",
    ]);
    expect(outcome(["Pen $3.00"], rest, noDefault, CAT_PAYEE)).toEqual([
      true,
      null,
    ]);
    expect(
      outcome(["Pen $3.00"], rest, {
        ...noDefault,
        defaultCategoryId: CAT_DEFAULT,
      }),
    ).toEqual([true, null]);
  });

  it("a zero shipping or discount needs no category", () => {
    const noShipping: ReceiptParserDefinition = {
      ...def,
      shippingCategoryId: undefined,
      categoryRules: [{ match: "*", categoryId: CAT_CABLE }],
    };
    expect(
      outcome(
        ["Pen $1.00"],
        ["Shipping $0.00", "Discount $0.00", "Total $1.00"],
        noShipping,
      ),
    ).toEqual([true, null]);
  });

  it("a discount larger than the rest cannot balance", () => {
    expect(outcome(["Pen $1.00"], ["Discount $5.00", "Total $1.00"])).toEqual([
      false,
      "items_unbalanced",
    ]);
  });
});

describe("parseReceipt: realistic lines without a delimiter", () => {
  // The design 5.1 patterns, on the lines of the spec section 5 receipt.
  const design: ReceiptParserDefinition = {
    version: 1,
    orderId: ["*order #{orderid}*", "Order number: {orderid}"],
    total: ["Order total: {amount}", "*Grand total*{amount}"],
    shipping: ["Shipping: {amount}"],
    discount: ["Discount: {amount}"],
    items: {
      startAfter: "Items in your order",
      stopAt: "Subtotal",
      patterns: ["{qty} x {name} {amount}", "{name} {amount}"],
    },
    categoryRules: [
      { match: "*cable*", categoryId: CAT_CABLE },
      { match: "*case*", categoryId: CAT_CASE },
    ],
    defaultCategoryId: CAT_DEFAULT,
    shippingCategoryId: CAT_SHIPPING,
  };
  const text = [
    "Thank you, your order #EX-20931 has shipped",
    "Items in your order",
    "2 x USB-C cable 19.98",
    "Phone case 15.00",
    "Subtotal 34.98",
    "Shipping: 4.99",
    "Discount: 2.00",
    "Order total: 37.97",
  ].join("\n");

  it("reads the spec section 5 receipt as it is written", () => {
    const parsed = parse(design, text, "Your receipt");
    expect(parsed).toEqual({
      orderId: "EX-20931",
      total: 379700,
      shipping: 49900,
      discount: 20000,
      items: [
        { name: "USB-C cable", qty: 2, amount: 199800, categoryId: CAT_CABLE },
        { name: "Phone case", qty: 1, amount: 150000, categoryId: CAT_CASE },
      ],
      shippingCategoryId: CAT_SHIPPING,
      discountCategoryId: CAT_DEFAULT,
      complete: true,
      reason: null,
    });
  });

  it("reads a total behind a wildcard and a currency code, but not behind words", () => {
    expect(parse(design, "Grand total PLN 37.97").total).toBe(379700);
    expect(parse(design, "Grand total: 1 234,56 zł").total).toBe(12345600);
    // Words between the label and the number are not an amount.
    expect(parse(design, "Grand total incl. VAT 37.97").total).toBeNull();
  });

  it("keeps a single-word name and a bare amount working", () => {
    const one: ReceiptParserDefinition = {
      version: 1,
      items: { patterns: ["{name} {amount}"] },
    };
    expect(parse(one, "Pen 2.50").items[0]).toMatchObject({
      name: "Pen",
      amount: 25000,
    });
  });
});
