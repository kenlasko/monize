import { parseReceipt } from "../parsing/parse-receipt";
import type {
  ParsedReceipt,
  ParsedReceiptReason,
  ReceiptParserDefinition,
} from "../parsing/receipt-parser.types";
import {
  RECEIPT_SUMMARY_MAX_LENGTH,
  buildReceiptProposal,
} from "./build-receipt-proposal";

const CAT_CABLE = "11111111-1111-4111-8111-111111111111";
const CAT_CASE = "22222222-2222-4222-8222-222222222222";
const CAT_DEFAULT = "33333333-3333-4333-8333-333333333333";
const CAT_SHIPPING = "44444444-4444-4444-8444-444444444444";
const CAT_GONE = "99999999-9999-4999-8999-999999999999";

const CATEGORY_NAMES: ReadonlyMap<string, string> = new Map([
  [CAT_CABLE, "Electronics"],
  [CAT_CASE, "Accessories"],
  [CAT_DEFAULT, "Shopping"],
  [CAT_SHIPPING, "Postage"],
]);

const CTX = {
  parserName: "Example Shop",
  payeeName: "Example Shop Ltd" as string | null,
  categoryNames: CATEGORY_NAMES,
};

const TX = {
  amount: -37.97,
  description: null as string | null,
  payeeId: null as string | null,
};

/** The spec section 5 receipt, already parsed: items 19.98 + 15.00, shipping 4.99, discount 2.00. */
const example = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
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
  ...over,
});

const SUMMARY = "Example Shop EX-20931: USB-C cable x2, Phone case";

/** A complete one-item receipt of 12.50. */
const single = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
  orderId: "EX-1",
  total: 125000,
  shipping: null,
  discount: null,
  items: [{ name: "Mug", qty: 1, amount: 125000, categoryId: CAT_DEFAULT }],
  shippingCategoryId: null,
  discountCategoryId: null,
  complete: true,
  reason: null,
  ...over,
});

describe("buildReceiptProposal: the spec section 5 numerical example", () => {
  it("proposes -19.98, -15.00, -4.99 and +2.00 for a -37.97 transaction", () => {
    expect(buildReceiptProposal(example(), TX, CTX)).toEqual({
      kind: "itemized",
      reason: null,
      input: {
        splits: [
          {
            categoryName: "Electronics",
            amount: -19.98,
            memo: "USB-C cable x 2",
          },
          { categoryName: "Accessories", amount: -15, memo: "Phone case" },
          { categoryName: "Postage", amount: -4.99 },
          { categoryName: "Shopping", amount: 2 },
        ],
        payeeName: "Example Shop Ltd",
        description: SUMMARY,
      },
    });
  });

  it("sums to the transaction exactly", () => {
    const { input } = buildReceiptProposal(example(), TX, CTX);
    const cents = input?.splits?.map((split) => Math.round(split.amount * 100));
    expect(cents).toEqual([-1998, -1500, -499, 200]);
    expect(cents?.reduce((a, b) => a + b, 0)).toBe(-3797);
  });

  it("signs a positive transaction the other way, the discount opposite again", () => {
    const { input } = buildReceiptProposal(
      example(),
      { ...TX, amount: 37.97 },
      CTX,
    );
    expect(input?.splits?.map((split) => split.amount)).toEqual([
      19.98, 15, 4.99, -2,
    ]);
  });

  it("the same receipt against a -35.00 transaction is description only: amount_differs", () => {
    expect(
      buildReceiptProposal(example(), { ...TX, amount: -35 }, CTX),
    ).toEqual({
      kind: "description_only",
      reason: "amount_differs",
      input: { payeeName: "Example Shop Ltd", description: SUMMARY },
    });
  });

  it("is what the parser and the builder produce together from the email text", () => {
    const def: ReceiptParserDefinition = {
      version: 1,
      orderId: ["Order number: {orderid}"],
      total: ["Order total: ${amount}"],
      shipping: ["Shipping: ${amount}"],
      discount: ["Discount: ${amount}"],
      items: {
        startAfter: "Items",
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
    const text = [
      "Order number: EX-20931",
      "Items",
      "2 x USB-C cable $19.98",
      "Phone case $15.00",
      "Subtotal $34.98",
      "Shipping: $4.99",
      "Discount: $2.00",
      "Order total: $37.97",
    ].join("\n");
    const parsed = parseReceipt(def, "Your order", text, null);
    expect(buildReceiptProposal(parsed, TX, CTX)).toEqual(
      buildReceiptProposal(example(), TX, CTX),
    );
  });
});

describe("buildReceiptProposal: the spec section 5 proposal table", () => {
  it("complete, amount equal, one line: a category, not a split", () => {
    expect(
      buildReceiptProposal(single(), { ...TX, amount: -12.5 }, CTX),
    ).toEqual({
      kind: "single_category",
      reason: null,
      input: {
        categoryName: "Shopping",
        payeeName: "Example Shop Ltd",
        description: "Example Shop EX-1: Mug",
      },
    });
  });

  it("complete, amount equal, two or more lines: splits and a description", () => {
    const two = single({
      total: 250000,
      items: [
        { name: "Mug", qty: 1, amount: 125000, categoryId: CAT_DEFAULT },
        { name: "Plate", qty: 1, amount: 125000, categoryId: CAT_CASE },
      ],
    });
    const result = buildReceiptProposal(two, { ...TX, amount: -25 }, CTX);
    expect(result.kind).toBe("itemized");
    expect(result.input?.splits).toEqual([
      { categoryName: "Shopping", amount: -12.5, memo: "Mug" },
      { categoryName: "Accessories", amount: -12.5, memo: "Plate" },
    ]);
    expect(result.input?.categoryName).toBeUndefined();
    expect(result.input?.description).toBe("Example Shop EX-1: Mug, Plate");
  });

  it("one item and a shipping line is a split of two, not a category", () => {
    const shipped = single({
      total: 175000,
      shipping: 50000,
      shippingCategoryId: CAT_SHIPPING,
    });
    const result = buildReceiptProposal(shipped, { ...TX, amount: -17.5 }, CTX);
    expect(result.kind).toBe("itemized");
    expect(result.input?.splits).toEqual([
      { categoryName: "Shopping", amount: -12.5, memo: "Mug" },
      { categoryName: "Postage", amount: -5 },
    ]);
  });

  it("one item and a discount is a split of two", () => {
    const discounted = single({
      total: 100000,
      discount: 25000,
      discountCategoryId: CAT_DEFAULT,
    });
    const result = buildReceiptProposal(
      discounted,
      { ...TX, amount: -10 },
      CTX,
    );
    expect(result.input?.splits?.map((split) => split.amount)).toEqual([
      -12.5, 2.5,
    ]);
  });

  it("a zero shipping or discount is not a line", () => {
    const zero = single({ shipping: 0, discount: 0 });
    expect(buildReceiptProposal(zero, { ...TX, amount: -12.5 }, CTX).kind).toBe(
      "single_category",
    );
  });

  it("complete but the amount differs: description only, amount_differs", () => {
    const result = buildReceiptProposal(
      single(),
      { ...TX, amount: -12.51 },
      CTX,
    );
    expect(result.kind).toBe("description_only");
    expect(result.reason).toBe("amount_differs");
    expect(result.input?.splits).toBeUndefined();
    expect(result.input?.categoryName).toBeUndefined();
    expect(result.input?.description).toBe("Example Shop EX-1: Mug");
  });

  it.each<ParsedReceiptReason>([
    "no_total",
    "no_items",
    "items_unbalanced",
    "items_uncategorized",
    "shipping_uncategorized",
  ])("not complete (%s): description only with that reason", (reason) => {
    const result = buildReceiptProposal(
      example({ complete: false, reason }),
      TX,
      CTX,
    );
    expect(result).toEqual({
      kind: "description_only",
      reason,
      input: { payeeName: "Example Shop Ltd", description: SUMMARY },
    });
  });

  it("never carries an amount, a date, an account or a status", () => {
    const { input } = buildReceiptProposal(example(), TX, CTX);
    expect(Object.keys(input ?? {}).sort()).toEqual([
      "description",
      "payeeName",
      "splits",
    ]);
    for (const split of input?.splits ?? []) {
      expect(
        Object.keys(split).every((k) =>
          ["categoryName", "amount", "memo"].includes(k),
        ),
      ).toBe(true);
    }
  });
});

describe("buildReceiptProposal: a category the user no longer has", () => {
  it("falls back to description only when an item's category is unknown", () => {
    const gone = example({
      items: [
        { name: "USB-C cable", qty: 2, amount: 199800, categoryId: CAT_GONE },
        { name: "Phone case", qty: 1, amount: 150000, categoryId: CAT_CASE },
      ],
    });
    expect(buildReceiptProposal(gone, TX, CTX)).toEqual({
      kind: "description_only",
      reason: "category_missing",
      input: { payeeName: "Example Shop Ltd", description: SUMMARY },
    });
  });

  it("falls back when the shipping or discount category is unknown", () => {
    expect(
      buildReceiptProposal(example({ shippingCategoryId: CAT_GONE }), TX, CTX),
    ).toMatchObject({ kind: "description_only", reason: "category_missing" });
    expect(
      buildReceiptProposal(example({ discountCategoryId: CAT_GONE }), TX, CTX),
    ).toMatchObject({ kind: "description_only", reason: "category_missing" });
  });

  it("falls back when a line has no category id at all", () => {
    const uncategorised = example({ shippingCategoryId: null });
    expect(buildReceiptProposal(uncategorised, TX, CTX)).toMatchObject({
      kind: "description_only",
      reason: "category_missing",
    });
  });

  it("falls back for a single line too", () => {
    const result = buildReceiptProposal(
      single({
        items: [{ name: "Mug", qty: 1, amount: 125000, categoryId: CAT_GONE }],
      }),
      { ...TX, amount: -12.5 },
      CTX,
    );
    expect(result).toMatchObject({
      kind: "description_only",
      reason: "category_missing",
    });
  });
});

describe("buildReceiptProposal: split memos", () => {
  const oneSplit = (name: string, qty: number) => {
    const receipt = example({
      items: [{ name, qty, amount: 379700, categoryId: CAT_CABLE }],
      shipping: null,
      discount: null,
      shippingCategoryId: null,
    });
    // One item and nothing else is a category; add a zero-sum second line via shipping.
    return receipt;
  };

  it("is the name, and `name x qty` only above a quantity of one", () => {
    const { input } = buildReceiptProposal(example(), TX, CTX);
    expect(input?.splits?.[0].memo).toBe("USB-C cable x 2");
    expect(input?.splits?.[1].memo).toBe("Phone case");
    expect(oneSplit("Mug", 1).items[0].qty).toBe(1);
  });

  it("is cut to the note length", () => {
    const long = example({
      items: [
        {
          name: "L".repeat(900),
          qty: 1,
          amount: 199800,
          categoryId: CAT_CABLE,
        },
        { name: "Phone case", qty: 1, amount: 150000, categoryId: CAT_CASE },
      ],
    });
    const memo = buildReceiptProposal(long, TX, CTX).input?.splits?.[0].memo;
    expect(memo).toHaveLength(750);
  });

  it("strips angle brackets and folds whitespace from email text", () => {
    const dirty = example({
      items: [
        {
          name: "<b>Cable</b>\n  pack",
          qty: 1,
          amount: 199800,
          categoryId: CAT_CABLE,
        },
        { name: "Phone case", qty: 1, amount: 150000, categoryId: CAT_CASE },
      ],
    });
    const { input } = buildReceiptProposal(dirty, TX, CTX);
    expect(input?.splits?.[0].memo).toBe("bCable/b pack");
    expect(input?.description).not.toMatch(/[<>]/);
  });

  it("leaves no memo for an item whose name is only stripped characters", () => {
    const blank = example({
      items: [
        { name: "<>", qty: 1, amount: 199800, categoryId: CAT_CABLE },
        { name: "Phone case", qty: 1, amount: 150000, categoryId: CAT_CASE },
      ],
    });
    expect(buildReceiptProposal(blank, TX, CTX).input?.splits?.[0]).toEqual({
      categoryName: "Electronics",
      amount: -19.98,
    });
  });
});

describe("buildReceiptProposal: the description summary", () => {
  const summaryOf = (parsed: ParsedReceipt, parserName = "Example Shop") =>
    buildReceiptProposal(
      { ...parsed, complete: false, reason: "no_total" },
      { ...TX, payeeId: "p" },
      { ...CTX, parserName },
    ).input?.description;

  it("is `parser orderId: item x2, item`", () => {
    expect(summaryOf(example())).toBe(SUMMARY);
  });

  it("leaves the order id out when there is none", () => {
    expect(summaryOf(example({ orderId: null }))).toBe(
      "Example Shop: USB-C cable x2, Phone case",
    );
  });

  it("leaves the items out when there are none", () => {
    expect(summaryOf(example({ items: [] }))).toBe("Example Shop EX-20931");
    expect(summaryOf(example({ items: [], orderId: null }))).toBe(
      "Example Shop",
    );
  });

  it("is cut to 300 characters with an ellipsis", () => {
    const many = example({
      items: Array.from({ length: 40 }, (_, i) => ({
        name: `Item number ${i}`,
        qty: 1,
        amount: 10000,
        categoryId: CAT_CABLE,
      })),
    });
    const summary = summaryOf(many) ?? "";
    expect(summary).toHaveLength(RECEIPT_SUMMARY_MAX_LENGTH);
    expect(summary.endsWith("...")).toBe(true);
    expect(summary.startsWith("Example Shop EX-20931: Item number 0, ")).toBe(
      true,
    );
  });

  it("is not cut at exactly 300 characters", () => {
    const name = "n".repeat(300 - "Example Shop EX-20931: ".length);
    const summary = summaryOf(
      example({ items: [{ name, qty: 1, amount: 1, categoryId: null }] }),
    );
    expect(summary).toHaveLength(300);
    expect(summary?.endsWith("...")).toBe(false);
  });

  it("carries no description when there is nothing to say", () => {
    const result = buildReceiptProposal(
      example({
        complete: false,
        reason: "no_total",
        items: [],
        orderId: null,
      }),
      { ...TX, payeeId: "p" },
      { ...CTX, parserName: "" },
    );
    expect(result).toEqual({ input: null, kind: "none", reason: "no_total" });
  });
});

describe("buildReceiptProposal: the description", () => {
  const descriptionFor = (existing: string | null, parsed = example()) =>
    buildReceiptProposal(parsed, { ...TX, description: existing }, CTX).input
      ?.description;

  it("is the summary when the transaction has none", () => {
    expect(descriptionFor(null)).toBe(SUMMARY);
    expect(descriptionFor("")).toBe(SUMMARY);
    expect(descriptionFor("   ")).toBe(SUMMARY);
  });

  it("appends the summary to an existing description with ' | '", () => {
    expect(descriptionFor("CARD PAYMENT")).toBe(`CARD PAYMENT | ${SUMMARY}`);
    expect(descriptionFor("  CARD PAYMENT  ")).toBe(
      `CARD PAYMENT | ${SUMMARY}`,
    );
  });

  it("leaves a description that already holds the summary, ignoring case", () => {
    expect(descriptionFor(`note: ${SUMMARY}`)).toBeUndefined();
    expect(descriptionFor(SUMMARY.toUpperCase())).toBeUndefined();
    // The itemized proposal is still made; only the description is left out.
    const result = buildReceiptProposal(
      example(),
      { ...TX, description: SUMMARY },
      CTX,
    );
    expect(result.kind).toBe("itemized");
    expect(result.input?.description).toBeUndefined();
  });

  it("caps the result at 750 characters", () => {
    const existing = "d".repeat(740);
    const result = descriptionFor(existing) ?? "";
    expect(result).toHaveLength(750);
    expect(result.startsWith(`${existing} | Example`)).toBe(true);
  });

  it("carries no description when the cap leaves the text unchanged", () => {
    expect(descriptionFor("d".repeat(750))).toBeUndefined();
    expect(descriptionFor("d".repeat(800))).toBeUndefined();
  });
});

describe("buildReceiptProposal: the payee", () => {
  it("proposes the parser payee's name only when the transaction has no payee", () => {
    const without = buildReceiptProposal(example(), TX, CTX);
    expect(without.input?.payeeName).toBe("Example Shop Ltd");
    const withPayee = buildReceiptProposal(
      example(),
      { ...TX, payeeId: "payee-1" },
      CTX,
    );
    expect(withPayee.input?.payeeName).toBeUndefined();
  });

  it("proposes nothing when the parser has no payee name", () => {
    expect(
      buildReceiptProposal(example(), TX, { ...CTX, payeeName: null }).input
        ?.payeeName,
    ).toBeUndefined();
    expect(
      buildReceiptProposal(example(), TX, { ...CTX, payeeName: "  " }).input
        ?.payeeName,
    ).toBeUndefined();
  });

  it("trims the name", () => {
    expect(
      buildReceiptProposal(example(), TX, { ...CTX, payeeName: " Shop " }).input
        ?.payeeName,
    ).toBe("Shop");
  });

  it("is enough to make a description-only proposal worth returning", () => {
    const result = buildReceiptProposal(
      example({ complete: false, reason: "no_total" }),
      { ...TX, description: SUMMARY },
      CTX,
    );
    expect(result).toEqual({
      kind: "description_only",
      reason: "no_total",
      input: { payeeName: "Example Shop Ltd" },
    });
  });
});

describe("buildReceiptProposal: a proposal that would carry nothing", () => {
  it("returns no input and kind none, keeping the reason", () => {
    const result = buildReceiptProposal(
      example({ complete: false, reason: "items_unbalanced" }),
      { ...TX, description: SUMMARY, payeeId: "payee-1" },
      CTX,
    );
    expect(result).toEqual({
      input: null,
      kind: "none",
      reason: "items_unbalanced",
    });
  });

  it("keeps amount_differs as the reason", () => {
    const result = buildReceiptProposal(
      example(),
      { amount: -1, description: SUMMARY, payeeId: "payee-1" },
      CTX,
    );
    expect(result).toEqual({
      input: null,
      kind: "none",
      reason: "amount_differs",
    });
  });
});

describe("buildReceiptProposal: an internal inconsistency", () => {
  it("throws when the split lines do not sum to the transaction", () => {
    // Claims to be complete and equal to the transaction, but its lines add up to 34.98.
    const lying = example({
      shipping: null,
      discount: null,
      shippingCategoryId: null,
    });
    expect(() => buildReceiptProposal(lying, TX, CTX)).toThrow(
      /split lines sum to -34.98, the transaction is -37.97/,
    );
  });
});
