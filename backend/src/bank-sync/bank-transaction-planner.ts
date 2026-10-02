import { createHash } from "node:crypto";
import { addDaysYMD } from "../common/date-utils";
import { roundMoney } from "../common/round.util";
import { TRANSACTION_NOTE_MAX_LENGTH } from "../common/transaction-note";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import {
  findRemittanceOperation,
  type BankOperation,
  type OperationDirection,
} from "./bank-operation";
import type { BankTransaction } from "./providers/bank-sync-provider.interface";

/**
 * Turns the rows a provider returned into the rows Monize will write, and
 * counts what it did not write and why. Pure: no clock, no database, no
 * provider. The truth table is `docs/specs/bank-sync.md` section 6 and the
 * first matching line wins:
 *
 * 1. not booked: not planned, counted as `pending` (not an error);
 * 2. no valid date: refused `missing_date`;
 * 3. date before the cut-off: not planned, counted as `beforeCutoff`;
 * 4. date after today + 1 day: refused `future_date`;
 * 5. amount not `^\d{1,16}(\.\d{1,8})?$` after trimming: refused `invalid_amount`;
 * 6. direction neither credit nor debit: refused `unknown_direction`;
 * 7. currency differs from the Monize account's: refused `currency_mismatch`
 *    (INV-BANKSYNC-003: never converted, never written with a foreign amount);
 * 8. otherwise planned.
 *
 * Before the table, a booked row repeating the entry reference AND the content
 * of an earlier booked row of the same fetch is dropped, and rows that share a
 * reference but differ in content are kept apart (`resolveEntryReferences`).
 *
 * A row whose currency the provider did not report is refused as
 * `currency_mismatch` too: an unknown currency is not the account's currency,
 * and writing the amount in the account's currency on a guess is exactly what
 * the invariant forbids.
 */

/** The reasons a booked row is refused, each counted in `refused`. */
export const BANK_IMPORT_REFUSAL_REASONS = [
  "missing_date",
  "future_date",
  "invalid_amount",
  "unknown_direction",
  "currency_mismatch",
] as const;
export type RefusalReason = (typeof BANK_IMPORT_REFUSAL_REASONS)[number];

/** The create DTO's bound on a payee name and on a reference number. */
export const BANK_IMPORT_PAYEE_MAX_LENGTH = 100;
export const BANK_IMPORT_REFERENCE_MAX_LENGTH = 100;

/** The width of `bank_sync_imported_transactions.external_key`. */
export const BANK_IMPORT_EXTERNAL_KEY_MAX_LENGTH = 255;

const AMOUNT_PATTERN = /^\d{1,16}(\.\d{1,8})?$/;

export interface PlannedBankRow {
  /** The duplicate key (INV-BANKSYNC-001); at most 255 characters. */
  externalKey: string;
  /** `YYYY-MM-DD`. */
  transactionDate: string;
  /** Signed: negative for a debit, at money precision. */
  amount: number;
  payeeText: string | null;
  /**
   * What the transaction's description will be: the remittance lines joined
   * with a space, without the line that only names the operation (`descriptionOf`).
   * Display text only: the `hash:` key is built from the raw remittance, not
   * from this.
   */
  description: string | null;
  referenceNumber: string | null;
  /** Which way the money moved; `TRANSFER` is incoming or outgoing by it. */
  direction: OperationDirection;
  /**
   * The bank's operation type; the sync turns it into a tag when the connection
   * asks for one. Not part of the key, the fingerprint or the transaction.
   */
  operation: BankOperation;
}

export interface BankImportPlan {
  planned: PlannedBankRow[];
  refused: Record<RefusalReason, number>;
  pending: number;
  beforeCutoff: number;
}

/**
 * One provider row as the preview lists it (spec section 7a): what the planner
 * did with it and the fields to show. `externalKey` is set only for a planned
 * row. A row the planner did not plan carries what could be read from the wire
 * row, `null` where nothing could.
 */
export interface PlanEntry {
  outcome: "planned" | "refused" | "pending" | "before_cutoff";
  /** Set for `refused`. */
  reason: RefusalReason | null;
  externalKey: string | null;
  transactionDate: string | null;
  /** Signed: negative for a debit; null when the amount or direction was unreadable. */
  amount: number | null;
  currencyCode: string | null;
  payeeText: string | null;
  description: string | null;
  referenceNumber: string | null;
  /** Which way the money moved; null when the bank's direction was unreadable. */
  direction: OperationDirection | null;
  /** The bank's operation type, for the tag a sync would add. */
  operation: BankOperation;
}

/** The plan, and one entry per provider row the planner looked at, in the provider's order. */
export interface ExplainedBankImport {
  plan: BankImportPlan;
  entries: PlanEntry[];
}

export interface BankImportContext {
  /** The Monize account's currency. */
  accountCurrencyCode: string;
  /** The cut-off date, `YYYY-MM-DD`: rows dated before it are never imported. */
  syncFromDate: string;
  /** The server's date, `YYYY-MM-DD`, injected so the plan is deterministic. */
  today: string;
}

/** A row that passed lines 1 to 7, before its key is assigned. */
interface Draft {
  transactionDate: string;
  amount: number;
  /** The unsigned amount, for the hash. */
  absoluteAmount: number;
  direction: OperationDirection;
  currencyCode: string;
  payeeText: string | null;
  /** The description the row is written with (`descriptionOf`). */
  description: string | null;
  /**
   * The remittance lines joined exactly as the bank sent them. It is what the
   * `hash:` key hashes, so it never changes with how the description is shown.
   */
  hashDescription: string | null;
  referenceNumber: string | null;
  entryReference: string | null;
  operation: BankOperation;
  /**
   * Set when the bank gave this reference to rows that differ in content, so the
   * reference alone does not name this row (`resolveEntryReferences`).
   */
  referenceDiscriminator: string | null;
}

type Classified =
  | { kind: "pending" }
  | { kind: "beforeCutoff" }
  | { kind: "refused"; reason: RefusalReason }
  | { kind: "planned"; draft: Draft };

/**
 * `value` trimmed and cut to `max` UTF-16 units, without splitting a surrogate
 * pair (a lone surrogate is not valid text). Null when nothing is left.
 */
function bounded(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length <= max) return trimmed;
  const last = trimmed.charCodeAt(max - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  const cut = trimmed.slice(0, isHighSurrogate ? max - 1 : max).trim();
  return cut === "" ? null : cut;
}

/** The lines of a row's remittance that say something, trimmed. */
function remittanceLinesOf(row: BankTransaction): string[] {
  return row.remittance
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * What a row's description says, twice: `raw`, the remittance lines joined with
 * a space as the bank sent them (what the duplicate key hashes), and `display`,
 * the same without the line that is only the operation code (`CARD-PAYMENT`),
 * which the operation tag and the preview already carry.
 *
 * The line left out is the one the operation was identified on, and only when
 * that line is exactly the code: a code that is merely the last word of a longer
 * line is part of the text and stays in it.
 */
function descriptionOf(
  row: BankTransaction,
  remittance: readonly string[],
): { raw: string | null; display: string | null } {
  const raw = bounded(remittance.join(" "), TRANSACTION_NOTE_MAX_LENGTH);
  const found = findRemittanceOperation(remittance);
  const codeLine =
    found !== null &&
    found.wholeLine &&
    found.code === row.operation.remittanceCode
      ? found.lineIndex
      : null;
  if (codeLine === null) return { raw, display: raw };
  return {
    raw,
    display: bounded(
      remittance.filter((_, index) => index !== codeLine).join(" "),
      TRANSACTION_NOTE_MAX_LENGTH,
    ),
  };
}

/** The first of the three dates that names a real day, or null. */
function firstValidDate(row: BankTransaction): string | null {
  for (const candidate of [
    row.bookingDate,
    row.valueDate,
    row.transactionDate,
  ]) {
    const trimmed = candidate?.trim();
    if (isCalendarDate(trimmed)) return trimmed;
  }
  return null;
}

function sameCurrency(rowCurrency: string | null, accountCurrency: string) {
  const row = rowCurrency?.trim().toUpperCase();
  return !!row && row === accountCurrency.trim().toUpperCase();
}

function classify(
  row: BankTransaction,
  ctx: BankImportContext,
  referenceDiscriminator: string | null,
): Classified {
  if (!row.booked) return { kind: "pending" };

  const transactionDate = firstValidDate(row);
  if (transactionDate === null) {
    return { kind: "refused", reason: "missing_date" };
  }
  if (transactionDate < ctx.syncFromDate) return { kind: "beforeCutoff" };
  if (transactionDate > addDaysYMD(ctx.today, 1)) {
    return { kind: "refused", reason: "future_date" };
  }

  const amountText = row.amount?.trim() ?? "";
  if (!AMOUNT_PATTERN.test(amountText)) {
    return { kind: "refused", reason: "invalid_amount" };
  }
  if (row.direction !== "credit" && row.direction !== "debit") {
    return { kind: "refused", reason: "unknown_direction" };
  }
  if (!sameCurrency(row.currencyCode, ctx.accountCurrencyCode)) {
    return { kind: "refused", reason: "currency_mismatch" };
  }

  const absoluteAmount = roundMoney(Number(amountText));
  const signed = row.direction === "debit" ? -absoluteAmount : absoluteAmount;
  const remittance = remittanceLinesOf(row);
  const description = descriptionOf(row, remittance);

  return {
    kind: "planned",
    draft: {
      transactionDate,
      // Not `-0`: a debit of nothing is nothing.
      amount: signed === 0 ? 0 : signed,
      absoluteAmount,
      direction: row.direction,
      currencyCode: ctx.accountCurrencyCode.trim().toUpperCase(),
      // The counterparty is already chosen by direction (creditor for a debit,
      // debtor for a credit); without one, the first remittance line stands in.
      payeeText:
        bounded(row.counterpartyName, BANK_IMPORT_PAYEE_MAX_LENGTH) ??
        bounded(remittance[0], BANK_IMPORT_PAYEE_MAX_LENGTH),
      description: description.display,
      hashDescription: description.raw,
      referenceNumber: bounded(
        row.bankReference,
        BANK_IMPORT_REFERENCE_MAX_LENGTH,
      ),
      entryReference: bounded(row.entryReference, Number.MAX_SAFE_INTEGER),
      operation: row.operation,
      referenceDiscriminator,
    },
  };
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * One field of the hash input, with the separator and the escape character
 * escaped so two different rows cannot produce the same input (a payee
 * containing `|` must not read as the start of the description).
 */
const hashField = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("|", "\\|");

/**
 * The hash form's input: `date|amount|currency|direction|payee|description`,
 * the description being the raw joined remittance (`hashDescription`), never
 * the one shown.
 */
function hashInput(draft: Draft): string {
  return [
    draft.transactionDate,
    String(draft.absoluteAmount),
    draft.currencyCode,
    draft.direction,
    draft.payeeText ?? "",
    draft.hashDescription ?? "",
  ]
    .map(hashField)
    .join("|");
}

/**
 * A key longer than the column is replaced by its prefix and the SHA-256 hex of
 * the whole value, so it stays deterministic and fits.
 */
function fitKey(prefix: string, key: string): string {
  return key.length <= BANK_IMPORT_EXTERNAL_KEY_MAX_LENGTH
    ? key
    : `${prefix}${sha256Hex(key)}`;
}

/**
 * A booked row's entry reference as it will be keyed (trimmed), or null when it
 * carries none.
 */
function entryReferenceOf(row: BankTransaction): string | null {
  return bounded(row.entryReference, Number.MAX_SAFE_INTEGER);
}

/** What a row says apart from its identifiers: two listings of one transaction agree on it. */
function contentSignature(row: BankTransaction): string {
  return JSON.stringify([
    row.bookingDate,
    row.valueDate,
    row.transactionDate,
    row.amount,
    row.currencyCode,
    row.direction,
    row.counterpartyName,
    row.remittance,
    row.bankReference,
  ]);
}

/** A booked row with the discriminator (if any) its reference needs. */
interface ResolvedRow {
  row: BankTransaction;
  referenceDiscriminator: string | null;
}

/**
 * Settles what a repeated entry reference means within one fetch.
 *
 * Enable Banking documents `entry_reference` as unique and immutable for
 * accounts with the same identification hashes, and its FAQ adds that some
 * banks "provide duplicate values even though they should not". So a repeat is
 * one of two things:
 *
 * - the same content: the same bank transaction listed twice (a row repeated
 *   across two pagination pages). The first occurrence wins and the repeat is
 *   dropped without a counter of its own: it is not a row the bank reported
 *   once;
 * - different content: two transactions under one reference. Dropping the second
 *   would lose a real transaction without a trace, so none of them is keyed by
 *   the reference alone; each takes the reference plus the SHA-256 of its
 *   content (`referenceDiscriminator`), which does not depend on the order the
 *   bank listed them in.
 *
 * Pending rows and rows without a reference are never dropped, and a pending
 * row cannot shadow the booked row that later carries its reference.
 */
function resolveEntryReferences(
  rows: readonly BankTransaction[],
): ResolvedRow[] {
  const signaturesByReference = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.booked) continue;
    const reference = entryReferenceOf(row);
    if (reference === null) continue;
    const signatures = signaturesByReference.get(reference) ?? new Set();
    signatures.add(contentSignature(row));
    signaturesByReference.set(reference, signatures);
  }

  const seen = new Set<string>();
  const resolved: ResolvedRow[] = [];
  for (const row of rows) {
    const reference = row.booked ? entryReferenceOf(row) : null;
    if (reference === null) {
      resolved.push({ row, referenceDiscriminator: null });
      continue;
    }
    const signature = contentSignature(row);
    const identity = `${reference}\u0000${signature}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const contested = (signaturesByReference.get(reference)?.size ?? 0) > 1;
    resolved.push({
      row,
      referenceDiscriminator: contested ? sha256Hex(signature) : null,
    });
  }
  return resolved;
}

/** What can be read of a row the planner did not plan, for the preview to list. */
function unplannedEntry(row: BankTransaction, c: Classified): PlanEntry {
  const remittance = remittanceLinesOf(row);
  const amountText = row.amount?.trim() ?? "";
  const magnitude = AMOUNT_PATTERN.test(amountText)
    ? roundMoney(Number(amountText))
    : null;
  const signed =
    magnitude === null ||
    (row.direction !== "credit" && row.direction !== "debit")
      ? null
      : row.direction === "debit"
        ? -magnitude
        : magnitude;
  return {
    outcome:
      c.kind === "pending"
        ? "pending"
        : c.kind === "beforeCutoff"
          ? "before_cutoff"
          : "refused",
    reason: c.kind === "refused" ? c.reason : null,
    externalKey: null,
    transactionDate: firstValidDate(row),
    amount: signed === 0 ? 0 : signed,
    currencyCode: row.currencyCode?.trim().toUpperCase() || null,
    payeeText:
      bounded(row.counterpartyName, BANK_IMPORT_PAYEE_MAX_LENGTH) ??
      bounded(remittance[0], BANK_IMPORT_PAYEE_MAX_LENGTH),
    description: descriptionOf(row, remittance).display,
    referenceNumber: bounded(
      row.bankReference,
      BANK_IMPORT_REFERENCE_MAX_LENGTH,
    ),
    direction:
      row.direction === "credit" || row.direction === "debit"
        ? row.direction
        : null,
    operation: row.operation,
  };
}

/**
 * The plan for one fetch, and one entry per row the planner looked at.
 *
 * The external key is the first that applies: `ref:` + the provider's entry
 * reference (unique and immutable across sessions of one account), followed by
 * `#` and the SHA-256 of the row's content when the bank gave the same reference
 * to rows that differ; otherwise `hash:` + the
 * SHA-256 of the row's content, then `:` + the occurrence number of that hash
 * among the planned rows of this fetch, counted from 0 in the order the
 * provider returned them. The hash form is stable because every fetch requests
 * whole days, so two identical coffees on one day are always `:0` and `:1`.
 *
 * The provider's `transaction_id` is deliberately not a key: it is a handle for
 * fetching details and may change between two list fetches, so a key built on
 * it would let the same bank transaction be imported twice.
 *
 * This is the one classification: a sync writes `plan` and the preview lists
 * `entries`, both from this call, so what is shown is what is planned.
 */
export function explainBankImport(
  rows: readonly BankTransaction[],
  ctx: BankImportContext,
): ExplainedBankImport {
  const resolved = resolveEntryReferences(rows);
  const classified = resolved.map(({ row, referenceDiscriminator }) =>
    classify(row, ctx, referenceDiscriminator),
  );

  const refused = Object.fromEntries(
    BANK_IMPORT_REFUSAL_REASONS.map((reason) => [
      reason,
      classified.filter((c) => c.kind === "refused" && c.reason === reason)
        .length,
    ]),
  ) as Record<RefusalReason, number>;

  const occurrences = new Map<string, number>();
  const planned: PlannedBankRow[] = [];
  const entries = classified.map((c, index): PlanEntry => {
    if (c.kind !== "planned") return unplannedEntry(resolved[index].row, c);
    const { draft } = c;
    const row: PlannedBankRow = {
      externalKey: keyFor(draft, occurrences),
      transactionDate: draft.transactionDate,
      amount: draft.amount,
      payeeText: draft.payeeText,
      description: draft.description,
      referenceNumber: draft.referenceNumber,
      direction: draft.direction,
      operation: draft.operation,
    };
    planned.push(row);
    return {
      outcome: "planned",
      reason: null,
      externalKey: row.externalKey,
      transactionDate: row.transactionDate,
      amount: row.amount,
      currencyCode: draft.currencyCode,
      payeeText: row.payeeText,
      description: row.description,
      referenceNumber: row.referenceNumber,
      direction: row.direction,
      operation: row.operation,
    };
  });

  return {
    plan: {
      planned,
      refused,
      pending: classified.filter((c) => c.kind === "pending").length,
      beforeCutoff: classified.filter((c) => c.kind === "beforeCutoff").length,
    },
    entries,
  };
}

/** The plan for one fetch (see `explainBankImport`). */
export function planBankImport(
  rows: readonly BankTransaction[],
  ctx: BankImportContext,
): BankImportPlan {
  return explainBankImport(rows, ctx).plan;
}

/** The key of one planned row; `occurrences` counts the hash forms seen so far. */
function keyFor(draft: Draft, occurrences: Map<string, number>): string {
  if (draft.entryReference !== null) {
    const discriminator =
      draft.referenceDiscriminator === null
        ? ""
        : `#${draft.referenceDiscriminator}`;
    return fitKey("ref:", `ref:${draft.entryReference}${discriminator}`);
  }
  const hash = sha256Hex(hashInput(draft));
  const occurrence = occurrences.get(hash) ?? 0;
  occurrences.set(hash, occurrence + 1);
  return `hash:${hash}:${occurrence}`;
}
