import { stripHtml } from "../../common/sanitization.util";
import { completeness } from "../parsing/parse-receipt";
import {
  isPlainReceiptAmount,
  parseReceiptAmount,
} from "../parsing/receipt-amount";
import type {
  ParsedReceipt,
  ParsedReceiptItem,
} from "../parsing/receipt-parser.types";
import {
  extractJsonObject,
  receiptExtractionSchema,
  type ReceiptExtractionAnswer,
} from "./email-receipt-ai.schema";

/**
 * The AI's answer as a `ParsedReceipt` (spec "AI extraction"). The model reads
 * the email; it never writes a split. Its answer takes the shape a saved parser
 * produces and is judged by the same completeness function
 * (`parse-receipt.ts`) and turned into a proposal by the same builder
 * (`buildReceiptProposal`), so a receipt read by the AI and one read by a parser
 * are proposed, refused and described by one set of rules. Pure: no database, no
 * provider call.
 */

const MONEY_UNITS = 10000;

export type AiExtraction =
  | {
      ok: true;
      /** What the AI read, marked `source: "ai"`. */
      parsed: ParsedReceipt;
      /** The AI's own one-line summary, cleaned; null when it gave none. */
      description: string | null;
      /** What was dropped or read as unknown, for the log and a refusal's note. */
      notes: string[];
    }
  | { ok: false; note: string };

/** Text from an email or a model: tags stripped, whitespace folded. */
const clean = (text: string): string =>
  (stripHtml(text) ?? "").replace(/\s+/g, " ").trim();

/**
 * One amount as 1/10000 units, or null when it is not a non-negative amount.
 * A JSON number must be finite and not negative and is scaled once with
 * `Math.round(n * 10000)`; a string goes through the receipt amount grammar
 * (spec section 2) and must hold nothing but the amount and a currency mark, as
 * a parser's amount capture must.
 */
export function aiAmountToUnits(value: string | number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const units = Math.round(value * MONEY_UNITS);
    return Number.isSafeInteger(units) ? units : null;
  }
  return isPlainReceiptAmount(value) ? parseReceiptAmount(value) : null;
}

/**
 * Read a model's reply. A reply that is not JSON, or not the bounded shape, is
 * refused whole. Inside a good one: an item whose amount does not convert (or is
 * not above zero) or whose name is empty is dropped; a shipping, discount or
 * total that does not convert is read as not stated; a `categoryId` that is not
 * in `categories` is none, as is an unknown `shippingCategoryId` or
 * `discountCategoryId`. Every such step is named in `notes`. The shipping and
 * discount categories go into the receipt as a parser's would, so a reading
 * with shipping or a discount is `complete` when the completeness rules say so.
 */
export function buildAiParsedReceipt(
  content: string,
  categories: ReadonlyMap<string, string>,
): AiExtraction {
  const raw = extractJsonObject(content);
  if (raw === undefined) {
    return { ok: false, note: "The AI's answer was not JSON." };
  }
  const checked = receiptExtractionSchema.safeParse(raw);
  if (!checked.success) {
    return {
      ok: false,
      note: "The AI's answer did not have the expected shape.",
    };
  }
  const answer: ReceiptExtractionAnswer = checked.data;
  const notes: string[] = [];

  const categoryById = new Map(
    [...categories.keys()].map((id) => [id.toLowerCase(), id]),
  );
  let unknownCategories = 0;
  /** A category id the model sent: one of the user's, else none (and noted). */
  const resolveCategory = (id: string | undefined): string | null => {
    if (id === undefined) return null;
    const known = categoryById.get(id.toLowerCase()) ?? null;
    if (known === null) unknownCategories++;
    return known;
  };
  const items: ParsedReceiptItem[] = [];
  let dropped = 0;
  for (const item of answer.items) {
    const name = clean(item.name);
    const units = aiAmountToUnits(item.amount);
    if (name === "" || units === null || units === 0) {
      dropped++;
      continue;
    }
    const categoryId = resolveCategory(item.categoryId);
    items.push({ name, qty: item.qty ?? 1, amount: units, categoryId });
  }
  if (dropped > 0) {
    notes.push(`${dropped} item(s) dropped: no name or no readable amount.`);
  }

  const figure = (
    label: string,
    value: string | number | undefined,
  ): number | null => {
    if (value === undefined) return null;
    const units = aiAmountToUnits(value);
    if (units === null) notes.push(`The ${label} was not a readable amount.`);
    return units;
  };
  const total = figure("total", answer.total);
  const shipping = figure("shipping", answer.shipping);
  const discount = figure("discount", answer.discount);
  const shippingCategoryId = resolveCategory(answer.shippingCategoryId);
  const discountCategoryId = resolveCategory(answer.discountCategoryId);
  if (unknownCategories > 0) {
    notes.push(`${unknownCategories} category id(s) not in the list.`);
  }
  const orderId =
    answer.orderId === undefined ? "" : clean(answer.orderId).slice(0, 100);

  const base = {
    orderId: orderId === "" ? null : orderId,
    total,
    shipping,
    discount,
    items,
    shippingCategoryId,
    discountCategoryId,
  };
  const reason = completeness(base);
  const description =
    answer.description === undefined ? "" : clean(answer.description);
  return {
    ok: true,
    parsed: { ...base, complete: reason === null, reason, source: "ai" },
    description: description === "" ? null : description,
    notes,
  };
}
