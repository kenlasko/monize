import { BadRequestException, ConflictException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import {
  lockAccountsForBalanceWrite,
  lockTransactionRows,
} from "../common/db/locks";
import {
  allowedDuplicateActions,
  loadDuplicateCandidates,
  matchPossibleDuplicates,
  mergeIntoExisting,
  mergeMovesDate,
  toDuplicateExistingView,
  type DuplicateAction,
  type DuplicateCandidate,
  type DuplicateIncomingRow,
} from "../import-preview/possible-duplicates";
import { tr } from "../i18n/translate";
import type {
  CategoryMappingDto,
  ImportDuplicateDecisionDto,
  ImportDuplicateRowDto,
} from "./dto/import.dto";
import {
  holdKey,
  isSameBankRow,
  ofxExternalId,
  type HeldBankRow,
} from "./ofx-external-id";
import type { QifTransaction } from "./qif-parser";

/**
 * Possible duplicates of a file import (docs/specs/import-duplicate-review.md
 * section 5): a row of a non-investment file that looks like a transaction
 * already in the destination account. The check route and the import pair the
 * rows through these functions, the import inside its own transaction.
 *
 * A row is named by its position in the parsed file (`result.transactions`),
 * 0-based: the import re-parses the same content, so the position names the
 * same row.
 */

/**
 * A refused set of decisions: the file or the account changed since the check
 * (409), or a decision the pair does not allow (400). Its own class so the
 * import reports it as it is rather than as "import failed".
 */
export class ImportDuplicatesChangedException extends ConflictException {}
export class ImportDuplicateDecisionRefusedException extends BadRequestException {}

/** What the import does with one paired row. */
export interface FileDuplicatePlan {
  existing: DuplicateCandidate;
  /** Null when nobody decided: the row is kept (spec section 3). */
  action: DuplicateAction | null;
}

/**
 * The categories a file row is a loan payment by: the processor writes a
 * non-split row in one of them as a transfer to the loan account
 * (`resolveTransactionTarget`), so the transfer check owns it too.
 */
export function loanCategoryNames(
  mappings: readonly Pick<
    CategoryMappingDto,
    "originalName" | "isLoanCategory"
  >[],
): Set<string> {
  return new Set(
    mappings.filter((m) => m.isLoanCategory).map((m) => m.originalName),
  );
}

/**
 * The rows that are compared: every row except a transfer or a loan payment
 * (the transfer check owns those), a void row (it moves no balance), and a row
 * whose bank id the account already holds on a row of the same date and
 * amount (skipped as already imported). Also answers those held bank ids: the
 * transaction holding one stands for the skipped row, so it pairs with no
 * other row of the file.
 */
export function fileDuplicateIncoming(
  rows: readonly QifTransaction[],
  heldExternalIds: ReadonlyMap<string, HeldBankRow>,
  loanCategories: ReadonlySet<string> = new Set(),
): { incoming: DuplicateIncomingRow<number>[]; heldKeys: Set<string> } {
  const incoming: DuplicateIncomingRow<number>[] = [];
  const heldKeys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const isSplit = (row.splits?.length ?? 0) > 0;
    const isLoanPayment = !isSplit && loanCategories.has(row.category);
    if (row.isTransfer || isLoanPayment || row.void) continue;
    const key = ofxExternalId(row.fitId);
    const holder = key === null ? undefined : heldExternalIds.get(key);
    if (key !== null && holder !== undefined && isSameBankRow(holder, row)) {
      heldKeys.add(key);
      continue;
    }
    incoming.push({ ref: index, date: row.date, amount: row.amount });
  }
  return { incoming, heldKeys };
}

/** Pair the file's rows with the account's transactions (spec section 2). */
export async function pairFileRows(
  m: EntityManager,
  userId: string,
  accountId: string,
  rows: readonly QifTransaction[],
  heldExternalIds: ReadonlyMap<string, HeldBankRow>,
  loanCategories: ReadonlySet<string> = new Set(),
): Promise<Map<number, DuplicateCandidate>> {
  const { incoming, heldKeys } = fileDuplicateIncoming(
    rows,
    heldExternalIds,
    loanCategories,
  );
  if (incoming.length === 0) return new Map();
  const candidates = await loadDuplicateCandidates(
    m,
    userId,
    accountId,
    incoming,
    { excludeBankSynced: false },
  );
  return matchPossibleDuplicates(
    incoming,
    candidates.filter(
      (candidate) =>
        candidate.externalId === null || !heldKeys.has(candidate.externalId),
    ),
  );
}

/** The check's answer for each pair, in file order. */
export function fileDuplicateRows(
  rows: readonly QifTransaction[],
  pairs: ReadonlyMap<number, DuplicateCandidate>,
  decimals: number,
): ImportDuplicateRowDto[] {
  return [...pairs.keys()]
    .sort((a, b) => a - b)
    .map((index) => {
      const row = rows[index];
      const existing = pairs.get(index) as DuplicateCandidate;
      return {
        row: index,
        transactionDate: row.date,
        amount: row.amount,
        payee: row.payee || null,
        memo: row.memo || null,
        referenceNumber: row.number || null,
        existingTransaction: toDuplicateExistingView(existing, decimals),
        duplicateActions: allowedDuplicateActions(existing),
      };
    });
}

/**
 * Hold the decisions to the pairs made now, before anything is written. The
 * existing transactions the decisions name are row-locked first and the rows
 * paired under that lock, so a pair no concurrent edit can move is what each
 * decision is checked against. A decision about a row that is not paired with
 * the transaction it names refuses the whole import (409); one the pair does
 * not allow, or a second one about the same row, is a 400. A pair without a
 * decision is planned with `action: null`.
 */
export async function planFileDuplicates(
  m: EntityManager,
  userId: string,
  accountId: string,
  rows: readonly QifTransaction[],
  heldExternalIds: ReadonlyMap<string, HeldBankRow>,
  decisions: readonly ImportDuplicateDecisionDto[],
  loanCategories: ReadonlySet<string> = new Set(),
): Promise<Map<number, FileDuplicatePlan>> {
  const byRow = new Map<number, ImportDuplicateDecisionDto>();
  for (const decision of decisions) {
    if (byRow.has(decision.row)) {
      throw new ImportDuplicateDecisionRefusedException(
        tr(
          "errors.import.duplicateDecisionRepeated",
          "A row of the file can have only one decision about its possible duplicate.",
        ),
      );
    }
    byRow.set(decision.row, decision);
  }

  if (byRow.size > 0) {
    // Accounts before transactions (docs/concurrency-and-idempotency.md
    // section 5), the order the bank sync writer takes too.
    await lockAccountsForBalanceWrite(m, [accountId], userId);
    await lockTransactionRows(
      m,
      [...byRow.values()].map((decision) => decision.transactionId),
      userId,
    );
  }
  const pairs = await pairFileRows(
    m,
    userId,
    accountId,
    rows,
    heldExternalIds,
    loanCategories,
  );

  const plans = new Map<number, FileDuplicatePlan>();
  for (const [index, existing] of pairs) {
    plans.set(index, { existing, action: null });
  }
  for (const [index, decision] of byRow) {
    const plan = plans.get(index);
    if (plan === undefined || plan.existing.id !== decision.transactionId) {
      throw new ImportDuplicatesChangedException(
        tr(
          "errors.import.duplicatesChanged",
          "The possible duplicates changed since they were checked. Nothing was imported; check again.",
        ),
      );
    }
    if (!allowedDuplicateActions(plan.existing).includes(decision.action)) {
      throw new ImportDuplicateDecisionRefusedException(
        tr(
          "errors.import.duplicateActionNotAllowed",
          "A reconciled transaction cannot be merged or replaced, and a transfer or a split cannot be replaced. Nothing was imported.",
        ),
      );
    }
    plan.action = decision.action;
  }
  return plans;
}

/**
 * Merge a file row into the existing transaction it pairs with: the row's date
 * (not for a transfer leg or a split parent), its check or reference number
 * when it has one, status Cleared, and its bank id when the existing row has
 * none and no row of the account holds it, so the next import of the same
 * statement recognizes the row. The id is stored only when the merge moves
 * the date: recognition needs the row's date and amount to be the file's
 * (`isSameBankRow`), so on a transfer leg or a split parent, which keep their
 * date, it would recognize nothing. Its payee, category, splits, tags and
 * memo stay.
 */
export async function mergeFileRow(
  m: EntityManager,
  userId: string,
  existing: DuplicateCandidate,
  row: QifTransaction,
  heldExternalIds: Map<string, HeldBankRow>,
): Promise<void> {
  const key = ofxExternalId(row.fitId);
  const externalId =
    key !== null &&
    existing.externalId === null &&
    !heldExternalIds.has(key) &&
    mergeMovesDate(existing)
      ? key
      : null;
  await mergeIntoExisting(m, userId, existing, {
    date: row.date,
    referenceNumber: row.number || null,
    externalId,
  });
  if (externalId !== null) holdKey(heldExternalIds, externalId, row);
}
