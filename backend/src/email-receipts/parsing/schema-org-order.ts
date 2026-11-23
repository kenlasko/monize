import {
  collectStructuredData,
  type MicrodataItem,
  type StructuredHtmlData,
} from "../imap/html-lines.util";
import { completeness } from "./parse-receipt";
import { foldWhitespace } from "./receipt-lines";
import {
  MAX_ITEMS,
  type ParsedReceipt,
  type ParsedReceiptItem,
} from "./receipt-parser.types";
import {
  FIAT_MONEY_DECIMALS,
  moneyUnits as exactMoneyUnits,
} from "../../common/round.util";

/**
 * The order an email carries as structured data for the mail client's own
 * order card (schema.org `Order` or `Invoice`, as JSON-LD or microdata; Google's
 * "Order" markup for Gmail). Pure: the HTML is scanned by
 * `imap/html-lines.util.ts` (the one file that imports `htmlparser2`), and
 * everything here reads the data that scan collected.
 *
 * The data is whatever the sender wrote: every walk is bounded (depth, nodes,
 * items, lengths), nothing is evaluated, `JSON.parse` failures are ignored, and a
 * property is read by a fixed name through `own()`. Amounts are machine numbers
 * (`24.99` or `"24.99"`), converted to 1/10000 units by `moneyUnits` (NOT the
 * receipt amount grammar, which is for the shop's own wording); a negative, a
 * non-finite or an unreadable value is `null`, never `0`.
 */

/** One line of a schema.org order. */
export interface SchemaOrgOrderItem {
  name: string;
  /** A positive integer; 1 when the markup states none (or one that is not a whole number). */
  qty: number;
  /** The line total in 1/10000 units: `unitPrice * qty`; null when there is no unit price. */
  amount: number | null;
  /** The unit price in 1/10000 units; null when the markup states none. */
  unitPrice: number | null;
}

/** What an `Order` or `Invoice` of schema.org says, in the units the receipt pipeline uses. */
export interface SchemaOrgOrder {
  orderNumber: string | null;
  /** `seller.name`, else `merchant.name`, `provider.name` or `broker.name`. */
  seller: string | null;
  /** An ISO 4217 code, upper-case; display only (nothing converts by it). */
  currency: string | null;
  /** As written (an ISO date or date-time); display only. */
  orderDate: string | null;
  /** The order's total in 1/10000 units; null when the markup states none. */
  total: number | null;
  discount: number | null;
  items: SchemaOrgOrderItem[];
}

/** Bounds of the JSON-LD walk. */
export const SCHEMA_ORG_MAX_DEPTH = 20;
export const SCHEMA_ORG_MAX_NODES = 2000;
const MAX_TEXT_CHARS = 200;
const MAX_ORDER_NUMBER_CHARS = 100;
const MAX_QUANTITY = 9999;
/** Whole units above this cannot be held as 1/10000 units in a safe integer. */
const MAX_INTEGER_DIGITS = 11;
const UNITS = 10000;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A property by its own name only: `constructor`, `__proto__` and the like are never read through the prototype. */
function own(node: Node, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(node, key)
    ? node[key]
    : undefined;
}

/** A JSON-LD value as its list: an array is its elements, anything else is one. */
const asList = (value: unknown): unknown[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];

/** `{"@value": x}` is x; a value that is not an object is itself. */
function unwrap(value: unknown): unknown {
  return isNode(value) && own(value, "@value") !== undefined
    ? own(value, "@value")
    : value;
}

// ------------------------------------------------------------------ text

/** Trimmed, whitespace-folded text from a string or a finite number; null for anything else or empty. */
function textOf(value: unknown, max = MAX_TEXT_CHARS): string | null {
  const raw = unwrap(value);
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
  else return null;
  const folded = foldWhitespace(text).trim();
  if (folded === "") return null;
  return folded.length > max ? folded.slice(0, max).trimEnd() : folded;
}

/** The `name` of a party that may be written as an object or as plain text. */
function nameOf(value: unknown): string | null {
  for (const entry of asList(value)) {
    const name = isNode(entry) ? textOf(own(entry, "name")) : textOf(entry);
    if (name !== null) return name;
  }
  return null;
}

// ----------------------------------------------------------------- money

/**
 * A machine decimal in 1/10000 units: digits, optionally a dot and digits. A
 * thousands separator, a currency mark, a comma, a sign or an exponent is not
 * one, so the Polish `1 234,56 zł` is refused here by design. Done on the digits
 * (no float), rounding a fifth fraction digit half up.
 */
function decimalUnits(text: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  if (whole.length > MAX_INTEGER_DIGITS) return null;
  const fraction = match[2] ?? "";
  let units = Number(whole) * UNITS + Number((fraction + "0000").slice(0, 4));
  if (fraction.length > 4 && fraction.charCodeAt(4) >= 0x35) units += 1;
  return Number.isSafeInteger(units) ? units : null;
}

/** A JSON number in 1/10000 units: finite, not negative, rounded once. */
function numberUnits(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const units = exactMoneyUnits(value, FIAT_MONEY_DECIMALS);
  return Number.isSafeInteger(units) && value < 10 ** MAX_INTEGER_DIGITS
    ? units
    : null;
}

/**
 * An amount in 1/10000 units from a number, a decimal string, a `{@value}`, or
 * a price-like object (`price`, else `value`; `depth` bounds the descent). Null
 * when it is none of those, or negative.
 */
function moneyUnits(value: unknown, depth = 0): number | null {
  const raw = unwrap(value);
  if (typeof raw === "number") return numberUnits(raw);
  if (typeof raw === "string") return decimalUnits(raw);
  if (Array.isArray(raw))
    return depth < 2 ? moneyUnits(raw[0], depth + 1) : null;
  if (isNode(raw) && depth < 2) {
    const price = own(raw, "price");
    return moneyUnits(
      price !== undefined ? price : own(raw, "value"),
      depth + 1,
    );
  }
  return null;
}

/** A whole number from 1 to 9999 as a JSON number or digit string, or a `{value}` holding one; else null. */
function quantityOf(value: unknown, depth = 0): number | null {
  const raw = unwrap(value);
  let number: number;
  if (typeof raw === "number") number = raw;
  else if (typeof raw === "string" && /^\d{1,5}$/.test(raw.trim())) {
    number = Number(raw.trim());
  } else if (Array.isArray(raw)) {
    return depth < 2 ? quantityOf(raw[0], depth + 1) : null;
  } else if (isNode(raw) && depth < 2) {
    return quantityOf(own(raw, "value"), depth + 1);
  } else return null;
  return Number.isInteger(number) && number >= 1 && number <= MAX_QUANTITY
    ? number
    : null;
}

// ----------------------------------------------------------------- items

/** The first of several properties that holds an amount, in the order given. */
function firstMoney(node: Node, keys: readonly string[]): number | null {
  for (const key of keys) {
    const units = moneyUnits(own(node, key));
    if (units !== null) return units;
  }
  return null;
}

/** The first of an item's properties (an offer's `itemOffered`, an order item's `orderedItem`) that is an object. */
function productOf(entry: Node): Node | null {
  for (const key of ["itemOffered", "orderedItem"]) {
    const found = asList(own(entry, key)).find(isNode);
    if (found !== undefined) return found;
  }
  return null;
}

/** The first of an item's properties that is plain text (`"itemOffered": "Widget"`). */
function productText(entry: Node): string | null {
  for (const key of ["itemOffered", "orderedItem"]) {
    for (const value of asList(own(entry, key))) {
      const text = textOf(value);
      if (text !== null) return text;
    }
  }
  return null;
}

/**
 * An `Offer` (its `itemOffered`), an `OrderItem` (its `orderedItem` and
 * `orderQuantity`) or a bare product, as one line; null when it names nothing.
 * The unit price is the entry's `price` or `priceSpecification`, else the
 * product's own `price`, else its first offer's. The quantity is
 * `eligibleQuantity` (an offer) or `orderQuantity`, a whole number from 1 to
 * 9999, else 1.
 */
function readItem(entry: unknown): SchemaOrgOrderItem | null {
  if (!isNode(entry)) {
    const name = textOf(entry);
    return name === null
      ? null
      : { name, qty: 1, amount: null, unitPrice: null };
  }
  const product = productOf(entry);
  const holder = product ?? entry;
  const name =
    (product === null ? null : textOf(own(product, "name"))) ??
    productText(entry) ??
    textOf(own(entry, "name"));
  if (name === null) return null;

  const offer = asList(own(holder, "offers")).find(isNode);
  const unitPrice =
    firstMoney(entry, ["price", "priceSpecification"]) ??
    (product === null ? null : firstMoney(product, ["price"])) ??
    (offer === undefined
      ? null
      : firstMoney(offer, ["price", "priceSpecification"]));

  const stated =
    own(entry, "eligibleQuantity") !== undefined
      ? own(entry, "eligibleQuantity")
      : own(entry, "orderQuantity");
  const qty = quantityOf(stated) ?? 1;
  const line = unitPrice === null ? null : unitPrice * qty;
  const amount = line !== null && Number.isSafeInteger(line) ? line : null;
  return { name, qty, amount, unitPrice };
}

/** The order's lines: `acceptedOffer` when it yields any, else `orderedItem`. */
function readItems(order: Node): SchemaOrgOrderItem[] {
  for (const key of ["acceptedOffer", "orderedItem"]) {
    const items: SchemaOrgOrderItem[] = [];
    for (const entry of asList(own(order, key))) {
      const item = readItem(entry);
      if (item !== null) items.push(item);
      if (items.length >= MAX_ITEMS) break;
    }
    if (items.length > 0) return items;
  }
  return [];
}

// ------------------------------------------------------------- the order

function currencyOf(order: Node): string | null {
  const holders: unknown[] = [
    order,
    own(order, "totalPaymentDue"),
    own(order, "priceSpecification"),
    ...asList(own(order, "acceptedOffer")),
  ];
  for (const holder of holders) {
    for (const node of asList(holder)) {
      if (!isNode(node)) continue;
      const code = textOf(own(node, "priceCurrency"), 10);
      if (code !== null && /^[A-Za-z]{3}$/.test(code))
        return code.toUpperCase();
    }
  }
  return null;
}

function readOrder(node: Node): SchemaOrgOrder {
  let seller: string | null = null;
  for (const key of ["seller", "merchant", "provider", "broker"]) {
    seller = nameOf(own(node, key));
    if (seller !== null) break;
  }
  return {
    orderNumber:
      textOf(own(node, "orderNumber"), MAX_ORDER_NUMBER_CHARS) ??
      textOf(own(node, "confirmationNumber"), MAX_ORDER_NUMBER_CHARS),
    seller,
    currency: currencyOf(node),
    orderDate: textOf(own(node, "orderDate"), 40),
    total: firstMoney(node, [
      "price",
      "totalPrice",
      "totalPaymentDue",
      "priceSpecification",
    ]),
    discount: moneyUnits(own(node, "discount")),
    items: readItems(node),
  };
}

/** `Order` or `Invoice`, with or without a schema.org prefix (`https://schema.org/Order`, `schema:Order`). */
function isOrderType(type: unknown): boolean {
  return asList(type).some((entry) => {
    if (typeof entry !== "string") return false;
    const name = entry.trim().split(/[/:#]/).pop();
    return name === "Order" || name === "Invoice";
  });
}

/** The order and invoice nodes of one JSON-LD document, in document order, within the depth and node bounds. */
function orderNodes(root: unknown, found: Node[]): void {
  let visited = 0;
  const walk = (value: unknown, depth: number): void => {
    if (visited >= SCHEMA_ORG_MAX_NODES || depth > SCHEMA_ORG_MAX_DEPTH) return;
    if (typeof value !== "object" || value === null) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    const node = value as Node;
    if (isOrderType(own(node, "@type"))) found.push(node);
    for (const key of Object.keys(node)) walk(node[key], depth + 1);
  };
  walk(root, 0);
}

/** A microdata item as the plain object a JSON-LD node would be (repeated properties become a list). */
function microdataNode(
  item: MicrodataItem,
  depth: number,
  budget: { left: number },
): Node {
  const node: Node = Object.create(null);
  node["@type"] = item.types;
  if (depth > SCHEMA_ORG_MAX_DEPTH) return node;
  for (const prop of item.props) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    const value =
      typeof prop.value === "string"
        ? prop.value
        : microdataNode(prop.value, depth + 1, budget);
    const before = node[prop.name];
    node[prop.name] = before === undefined ? value : [...asList(before), value];
  }
  return node;
}

/** Whether a reading is something to build a receipt from: a total and at least one line. */
export function isUsableSchemaOrgOrder(order: SchemaOrgOrder): boolean {
  return order.total !== null && order.items.length > 0;
}

const hasContent = (order: SchemaOrgOrder): boolean =>
  order.orderNumber !== null || order.total !== null || order.items.length > 0;

/**
 * The order the collected structured data describes, or null when it has none.
 * JSON-LD scripts come first (in document order), then the microdata items. The
 * first reading with a total and a line wins; failing that, the first with any
 * content (so a person can see what was found); a node of another type, a
 * script that is not JSON and an order with nothing in it are ignored.
 */
export function orderFromStructuredData(
  data: StructuredHtmlData,
): SchemaOrgOrder | null {
  const nodes: Node[] = [];
  for (const text of data.jsonLd) {
    let root: unknown;
    try {
      root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      continue;
    }
    orderNodes(root, nodes);
  }
  const budget = { left: SCHEMA_ORG_MAX_NODES };
  for (const item of data.microdata) {
    orderNodes(microdataNode(item, 0, budget), nodes);
  }
  let first: SchemaOrgOrder | null = null;
  for (const node of nodes) {
    const order = readOrder(node);
    if (isUsableSchemaOrgOrder(order)) return order;
    if (first === null && hasContent(order)) first = order;
  }
  return first;
}

/** The schema.org order an HTML body carries, or null (see `orderFromStructuredData`). */
export function extractSchemaOrgOrder(html: string): SchemaOrgOrder | null {
  return orderFromStructuredData(collectStructuredData(html));
}

/**
 * The receipt a schema.org order amounts to (`source: "schema_org"`), judged by
 * the same `completeness` a parser's reading is. `categoryId` is the default
 * category of the payee the seller resolves to (null when there is none); every
 * item and the discount line take it. A line with no unit price takes the order
 * total when it is the only line (as a parser's item does), else the reading is
 * `item_amount_missing`. Shipping is not read: an order whose lines plus its
 * shipping make the total is `items_unbalanced`, and says so.
 */
export function schemaOrgToParsedReceipt(
  order: SchemaOrgOrder,
  categoryId: string | null,
): ParsedReceipt {
  const only = order.items.length === 1 ? order.total : null;
  const resolved = order.items.map((item) => ({
    ...item,
    amount: item.amount ?? only,
  }));
  const kept: ParsedReceiptItem[] = [];
  for (const item of resolved) {
    if (item.amount === null) continue;
    kept.push({
      name: item.name,
      qty: item.qty,
      amount: item.amount,
      categoryId,
    });
  }
  const base = {
    orderId: order.orderNumber,
    total: order.total,
    paid: null,
    payee: order.seller,
    shipping: null,
    discount: order.discount,
    items: kept,
    shippingCategoryId: null,
    discountCategoryId: categoryId,
  };
  const reason = completeness(base, kept.length !== resolved.length);
  return {
    ...base,
    complete: reason === null,
    reason,
    source: "schema_org",
  };
}
