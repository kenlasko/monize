/**
 * The types of the email-receipt parser (design 5). Pure data: no behaviour,
 * no database, no clock. Every amount a parser reads is a non-negative
 * integer in 1/10000 units (spec section 1), the unit rule facts use.
 */

/** The only definition version this code reads or writes. */
export const RECEIPT_PARSER_VERSION = 1;

/** Design 5.2: bounds the validator enforces and the parser relies on. */
export const MAX_PATTERNS_PER_FIELD = 10;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_CATEGORY_RULES = 50;
export const MAX_SECTION_MARKER_LENGTH = 100;
/** Parsing reads at most this many lines of an email. */
export const MAX_PARSE_LINES = 2000;
/** Parsing keeps at most this many line items. */
export const MAX_ITEMS = 100;
/** A line is cut to this many characters (the glob matcher's own bound). */
export const MAX_LINE_LENGTH = 500;

/** The item section and the patterns that read one line item per line. */
export interface ReceiptItemsDefinition {
  /** Case-insensitive substring: items start on the line AFTER the first line holding it. */
  startAfter?: string;
  /** Case-insensitive substring: items end BEFORE the first line holding it after the start. */
  stopAt?: string;
  patterns: string[];
}

/** A category for every item whose name matches the glob. */
export interface ReceiptCategoryRule {
  match: string;
  categoryId: string;
}

/** A per-merchant parser, version 1 (the `definition` jsonb of `email_receipt_parsers`). */
export interface ReceiptParserDefinition {
  version: 1;
  orderId?: string[];
  total?: string[];
  shipping?: string[];
  discount?: string[];
  items?: ReceiptItemsDefinition;
  categoryRules?: ReceiptCategoryRule[];
  defaultCategoryId?: string;
  shippingCategoryId?: string;
}

/** One line item as read from the email. */
export interface ParsedReceiptItem {
  name: string;
  qty: number;
  /** The line total, in 1/10000 units. */
  amount: number;
  categoryId: string | null;
}

/** The first thing missing from a receipt that is not complete (spec section 4). */
export type ParsedReceiptReason =
  | "no_total"
  | "no_items"
  | "items_unbalanced"
  | "items_uncategorized"
  | "shipping_uncategorized";

/**
 * What a parser read from one email. Amounts are 1/10000 units. `total`,
 * `shipping` and `discount` are null when the email did not state them.
 *
 * `shippingCategoryId` and `discountCategoryId` are the categories the
 * proposal gives the shipping and discount lines; they are resolved here, from
 * the definition, so the proposal builder needs no definition.
 */
export interface ParsedReceipt {
  orderId: string | null;
  total: number | null;
  shipping: number | null;
  discount: number | null;
  items: ParsedReceiptItem[];
  shippingCategoryId: string | null;
  discountCategoryId: string | null;
  complete: boolean;
  reason: ParsedReceiptReason | null;
  /**
   * Who read the email: a saved parser (absent, as every receipt stored before
   * this field existed) or the AI (`"ai"`, spec "AI extraction"). It changes
   * nothing about the completeness rules or the proposal; it tells the reader
   * where the figures came from.
   */
  source?: "parser" | "ai";
}
