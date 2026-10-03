import { matchesAliasPattern } from "../../payees/alias-match.util";
import type { GlobCaptures } from "../../transaction-rules/rule-glob-capture";
import {
  isPlainReceiptAmount,
  parseReceiptAmount,
  parseReceiptQty,
} from "./receipt-amount";
import { matchReceiptPattern } from "./receipt-glob";
import {
  MAX_ITEMS,
  MAX_LINE_LENGTH,
  MAX_PARSE_LINES,
  ParsedReceipt,
  ParsedReceiptItem,
  ParsedReceiptReason,
  ReceiptParserDefinition,
} from "./receipt-parser.types";

/**
 * The receipt parser (design 5.1 and 5.3, spec section 4): one definition,
 * the subject and the text of one email in, what the email says out. Pure: no
 * database, no clock, no regular expression over email text (every pattern is
 * a rule glob matched against one line at a time), and integer arithmetic only
 * (amounts are 1/10000 units).
 */

/** Whitespace, NBSP included, folded to one space; trimmed; cut to the line bound. */
function normalizeLine(line: string): string {
  const folded = line.replace(/\s+/g, " ").trim();
  return folded.length > MAX_LINE_LENGTH
    ? folded.slice(0, MAX_LINE_LENGTH).trimEnd()
    : folded;
}

/**
 * Split the text of an email into the lines a parser reads: split on line
 * breaks, runs of whitespace (non-breaking spaces included) collapsed to one
 * space, trimmed, empty lines dropped, each line cut to 500 characters and at
 * most 2,000 lines kept.
 */
export function normalizeReceiptLines(text: string): string[] {
  if (typeof text !== "string") return [];
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = normalizeLine(raw);
    if (line === "") continue;
    lines.push(line);
    if (lines.length >= MAX_PARSE_LINES) break;
  }
  return lines;
}

/** An order number has no spaces: only the first whitespace-delimited token of the capture is kept. */
const orderIdToken = (captures: GlobCaptures): string =>
  captures.orderid?.trim().split(/\s+/)[0] ?? "";

/** The order id: subject first, then each line; the first pattern that captures one or more characters wins. */
function findOrderId(
  patterns: readonly string[] | undefined,
  subject: string,
  lines: readonly string[],
): string | null {
  if (!patterns) return null;
  const usable = (captures: GlobCaptures): boolean =>
    orderIdToken(captures) !== "";
  for (const text of [subject, ...lines]) {
    for (const pattern of patterns) {
      const captures = matchReceiptPattern(pattern, text, usable);
      if (captures !== null) return orderIdToken(captures);
    }
  }
  return null;
}

/** An `amount` capture that is an amount and nothing else but a currency mark. */
const hasPlainAmount = (captures: GlobCaptures): boolean =>
  captures.amount !== undefined && isPlainReceiptAmount(captures.amount);

/** The first line matching any pattern whose `amount` capture parses. */
function findAmount(
  patterns: readonly string[] | undefined,
  lines: readonly string[],
): number | null {
  if (!patterns) return null;
  for (const line of lines) {
    for (const pattern of patterns) {
      const captures = matchReceiptPattern(pattern, line, hasPlainAmount);
      if (captures !== null) return parseReceiptAmount(captures.amount);
    }
  }
  return null;
}

/** The lines between `startAfter` and `stopAt` (both optional, case-insensitive substrings). */
function itemSection(
  lines: readonly string[],
  startAfter: string | undefined,
  stopAt: string | undefined,
): readonly string[] {
  let start = 0;
  if (startAfter !== undefined) {
    const marker = startAfter.toLowerCase();
    const at = lines.findIndex((line) => line.toLowerCase().includes(marker));
    // A start marker that never appears leaves no section to read: reading from
    // the top instead would take the header and the totals for items.
    if (at === -1) return [];
    start = at + 1;
  }
  let end = lines.length;
  if (stopAt !== undefined) {
    const marker = stopAt.toLowerCase();
    for (let i = start; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(marker)) {
        end = i;
        break;
      }
    }
  }
  return lines.slice(start, end);
}

/** Name, qty and line total in units from the captures of an item pattern, or null when they do not read. */
function readItemCaptures(
  captures: GlobCaptures,
): { name: string; qty: number; amount: number } | null {
  const name = captures.name?.trim() ?? "";
  if (name === "") return null;
  const qty = captures.qty === undefined ? 1 : parseReceiptQty(captures.qty);
  if (qty === null) return null;
  // The line total is the `amount` capture, else the unit `price` times qty.
  const money = captures.amount ?? captures.price;
  if (money === undefined) return null;
  const units = parseReceiptAmount(money);
  if (units === null || !isPlainReceiptAmount(money)) return null;
  const amount = captures.amount === undefined ? units * qty : units;
  return Number.isSafeInteger(amount) ? { name, qty, amount } : null;
}

/** One item line read by one pattern, or null when neither reading of the line is usable. */
function readItem(
  line: string,
  pattern: string,
): { name: string; qty: number; amount: number } | null {
  const captures = matchReceiptPattern(
    pattern,
    line,
    (c) => readItemCaptures(c) !== null,
  );
  return captures === null ? null : readItemCaptures(captures);
}

/** The category of an item: the first matching rule, else the default, else the payee's default, else none. */
function itemCategory(
  def: ReceiptParserDefinition,
  name: string,
  fallbackCategoryId: string | null,
): string | null {
  for (const rule of def.categoryRules ?? []) {
    if (matchesAliasPattern(name, rule.match)) return rule.categoryId;
  }
  return def.defaultCategoryId ?? fallbackCategoryId;
}

function parseItems(
  def: ReceiptParserDefinition,
  lines: readonly string[],
  fallbackCategoryId: string | null,
): ParsedReceiptItem[] {
  if (!def.items) return [];
  const items: ParsedReceiptItem[] = [];
  for (const line of itemSection(
    lines,
    def.items.startAfter,
    def.items.stopAt,
  )) {
    for (const pattern of def.items.patterns) {
      const item = readItem(line, pattern);
      if (item === null) continue;
      items.push({
        ...item,
        categoryId: itemCategory(def, item.name, fallbackCategoryId),
      });
      break;
    }
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * The first thing missing, in the order of the spec's completeness table
 * (section 4); null when the receipt is complete. The one truth table: a
 * receipt read by the AI is judged by this function too.
 */
export function completeness(
  parsed: Omit<ParsedReceipt, "complete" | "reason" | "source">,
): ParsedReceiptReason | null {
  const { total, items, shipping, discount } = parsed;
  if (total === null) return "no_total";
  if (items.length === 0) return "no_items";
  const itemsUnits = items.reduce((sum, item) => sum + item.amount, 0);
  if (itemsUnits + (shipping ?? 0) - (discount ?? 0) !== total) {
    return "items_unbalanced";
  }
  const discountUncategorized =
    (discount ?? 0) > 0 && parsed.discountCategoryId === null;
  if (items.some((item) => item.categoryId === null) || discountUncategorized) {
    return "items_uncategorized";
  }
  if ((shipping ?? 0) > 0 && parsed.shippingCategoryId === null) {
    return "shipping_uncategorized";
  }
  return null;
}

/**
 * Read one email with a parser definition. `fallbackCategoryId` is the parser
 * payee's default category, used for an item no rule categorises and no
 * `defaultCategoryId` covers.
 *
 * The shipping line is categorised by `shippingCategoryId` alone, the discount
 * line by `defaultCategoryId` (else the fallback): a parser must say where
 * shipping goes before the receipt counts as complete.
 */
export function parseReceipt(
  def: ReceiptParserDefinition,
  subject: string,
  bodyText: string,
  fallbackCategoryId: string | null,
): ParsedReceipt {
  const lines = normalizeReceiptLines(bodyText);
  const parsed = {
    orderId: findOrderId(
      def.orderId,
      typeof subject === "string" ? normalizeLine(subject) : "",
      lines,
    ),
    total: findAmount(def.total, lines),
    shipping: findAmount(def.shipping, lines),
    discount: findAmount(def.discount, lines),
    items: parseItems(def, lines, fallbackCategoryId),
    shippingCategoryId: def.shippingCategoryId ?? null,
    discountCategoryId: def.defaultCategoryId ?? fallbackCategoryId,
  };
  const reason = completeness(parsed);
  return { ...parsed, complete: reason === null, reason };
}
