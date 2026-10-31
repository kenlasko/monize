import { exportedAttachment } from "./shared-backup";
import { BackupCompletenessReport } from "./backup-format";
import { attachmentDigestConsistent } from "./attachment-integrity.util";
import { DEFAULT_EXPORT_BATCH_ROWS, ExportReader } from "./export-cursor";

/**
 * Whether an artifact will carry the bytes of every attachment it names, decided
 * **before** the first byte is written and without holding any of those bytes.
 *
 * Two rules meet here and neither may give way:
 *
 *  - A download the server knows cannot restore everything it names says so in
 *    its own headers and filename (F3RB-004), which means the verdict has to
 *    exist before anything reaches the socket.
 *  - Peak memory must not track the size of the attachment set (F3RB-006, issue
 *    #1070), which rules out the old answer -- read every blob and every object
 *    into arrays, assemble, then judge what was assembled.
 *
 * So the verdict is reached from digests rather than from bytes. For the
 * `database` provider Postgres computes `octet_length` and `sha256` over the
 * column and only those travel; for `local`/`s3` each object is opened, checked
 * and dropped, one at a time. That costs the external stores a second read of
 * each object when the body is written -- the deliberate price of knowing the
 * answer before the download starts, and it is bounded work rather than bounded
 * memory being traded away.
 */

/** What one attachment's bytes turned out to be, without keeping them. */
export type AttachmentReadResult =
  | { status: "ok"; bytes: Buffer }
  | { status: "unreadable" }
  | { status: "inconsistent" };

/**
 * Opens one attachment object and checks it against its metadata row. Owned by
 * `BackupExportService`, which holds the storage provider -- there is exactly one
 * such reader in the export half of the module, and the source guard in
 * `backup.service.spec.ts` is what keeps it that way.
 */
export type AttachmentObjectReader = (
  id: string,
  row: Record<string, unknown>,
) => Promise<AttachmentReadResult>;

/**
 * Whether a row's own `storage_provider` names an object store this export can
 * read from.
 *
 * A predicate rather than the bound provider's name, which is what this file used
 * to compare each row against. Those two are the same value only once a storage
 * switch has finished relocating (`AttachmentStorageMigrator`): mid-relocation, a
 * comparison against the bound provider counted every not-yet-moved attachment as
 * missing and made the artifact incomplete -- for bytes this process could read
 * perfectly well, through the backend the row itself names. `database` is always
 * false here: its bytes travel in `attachment_blobs` with the rows.
 */
export type ExternalProviderPredicate = (providerName: string) => boolean;

export interface AttachmentAudit {
  report: BackupCompletenessReport;
  /**
   * External object ids whose bytes were read and verified during the audit --
   * exactly the ones the body will carry. Ids only: a set of UUIDs for a
   * thousand attachments is tens of kilobytes, where their bytes would be
   * gigabytes.
   */
  carriedExternalIds: ReadonlySet<string>;
  /** Objects the store could not produce at all. */
  unreadable: number;
  /** Objects whose bytes no longer match the size or checksum recorded for them. */
  inconsistent: number;
}

/** Every attachment metadata row for the user, in id order. */
const ATTACHMENT_METADATA_SQL = `SELECT id, storage_provider, byte_size, sha256
         FROM transaction_attachments
        WHERE ${exportedAttachment()}
        ORDER BY id`;

/**
 * Size and checksum of each `database`-provider blob, computed by Postgres.
 *
 * The bytes stay in the database: this returns a number and 64 hex characters
 * per attachment. Doing the same in JavaScript would mean pulling every blob
 * onto the heap to hash it, which is the defect this file exists to remove.
 *
 * The comparison itself is still `attachment-integrity.util.ts` -- the same
 * predicate the export's object reader and the restore's staging use. A second
 * copy of "does this match its metadata" written in SQL is exactly the drift
 * `AGENTS.md` warns about, so the digest travels and the judgement does
 * not.
 */
const ATTACHMENT_BLOB_DIGEST_SQL = `SELECT ab.attachment_id,
                octet_length(ab.data) AS byte_size,
                encode(sha256(ab.data), 'hex') AS sha256
           FROM attachment_blobs ab
           JOIN transaction_attachments ta ON ab.attachment_id = ta.id
          WHERE ${exportedAttachment("ta")}`;

interface BlobDigest {
  byteSize: number;
  sha256: string | null;
}

async function readBlobDigests(
  reader: ExportReader,
): Promise<Map<string, BlobDigest>> {
  const digests = new Map<string, BlobDigest>();
  for await (const batch of reader.rows(
    ATTACHMENT_BLOB_DIGEST_SQL,
    DEFAULT_EXPORT_BATCH_ROWS,
  )) {
    for (const row of batch) {
      digests.set(String(row.attachment_id ?? ""), {
        byteSize: Number(row.byte_size),
        sha256: typeof row.sha256 === "string" ? row.sha256 : null,
      });
    }
  }
  return digests;
}

/**
 * Reaches the completeness verdict for `userId`'s attachments.
 *
 * Runs inside the export snapshot, so its judgement about the database provider
 * is not a prediction: the body reads the same `REPEATABLE READ` snapshot and
 * will find exactly the rows counted here. The external half is a judgement
 * about an object store, which nothing can hold still -- an object that changes
 * between the audit and the body is caught again when the body re-verifies it,
 * and the divergence is logged rather than silently packaged.
 */
export async function auditAttachments(
  reader: ExportReader,
  isReadable: ExternalProviderPredicate,
  readObject: AttachmentObjectReader,
): Promise<AttachmentAudit> {
  const digests = await readBlobDigests(reader);
  const carriedExternalIds = new Set<string>();
  let expected = 0;
  let missing = 0;
  let inconsistent = 0;
  let unreadable = 0;

  for await (const batch of reader.rows(
    ATTACHMENT_METADATA_SQL,
    DEFAULT_EXPORT_BATCH_ROWS,
  )) {
    for (const row of batch) {
      expected += 1;
      const id = String(row.id ?? "");
      const digest = digests.get(id);
      if (digest) {
        // The bytes are already in the artifact, in `attachment_blobs`. Only the
        // database provider's are unvalidated at this point; a row from another
        // provider that also has a blob is a legacy mixed state, and its bytes
        // travelling is what matters rather than which column they came from.
        if (String(row.storage_provider ?? "database") === "database") {
          const consistent = attachmentDigestConsistent(
            { byteSize: digest.byteSize, sha256: () => digest.sha256 },
            row,
          );
          if (!consistent) inconsistent += 1;
        }
        continue;
      }
      // No blob, and nowhere else to look. A `database`-provider row's bytes were
      // supposed to be in `attachment_blobs` and are not; a row naming a backend
      // this deployment cannot address travels as metadata only. Neither case
      // opens an object store: there is nothing there to open.
      if (!isReadable(String(row.storage_provider ?? "database"))) {
        missing += 1;
        continue;
      }
      const result = await readObject(id, row);
      if (result.status === "ok") {
        carriedExternalIds.add(id);
        continue;
      }
      // An object the store cannot produce, or one whose bytes contradict the
      // row, is omitted rather than packaged -- and the artifact is incomplete
      // by exactly that attachment. Counted as missing either way: what the user
      // needs to know is that the bytes are not in the file.
      if (result.status === "unreadable") unreadable += 1;
      else inconsistent += 1;
      missing += 1;
    }
  }

  const included = expected - missing - inconsistent;
  return {
    report: {
      complete: missing === 0 && inconsistent === 0,
      expectedAttachments: expected,
      includedAttachments: included,
      missingAttachments: missing,
      inconsistentAttachments: inconsistent,
    },
    carriedExternalIds,
    unreadable,
    inconsistent,
  };
}

/**
 * The `local`/`s3` providers' bytes, as `attachment_blobs` rows, one at a time.
 *
 * **A backup that cannot restore an attachment is not a backup of it.** Only
 * `database`-provider bytes used to travel; for `local` and `s3` the artifact
 * carried metadata and the operator was told to restore the sidecar volume or
 * bucket alongside it. That works only while the *target* database still holds
 * the matching row, because the restore has to prove the caller is entitled to
 * read the object before it reads it -- and after the ownership fix, the proof is
 * a current `transaction_attachments` row. So the two cases backups exist for
 * both failed: a fresh instance has no such row, and an account whose attachment
 * was deleted has no such row either.
 *
 * There is no way to fix that with a better ownership check. An identifier, a
 * size and a hash in an uploaded document cannot establish a right to read an
 * object, however they are combined. The only thing that can is the bytes being
 * *in* the artifact the user downloaded, which is what this does.
 *
 * What it no longer costs is memory. This used to build one array of every
 * carried object, base64-encoded, before serialisation began -- thirty 10 MiB
 * receipts are ~400 MiB of text on a pod the chart sizes at 400 MiB. Yielding a
 * row at a time means one object is resident, and the writer drops it as soon as
 * gzip has taken it (issue #1070).
 *
 * `only`, when given, is the audit's verdict: the ids whose bytes were read and
 * verified before the download started. Rows outside it are skipped without a
 * read, so the body cannot carry an object the headers said was missing.
 */
export function externalAttachmentRows(
  isReadable: ExternalProviderPredicate,
  readObject: AttachmentObjectReader,
  options: {
    only?: ReadonlySet<string>;
    onDivergence?: (id: string) => void;
  } = {},
): (reader: ExportReader) => AsyncGenerator<Record<string, unknown>> {
  return async function* (reader: ExportReader) {
    for await (const batch of reader.rows(
      ATTACHMENT_METADATA_SQL,
      DEFAULT_EXPORT_BATCH_ROWS,
    )) {
      for (const row of batch) {
        // A `database`-provider row's bytes are already in the rows the table
        // query returned, and a backend this deployment cannot address has
        // nothing to read: the predicate answers both.
        if (!isReadable(String(row.storage_provider ?? "database"))) continue;
        const id = String(row.id ?? "");
        if (options.only && !options.only.has(id)) continue;
        const result = await readObject(id, row);
        if (result.status !== "ok") {
          // The audit read this object successfully moments ago, inside the same
          // snapshot; the store has changed under us since. Nothing here can
          // restore the header's promise, so say so rather than let the count in
          // the response quietly stop describing the file.
          options.onDivergence?.(id);
          continue;
        }
        yield { attachment_id: id, data: result.bytes.toString("base64") };
      }
    }
  };
}

/** Exposed for the specs that assert the export never widens its own scope. */
export const ATTACHMENT_EXPORT_SQL = {
  metadata: ATTACHMENT_METADATA_SQL,
  blobDigests: ATTACHMENT_BLOB_DIGEST_SQL,
};
