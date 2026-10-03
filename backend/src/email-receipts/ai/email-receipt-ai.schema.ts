import { z } from "zod";

/** The longest reply read at all: a model that answers with a book is refused. */
const MAX_REPLY_CHARS = 200_000;

/**
 * The JSON object in a model's reply, or undefined. Tolerates a fenced
 * ```json block and prose around one object (first `{` to last `}`); never
 * throws, and reads nothing past `MAX_REPLY_CHARS`.
 */
export function extractJsonObject(content: unknown): unknown {
  if (typeof content !== "string" || content.length > MAX_REPLY_CHARS) {
    return undefined;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const candidates = [
    fenced?.[1] ?? null,
    content,
    content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1),
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // try the next reading
    }
  }
  return undefined;
}

export const EXTRACTION_MAX_ITEMS = 100;
export const EXTRACTION_MAX_ORDER_ID = 100;
export const EXTRACTION_MAX_ITEM_NAME = 200;
export const EXTRACTION_MAX_DESCRIPTION = 300;
/** Longest amount text read: more than any amount written on a receipt. */
const MAX_AMOUNT_TEXT = 40;
/** Longest category id read; a longer string is not an id and reads as none. */
const MAX_CATEGORY_ID = 100;
const MAX_QTY = 9999;

/** A model leaves a key out as often as it sends null: both mean "not given". */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

/** An amount as the email wrote it: text ("1.234,56 zl") or a plain JSON number. */
const amountValue = z.union([
  z.string().trim().min(1).max(MAX_AMOUNT_TEXT),
  z.number().finite(),
]);

/**
 * What the AI reads out of an order email (spec "AI extraction"): the receipt's
 * own content, never a split of the transaction. Amounts are the line totals as
 * the email states them; they become 1/10000 units in
 * `buildAiParsedReceipt`, which also drops what does not convert. Unknown keys
 * are refused, so an answer cannot carry an account, a date or a status for the
 * transaction.
 */
export const receiptExtractionSchema = z
  .object({
    orderId: optional(z.string().trim().max(EXTRACTION_MAX_ORDER_ID)),
    items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(EXTRACTION_MAX_ITEM_NAME),
            qty: optional(z.number().int().min(1).max(MAX_QTY)),
            amount: amountValue,
            categoryId: optional(z.string().trim().max(MAX_CATEGORY_ID)),
          })
          .strict(),
      )
      .max(EXTRACTION_MAX_ITEMS),
    shipping: optional(amountValue),
    shippingCategoryId: optional(z.string().trim().max(MAX_CATEGORY_ID)),
    discount: optional(amountValue),
    discountCategoryId: optional(z.string().trim().max(MAX_CATEGORY_ID)),
    total: optional(amountValue),
    description: optional(z.string().trim().max(EXTRACTION_MAX_DESCRIPTION)),
  })
  .strict();

export type ReceiptExtractionAnswer = z.infer<typeof receiptExtractionSchema>;
