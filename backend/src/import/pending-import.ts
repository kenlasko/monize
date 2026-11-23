/**
 * The flag the QIF importer puts in the description of a cross-currency
 * transfer leg whose amount is not the bank's own: QIF carries no rate, so the
 * leg holds the file's figure (or the market rate's) as a placeholder until the
 * other account's file is imported, which replaces the amount and the
 * description together. The importer's pending lookups and the reports' reads
 * of a transfer's posted amounts all match this one text.
 */
export const PENDING_IMPORT_MARKER = "PENDING IMPORT";

export const PENDING_IMPORT_NOTE = `⚠️ ${PENDING_IMPORT_MARKER}: Amount may need adjustment when importing the other account.`;

/** The `LIKE` pattern a SQL read matches the flag with. */
export const PENDING_IMPORT_LIKE = `%${PENDING_IMPORT_MARKER}%`;

/**
 * Whether a transfer leg's amount is still the importer's placeholder, so it
 * is not yet a figure that moved (issue #2338).
 */
export function isPendingImportAmount(
  description: string | null | undefined,
): boolean {
  return !!description && description.includes(PENDING_IMPORT_MARKER);
}
