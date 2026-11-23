import { addDaysYMD } from "../../common/date-utils";
import { normalizePayeeName } from "../../payees/payee-normalize.util";
import {
  DEFAULT_DAYS_AFTER,
  DEFAULT_DAYS_BEFORE,
  DEFAULT_MATCH_CONFIG,
  type ResolvedMatchConfig,
} from "../parsing/receipt-match-config";
import type {
  ParsedReceipt,
  ReceiptMatchStrategy,
} from "../parsing/receipt-parser.types";
import { FIAT_MONEY_DECIMALS, moneyUnits } from "../../common/round.util";

/**
 * Which bank transaction an order-confirmation email pays for (spec section
 * 3). Pure: the candidates are loaded by the caller in one query and handed
 * in; nothing here reads the database or the clock. The truth table is the
 * spec's, row for row.
 */

/**
 * The window is centred on the PURCHASE date: the day the shop sent the order
 * (the original date of a forwarded email) or, when none is known, the day the
 * email arrived. A candidate is dated this many days before it by default... */
export const RECEIPT_MATCH_DAYS_BEFORE = DEFAULT_DAYS_BEFORE;
/** ...or this many days after (the bank posts later than the shop mails). A profile's `match` section changes both. */
export const RECEIPT_MATCH_DAYS_AFTER = DEFAULT_DAYS_AFTER;
/** The candidate list stored on an ambiguous receipt. */
export const MAX_STORED_CANDIDATES = 10;
/** An order id or a reference shorter than this is too likely to occur by chance to be a signal. */
export const MIN_ORDER_ID_LENGTH = 4;

const MS_PER_DAY = 86_400_000;

export interface ReceiptMatchCandidate {
  id: string;
  /** `YYYY-MM-DD`. */
  transactionDate: string;
  /** Signed, as stored. */
  amount: number;
  payeeId: string | null;
  payeeName: string | null;
  description: string | null;
  referenceNumber: string | null;
  /**
   * The receipt whose applied request enriched this transaction (a settlement
   * receipt's candidates only, linked receipts spec 6); `matchReceipt` ignores it.
   */
  enrichedByReceiptId?: string | null;
}

/** The match kind a strategy stores (spec 3a): `orderId` is stored as `order_id`. */
export type ReceiptMatchKind =
  "order_id" | "reference" | "amount_payee" | "amount_date";

const MATCH_KIND_OF: Record<ReceiptMatchStrategy, ReceiptMatchKind> = {
  reference: "reference",
  orderId: "order_id",
  amount_payee: "amount_payee",
  amount_date: "amount_date",
};

/** What one strategy found: how many candidates it kept and which (at most 10, closest date first). */
export interface ReceiptMatchAttempt {
  strategy: ReceiptMatchStrategy;
  count: number;
  candidateIds: string[];
}

interface MatchDetail {
  /** Every strategy tried, in order, up to and including the one that decided. */
  attempts: ReceiptMatchAttempt[];
  /** Candidates inside the window (what the strategies chose from). */
  considered: number;
}

export type ReceiptMatchResult =
  | ({
      kind: "matched";
      transactionId: string;
      matchKind: ReceiptMatchKind;
      strategy: ReceiptMatchStrategy;
    } & MatchDetail)
  | ({
      kind: "ambiguous";
      candidateIds: string[];
      strategy: ReceiptMatchStrategy;
    } & MatchDetail)
  | ({ kind: "unmatched" } & MatchDetail);

/** The inclusive date range in which a transaction can be the one an email paid for. */
export function receiptCandidateWindow(
  purchaseDate: string,
  config: Pick<
    ResolvedMatchConfig,
    "daysBefore" | "daysAfter"
  > = DEFAULT_MATCH_CONFIG,
): {
  from: string;
  to: string;
} {
  return {
    from: addDaysYMD(purchaseDate, -config.daysBefore),
    to: addDaysYMD(purchaseDate, config.daysAfter),
  };
}

/** Whole days between two `YYYY-MM-DD` dates (UTC, so no daylight-saving drift). */
function daysApart(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.abs(
    Math.round(
      (Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / MS_PER_DAY,
    ),
  );
}

/** At most 10 ids, the closest date to the received date first, ties by id. */
function closestIds(
  set: readonly ReceiptMatchCandidate[],
  purchaseDate: string,
): string[] {
  return [...set]
    .sort(
      (x, y) =>
        daysApart(x.transactionDate, purchaseDate) -
          daysApart(y.transactionDate, purchaseDate) ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    )
    .slice(0, MAX_STORED_CANDIDATES)
    .map((candidate) => candidate.id);
}

/**
 * Signals O and R: the value occurs, case-insensitively, in one of the
 * transaction's chosen text fields (`description`, the payee name, the reference
 * number).
 */
function mentions(
  candidate: ReceiptMatchCandidate,
  value: string,
  fields: ResolvedMatchConfig["referenceIn"],
): boolean {
  const needle = value.toLowerCase();
  const texts = [
    fields.includes("description") ? candidate.description : null,
    fields.includes("payee") ? candidate.payeeName : null,
    fields.includes("referenceNumber") ? candidate.referenceNumber : null,
  ];
  return texts
    .filter((text): text is string => typeof text === "string")
    .some((text) => text.toLowerCase().includes(needle));
}

/** The amount the bank was charged: what was paid, else the total; null when the email states neither. */
export function receiptMatchAmount(
  parsed: Partial<Pick<ParsedReceipt, "total" | "paid">>,
): number | null {
  return parsed.paid ?? parsed.total ?? null;
}

/** Signal P (by name): the candidate's payee is the merchant the email names, ignoring case, accents and legal suffixes. */
function namesParsedPayee(
  candidate: ReceiptMatchCandidate,
  parsedPayee: string | null,
): boolean {
  if (parsedPayee === null || candidate.payeeName === null) return false;
  const wanted = normalizePayeeName(parsedPayee);
  return wanted !== "" && normalizePayeeName(candidate.payeeName) === wanted;
}

/**
 * Match a parsed receipt against the user's candidate transactions with the
 * strategies the profile lists, in order (spec 3 and 3a). Signals per
 * candidate: R and O (the parsed reference, and the order id, each at least four
 * characters, appear in the chosen text fields), A (`abs(amount)` in units is
 * within the tolerance of the amount paid, else the parsed total; false when
 * neither was parsed) and P (the candidate's payee is the parser's payee, or its
 * payee's name is the merchant the email names).
 *
 * `reference` and `orderId` keep the candidates with R / O; `amount_payee` those
 * with A and P; `amount_date` those with A. A strategy with exactly one candidate
 * matches; several are ambiguous with exactly those candidates; none passes to the
 * next strategy; none left is unmatched. A candidate outside the window around
 * `purchaseDate` (the profile's, else 3 days before and 14 after) is ignored. An
 * order email describes a purchase, so only an expense (amount below zero) is a
 * candidate for any strategy; income and a zero amount are ignored. With
 * no `config` the strategies are `orderId`, `amount_payee`, `amount_date`: the
 * truth table a profile without a `match` section always had.
 */
export function matchReceipt(
  parsed: Partial<
    Pick<ParsedReceipt, "total" | "paid" | "payee" | "reference">
  > &
    Pick<ParsedReceipt, "orderId">,
  purchaseDate: string,
  candidates: readonly ReceiptMatchCandidate[],
  parserPayeeId: string | null,
  config: ResolvedMatchConfig = DEFAULT_MATCH_CONFIG,
): ReceiptMatchResult {
  const window = receiptCandidateWindow(purchaseDate, config);
  const inWindow = candidates.filter(
    (candidate) =>
      candidate.amount < 0 &&
      candidate.transactionDate >= window.from &&
      candidate.transactionDate <= window.to,
  );
  const attempts: ReceiptMatchAttempt[] = [];
  const detail = (): MatchDetail => ({
    attempts,
    considered: inWindow.length,
  });

  const paid = receiptMatchAmount(parsed);
  const parsedPayee = parsed.payee ?? null;
  const withinTolerance = (candidate: ReceiptMatchCandidate): boolean =>
    paid !== null &&
    Math.abs(
      moneyUnits(Math.abs(candidate.amount), FIAT_MONEY_DECIMALS) - paid,
    ) <= config.toleranceUnits;
  const hasPayeeSignal = (candidate: ReceiptMatchCandidate): boolean =>
    (parserPayeeId !== null && candidate.payeeId === parserPayeeId) ||
    namesParsedPayee(candidate, parsedPayee);
  const byText = (raw: string | null | undefined) => {
    const value = raw?.trim() ?? "";
    return value.length >= MIN_ORDER_ID_LENGTH
      ? inWindow.filter((candidate) =>
          mentions(candidate, value, config.referenceIn),
        )
      : [];
  };

  for (const strategy of config.by) {
    let kept: ReceiptMatchCandidate[];
    switch (strategy) {
      case "reference":
        kept = byText(parsed.reference);
        break;
      case "orderId":
        kept = byText(parsed.orderId);
        break;
      case "amount_payee":
        kept = inWindow.filter(
          (candidate) =>
            withinTolerance(candidate) && hasPayeeSignal(candidate),
        );
        break;
      case "amount_date":
        kept = inWindow.filter(withinTolerance);
        break;
    }
    const candidateIds = closestIds(kept, purchaseDate);
    attempts.push({ strategy, count: kept.length, candidateIds });
    if (kept.length === 1) {
      return {
        kind: "matched",
        transactionId: kept[0].id,
        matchKind: MATCH_KIND_OF[strategy],
        strategy,
        ...detail(),
      };
    }
    if (kept.length > 1) {
      return { kind: "ambiguous", candidateIds, strategy, ...detail() };
    }
  }
  return { kind: "unmatched", ...detail() };
}
