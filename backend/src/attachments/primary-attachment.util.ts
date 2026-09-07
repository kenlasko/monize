import { IsNull } from "typeorm";

/**
 * "Is this a visible attachment?", written once.
 *
 * A scanned document is stored as two rows -- the enhanced image the user sees
 * and the original photo it came from -- linked by
 * `original_of_attachment_id`, which is set on the ORIGINAL and NULL on
 * everything a user is meant to see (`docs/future-plans/document-scanner.md`).
 * So every read that answers "how many attachments does this transaction have"
 * or "which ones do I show" has to exclude the originals, and each of those
 * reads is in a different file: the per-transaction cap, the list, the
 * register's `attachmentCount`, the `hasAttachments` filter.
 *
 * Four sites spelling the same condition is how a list showing one row ends up
 * beside a register cell reading "2". The condition lives here in the two
 * dialects the codebase uses, and `primary-attachment.guard.spec.ts` fails when
 * the column is named in a query anywhere else.
 */

/** Raw-SQL form. Callers add their own alias where the query needs one. */
export const PRIMARY_ATTACHMENT_SQL = "original_of_attachment_id IS NULL";

/**
 * Raw-SQL form for a query that aliases `transaction_attachments`.
 *
 * A separate function rather than string concatenation at the call site,
 * because an alias pasted in by hand is the version the guard cannot check.
 */
export function primaryAttachmentSql(alias: string): string {
  return `${alias}.${PRIMARY_ATTACHMENT_SQL}`;
}

/** TypeORM `where` fragment, to spread into a `find`/`count` condition. */
export const primaryAttachmentWhere = {
  originalOfAttachmentId: IsNull(),
} as const;
