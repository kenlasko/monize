import type { EntityManager } from "typeorm";
import { addDaysYMD } from "../common/date-utils";
import { returnedRows } from "../common/db/query-result";
import { MONEY_SCALE, roundMoney } from "../common/round.util";
import { TransactionStatus } from "../transactions/entities/transaction.entity";

/**
 * Possible duplicates: an incoming row of an import that looks like a
 * transaction already in the destination account
 * (docs/specs/import-duplicate-review.md section 2). Source-neutral: bank sync
 * and the file import both pair through `matchPossibleDuplicates`, over the
 * rows `loadDuplicateCandidates` reads, in the preview and again in the write.
 */

/** How many calendar days apart, either side, a pair's two dates may be. */
export const DUPLICATE_WINDOW_DAYS = 3;

/** What a person can decide about a pair (spec section 3). */
export const DUPLICATE_ACTIONS = [
  "import",
  "merge",
  "keep",
  "replace",
] as const;
export type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

/** An incoming row, as the matcher needs it. */
export interface DuplicateIncomingRow<K> {
  /** The row's identity in its source: a bank row's key, a file row's position. */
  ref: K;
  /** `YYYY-MM-DD`. */
  date: string;
  amount: number;
}

/**
 * An existing transaction the matcher may pair, with what the list shows of
 * it beside the incoming row.
 */
export interface DuplicateCandidate {
  id: string;
  transactionDate: string;
  amount: number;
  payeeName: string | null;
  categoryName: string | null;
  description: string | null;
  referenceNumber: string | null;
  status: TransactionStatus;
  isTransfer: boolean;
  isSplit: boolean;
  /** The other leg's account, for a transfer; null when it cannot be read. */
  transferAccountName: string | null;
  /**
   * The row's `external_id` (an API key or an OFX `ofx:` FITID); null when it
   * has none. Never shown: a merge stores a FITID only on a row without one,
   * and a file import leaves out a row whose id names a file row it skips.
   */
  externalId: string | null;
}

const DAY_MS = 86_400_000;

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** The amount as the matcher compares it: at the column's storage scale. */
function amountKey(amount: number): number {
  return roundMoney(amount, MONEY_SCALE);
}

/**
 * Pair incoming rows with existing transactions, one to one (spec section 2):
 * equal amounts, dates at most `windowDays` apart. Every candidate pair is
 * ranked by the day difference, then the incoming row's position in `incoming`,
 * then the existing row's date and id; the pairs are taken in that order and
 * one whose incoming row or existing transaction is already taken is dropped.
 * Answers the pairs keyed by the incoming row's `ref`.
 */
export function matchPossibleDuplicates<K>(
  incoming: readonly DuplicateIncomingRow<K>[],
  existing: readonly DuplicateCandidate[],
  windowDays: number = DUPLICATE_WINDOW_DAYS,
): Map<K, DuplicateCandidate> {
  const byAmount = new Map<number, DuplicateCandidate[]>();
  for (const candidate of existing) {
    const key = amountKey(candidate.amount);
    const bucket = byAmount.get(key);
    if (bucket === undefined) byAmount.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const ranked: {
    position: number;
    diff: number;
    day: number;
    candidate: DuplicateCandidate;
  }[] = [];
  for (const [position, row] of incoming.entries()) {
    const same = byAmount.get(amountKey(row.amount));
    if (same === undefined) continue;
    const day = dayNumber(row.date);
    for (const candidate of same) {
      const candidateDay = dayNumber(candidate.transactionDate);
      const diff = Math.abs(candidateDay - day);
      if (diff <= windowDays) {
        ranked.push({ position, diff, day: candidateDay, candidate });
      }
    }
  }
  ranked.sort(
    (a, b) =>
      a.diff - b.diff ||
      a.position - b.position ||
      a.day - b.day ||
      (a.candidate.id < b.candidate.id
        ? -1
        : a.candidate.id > b.candidate.id
          ? 1
          : 0),
  );

  const pairs = new Map<K, DuplicateCandidate>();
  const takenRows = new Set<number>();
  const takenExisting = new Set<string>();
  for (const { position, candidate } of ranked) {
    if (takenRows.has(position) || takenExisting.has(candidate.id)) continue;
    takenRows.add(position);
    takenExisting.add(candidate.id);
    pairs.set(incoming[position].ref, candidate);
  }
  return pairs;
}

/**
 * The actions spec section 3 offers for a pair: a Reconciled row can only be
 * kept or imported beside, and neither a transfer leg nor a split parent can
 * be deleted from here (the other leg, or a split's transfer legs in other
 * accounts, would go with it).
 */
export function allowedDuplicateActions(
  existing: Pick<DuplicateCandidate, "status" | "isTransfer" | "isSplit">,
): DuplicateAction[] {
  if (existing.status === TransactionStatus.RECONCILED) {
    return ["import", "keep"];
  }
  if (existing.isTransfer || existing.isSplit) {
    return ["import", "merge", "keep"];
  }
  return ["import", "merge", "keep", "replace"];
}

/**
 * Whether a merge moves the existing row's date: not for a transfer leg or a
 * split parent, whose other legs keep theirs (spec section 3).
 */
export function mergeMovesDate(
  existing: Pick<DuplicateCandidate, "isTransfer" | "isSplit">,
): boolean {
  return !existing.isTransfer && !existing.isSplit;
}

/** What a merge takes from the incoming row (spec section 3). */
export interface MergeFromIncoming {
  /** `YYYY-MM-DD`; not applied to a transfer leg or a split parent. */
  date: string;
  /** Kept as it was when the incoming row has none. */
  referenceNumber: string | null;
  /** Stored only when the existing row has none; null to store none. */
  externalId: string | null;
}

/**
 * Merge an incoming row into the existing transaction it pairs with, in the
 * caller's transaction: the incoming date (`mergeMovesDate`), its reference
 * when it has one, status Cleared, and its external id when the existing row
 * has none. Its payee, category, splits, tags and memo stay. The one merge
 * both imports write.
 */
export async function mergeIntoExisting(
  m: EntityManager,
  userId: string,
  existing: DuplicateCandidate,
  incoming: MergeFromIncoming,
): Promise<void> {
  await m.query(
    `UPDATE transactions
        SET transaction_date = CASE WHEN $3::boolean THEN $4::date ELSE transaction_date END,
            reference_number = COALESCE($5, reference_number),
            status = $6,
            external_id = COALESCE(external_id, $7),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND user_id = $2`,
    [
      existing.id,
      userId,
      mergeMovesDate(existing),
      incoming.date,
      incoming.referenceNumber,
      TransactionStatus.CLEARED,
      incoming.externalId,
    ],
  );
}

export interface LoadDuplicateCandidatesOptions {
  /**
   * Leave out a transaction bank sync wrote or linked (a ledger row names
   * it): bank sync compares its rows only with what it did not bring in itself.
   */
  excludeBankSynced: boolean;
}

/**
 * The existing transactions of `accountId` that `incoming` could pair with:
 * the same amounts, dated within the window of the incoming dates, not VOID,
 * not a split child and not the cash leg of an investment transaction (spec
 * section 2). One read-only `SELECT` in the caller's transaction, filtered by
 * `userId`, in date order.
 */
export async function loadDuplicateCandidates(
  m: EntityManager,
  userId: string,
  accountId: string,
  incoming: readonly Pick<DuplicateIncomingRow<unknown>, "date" | "amount">[],
  options: LoadDuplicateCandidatesOptions,
  windowDays: number = DUPLICATE_WINDOW_DAYS,
): Promise<DuplicateCandidate[]> {
  if (incoming.length === 0) return [];
  const dates = incoming.map((row) => row.date).sort();
  const from = addDaysYMD(dates[0], -windowDays);
  const to = addDaysYMD(dates[dates.length - 1], windowDays);
  const amounts = [
    ...new Set(
      incoming.map((row) => amountKey(row.amount).toFixed(MONEY_SCALE)),
    ),
  ];
  const rows = returnedRows<{
    id: string;
    transaction_date: string;
    amount: string;
    payee_name: string | null;
    category_name: string | null;
    description: string | null;
    reference_number: string | null;
    status: TransactionStatus | null;
    is_transfer: boolean | null;
    is_split: boolean | null;
    transfer_account_name: string | null;
    external_id: string | null;
  }>(
    await m.query(
      `SELECT t.id,
              TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS transaction_date,
              t.amount::text AS amount,
              COALESCE(p.name, t.payee_name) AS payee_name,
              c.name AS category_name,
              t.description,
              t.reference_number,
              t.status,
              t.is_transfer,
              t.is_split,
              la.name AS transfer_account_name,
              t.external_id
         FROM transactions t
         LEFT JOIN payees p ON p.id = t.payee_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN transactions lt ON lt.id = t.linked_transaction_id
         LEFT JOIN accounts la ON la.id = lt.account_id
        WHERE t.user_id = $1
          AND t.account_id = $2
          AND t.transaction_date BETWEEN $3::date AND $4::date
          AND t.amount = ANY($5::numeric[])
          AND (t.status IS NULL OR t.status <> 'VOID')
          AND t.parent_transaction_id IS NULL
          -- includes VOID: records read -- a trade's cash leg is the trade's
          -- whatever its status, and the import cannot merge or delete it.
          AND NOT EXISTS (
                SELECT 1 FROM investment_transactions it
                 WHERE it.transaction_id = t.id)
          AND (NOT $6::boolean OR NOT EXISTS (
                SELECT 1 FROM bank_sync_imported_transactions b
                 WHERE b.transaction_id = t.id))
        ORDER BY t.transaction_date, t.created_at, t.id`,
      [userId, accountId, from, to, amounts, options.excludeBankSynced],
    ),
  );
  return rows.map((row) => ({
    id: row.id,
    transactionDate: row.transaction_date,
    amount: Number(row.amount),
    payeeName: row.payee_name,
    categoryName: row.category_name,
    description: row.description,
    referenceNumber: row.reference_number,
    status: row.status ?? TransactionStatus.UNRECONCILED,
    isTransfer: row.is_transfer === true,
    isSplit: row.is_split === true,
    transferAccountName: row.transfer_account_name,
    externalId: row.external_id ?? null,
  }));
}

/**
 * Read the candidates and pair: what a preview shows and what a write
 * re-computes under its lock, through the same two functions.
 */
export async function findPossibleDuplicates<K>(
  m: EntityManager,
  userId: string,
  accountId: string,
  incoming: readonly DuplicateIncomingRow<K>[],
  options: LoadDuplicateCandidatesOptions,
): Promise<Map<K, DuplicateCandidate>> {
  if (incoming.length === 0) return new Map();
  const candidates = await loadDuplicateCandidates(
    m,
    userId,
    accountId,
    incoming,
    options,
  );
  return matchPossibleDuplicates(incoming, candidates);
}

/** The existing transaction of a pair as an answer carries it (amount as a decimal string). */
export interface DuplicateExistingView {
  id: string;
  transactionDate: string;
  amount: string;
  payeeName: string | null;
  categoryName: string | null;
  description: string | null;
  referenceNumber: string | null;
  status: TransactionStatus;
  isTransfer: boolean;
  isSplit: boolean;
  transferAccountName: string | null;
}

export function toDuplicateExistingView(
  existing: DuplicateCandidate,
  decimals: number,
): DuplicateExistingView {
  return {
    id: existing.id,
    transactionDate: existing.transactionDate,
    amount: roundMoney(existing.amount, decimals).toFixed(decimals),
    payeeName: existing.payeeName,
    categoryName: existing.categoryName,
    description: existing.description,
    referenceNumber: existing.referenceNumber,
    status: existing.status,
    isTransfer: existing.isTransfer,
    isSplit: existing.isSplit,
    transferAccountName: existing.transferAccountName,
  };
}
