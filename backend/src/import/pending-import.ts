/**
 * The note the QIF importer still appends to the description of a
 * cross-currency transfer leg it writes provisional. The state itself is
 * `transactions.amount_is_provisional`, which the importer's lookups and the
 * reports' reads of a transfer's posted amounts read (issue #2338, design P4
 * of `docs/future-plans/provisional-amounts.md`); the text decides nothing and
 * is retired by task B4.
 */
export const PENDING_IMPORT_MARKER = "PENDING IMPORT";

export const PENDING_IMPORT_NOTE = `⚠️ ${PENDING_IMPORT_MARKER}: Amount may need adjustment when importing the other account.`;
