import {
  collectParserCategoryIds,
  validateReceiptParserDefinition,
} from "./receipt-parser.validation";
import {
  MAX_CATEGORY_RULES,
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS_PER_FIELD,
  MAX_SECTION_MARKER_LENGTH,
} from "./receipt-parser.types";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

const valid = (): Record<string, unknown> => ({
  version: 1,
  orderId: ["*order #{orderid}", "Order number: {orderid}"],
  total: ["Order total: {amount}", "*Grand total*{amount}"],
  shipping: ["Shipping: {amount}"],
  discount: ["Discount: {amount}"],
  items: {
    startAfter: "Items in your order",
    stopAt: "Subtotal",
    patterns: ["{qty} x {name} ${amount}", "{name} @{price}"],
  },
  categoryRules: [
    { match: "*cable*", categoryId: UUID_A },
    { match: "*book*", categoryId: UUID_B },
  ],
  defaultCategoryId: UUID_C,
  shippingCategoryId: UUID_A,
});

const errorsOf = (input: unknown) => {
  const result = validateReceiptParserDefinition(input);
  if (result.ok) throw new Error("expected a refusal");
  return result.errors;
};

const codesAt = (input: unknown, path: string): string[] =>
  errorsOf(input)
    .filter((error) => error.path === path)
    .map((error) => error.code);

describe("validateReceiptParserDefinition: accepted definitions", () => {
  it("accepts the design's example shape and returns it unchanged", () => {
    const input = valid();
    const result = validateReceiptParserDefinition(input);
    expect(result).toEqual({ ok: true, definition: input });
  });

  it("accepts the smallest definition", () => {
    expect(validateReceiptParserDefinition({ version: 1 })).toEqual({
      ok: true,
      definition: { version: 1 },
    });
  });

  it("accepts an empty pattern list for an optional field", () => {
    const result = validateReceiptParserDefinition({ version: 1, total: [] });
    expect(result).toEqual({ ok: true, definition: { version: 1, total: [] } });
  });

  it("returns a fresh object holding only validated data", () => {
    const input = valid();
    const result = validateReceiptParserDefinition(input);
    if (!result.ok) throw new Error("expected acceptance");
    (input.total as string[]).push("{amount}");
    (input.items as { patterns: string[] }).patterns.length = 0;
    expect(result.definition.total).toHaveLength(2);
    expect(result.definition.items?.patterns).toHaveLength(2);
    expect(result.definition).not.toBe(input);
  });

  it("accepts an upper-case UUID", () => {
    const result = validateReceiptParserDefinition({
      version: 1,
      defaultCategoryId: UUID_A.toUpperCase(),
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["price with qty", "{qty} x {name} @{price}"],
    ["price alone", "{name} @{price}"],
    ["amount alone", "{name} ${amount}"],
    ["amount with qty", "{name} x{qty} = {amount}"],
  ])("accepts an item pattern with %s", (_label, pattern) => {
    const result = validateReceiptParserDefinition({
      version: 1,
      items: { patterns: [pattern] },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts duplicate category rule patterns", () => {
    const result = validateReceiptParserDefinition({
      version: 1,
      categoryRules: [
        { match: "*cable*", categoryId: UUID_A },
        { match: "*cable*", categoryId: UUID_B },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts the bounds exactly", () => {
    const tenPatterns = Array.from(
      { length: MAX_PATTERNS_PER_FIELD },
      (_, i) => `T${i} {amount}`,
    );
    const longPattern = `{amount}${"x".repeat(MAX_PATTERN_LENGTH - 8)}`;
    const rules = Array.from({ length: MAX_CATEGORY_RULES }, (_, i) => ({
      match: `*r${i}*`,
      categoryId: UUID_A,
    }));
    const result = validateReceiptParserDefinition({
      version: 1,
      total: tenPatterns,
      shipping: [longPattern],
      items: {
        startAfter: "s".repeat(MAX_SECTION_MARKER_LENGTH),
        stopAt: "e".repeat(MAX_SECTION_MARKER_LENGTH),
        patterns: ["{name} {amount}"],
      },
      categoryRules: rules,
    });
    expect(longPattern).toHaveLength(MAX_PATTERN_LENGTH);
    expect(result.ok).toBe(true);
  });
});

describe("validateReceiptParserDefinition: never throws", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["a string", "{}"],
    ["a number", 1],
    ["a boolean", true],
  ])("refuses %s as not_object", (_label, input) => {
    expect(errorsOf(input)).toEqual([{ path: "", code: "not_object" }]);
  });

  it("survives hostile nesting and prototype keys", () => {
    const hostile = JSON.parse(
      '{"version":1,"__proto__":{"x":1},"constructor":{"a":1},"items":{"patterns":[{"a":1}]}}',
    );
    expect(() => validateReceiptParserDefinition(hostile)).not.toThrow();
    const codes = errorsOf(hostile).map((error) => error.code);
    expect(codes).toContain("unknown_key");
    expect(codes).toContain("invalid_type");
  });
});

describe("validateReceiptParserDefinition: keys and version", () => {
  it("refuses an unknown key at the top level", () => {
    expect(errorsOf({ ...valid(), extra: 1 })).toEqual([
      { path: "extra", code: "unknown_key" },
    ]);
  });

  it("refuses an unknown key under items", () => {
    const input = valid();
    (input.items as Record<string, unknown>).extra = "x";
    expect(errorsOf(input)).toEqual([
      { path: "items.extra", code: "unknown_key" },
    ]);
  });

  it("refuses an unknown key in a category rule", () => {
    const input = valid();
    (input.categoryRules as Record<string, unknown>[])[1].note = "x";
    expect(errorsOf(input)).toEqual([
      { path: "categoryRules[1].note", code: "unknown_key" },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["2", 2],
    ["0", 0],
    ["a string", "1"],
    ["null", null],
  ])("refuses version %s", (_label, version) => {
    const input = { ...valid(), version };
    expect(codesAt(input, "version")).toEqual(["invalid_version"]);
  });
});

describe("validateReceiptParserDefinition: types", () => {
  it.each([
    ["orderId is a string", { orderId: "Order {orderid}" }, "orderId"],
    ["orderId holds a number", { orderId: [1] }, "orderId[0]"],
    ["total is an object", { total: {} }, "total"],
    ["shipping holds null", { shipping: [null] }, "shipping[0]"],
    ["discount is null", { discount: null }, "discount"],
    ["items is a string", { items: "x" }, "items"],
    ["items is an array", { items: [] }, "items"],
    ["items.patterns is missing", { items: {} }, "items.patterns"],
    [
      "items.patterns is a string",
      { items: { patterns: "x" } },
      "items.patterns",
    ],
    [
      "startAfter is a number",
      { items: { startAfter: 5, patterns: ["{name} {amount}"] } },
      "items.startAfter",
    ],
    [
      "stopAt is null",
      { items: { stopAt: null, patterns: ["{name} {amount}"] } },
      "items.stopAt",
    ],
    ["categoryRules is an object", { categoryRules: {} }, "categoryRules"],
    ["a category rule is a number", { categoryRules: [5] }, "categoryRules[0]"],
    [
      "a rule match is a number",
      { categoryRules: [{ match: 5, categoryId: UUID_A }] },
      "categoryRules[0].match",
    ],
    [
      "defaultCategoryId is a number",
      { defaultCategoryId: 5 },
      "defaultCategoryId",
    ],
    [
      "shippingCategoryId is null",
      { shippingCategoryId: null },
      "shippingCategoryId",
    ],
  ])("refuses when %s", (_label, patch, path) => {
    expect(codesAt({ version: 1, ...patch }, path)).toEqual(["invalid_type"]);
  });
});

describe("validateReceiptParserDefinition: bounds", () => {
  const tooMany = Array.from(
    { length: MAX_PATTERNS_PER_FIELD + 1 },
    (_, i) => `T${i} {amount}`,
  );

  it.each([["total"], ["shipping"], ["discount"]])(
    "refuses more than 10 patterns in %s",
    (field) => {
      expect(codesAt({ version: 1, [field]: tooMany }, field)).toEqual([
        "too_many",
      ]);
    },
  );

  it("refuses more than 10 orderId and item patterns", () => {
    const orderIds = tooMany.map((p) => p.replace("{amount}", "{orderid}"));
    expect(codesAt({ version: 1, orderId: orderIds }, "orderId")).toEqual([
      "too_many",
    ]);
    const items = tooMany.map((p) => p.replace("{amount}", "{name} {amount}"));
    expect(
      codesAt({ version: 1, items: { patterns: items } }, "items.patterns"),
    ).toEqual(["too_many"]);
  });

  it("refuses an empty items.patterns", () => {
    expect(
      codesAt({ version: 1, items: { patterns: [] } }, "items.patterns"),
    ).toEqual(["empty"]);
  });

  it("refuses a pattern of 201 characters", () => {
    const pattern = `{amount}${"x".repeat(MAX_PATTERN_LENGTH - 7)}`;
    expect(pattern).toHaveLength(MAX_PATTERN_LENGTH + 1);
    expect(codesAt({ version: 1, total: [pattern] }, "total[0]")).toEqual([
      "too_long",
    ]);
  });

  it("refuses an empty or blank pattern", () => {
    expect(codesAt({ version: 1, total: [""] }, "total[0]")).toEqual(["empty"]);
    expect(codesAt({ version: 1, total: ["   "] }, "total[0]")).toEqual([
      "empty",
    ]);
  });

  it("refuses a pattern holding a control character", () => {
    expect(
      codesAt({ version: 1, total: ["Total\n{amount}"] }, "total[0]"),
    ).toEqual(["control_character"]);
    expect(
      codesAt({ version: 1, total: ["Total\x7f{amount}"] }, "total[0]"),
    ).toEqual(["control_character"]);
  });

  it("refuses 51 category rules", () => {
    const rules = Array.from({ length: MAX_CATEGORY_RULES + 1 }, (_, i) => ({
      match: `*r${i}*`,
      categoryId: UUID_A,
    }));
    expect(
      codesAt({ version: 1, categoryRules: rules }, "categoryRules"),
    ).toEqual(["too_many"]);
  });

  it("refuses a section marker of 101 characters, or an empty one", () => {
    const items = (marker: string) => ({
      version: 1,
      items: { startAfter: marker, patterns: ["{name} {amount}"] },
    });
    expect(
      codesAt(
        items("s".repeat(MAX_SECTION_MARKER_LENGTH + 1)),
        "items.startAfter",
      ),
    ).toEqual(["too_long"]);
    expect(codesAt(items("  "), "items.startAfter")).toEqual(["empty"]);
    const stop = {
      version: 1,
      items: { stopAt: "", patterns: ["{name} {amount}"] },
    };
    expect(codesAt(stop, "items.stopAt")).toEqual(["empty"]);
  });

  it("reports at most 50 errors however bad the input", () => {
    const rules = Array.from({ length: MAX_CATEGORY_RULES }, () => ({
      match: "{x}",
      categoryId: "nope",
    }));
    expect(errorsOf({ version: 1, categoryRules: rules })).toHaveLength(50);
  });
});

describe("validateReceiptParserDefinition: captures", () => {
  it("refuses a malformed capture", () => {
    expect(
      codesAt({ version: 1, total: ["Total {Amount}"] }, "total[0]"),
    ).toEqual(expect.arrayContaining(["malformed_capture", "capture_missing"]));
  });

  it("refuses more than five captures in a pattern", () => {
    const pattern = "{name} {amount} {price} {qty} {orderid} {other}";
    const codes = codesAt(
      { version: 1, items: { patterns: [pattern] } },
      "items.patterns[0]",
    );
    expect(codes).toContain("too_many_captures");
    expect(codes).toContain("capture_not_allowed");
  });

  it("refuses a capture name twice in one pattern", () => {
    expect(
      codesAt({ version: 1, total: ["{amount} of {amount}"] }, "total[0]"),
    ).toEqual(["duplicate_capture"]);
  });

  it("refuses a capture name the field does not take", () => {
    expect(
      codesAt({ version: 1, total: ["{name} {amount}"] }, "total[0]"),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt({ version: 1, shipping: ["{qty} {amount}"] }, "shipping[0]"),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt({ version: 1, discount: ["{orderid} {amount}"] }, "discount[0]"),
    ).toEqual(["capture_not_allowed"]);
    expect(
      codesAt({ version: 1, orderId: ["{amount}"] }, "orderId[0]"),
    ).toEqual(["capture_not_allowed", "capture_missing"]);
    expect(
      codesAt(
        { version: 1, items: { patterns: ["{name} {amount} {payee}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_not_allowed"]);
  });

  it("refuses a pattern without the capture its field needs", () => {
    expect(codesAt({ version: 1, total: ["Total"] }, "total[0]")).toEqual([
      "capture_missing",
    ]);
    expect(codesAt({ version: 1, orderId: ["Order"] }, "orderId[0]")).toEqual([
      "capture_missing",
    ]);
  });

  it("refuses an item pattern without a name", () => {
    expect(
      codesAt(
        { version: 1, items: { patterns: ["{amount}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_missing"]);
  });

  it("refuses an item pattern with neither amount nor price", () => {
    expect(
      codesAt(
        { version: 1, items: { patterns: ["{qty} {name}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_missing"]);
    expect(
      codesAt(
        { version: 1, items: { patterns: ["{name}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_missing"]);
  });

  it("refuses an item pattern with both amount and price", () => {
    expect(
      codesAt(
        { version: 1, items: { patterns: ["{name} {amount} {price}"] } },
        "items.patterns[0]",
      ),
    ).toEqual(["capture_conflict"]);
  });

  it("refuses a capture in a category rule's match", () => {
    expect(
      codesAt(
        {
          version: 1,
          categoryRules: [{ match: "{name}", categoryId: UUID_A }],
        },
        "categoryRules[0].match",
      ),
    ).toEqual(["capture_not_allowed"]);
  });

  it("reports the path of the pattern that is wrong", () => {
    const input = valid();
    (input.items as { patterns: string[] }).patterns[1] = "{name}";
    expect(errorsOf(input)).toEqual([
      { path: "items.patterns[1]", code: "capture_missing" },
    ]);
  });
});

describe("validateReceiptParserDefinition: category ids", () => {
  it.each([
    ["not-a-uuid"],
    [""],
    ["11111111-1111-4111-8111-11111111111"],
    ["11111111111141118111111111111111"],
    ["11111111-1111-4111-8111-11111111111g"],
  ])("refuses %j as a category id", (id) => {
    expect(
      codesAt({ version: 1, defaultCategoryId: id }, "defaultCategoryId"),
    ).toEqual(["invalid_uuid"]);
    expect(
      codesAt({ version: 1, shippingCategoryId: id }, "shippingCategoryId"),
    ).toEqual(["invalid_uuid"]);
    expect(
      codesAt(
        { version: 1, categoryRules: [{ match: "*a*", categoryId: id }] },
        "categoryRules[0].categoryId",
      ),
    ).toEqual(["invalid_uuid"]);
  });

  it("reports a missing rule field as a type error", () => {
    expect(errorsOf({ version: 1, categoryRules: [{}] })).toEqual([
      { path: "categoryRules[0].match", code: "invalid_type" },
      { path: "categoryRules[0].categoryId", code: "invalid_type" },
    ]);
  });
});

describe("collectParserCategoryIds", () => {
  it("lists each id once: rules, then the default, then shipping", () => {
    const result = validateReceiptParserDefinition({
      version: 1,
      categoryRules: [
        { match: "*a*", categoryId: UUID_B },
        { match: "*b*", categoryId: UUID_A },
        { match: "*c*", categoryId: UUID_B },
      ],
      defaultCategoryId: UUID_A,
      shippingCategoryId: UUID_C,
    });
    if (!result.ok) throw new Error("expected acceptance");
    expect(collectParserCategoryIds(result.definition)).toEqual([
      UUID_B,
      UUID_A,
      UUID_C,
    ]);
  });

  it("is empty for a definition without categories", () => {
    expect(collectParserCategoryIds({ version: 1 })).toEqual([]);
  });

  it("lists the default alone", () => {
    expect(
      collectParserCategoryIds({ version: 1, defaultCategoryId: UUID_A }),
    ).toEqual([UUID_A]);
  });
});
