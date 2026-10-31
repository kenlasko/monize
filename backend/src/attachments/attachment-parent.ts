/**
 * Which row an attachment hangs off.
 *
 * An attachment has exactly one parent (WTY-003): a transaction, whose
 * receipts and invoices the register shows, or a warranty, whose receipt,
 * manual and photos prove the purchase. `transaction_attachments` keeps its
 * historical name and carries both columns, `transaction_id` and
 * `warranty_id`, with `chk_attachment_one_parent` requiring exactly one of
 * them; this union is the application-side form of that rule. A caller names
 * the parent as a kind and an id and never passes two ids, and every query
 * that reads under a parent derives its column from the kind here rather
 * than spelling it per site.
 *
 * Ownership is `user_id` on the attachment row itself, whichever parent it
 * has, so the `attachment_blobs` policy, the tombstone trigger, the orphan
 * sweeper and the storage migrator need no knowledge of the parent.
 */
export type AttachmentParent =
  | { readonly kind: "transaction"; readonly id: string }
  | { readonly kind: "warranty"; readonly id: string }
  | { readonly kind: "shared-group"; readonly id: string }
  | { readonly kind: "shared-entry"; readonly id: string };

export type AttachmentParentKind = AttachmentParent["kind"];

/**
 * What a warranty's document is. A transaction's attachments always carry
 * `other` (the design's open question W4 keeps the picker off the register).
 */
export const DOCUMENT_KINDS = [
  "receipt",
  "manual",
  "photo",
  "warranty",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DEFAULT_DOCUMENT_KIND: DocumentKind = "other";

/** The SQL column that holds a parent of this kind. */
export function parentColumn(
  parent: AttachmentParent,
): "transaction_id" | "warranty_id" | "shared_group_id" | "shared_entry_id" {
  switch (parent.kind) {
    case "transaction":
      return "transaction_id";
    case "warranty":
      return "warranty_id";
    case "shared-group":
      return "shared_group_id";
    case "shared-entry":
      return "shared_entry_id";
    default:
      return unreachableParent(parent);
  }
}

/**
 * The entity `where` fragment that restricts a read to this parent. One key
 * only, never both: TypeORM drops a `null` value from a `where`, so writing
 * the other column as `null` would read as "any parent" rather than "no
 * parent".
 */
export function attachmentParentWhere(
  parent: AttachmentParent,
):
  | { transactionId: string }
  | { warrantyId: string }
  | { sharedGroupId: string }
  | { sharedEntryId: string } {
  switch (parent.kind) {
    case "transaction":
      return { transactionId: parent.id };
    case "warranty":
      return { warrantyId: parent.id };
    case "shared-group":
      return { sharedGroupId: parent.id };
    case "shared-entry":
      return { sharedEntryId: parent.id };
    default:
      return unreachableParent(parent);
  }
}

/**
 * Both parent columns as a row carries them: the named one set, the other
 * `null`. For an INSERT, where the CHECK needs the pair to be explicit.
 */
export function attachmentParentColumns(parent: AttachmentParent): {
  transactionId: string | null;
  warrantyId: string | null;
  sharedGroupId?: string | null;
  sharedEntryId?: string | null;
} {
  switch (parent.kind) {
    case "transaction":
      return { transactionId: parent.id, warrantyId: null };
    case "warranty":
      return { transactionId: null, warrantyId: parent.id };
    case "shared-group":
      return {
        transactionId: null,
        warrantyId: null,
        sharedGroupId: parent.id,
        sharedEntryId: null,
      };
    case "shared-entry":
      return {
        transactionId: null,
        warrantyId: null,
        sharedGroupId: null,
        sharedEntryId: parent.id,
      };
    default:
      return unreachableParent(parent);
  }
}

/**
 * A transaction's attachments are its own rows plus the documents of every
 * warranty linked to it.
 *
 * The maintainer's ruling (2026-10-22, reversing the consumer rule of design
 * decision 7): a receipt uploaded to a warranty is a fact about the purchase,
 * so it shows in the transaction's attachments list and is counted by the
 * register's paperclip, the `has:attachment` search and the rule engine's
 * attachment fact. The row still has exactly one parent (WTY-003), the
 * warranty; the transaction reaches it through `warranties.transaction_id`.
 * Every linked warranty counts, archived or not, because the document proves
 * the purchase whether or not the warranty is put away.
 *
 * The rule is written here, once, in the two dialects the reads use: a
 * predicate for an `EXISTS` about one transaction, and a join plus the
 * "reached from" expression for a grouped read over a page of them.
 * `attachment-parent.guard.spec.ts` fails a `transaction_attachments` read in
 * the transaction-side consumers that answers for a transaction without one
 * of them, so a count of own rows alone, or a reach into a warranty's
 * documents that skips `warranties.transaction_id`, cannot come back.
 */

/**
 * `transaction_attachments` aliased `taAlias` is reached from the transaction
 * `txIdExpr` names: it is the transaction's own row, or a document of a
 * warranty linked to that transaction. Self-contained, for an `EXISTS`.
 */
export function attachmentReachableFromTransactionSql(
  taAlias: string,
  txIdExpr: string,
): string {
  return (
    `(${taAlias}.transaction_id = ${txIdExpr} OR ${taAlias}.warranty_id IN ` +
    `(SELECT reach_w.id FROM warranties reach_w WHERE reach_w.transaction_id = ${txIdExpr}))`
  );
}

/**
 * The `LEFT JOIN warranties <wAlias>` condition a grouped read adds, so each
 * attachment row sits beside the warranty it hangs off (none for a
 * transaction's own row).
 */
export function reachingWarrantyJoinSql(
  taAlias: string,
  wAlias: string,
): string {
  return `${wAlias}.id = ${taAlias}.warranty_id`;
}

/**
 * The transaction an attachment row is reached from, given the join above:
 * its own, or the one its warranty links to. NULL for a document of a
 * warranty with no purchase, which no transaction reaches. A grouped read
 * selects and groups by this and restricts it to the page's ids.
 */
export function reachedTransactionIdSql(
  taAlias: string,
  wAlias: string,
): string {
  return `COALESCE(${taAlias}.transaction_id, ${wAlias}.transaction_id)`;
}

function unreachableParent(parent: never): never {
  throw new Error(`Unknown attachment parent kind: ${JSON.stringify(parent)}`);
}
