import { EntityManager } from "typeorm";
import { loadQualifiedCategoryNames } from "../../categories/category-name.util";
import { returnedRows } from "../../common/db/query-result";
import { effectiveReceiptDate } from "../imap/forwarded-receipt";
import {
  matchReceipt,
  receiptCandidateWindow,
  receiptMatchAmount,
  type ReceiptMatchCandidate,
  type ReceiptMatchResult,
} from "../matching/match-receipt";
import {
  parseReceiptLinesTraced,
  readLineGuards,
  receiptOutcome,
  type ReceiptOutcome,
} from "../parsing/parse-receipt";
import {
  resolveMatchConfig,
  type ResolvedMatchConfig,
} from "../parsing/receipt-match-config";
import type {
  ParsedReceipt,
  ParsedTrade,
  ReceiptParserDefinition,
  ReceiptLinkOutcome,
  ReceiptTrace,
  ReceiptTradeTrace,
} from "../parsing/receipt-parser.types";
import { loadLinkedComponents } from "../linking/component-lookup";
import { joinSettlement } from "../linking/join-settlement";
import {
  waitingSettlements,
  type WaitingSettlement,
} from "../linking/waiting-settlements";
import { loadReceiptCandidates } from "../pipeline/receipt-candidates";
import { ReceiptSourceLines } from "../pipeline/receipt-source-lines";
import { readTradeEmail } from "../pipeline/trade-reading";
import type { DraftComponentReader } from "./component-draft";
import { FIAT_MONEY_DECIMALS, moneyUnits } from "../../common/round.util";

/** The parts of a stored email a dry run reads. */
export interface DryRunReceipt {
  id: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: Date;
  originalSentAt: Date | null;
}

/** The payee a parser carries: its default category is the fallback, and the payee is a match signal. */
export interface DryRunPayee {
  id: string;
  defaultCategoryId: string | null;
}

/**
 * One part of a settlement as the join read it (linked receipts spec 10).
 * Amounts are 1/10000 units, like `parsed`; `componentNet` and `taken` are null
 * when the part had no complete component to measure.
 */
export interface DryRunLink {
  partIndex: number;
  /** The part's link value; null when it captured none. */
  link: string | null;
  /** The component the link found (the newest of several); null when none. */
  component: {
    id: string;
    subject: string;
    /** `YYYY-MM-DD`. */
    effectiveDate: string;
    /** The name of the component's profile; null when it has none. */
    profileName: string | null;
    /** `draft`: read with the test's `componentDrafts`; `stored`: the receipt as the pipeline stored it. */
    source: "stored" | "draft";
  } | null;
  partAmount: number;
  componentNet: number | null;
  taken: number | null;
  outcome: ReceiptLinkOutcome;
  /** How many components the link found: 0, 1 or more. */
  several: number;
}

/** What reading one stored email with a definition, and matching the result, yields. */
export interface ReceiptDryRun {
  parsed: ParsedReceipt;
  trace: ReceiptTrace;
  outcome: ReceiptOutcome;
  /** The day the shop sent the order when a forward carried it, else the day the email arrived. */
  effectiveDate: Date;
  /** `YYYY-MM-DD` of `effectiveDate`: what the match window is centred on. */
  purchaseDate: string;
  matchConfig: ResolvedMatchConfig;
  candidates: ReceiptMatchCandidate[];
  match: ReceiptMatchResult;
  /** The candidate the matcher chose, when it chose one. */
  hit: ReceiptMatchCandidate | undefined;
  /**
   * A trade profile's reading and what read each value. Present only for a
   * definition with a `trade` section, which is not matched to a bank
   * transaction: `parsed`, `trace` and `match` are then the empty reading of a
   * receipt and no candidate was looked up.
   */
  trade?: { parsed: ParsedTrade; trace: ReceiptTradeTrace };
  /**
   * Present only for a `component` profile, which is not matched to a bank
   * transaction (`match` is the empty "unmatched, considered 0" shape and no
   * candidate was looked up): the link value it read and the settlements whose
   * link rows wait for it (at most `MAX_WAITING_SETTLEMENTS`, newest first).
   */
  component?: {
    linkKey: string | null;
    waitingSettlements: WaitingSettlement[];
  };
  /**
   * Present only for a `settlement` profile that was read: one entry per part,
   * in item order. `parsed` is then the JOINED reading, which `match` and
   * `candidates` are computed from.
   */
  links?: DryRunLink[];
}

const EMPTY_PARSED: ParsedReceipt = {
  orderId: null,
  total: null,
  paid: null,
  payee: null,
  shipping: null,
  discount: null,
  items: [],
  shippingCategoryId: null,
  discountCategoryId: null,
  complete: false,
  reason: "no_total",
};

const EMPTY_TRACE: ReceiptTrace = {
  orderId: null,
  reference: null,
  total: null,
  paid: null,
  shipping: null,
  discount: null,
  payee: null,
  requireLine: null,
  skipIfLine: null,
  waitIfLine: null,
  items: [],
};

/**
 * Read one stored email with `definition` and say what the matcher would do
 * with the result. The one implementation behind the parser test endpoint, the
 * assistant's `test` operation and the preview, so a preview computes what the
 * commit will do through the same code. Reads only.
 *
 * `componentDrafts` (a settlement only, drafts already checked by
 * `checkComponentDrafts`; ONE reader for every email of a test call) add
 * candidates to the component search: the user's stored emails read with the
 * unsaved component profiles, which replace the stored component of the same email
 * and are chosen among exactly as stored ones are (linked receipts spec 10a).
 */
export async function dryRunReceipt(
  m: EntityManager,
  userId: string,
  definition: ReceiptParserDefinition,
  receipt: DryRunReceipt,
  payee: DryRunPayee | null,
  componentDrafts?: DraftComponentReader,
): Promise<ReceiptDryRun> {
  if (definition.trade) {
    return dryRunTrade(m, userId, definition, definition.trade, receipt);
  }
  // The lines of the source the definition chose (`text` or `html`); the trace's
  // line numbers refer to them. `no_html`: it reads HTML, the email has none.
  const read = parseReceiptLinesTraced(
    definition,
    receipt.subject,
    new ReceiptSourceLines(receipt).forSource(definition.source),
    payee?.defaultCategoryId ?? null,
  );
  const effectiveDate = effectiveReceiptDate(receipt);
  const purchaseDate = effectiveDate.toISOString().slice(0, 10);
  const matchConfig = resolveMatchConfig(definition.match);
  // A component never looks for a bank transaction (linked receipts spec 2.1):
  // the pipeline stores it and re-reads the settlements waiting for its key.
  if (definition.role === "component") {
    const linkKey = read.parsed.linkKey ?? null;
    return {
      parsed: read.parsed,
      trace: read.trace,
      outcome: read.outcome,
      effectiveDate,
      purchaseDate,
      matchConfig,
      candidates: [],
      match: { kind: "unmatched", considered: 0, attempts: [] },
      hit: undefined,
      component: {
        linkKey,
        waitingSettlements:
          read.outcome === "read" && linkKey !== null
            ? await waitingSettlements(m, userId, receipt.id, linkKey)
            : [],
      },
    };
  }
  // A settlement is matched as its JOINED reading, through the pipeline's own
  // loader and join, without row locks (spec 10).
  const isSettlement = definition.role === "settlement";
  let parsed = read.parsed;
  let links: DryRunLink[] | undefined;
  if (isSettlement && read.outcome === "read") {
    const settlement = { id: receipt.id, effectiveDate: purchaseDate };
    const partLinks = parsed.items.map((item) => item.link ?? null);
    const drafts = componentDrafts
      ? await componentDrafts.read(
          m,
          userId,
          settlement,
          new Set(partLinks.filter((link): link is string => link !== null)),
          definition.link ?? {},
        )
      : [];
    const draftIds = new Set(drafts.map((draft) => draft.id));
    const parts = await loadLinkedComponents(
      m,
      userId,
      settlement,
      partLinks,
      definition.link ?? {},
      false,
      drafts,
    );
    const joined = joinSettlement(parsed, parts);
    parsed = joined.parsed;
    links = joined.reports.map((report) => {
      const part = parts[report.partIndex];
      const found = part?.component ?? null;
      return {
        partIndex: report.partIndex,
        link: report.link,
        component: found
          ? {
              id: found.receiptId,
              subject: found.subject ?? "",
              effectiveDate: found.effectiveDate ?? "",
              profileName: found.profileName ?? null,
              source: draftIds.has(found.receiptId)
                ? ("draft" as const)
                : ("stored" as const),
            }
          : null,
        partAmount: report.partAmount,
        componentNet: report.componentNet ?? null,
        taken: report.taken ?? null,
        outcome: report.outcome,
        several: part?.several ?? 0,
      };
    });
  }
  const candidates = await loadReceiptCandidates(
    m,
    userId,
    purchaseDate,
    receipt.id,
    matchConfig,
    isSettlement,
  );
  const match = matchReceipt(
    parsed,
    purchaseDate,
    candidates,
    payee?.id ?? null,
    matchConfig,
  );
  const hit =
    match.kind === "matched"
      ? candidates.find((c) => c.id === match.transactionId)
      : undefined;
  return {
    parsed,
    trace: read.trace,
    outcome: read.outcome,
    effectiveDate,
    purchaseDate,
    matchConfig,
    candidates,
    match,
    hit,
    ...(links ? { links } : {}),
  };
}

/**
 * The dry run of a trade profile: the lines are read with the `trade` section
 * and nothing is matched, because a trade creates a transaction rather than
 * finding one. Reads only.
 */
async function dryRunTrade(
  m: EntityManager,
  userId: string,
  definition: ReceiptParserDefinition,
  trade: NonNullable<ReceiptParserDefinition["trade"]>,
  receipt: DryRunReceipt,
): Promise<ReceiptDryRun> {
  const lines = new ReceiptSourceLines(receipt).forSource(definition.source);
  const effectiveDate = effectiveReceiptDate(receipt);
  const read = await readTradeEmail(m, userId, trade, lines ?? []);
  return {
    parsed: EMPTY_PARSED,
    trace: EMPTY_TRACE,
    outcome:
      lines === null
        ? "no_html"
        : receiptOutcome(readLineGuards(definition, lines), definition.discard),
    effectiveDate,
    purchaseDate: effectiveDate.toISOString().slice(0, 10),
    matchConfig: resolveMatchConfig(undefined),
    candidates: [],
    match: { kind: "unmatched", considered: 0, attempts: [] },
    hit: undefined,
    trade: { parsed: read.trade, trace: read.trace },
  };
}

// ---------------------------------------------------------------- transactions

/** A transaction as the wizard, the preview and the prompt describe it. */
export interface TransactionSummary {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed, in the transaction's currency. */
  amount: number;
  currencyCode: string;
  payeeName: string | null;
  description: string | null;
  /** Category lines: the splits, or the single category of an unsplit transaction. */
  categories: Array<{
    category: string | null;
    amount: number | null;
    memo: string | null;
  }>;
}

/**
 * The user's transactions among `ids`, by id (an id that is not the user's is
 * absent: the caller decides whether that is a 404). Two statements however
 * many ids: the rows, then their split lines.
 */
export async function loadTransactionSummaries(
  m: EntityManager,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, TransactionSummary>> {
  const result = new Map<string, TransactionSummary>();
  if (ids.length === 0) return result;
  const rows = returnedRows<{
    id: string;
    date: string;
    amount: string | number;
    currency_code: string;
    payee_name: string | null;
    description: string | null;
    category_id: string | null;
  }>(
    await m.query(
      `SELECT t.id, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date,
              t.amount, t.currency_code, t.payee_name, t.description,
              t.category_id
         FROM transactions t
        WHERE t.user_id = $1
          AND t.id = ANY($2::uuid[])`,
      [userId, [...ids]],
    ),
  );
  if (rows.length === 0) return result;
  const splitRows = returnedRows<{
    transaction_id: string;
    category_id: string | null;
    amount: string | number;
    memo: string | null;
  }>(
    await m.query(
      `SELECT s.transaction_id, s.category_id, s.amount, s.memo
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
        WHERE t.user_id = $1
          AND s.transaction_id = ANY($2::uuid[])
        ORDER BY s.created_at ASC, s.id ASC`,
      [userId, rows.map((row) => row.id)],
    ),
  );
  const names = await loadQualifiedCategoryNames(m, userId);
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (names.get(id) ?? null);
  for (const row of rows) {
    const splits = splitRows.filter((s) => s.transaction_id === row.id);
    result.set(row.id, {
      id: row.id,
      date: row.date,
      amount: Number(row.amount),
      currencyCode: row.currency_code,
      payeeName: row.payee_name,
      description: row.description,
      categories:
        splits.length > 0
          ? splits.map((s) => ({
              category: nameOf(s.category_id),
              amount: Number(s.amount),
              memo: s.memo,
            }))
          : [{ category: nameOf(row.category_id), amount: null, memo: null }],
    });
  }
  return result;
}

/** One line a person reads: "2026-03-02, -49.99 PLN, Allegro". */
export function summarizeTransaction(tx: {
  date: string;
  amount: number;
  currencyCode?: string | null;
  payeeName: string | null;
}): string {
  return [
    tx.date,
    tx.currencyCode ? `${tx.amount} ${tx.currencyCode}` : `${tx.amount}`,
    ...(tx.payeeName ? [tx.payeeName] : []),
  ].join(", ");
}

// ------------------------------------------------------------------ agreement

/** Whether a parsed email agrees with the transaction a person says it paid for. */
export interface ExpectedAgreement {
  /** The transaction's date lies inside the profile's match window around the purchase date. */
  date: boolean;
  /** The amount paid (else the total) equals the transaction's amount within the profile's tolerance; false when the email states neither. */
  total: boolean;
  /** Both of the above. */
  agrees: boolean;
}

/**
 * Compare a parse with the expected transaction by the matcher's own rules: the
 * date window and the amount tolerance of the profile (`receiptCandidateWindow`,
 * `receiptMatchAmount`), so "agrees" means the matcher could pick that
 * transaction on date and amount.
 */
export function compareWithExpected(
  parsed: Pick<ParsedReceipt, "total" | "paid">,
  purchaseDate: string,
  matchConfig: Pick<
    ResolvedMatchConfig,
    "daysBefore" | "daysAfter" | "toleranceUnits"
  >,
  expected: Pick<TransactionSummary, "date" | "amount">,
): ExpectedAgreement {
  const window = receiptCandidateWindow(purchaseDate, matchConfig);
  const date = expected.date >= window.from && expected.date <= window.to;
  const paid = receiptMatchAmount(parsed);
  const total =
    paid !== null &&
    Math.abs(
      moneyUnits(Math.abs(expected.amount), FIAT_MONEY_DECIMALS) - paid,
    ) <= matchConfig.toleranceUnits;
  return { date, total, agrees: date && total };
}
