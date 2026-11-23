import { completeness } from "../parsing/parse-receipt";
import {
  aiAmountToUnits,
  buildAiParsedReceipt,
} from "./email-receipt-ai.extraction";

const BOOKS = "11111111-1111-4111-8111-111111111111";
const FOOD = "22222222-2222-4222-8222-222222222222";
const categories = new Map([
  [BOOKS, "Books"],
  [FOOD, "Food: Groceries"],
]);

const build = (value: unknown) =>
  buildAiParsedReceipt(JSON.stringify(value), categories);

describe("aiAmountToUnits", () => {
  it.each([
    [19.99, 199900],
    [0, 0],
    [12, 120000],
    [0.1 + 0.2, 3000],
    // 300000000000.03 * 10000 is 3000000000000300.5 in doubles (#2343).
    [300_000_000_000.03, 3_000_000_000_000_300],
    ["12.99", 129900],
    ["1.234,56 EUR", 12345600],
    ["$1,234.56", 12345600],
    ["0.00", 0],
  ])("%p is %p units", (input, expected) => {
    expect(aiAmountToUnits(input)).toBe(expected);
  });

  it.each([
    [-1],
    [Infinity],
    [NaN],
    [1e300],
    ["-5.00"],
    ["(5.00)"],
    ["abc"],
    ["cable 19.98"],
    ["1,23,4"],
    [""],
  ])("%p is not an amount", (input) => {
    expect(aiAmountToUnits(input)).toBeNull();
  });
});

describe("buildAiParsedReceipt: paid", () => {
  const answer = (over: Record<string, unknown>) => ({
    items: [{ name: "Game", amount: "24.99", categoryId: BOOKS }],
    discount: "3.00",
    discountCategoryId: BOOKS,
    ...over,
  });

  it("reads paid and judges it with the shared arithmetic: paid is the net, total the list price", () => {
    const result = build(answer({ total: "24.99", paid: "21.99" }));
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        total: 249900,
        paid: 219900,
        payee: null,
        complete: true,
        reason: null,
      },
    });
  });

  it("is incomplete when paid is not the net", () => {
    const result = build(answer({ total: "24.99", paid: "24.99" }));
    expect(result).toMatchObject({
      ok: true,
      parsed: { complete: false, reason: "items_unbalanced" },
    });
  });

  it("is complete from paid alone, and null paid when it is not given", () => {
    expect(build(answer({ paid: "21.99" }))).toMatchObject({
      parsed: { total: null, paid: 219900, complete: true },
    });
    expect(build(answer({ total: "21.99" }))).toMatchObject({
      parsed: { paid: null, complete: true },
    });
  });

  it("reads an unreadable paid as not stated, and says so", () => {
    const result = build(answer({ total: "21.99", paid: "soon" }));
    expect(result).toMatchObject({ parsed: { paid: null } });
    expect(result).toMatchObject({
      notes: ["The paid was not a readable amount."],
    });
  });
});

describe("buildAiParsedReceipt", () => {
  it("reads a complete receipt, marked as read by the AI, with the same truth table as a parser", () => {
    const result = build({
      orderId: " A-1 ",
      items: [
        { name: "  Widget  ", qty: 2, amount: "19.98", categoryId: BOOKS },
        { name: "Cable", amount: 15, categoryId: FOOD.toUpperCase() },
      ],
      total: "34.98",
      description: "  Order <b>A-1</b> ",
    });
    expect(result).toEqual({
      ok: true,
      parsed: {
        orderId: "A-1",
        total: 349800,
        paid: null,
        payee: null,
        shipping: null,
        discount: null,
        items: [
          { name: "Widget", qty: 2, amount: 199800, categoryId: BOOKS },
          { name: "Cable", qty: 1, amount: 150000, categoryId: FOOD },
        ],
        shippingCategoryId: null,
        discountCategoryId: null,
        complete: true,
        reason: null,
        source: "ai",
      },
      description: "Order bA-1/b",
      notes: [],
    });
  });

  it("judges completeness with the parser's own function, shipping and discount categories included", () => {
    const answer = {
      items: [{ name: "Widget", amount: "10.00", categoryId: BOOKS }],
      shipping: "2.00",
      shippingCategoryId: FOOD,
      discount: "1.00",
      discountCategoryId: BOOKS.toUpperCase(),
      total: "11.00",
    };
    const result = build(answer);
    if (!result.ok) throw new Error("expected a reading");
    const { complete: _c, reason: _r, source: _s, ...base } = result.parsed;
    expect(result.parsed.reason).toBe(completeness(base));
    expect(result.parsed).toMatchObject({
      shippingCategoryId: FOOD,
      discountCategoryId: BOOKS,
      complete: true,
      reason: null,
      source: "ai",
    });
  });

  it("without a shipping or discount category the reading is not complete, as for a parser", () => {
    const base = {
      items: [{ name: "Widget", amount: "10.00", categoryId: BOOKS }],
      total: "12.00",
    };
    const noShippingCategory = build({ ...base, shipping: "2.00" });
    if (!noShippingCategory.ok) throw new Error("expected a reading");
    expect(noShippingCategory.parsed.reason).toBe("shipping_uncategorized");

    const noDiscountCategory = build({
      items: base.items,
      shipping: "3.00",
      shippingCategoryId: FOOD,
      discount: "1.00",
      total: "12.00",
    });
    if (!noDiscountCategory.ok) throw new Error("expected a reading");
    expect(noDiscountCategory.parsed.reason).toBe("items_uncategorized");
  });

  it("an unknown or malformed shipping or discount category id is none, and is noted", () => {
    const result = build({
      items: [{ name: "Widget", amount: "10.00", categoryId: BOOKS }],
      shipping: "2.00",
      shippingCategoryId: "nope",
      discount: "1.00",
      discountCategoryId: null,
      total: "11.00",
    });
    if (!result.ok) throw new Error("expected a reading");
    expect(result.parsed.shippingCategoryId).toBeNull();
    expect(result.parsed.discountCategoryId).toBeNull();
    expect(result.parsed.complete).toBe(false);
    expect(result.notes).toEqual(["1 category id(s) not in the list."]);
  });

  it.each([
    [
      "no total",
      { items: [{ name: "A", amount: "1.00", categoryId: BOOKS }] },
      "no_total",
    ],
    ["no items", { items: [], total: "1.00" }, "no_items"],
    [
      "items that do not add up",
      {
        items: [{ name: "A", amount: "1.00", categoryId: BOOKS }],
        total: "2.00",
      },
      "items_unbalanced",
    ],
    [
      "an item with no category",
      { items: [{ name: "A", amount: "1.00" }], total: "1.00" },
      "items_uncategorized",
    ],
    [
      "shipping with no category",
      {
        items: [{ name: "A", amount: "1.00", categoryId: BOOKS }],
        shipping: "1.00",
        total: "2.00",
      },
      "shipping_uncategorized",
    ],
  ])("%s", (_name, answer, reason) => {
    const result = build(answer);
    if (!result.ok) throw new Error("expected a reading");
    expect(result.parsed.reason).toBe(reason);
    expect(result.parsed.complete).toBe(false);
  });

  it("an unknown or malformed category id is none, and is noted", () => {
    const result = build({
      items: [
        { name: "A", amount: "1.00", categoryId: "nope" },
        { name: "B", amount: "1.00", categoryId: null },
      ],
      total: "2.00",
    });
    if (!result.ok) throw new Error("expected a reading");
    expect(result.parsed.items.map((i) => i.categoryId)).toEqual([null, null]);
    expect(result.notes).toEqual(["1 category id(s) not in the list."]);
  });

  it("drops an item with no readable positive amount or no name, and says how many", () => {
    const result = build({
      items: [
        { name: "A", amount: "1.00", categoryId: BOOKS },
        { name: "B", amount: "-1.00" },
        { name: "C", amount: "free" },
        { name: "D", amount: 0 },
        { name: "<>", amount: "1.00" },
      ],
      total: "1.00",
    });
    if (!result.ok) throw new Error("expected a reading");
    expect(result.parsed.items.map((i) => i.name)).toEqual(["A"]);
    expect(result.notes).toEqual([
      "4 item(s) dropped: no name or no readable amount.",
    ]);
    expect(result.parsed.complete).toBe(true);
  });

  it("reads an unreadable total, shipping or discount as not stated, and says so", () => {
    const result = build({
      items: [],
      total: "lots",
      shipping: -2,
      discount: "n/a",
    });
    if (!result.ok) throw new Error("expected a reading");
    expect(result.parsed).toMatchObject({
      total: null,
      shipping: null,
      discount: null,
      reason: "no_total",
    });
    expect(result.notes).toHaveLength(3);
  });

  it("keeps a stated zero as zero, never as not stated", () => {
    const result = build({
      items: [{ name: "A", amount: "1.00", categoryId: BOOKS }],
      shipping: "0.00",
      total: "1.00",
    });
    if (!result.ok) throw new Error("expected a reading");
    expect(result.parsed.shipping).toBe(0);
    expect(result.parsed.complete).toBe(true);
  });

  it("cuts the order id and drops an empty one and an empty description", () => {
    const result = build({ items: [], orderId: "<>", description: " " });
    if (!result.ok) throw new Error("expected a reading");
    expect(result.parsed.orderId).toBeNull();
    expect(result.description).toBeNull();
  });

  it.each([
    ["not JSON", "no json"],
    ["an array", "[1,2]"],
    ["the wrong shape", JSON.stringify({ items: "x" })],
  ])("refuses %s", (_name, content) => {
    expect(buildAiParsedReceipt(content, categories)).toMatchObject({
      ok: false,
    });
  });
});
