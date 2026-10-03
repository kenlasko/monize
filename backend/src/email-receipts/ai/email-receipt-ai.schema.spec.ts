import {
  EXTRACTION_MAX_DESCRIPTION,
  EXTRACTION_MAX_ITEM_NAME,
  EXTRACTION_MAX_ITEMS,
  EXTRACTION_MAX_ORDER_ID,
  extractJsonObject,
  receiptExtractionSchema,
} from "./email-receipt-ai.schema";

describe("extractJsonObject", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads a fenced ```json block", () => {
    expect(extractJsonObject('Here:\n```json\n{"a": 2}\n```\nDone')).toEqual({
      a: 2,
    });
    expect(extractJsonObject('```\n{"a": 3}\n```')).toEqual({ a: 3 });
  });

  it("reads an object inside prose", () => {
    expect(extractJsonObject('Sure! {"a": 4} hope it helps')).toEqual({ a: 4 });
  });

  it.each(["", "not json", "[1,2", "{broken", 42, null, undefined])(
    "returns undefined for %p",
    (input) => expect(extractJsonObject(input)).toBeUndefined(),
  );

  it("refuses a reply of a book's length", () => {
    expect(
      extractJsonObject('{"a":"' + "x".repeat(300_000) + '"}'),
    ).toBeUndefined();
  });
});

describe("receiptExtractionSchema", () => {
  const ok = (value: unknown) => receiptExtractionSchema.safeParse(value);
  const item = { name: "Cable", amount: "9.99" };

  it("accepts the whole shape and maps null to absent", () => {
    const parsed = ok({
      orderId: "A-1",
      items: [
        { name: "Cable", qty: 2, amount: 19.98, categoryId: null },
        { name: "Case", amount: "15,00 zl", categoryId: "abc" },
      ],
      shipping: "4.99",
      shippingCategoryId: "cat-s",
      discount: null,
      discountCategoryId: null,
      total: 39.97,
      description: "Order A-1",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      orderId: "A-1",
      items: [
        { name: "Cable", qty: 2, amount: 19.98, categoryId: undefined },
        { name: "Case", qty: undefined, amount: "15,00 zl", categoryId: "abc" },
      ],
      shipping: "4.99",
      shippingCategoryId: "cat-s",
      discount: undefined,
      discountCategoryId: undefined,
      total: 39.97,
      description: "Order A-1",
    });
  });

  it("bounds the shipping and discount category ids and refuses a non-text one", () => {
    expect(ok({ items: [], shippingCategoryId: "c".repeat(101) }).success).toBe(
      false,
    );
    expect(ok({ items: [], discountCategoryId: 5 }).success).toBe(false);
  });

  it("needs the items list, which may be empty", () => {
    expect(ok({}).success).toBe(false);
    expect(ok({ items: [] }).success).toBe(true);
  });

  it("refuses an unknown key at either level, so an answer cannot carry an account, a date or a split", () => {
    expect(ok({ items: [], date: "2026-01-01" }).success).toBe(false);
    expect(ok({ items: [], splits: [] }).success).toBe(false);
    expect(ok({ items: [{ ...item, accountId: "x" }] }).success).toBe(false);
  });

  it("bounds the items, the names, the order id and the description", () => {
    expect(ok({ items: Array(EXTRACTION_MAX_ITEMS).fill(item) }).success).toBe(
      true,
    );
    expect(
      ok({ items: Array(EXTRACTION_MAX_ITEMS + 1).fill(item) }).success,
    ).toBe(false);
    expect(
      ok({
        items: [{ ...item, name: "n".repeat(EXTRACTION_MAX_ITEM_NAME + 1) }],
      }).success,
    ).toBe(false);
    expect(
      ok({ items: [], orderId: "o".repeat(EXTRACTION_MAX_ORDER_ID + 1) })
        .success,
    ).toBe(false);
    expect(
      ok({
        items: [],
        description: "d".repeat(EXTRACTION_MAX_DESCRIPTION + 1),
      }).success,
    ).toBe(false);
  });

  it("refuses an empty name, a non-integer or out-of-range qty, and a non-finite or non-text amount", () => {
    expect(ok({ items: [{ ...item, name: " " }] }).success).toBe(false);
    expect(ok({ items: [{ ...item, qty: 1.5 }] }).success).toBe(false);
    expect(ok({ items: [{ ...item, qty: 0 }] }).success).toBe(false);
    expect(ok({ items: [{ ...item, qty: 10000 }] }).success).toBe(false);
    expect(ok({ items: [{ ...item, amount: null }] }).success).toBe(false);
    expect(ok({ items: [{ ...item, amount: {} }] }).success).toBe(false);
    expect(ok({ items: [{ ...item, amount: "" }] }).success).toBe(false);
    expect(ok({ items: [], total: Infinity }).success).toBe(false);
  });
});
