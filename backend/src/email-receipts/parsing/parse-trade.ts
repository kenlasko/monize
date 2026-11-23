import type { GlobCaptures } from "../../transaction-rules/rule-glob-capture";
import { findField } from "./parse-receipt";
import { normalizeLine, traceMatch } from "./receipt-lines";
import { matchReceiptLines, matchReceiptPattern } from "./receipt-glob";
import {
  MAX_TRADE_QUANTITY_DECIMALS,
  tradeActionMovesShares,
  type ParsedTrade,
  type ParsedTradeAction,
  type ParsedTradeCurrencySource,
  type ParsedTradeReason,
  type ReceiptFieldEntry,
  type ReceiptTradeDefinition,
  type ReceiptTradeTrace,
  type ReceiptTraceHit,
} from "./receipt-parser.types";
import { parseTradeNumber, tradeAmountCurrency } from "./trade-number";
import { toScaledUnits } from "../../common/round.util";

/**
 * The trade reader (design "Trade confirmations"): the lines of one brokerage
 * "order filled" email in, one {@link ParsedTrade} out. Pure: no database, no
 * clock, no regular expression built from the profile. It reuses the receipt
 * reader's field machinery (`findField`: entries in array order, line patterns
 * and labelled entries), so a trade profile reads exactly like a receipt one.
 *
 * Arithmetic is integer: money is 1/10000 units, a share count and a price are
 * held as integers of 1e-8 in a BigInt while they are multiplied, so neither a
 * fractional share (75.9878) nor a 4-decimal price (26.3201) is ever a float in
 * a comparison. Numbers are read with the trade grammar (`trade-number.ts`).
 */

const MONEY_UNITS = 10_000;
const MONEY_DECIMALS = 4;
const QUANTITY_UNITS = 100_000_000n;
/** A price is read to 8 decimals for the cross-check, stored to 4 for the card. */
const PRICE_DECIMALS = 8;
const ONE_CENT_UNITS = 100n;

/** English and French month names (Wealthsimple writes both). */
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  janvier: 1,
  janv: 1,
  février: 2,
  fevrier: 2,
  févr: 2,
  fevr: 2,
  mars: 3,
  avril: 4,
  avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  juil: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
  decembre: 12,
  déc: 12,
};

const isDigits = (text: string): boolean =>
  text !== "" && [...text].every((ch) => ch >= "0" && ch <= "9");

/**
 * A share count: a positive number with up to 8 decimals, in either decimal
 * convention ("75.9878", "75,9878", "1,234.5"); a sign is dropped (the action
 * says which way the shares moved). Anything else is null. Returned as the
 * exact integer of 1e-8 shares and as a number.
 */
export function parseTradeQuantity(
  text: string,
): { units: bigint; value: number } | null {
  const read = parseTradeNumber(text, MAX_TRADE_QUANTITY_DECIMALS);
  if (read === null || read.units === 0n) return null;
  return { units: read.units, value: Number(read.units) / 1e8 };
}

const REINVEST_WORDS = [
  "reinvest",
  "reinvested",
  "reinvestment",
  "drip",
  "réinvestir",
  "réinvesti",
  "réinvestis",
  "réinvestissement",
  "reinvesti",
  "reinvestissement",
];
const DIVIDEND_WORDS = [
  "dividend",
  "dividends",
  "distribution",
  "distributions",
  "dividende",
  "dividendes",
];

/**
 * What the text says the trade is (English or French): a reinvested dividend
 * when it names a reinvestment ("Dividend reinvested", "DRIP buy"); else a buy
 * or a sell when it names exactly one of them, even beside a dividend word (a
 * fund's name: "Bought 10 Vanguard High Dividend Yield"); else a cash dividend
 * when it names a dividend or a distribution. Null when it names none of them,
 * or both a buy and a sell.
 */
export function parseTradeAction(text: string): ParsedTradeAction | null {
  const words = text.toLowerCase().split(/[^a-zà-ÿ]+/);
  if (REINVEST_WORDS.some((w) => words.includes(w))) return "REINVEST";
  const buy = ["buy", "bought", "achat", "acheté", "achete"].some((w) =>
    words.includes(w),
  );
  const sell = ["sell", "sold", "vente", "vendu"].some((w) =>
    words.includes(w),
  );
  if (buy !== sell) return buy ? "BUY" : "SELL";
  if (buy) return null;
  return DIVIDEND_WORDS.some((w) => words.includes(w)) ? "DIVIDEND" : null;
}

/**
 * The day in a trade's date text:
 * - `YYYY-MM-DD`, also as the date of an ISO timestamp ("2026-10-15T12:04:00Z")
 *   or written `YYYY/MM/DD`;
 * - a month name with a day and a year, either order, English or French
 *   ("October 15, 2026 12:04 EDT", "15 Oct 2026", "15 octobre 2026", "1er mai 2026");
 * - a numeric day and month with a 4-digit year ("10/15/2026", "15.10.2026")
 *   only when which is the day is certain (one part above 12, or both equal).
 * The time and the zone are ignored on purpose: the text states the broker's
 * own local day, which is the day the trade is dated. Null when no real
 * calendar day is found.
 */
export function parseTradeDate(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/t\d.*$/, ""))
    .filter((t) => t !== "");
  for (const token of tokens) {
    const parts = token.split(/[-/]/);
    if (
      parts.length === 3 &&
      parts[0].length === 4 &&
      parts[1].length === 2 &&
      parts[2].length === 2 &&
      parts.every(isDigits)
    ) {
      return validDay(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    }
  }
  const dayOf = (token: string): string =>
    token.replace(/\.$/, "").replace(/(st|nd|rd|th|er)$/, "");
  const monthOf = (token: string): number | undefined =>
    MONTHS[token.replace(/\.$/, "")];
  for (let i = 0; i + 2 < tokens.length; i++) {
    const year = tokens[i + 2];
    if (year.length !== 4 || !isDigits(year)) continue;
    // Month day year ("October 15, 2026").
    const month = monthOf(tokens[i]);
    const day = dayOf(tokens[i + 1]);
    if (month && isDigits(day)) {
      return validDay(Number(year), month, Number(day));
    }
    // Day month year ("15 octobre 2026").
    const month2 = monthOf(tokens[i + 1]);
    const day2 = dayOf(tokens[i]);
    if (month2 && isDigits(day2)) {
      return validDay(Number(year), month2, Number(day2));
    }
  }
  for (const token of tokens) {
    const parts = token.split(/[/.]/);
    if (
      parts.length !== 3 ||
      parts[2].length !== 4 ||
      !parts.every(isDigits) ||
      parts[0].length > 2 ||
      parts[1].length > 2
    ) {
      continue;
    }
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    const year = Number(parts[2]);
    if (a > 12 && b <= 12) return validDay(year, b, a);
    if (b > 12 && a <= 12) return validDay(year, a, b);
    if (a === b) return validDay(year, a, b);
    return null;
  }
  return null;
}

function validDay(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2200 || month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > last) return null;
  const pad = (n: number, width: number): string =>
    String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * Whether quantity times price agrees with the executed total. A price written
 * with `d` decimals is within half a unit of its last place, so the product may
 * be off by `quantity * 0.5 * 10^-d`, plus one cent for the total's own
 * rounding. Commission is in the total of a buy (and of a reinvestment) and
 * out of a sell's proceeds (and of a dividend's).
 * `priceUnits8` is the price in 1e-8 units, exactly as written.
 */
export function tradeIsConsistent(input: {
  action: ParsedTradeAction;
  quantityUnits: bigint;
  priceUnits8: bigint;
  priceDecimals: number;
  totalUnits: number;
  commissionUnits: number;
}): boolean {
  const gross = commissionIsAdded(input.action)
    ? input.totalUnits - input.commissionUnits
    : input.totalUnits + input.commissionUnits;
  if (gross < 0) return false;
  // Both sides at 1e-16 of a currency unit: quantity (1e-8) * price (1e-8),
  // and the total (1e-4) scaled by 1e12.
  const product = input.quantityUnits * input.priceUnits8;
  const expected = BigInt(gross) * 1_000_000_000_000n;
  const diff = product > expected ? product - expected : expected - product;
  const decimals = Math.min(Math.max(input.priceDecimals, 0), PRICE_DECIMALS);
  const halfLastPlace = 10n ** BigInt(PRICE_DECIMALS - decimals) / 2n;
  const tolerance =
    input.quantityUnits * (halfLastPlace === 0n ? 1n : halfLastPlace) +
    ONE_CENT_UNITS * 1_000_000_000_000n;
  return diff <= tolerance;
}

/** Whether a commission is added to the trade's total (a buy, a reinvestment) rather than taken from its proceeds (a sell, a dividend). */
function commissionIsAdded(action: ParsedTradeAction): boolean {
  return action === "BUY" || action === "REINVEST";
}

/** An amount field (total, commission): the first capture `{amount}` the trade grammar reads, as 1/10000 units. */
function readTradeAmount(
  entries: readonly ReceiptFieldEntry[] | undefined,
  lines: readonly string[],
): { value: number; text: string; hit: ReceiptTraceHit } | null {
  const found = findField(
    entries,
    lines,
    (captures) =>
      captures.amount !== undefined &&
      parseTradeNumber(captures.amount, MONEY_DECIMALS) !== null,
  );
  if (found === null) return null;
  const read = parseTradeNumber(found.captures.amount, MONEY_DECIMALS);
  if (read === null || read.units > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return {
    value: Number(read.units),
    text: found.captures.amount,
    hit: found.hit,
  };
}

const hasCapture =
  (name: string) =>
  (captures: GlobCaptures): boolean =>
    (captures[name] ?? "").trim() !== "";

/** The first non-empty capture `name` a field reads, with what read it. */
function readText(
  entries: readonly ReceiptFieldEntry[] | undefined,
  lines: readonly string[],
  name: string,
  accept: (value: string) => boolean = () => true,
): { value: string; hit: ReceiptTraceHit } | null {
  const found = findField(
    entries,
    lines,
    (captures) => hasCapture(name)(captures) && accept(captures[name].trim()),
  );
  return found === null
    ? null
    : { value: found.captures[name].trim(), hit: found.hit };
}

/** What the account rules decided: an account, or none and whether the currency would have told. */
export interface TradeAccountDecision {
  accountId: string | null;
  /** A rule for this account text applies to one currency, and the trade's is unknown. */
  needsCurrency: boolean;
}

/**
 * The account a trade is for: the first rule whose glob matches the account
 * text (the empty text when the email prints none, which only a `*` rule
 * matches), else the default. A rule with a `currency` applies only to a trade
 * in that currency: one in another is skipped, and while the trade's currency
 * is unknown the rule can neither apply nor be skipped, so there is no
 * account (`needsCurrency`), never a guess between two accounts printed alike.
 * When the email names an account and the profile has rules, none of which
 * matches it, there is no account: the email names one the profile does not
 * know (a TFSA beside a profile's RRSP rule), and booking it to the default
 * would book it to the wrong account. The default covers emails that name no
 * account, and profiles that map every account to one.
 */
export function resolveTradeAccount(
  definition: Pick<ReceiptTradeDefinition, "accountRules" | "defaultAccountId">,
  accountText: string | null,
  currency: string | null,
): TradeAccountDecision {
  const rules = definition.accountRules ?? [];
  const line = accountText === null ? "" : normalizeLine(accountText);
  const wanted = currency?.toUpperCase() ?? null;
  for (const rule of rules) {
    if (matchReceiptPattern(rule.match, line, () => true) === null) continue;
    if (rule.currency === undefined) {
      return { accountId: rule.accountId, needsCurrency: false };
    }
    if (wanted === null) return { accountId: null, needsCurrency: true };
    if (rule.currency.toUpperCase() === wanted) {
      return { accountId: rule.accountId, needsCurrency: false };
    }
  }
  if (accountText !== null && rules.length > 0) {
    return { accountId: null, needsCurrency: false };
  }
  return {
    accountId: definition.defaultAccountId ?? null,
    needsCurrency: false,
  };
}

/** The first currency marker that matches a line (or, multi-line, a run of lines), with what matched it. */
function readCurrencyMarker(
  definition: Pick<ReceiptTradeDefinition, "currencyMarkers">,
  lines: readonly string[],
): { currency: string; hit: ReceiptTraceHit } | null {
  const markers = definition.currencyMarkers ?? [];
  for (const [entry, marker] of markers.entries()) {
    for (let index = 0; index < lines.length; index++) {
      const found = matchReceiptLines(marker.match, lines, index, () => true);
      if (found !== null) {
        return {
          currency: marker.currency.toUpperCase(),
          hit: {
            entry,
            pattern: marker.match,
            ...traceMatch(lines, index, found.span),
          },
        };
      }
    }
  }
  return null;
}

/**
 * What a caller with a database adds to a reading: the currency of the user's
 * security for the ticker, consulted only when an account rule needs a
 * currency the email does not name.
 */
export interface TradeReadOptions {
  securityCurrency?: string | null;
}

export interface TracedTrade {
  trade: ParsedTrade;
  trace: ReceiptTradeTrace;
}

/** Read one email's lines with a profile's `trade` section. */
export function parseTradeLinesTraced(
  definition: ReceiptTradeDefinition,
  lines: readonly string[],
  options: TradeReadOptions = {},
): TracedTrade {
  const action = readText(definition.action, lines, "action", (v) => {
    return parseTradeAction(v) !== null;
  });
  const symbol = readText(definition.symbol, lines, "symbol");
  const quantityRead = readText(
    definition.quantity,
    lines,
    "quantity",
    (v) => parseTradeQuantity(v) !== null,
  );
  const total = readTradeAmount(definition.total, lines);
  // The price is read to 8 decimals and keeps the number of decimals it was
  // written with: they bound the rounding the cross-check allows.
  const priceFound = findField(
    definition.price,
    lines,
    (captures) =>
      captures.amount !== undefined &&
      parseTradeNumber(captures.amount, PRICE_DECIMALS) !== null,
  );
  const priceRead = priceFound
    ? parseTradeNumber(priceFound.captures.amount, PRICE_DECIMALS)
    : null;
  const price =
    priceFound && priceRead !== null
      ? {
          // Stored in 1/10000 units, rounded half up, for the card.
          value: Number((priceRead.units + 5_000n) / 10_000n),
          units8: priceRead.units,
          decimals: priceRead.decimals,
          hit: priceFound.hit,
        }
      : null;
  const commission = readTradeAmount(definition.commission, lines);
  const dateRead = readText(
    definition.date,
    lines,
    "date",
    (v) => parseTradeDate(v) !== null,
  );
  const accountRead = readText(definition.account, lines, "account");

  const quantity = quantityRead ? parseTradeQuantity(quantityRead.value) : null;
  const accountText = accountRead?.value ?? null;
  // The email's own word for the currency comes first (its amounts, then a
  // marker); the security's currency only settles a rule the email leaves open.
  const amountCurrency =
    (total ? tradeAmountCurrency(total.text) : null) ??
    (priceFound ? tradeAmountCurrency(priceFound.captures.amount) : null);
  const marker =
    amountCurrency === null ? readCurrencyMarker(definition, lines) : null;
  const emailCurrency = amountCurrency ?? marker?.currency ?? null;
  const securityCurrency =
    emailCurrency === null
      ? (options.securityCurrency?.toUpperCase() ?? null)
      : null;
  const currency = emailCurrency ?? securityCurrency;
  const currencySource: ParsedTradeCurrencySource | null =
    amountCurrency !== null
      ? "amount"
      : marker !== null
        ? "marker"
        : securityCurrency !== null
          ? "security"
          : null;
  const decision = resolveTradeAccount(definition, accountText, currency);
  const accountId = decision.accountId;
  const actionValue = action ? parseTradeAction(action.value) : null;
  let reason: ParsedTradeReason | null = null;
  if (actionValue === null) reason = "trade_no_action";
  else if (symbol === null) reason = "trade_no_symbol";
  else if (quantity === null && tradeActionMovesShares(actionValue)) {
    reason = "trade_no_quantity";
  } else if (total === null && price === null) reason = "trade_no_amount";
  else if (accountId === null) {
    reason = decision.needsCurrency ? "trade_no_currency" : "trade_no_account";
  }

  let consistent: boolean | null = null;
  if (
    reason === null &&
    actionValue !== null &&
    quantity !== null &&
    total !== null &&
    price !== null
  ) {
    consistent = tradeIsConsistent({
      action: actionValue,
      quantityUnits: quantity.units,
      priceUnits8: price.units8,
      priceDecimals: price.decimals,
      totalUnits: total.value,
      commissionUnits: commission?.value ?? 0,
    });
  }

  const read: ParsedTrade = {
    action: actionValue,
    symbol: symbol?.value ?? null,
    quantity: quantity?.value ?? null,
    total: total?.value ?? null,
    price: price?.value ?? null,
    // The price as written: the total a price-only email implies is derived
    // from it, never from the 4-decimal card price (A26-L17, INV-TRADE-001).
    priceUnits8: price ? price.units8.toString() : null,
    commission: commission?.value ?? null,
    currency,
    currencySource,
    date: dateRead ? parseTradeDate(dateRead.value) : null,
    accountText,
    accountId,
    complete: reason === null,
    consistent,
    reason,
  };
  // A sell whose price implies less than its commission, or a dividend priced
  // per share without its share count, has no total to propose.
  const trade: ParsedTrade =
    read.complete && tradeExecutedTotalUnits(read) === null
      ? {
          ...read,
          complete: false,
          consistent: null,
          reason: "trade_no_amount",
        }
      : read;
  return {
    trade,
    trace: {
      action: action?.hit ?? null,
      symbol: symbol?.hit ?? null,
      quantity: quantityRead?.hit ?? null,
      total: total?.hit ?? null,
      price: price?.hit ?? null,
      commission: commission?.hit ?? null,
      date: dateRead?.hit ?? null,
      account: accountRead?.hit ?? null,
      currency: marker?.hit ?? null,
    },
  };
}

export function parseTradeLines(
  definition: ReceiptTradeDefinition,
  lines: readonly string[],
  options: TradeReadOptions = {},
): ParsedTrade {
  return parseTradeLinesTraced(definition, lines, options).trade;
}

/**
 * The executed total a complete reading proposes, in 1/10000 units: the total
 * the email states, else the one its price implies (commission added to a buy
 * or a reinvestment, taken from a sell or a dividend), rounded half up to
 * 1/10000. Null when neither is read, and for a dividend that states its
 * amount per share but not the shares it was paid on.
 * The one place this is decided, so the preview shows what the pipeline proposes.
 */
export function tradeExecutedTotalUnits(trade: ParsedTrade): number | null {
  if (trade.total !== null) return trade.total;
  if (trade.price === null || trade.quantity === null) return null;
  const quantity8 = toScaledUnits(trade.quantity, 8);
  // From the price as written when the reading carries it: quantity (1e-8) x
  // price (1e-8) is 1e-16, money is 1e-4, so divide by 1e12, half up. A
  // reading stored before `priceUnits8` existed keeps the card price.
  const gross =
    trade.priceUnits8 !== undefined && trade.priceUnits8 !== null
      ? (quantity8 * BigInt(trade.priceUnits8) + 500_000_000_000n) /
        1_000_000_000_000n
      : (quantity8 * BigInt(trade.price) + 50_000_000n) / QUANTITY_UNITS;
  const commission = BigInt(trade.commission ?? 0);
  const total =
    trade.action === null || commissionIsAdded(trade.action)
      ? gross + commission
      : gross - commission;
  return total < 0n ? null : Number(total);
}

/**
 * Whether the auto-apply gate may book a reading without a person (the other
 * conditions are the mailbox's, the profile's and the ledger's): a complete
 * reading whose quantity times price agrees with its total, or a complete cash
 * dividend that states nothing to cross-check. A reading whose figures
 * disagree never auto-applies, and neither does a buy, sell or reinvestment
 * that cannot be cross-checked.
 */
export function tradeMayAutoApply(trade: ParsedTrade): boolean {
  if (!trade.complete) return false;
  if (trade.consistent === true) return true;
  return (
    trade.consistent === null &&
    trade.action !== null &&
    !tradeActionMovesShares(trade.action)
  );
}

/** The executed total as a decimal for the proposal: 1/10000 units to a number with at most 4 decimals. */
export function tradeUnitsToAmount(units: number): number {
  return units / MONEY_UNITS;
}
