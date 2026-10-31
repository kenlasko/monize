import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { createHash } from "crypto";
import { withScopedDb } from "../common/db/scoped-db";
import {
  ATTACHMENT_STORAGE_PROVIDER,
  AttachmentStorageProvider,
} from "../attachments/storage/attachment-storage.interface";
import {
  clearObjectIntent,
  dropCommittedObjectIntent,
  recordObjectIntent,
} from "../attachments/storage/object-intent";
import { attachmentBytesConsistent } from "./attachment-integrity.util";
import { BackupData } from "./backup-format";

/**
 * How long a restore owns an object it is staging.
 *
 * Covers the whole window between the intent and the restore commit: staging the
 * remaining objects of a large artifact (one put per attachment, each a network
 * call on an object store), the maintenance lease the transaction runs under
 * (`USER_MAINTENANCE_LEASE_MS`, 15 minutes) and the transaction itself. The 15
 * minute upload lease of `AttachmentsService.create` covers one put and is too
 * short for that. Two hours keeps the sweeper away from a restore that is still
 * running; the price is that bytes left by a dead process are reclaimed two
 * hours (plus up to one hourly sweep) later. Correctness does not depend on the
 * value: `clearObjectIntent` refuses, and the restore rolls back, if the sweeper
 * claimed a key first.
 */
export const RESTORE_STAGING_INTENT_LEASE_MS = 2 * 60 * 60 * 1000;

/** What staging left behind for the restore's two cleanup paths to reason about. */
export interface StagedAttachments {
  /** Object keys this restore wrote. Removed if the transaction then fails. */
  stagedKeys: string[];
  /** Object keys this restore read from. Never removed by the post-commit sweep. */
  sourceKeys: string[];
  /** Metadata rows dropped because their bytes could not be made reachable. */
  skipped: number;
}

/**
 * The attachment side of a restore: bytes carried inside the artifact, the
 * database-backed ownership proof a legacy artifact needs before an external
 * object may be read, and the two cleanup paths -- discard what a failed restore
 * staged, remove what a committed restore displaced.
 *
 * Split out of `BackupService` (issue #1092). It is the only place in the restore
 * that touches the object store, which is what makes the ordering rule reviewable:
 * bytes are written *before* the commit and deleted *after* it, so a failure
 * leaves bytes nobody references rather than a row promising bytes that are gone.
 */
@Injectable()
export class BackupAttachmentTransferService {
  private readonly logger = new Logger(BackupAttachmentTransferService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(ATTACHMENT_STORAGE_PROVIDER)
    private readonly attachmentStorage: AttachmentStorageProvider,
  ) {}

  /**
   * Drop the upload intent of every staged key, inside the restore transaction,
   * so the intents commit away with the rows that now own the bytes.
   *
   * Fenced on `swept_at IS NULL`: if the sweeper claimed a key before the commit
   * this throws and the restore rolls back (its `.catch` then discards the rest).
   * One statement after another on the transaction's manager, never in parallel.
   */
  async clearStagingIntents(
    manager: EntityManager,
    stagedKeys: string[],
  ): Promise<void> {
    for (const key of stagedKeys) {
      await clearObjectIntent(manager, this.attachmentStorage.name, key);
    }
  }

  /**
   * Every external object key this user's attachments currently occupy.
   *
   * Empty for the `database` provider: its bytes live in `attachment_blobs` and
   * go with the rows, inside the transaction.
   */
  async collectExternalAttachmentKeys(userId: string): Promise<string[]> {
    if (this.attachmentStorage.name === "database") return [];
    const rows: Array<{ storage_key: string }> = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT storage_key FROM transaction_attachments
            WHERE user_id = $1 AND shared_group_id IS NULL AND shared_entry_id IS NULL AND storage_provider = $2`,
          [userId, this.attachmentStorage.name],
        ),
    );
    return rows.map((row) => row.storage_key).filter(Boolean);
  }

  /**
   * Remove the objects the restore displaced, after it has committed.
   *
   * A destructive restore deletes every `transaction_attachments` row the user
   * had. For `local` and `s3` the bytes are not in those rows, so they used to
   * stay in the volume or the bucket forever, referenced by nothing -- a receipt
   * or a medical document surviving the replacement of the account it belonged
   * to, and still present in whatever backs that storage up. The metadata was
   * gone, so nothing could ever find them again to clean them up either.
   *
   * Three constraints decide when and what:
   *
   * - **After the commit.** Bytes deleted before it that the transaction then
   *   rolls back leave a metadata row promising a download that does not exist,
   *   which the user cannot distinguish from a working attachment. Orphaned bytes
   *   cost storage; a row pointing at nothing costs trust. That is the same rule
   *   `AttachmentsService.remove` follows.
   * - **Only keys the target user held.** Not the old keys named by the uploaded
   *   file: a cross-user restore on the same instance legitimately reads another
   *   user's objects as its source, and the same backup may be restored more than
   *   once. Deleting those would break both.
   * - **Never a key just staged.** Restoring a backup taken from this same
   *   account re-uses ids, so a displaced key and a newly written key can be the
   *   same string. Deleting it would remove the bytes the restore just committed
   *   metadata for.
   * - **Never a key the backup reads as its source.** This is the one that bit:
   *   a backup taken from this account names the keys this account currently
   *   holds, so its source objects *are* its displaced objects. Deleting them
   *   left the artifact naming bytes that no longer existed -- the first restore
   *   worked, and a second restore of the same file skipped every attachment and
   *   then deleted the copy the first restore had made, losing the content
   *   entirely while still reporting success.
   *
   *   So when a key is both an orphan and a source, the source wins. That keeps
   *   an object nothing in the database references, which is exactly what this
   *   method exists to remove -- and it is the right way round: an orphaned copy
   *   of the user's own receipt costs storage, while a backup that can only be
   *   restored once costs the receipt. `stageAttachmentObjects` says the same
   *   thing from the other side, and the two used to contradict each other.
   *
   * Best-effort per key: a storage error here must not turn a completed restore
   * into a failure, since the database is already the backup's. It is logged.
   */
  async deleteDisplacedAttachmentObjects(
    displacedKeys: string[],
    retainedKeys: string[],
  ): Promise<void> {
    if (displacedKeys.length === 0) return;
    const retained = new Set(retainedKeys);
    const removable = displacedKeys.filter((key) => !retained.has(key));
    if (removable.length === 0) return;

    let failures = 0;
    for (const key of removable) {
      try {
        await this.attachmentStorage.delete(key);
      } catch (error) {
        failures += 1;
        this.logger.warn(
          `Could not remove displaced attachment object ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.logger.log(
      `Removed ${removable.length - failures} displaced attachment object(s) after restore` +
        (failures > 0 ? ` (${failures} could not be removed)` : ""),
    );
  }

  /**
   * Makes every restored attachment's bytes reachable under the key its
   * restored metadata will name -- or drops the metadata row and says so.
   *
   * **Two paths, and the first is the one new artifacts take.** A backup now
   * carries attachment bytes for *every* provider, base64 in `attachment_blobs`
   * (see `externalAttachmentRows`). When the bytes are in the artifact the
   * restore uses them directly -- validates them against their own metadata, and
   * places them where this runtime keeps its attachments (in the blob rows for the
   * `database` provider, in the object store for `local`/`s3`, whichever the target
   * runs, rewriting `storage_provider` to match). No object outside the file is
   * read, so no ownership question arises: the bytes are the user's own download.
   * This is what makes a fresh instance and a deleted-metadata account recoverable
   * (F3R5-001).
   *
   * **The second path is the legacy one**, for an artifact produced before bytes
   * travelled. Those carried only metadata for `local`/`s3`, whose objects live
   * outside Postgres under a `storage_key` that equals the attachment's UUID. The
   * restore mints a fresh UUID per row, so the metadata came back pointing at
   * `<new-uuid>` while the object was still at `<old-uuid>`: unreachable after a
   * restore that reported success. So for those the bytes are *copied* from the old
   * key to the new -- and only after the restoring user is shown to own a matching
   * row, because an uploaded id cannot authorize reading a deployment-wide object
   * (F3RRR-001). On a fresh instance that ownership row does not exist and the
   * attachment is skipped, which is exactly why the bytes now travel.
   *
   * Preserving the old key instead of copying would be worse than the original
   * bug: the bytes were not in those older backups, so a restore into a different
   * user on the same instance would hand that user working links to attachments
   * whose contents they were never sent.
   *
   * Either way, a carried or copied object is checked against the size and SHA-256
   * its metadata claims, all before the destructive delete, so a missing or corrupt
   * object cannot be discovered halfway through.
   *
   * An object that cannot be staged is not restorable, and a metadata row
   * pointing at nothing is a broken attachment the user cannot tell from a
   * working one. Refusing the whole restore over a receipt image would be the
   * wrong trade -- the ledger is the point -- so the row is dropped and
   * counted, and the count is reported separately from `restored` rather than
   * added to it.
   *
   * **The right to read a source object comes from the database, not the file.**
   * Before any external object is read, the restoring user must currently own an
   * attachment with that original id, on this provider, with the same byte size
   * and SHA-256 *as stored* -- checked against `transaction_attachments`, which is
   * still intact because staging runs before the destructive delete. A row that
   * fails is unrestorable and is dropped and counted.
   *
   * Two earlier versions of this got it wrong in the same way, and the second was
   * a fix for the first:
   *
   *  1. The destination came from `row.storage_key`, and a key not recognised as a
   *     remapped id was treated as legacy or operator-chosen -- skip the load, the
   *     checksum and the copy, because the object supposedly already sat where the
   *     metadata pointed. A crafted backup could name any valid key, including
   *     another tenant's, and the row was inserted under the uploader's `user_id`.
   *  2. So the keys were derived from the id remap instead, with "a row whose id is
   *     not in the map did not come from this backup's graph" as the boundary. But
   *     the graph is the *uploaded* graph: `collectRowIdRemap` admits every
   *     UUID-shaped `row.id` in the file, so the check could never fire for a
   *     well-formed crafted row. Put the victim's attachment id in `row.id` --
   *     along with the size and hash from any standard backup, which carries
   *     external attachment metadata -- and the restore read their object and
   *     copied it under the attacker's ownership. The uploaded document was
   *     authorizing itself.
   *
   * Which field is trusted was never the question. **No unsigned value from the
   * file can establish ownership** -- not a key, not an id, not a checksum, not a
   * byte count. Only a record the server already holds can.
   *
   * The consequence is deliberate: restoring one user's backup into a *different*
   * user on the same instance now skips external attachments rather than
   * disclosing them, and a fresh instance skips them because the objects are not
   * there. That is the same conclusion the original analysis reached about
   * preserving the old key, applied to reading it.
   *
   * Returns the keys written and the source keys consumed, so a failed database
   * transaction can remove the former and the post-commit cleanup can spare the
   * latter -- see `deleteDisplacedAttachmentObjects`.
   */
  async stageAttachmentObjects(
    userId: string,
    data: BackupData,
    idRemap: Map<string, string>,
  ): Promise<StagedAttachments> {
    const rows = data.transaction_attachments;
    if (!rows?.length) return { stagedKeys: [], sourceKeys: [], skipped: 0 };

    // `idRemap` contains every UUID-keyed row in the uploaded graph. Reversing
    // the whole map allocated another graph-sized array just to authorize legacy
    // attachment reads. Keep only the remapped attachment ids this method can use.
    const attachmentIds = new Set(
      rows.map((row) => String(row.id ?? "")).filter(Boolean),
    );
    const oldIdOf = new Map<string, string>();
    for (const [oldId, newId] of idRemap) {
      if (attachmentIds.has(newId)) oldIdOf.set(newId, oldId);
    }
    // Last row wins for a duplicated id -- and, critically, the row that is
    // *validated* below must be the row that is *inserted*. `attachment_blobs`
    // has `attachment_id` as its primary key, and Phase-2 inserts with
    // `ON CONFLICT DO NOTHING`, so a raw uploaded array with two rows for one id
    // would validate the last and commit the first. A crafted backup could pair
    // valid bytes (checked, accepted) with corrupt bytes (inserted). So the
    // canonical encoded string is kept here beside the decoded Buffer, and
    // `data.attachment_blobs` is rebuilt from it below -- one row per id, exactly
    // the bytes that passed the check.
    const carriedBytes = new Map<string, Buffer>();
    const canonicalEncoded = new Map<string, string>();
    for (const blob of data.attachment_blobs ?? []) {
      const id = String(blob.attachment_id ?? "");
      if (id.length === 0) continue;
      const encoded = blob.data;
      if (typeof encoded !== "string") continue;
      carriedBytes.set(id, Buffer.from(encoded, "base64"));
      canonicalEncoded.set(id, encoded);
    }

    const runtimeProvider = this.attachmentStorage.name;

    // Only legacy external rows need a database ownership proof. Current-format
    // rows carry their bytes and never read a source object; database-provider or
    // cross-provider legacy rows cannot use this runtime's object store either.
    const legacySourceIds = new Set<string>();
    for (const row of rows) {
      const attachmentId = String(row.id ?? "");
      if (carriedBytes.has(attachmentId)) continue;
      const provider = String(row.storage_provider ?? "database");
      if (provider === "database" || provider !== runtimeProvider) continue;
      const oldId = oldIdOf.get(attachmentId);
      if (oldId !== undefined) legacySourceIds.add(oldId);
    }

    // `loadOwnedAttachmentSources` returns before querying for an empty list, so
    // a fully self-contained backup performs no legacy ownership read at all.
    const ownedSources = await this.loadOwnedAttachmentSources(userId, [
      ...legacySourceIds,
    ]);

    const stagedKeys: string[] = [];
    const sourceKeys: string[] = [];
    const unrestorable = new Set<string>();
    /** Blob rows for attachments whose bytes are going to the object store. */
    const externallyPlaced = new Set<string>();

    for (const row of rows) {
      const attachmentId = String(row.id ?? "");
      const provider = String(row.storage_provider ?? "database");

      // Whatever the file said, the key is the attachment id. Every provider
      // addresses by it (the database provider by primary key, local and s3 by
      // object name), and normalising here means no uploaded value reaches a
      // provider from any path.
      row.storage_key = attachmentId;

      const carried = carriedBytes.get(attachmentId);
      if (carried !== undefined) {
        // The bytes are in the artifact, so nothing outside it is consulted and no
        // ownership question arises: this is the user's own download, and it can
        // only ever grant them their own files. This is the path that makes a
        // fresh instance and a deleted-metadata account recoverable.
        if (!attachmentBytesConsistent(carried, row)) {
          unrestorable.add(attachmentId);
          continue;
        }

        // Where the bytes land is this runtime's decision, not the source
        // instance's -- so a backup taken under one provider restores under
        // another, which used to be a skip.
        row.storage_provider = runtimeProvider;
        if (runtimeProvider === "database") {
          // The blob row stays and is inserted with everything else.
          continue;
        }
        if (
          !(await this.tryStageAttachmentObject(userId, attachmentId, carried))
        ) {
          // The write failed: drop the row rather than halt the whole restore,
          // and leave the objects already staged this run untouched -- they are
          // referenced by attachments that are still coming back.
          unrestorable.add(attachmentId);
          continue;
        }
        stagedKeys.push(attachmentId);
        // ...and its blob row must not be inserted: `attachment_blobs` is the
        // database provider's storage, and a row there for an externally stored
        // attachment is a second copy nothing reads.
        externallyPlaced.add(attachmentId);
        continue;
      }

      if (provider === "database") {
        // Bytes should have travelled and did not. The metadata row describes a
        // download that will 404, which the user cannot tell from a working
        // attachment.
        unrestorable.add(attachmentId);
        continue;
      }

      if (provider !== runtimeProvider) {
        // An artifact from before external bytes travelled, taken on a different
        // backend. There is nothing here to read and nothing in the file.
        unrestorable.add(attachmentId);
        continue;
      }

      const oldKey = oldIdOf.get(attachmentId);
      if (oldKey === undefined) {
        // Not a remapped id at all, so there is no original to read from.
        unrestorable.add(attachmentId);
        continue;
      }

      // The authorization check. `owned` comes from the database; every field of
      // `row` comes from the uploaded file, so the two are compared and the file
      // never gets the last word. A mismatch means this user is not entitled to
      // these bytes -- whether the file is crafted or merely stale.
      const owned = ownedSources.get(oldKey);
      if (
        owned === undefined ||
        owned.provider !== provider ||
        owned.byteSize !== Number(row.byte_size) ||
        (typeof row.sha256 === "string" && owned.sha256 !== row.sha256)
      ) {
        unrestorable.add(attachmentId);
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await this.attachmentStorage.load(oldKey);
      } catch {
        unrestorable.add(attachmentId);
        continue;
      }

      // Integrity, against the *stored* size and hash rather than the file's.
      // The file's values were already required to equal these, so this catches
      // an object that has changed under the row since -- corruption, a partial
      // write, an operator replacing bytes by hand.
      if (bytes.length !== owned.byteSize) {
        unrestorable.add(attachmentId);
        continue;
      }
      if (owned.sha256.length > 0) {
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== owned.sha256) {
          unrestorable.add(attachmentId);
          continue;
        }
      }

      // `oldKey` was loaded and its bytes verified above, so it is a source this
      // restore read from -- record it *before* attempting the destination
      // write, not after. On a same-account restore `oldKey` is also the user's
      // current, displaced object and the file's only copy of these bytes; if
      // the copy then fails and this row is dropped (below), the post-commit
      // sweep must still spare `oldKey` rather than delete the bytes and leave
      // the backup unrestorable. `sourceKeys` is defined as exactly "keys this
      // restore read from, never removed by the post-commit sweep", and reading
      // is what already happened here.
      sourceKeys.push(oldKey);

      if (!(await this.tryStageAttachmentObject(userId, attachmentId, bytes))) {
        unrestorable.add(attachmentId);
        continue;
      }
      stagedKeys.push(attachmentId);
    }

    if (unrestorable.size > 0) {
      // Immutability: the caller's arrays are replaced, not spliced.
      data.transaction_attachments = rows.filter(
        (row) => !unrestorable.has(String(row.id ?? "")),
      );
      this.logger.warn(
        `Restore is dropping ${unrestorable.size} attachment(s) whose bytes could not be staged ` +
          `(provider ${runtimeProvider}); their metadata would point at nothing.`,
      );
    }

    // Rebuild `attachment_blobs` from the canonical, validated bytes rather than
    // filtering the uploaded array. This does three things at once, and the third
    // is why filtering was not enough:
    //  - drops rows whose attachment was unrestorable;
    //  - drops rows whose bytes went to the object store instead (a row in
    //    `attachment_blobs` for an externally stored attachment is a second copy
    //    nothing reads);
    //  - collapses any duplicate `attachment_id` to the single row whose bytes
    //    were checked, so the primary-key conflict can no longer commit a
    //    different, unverified copy than the one staging validated.
    // Every id here was decoded and (for database-provider rows that stayed)
    // checked against its metadata; a malformed row with no usable id or data was
    // never admitted to the map.
    const rebuiltBlobs: Record<string, unknown>[] = [];
    for (const [id, encoded] of canonicalEncoded) {
      if (unrestorable.has(id) || externallyPlaced.has(id)) continue;
      rebuiltBlobs.push({ attachment_id: id, data: encoded });
    }
    data.attachment_blobs = rebuiltBlobs;

    return { stagedKeys, sourceKeys, skipped: unrestorable.size };
  }

  /**
   * The attachments this user owns among `candidateIds`, by id.
   *
   * Scoped to the user in the query, so the answer cannot include somebody
   * else's row however the ids were chosen. `byte_size` and `sha256` come back so
   * the caller can require the uploaded row to agree with the stored one -- an
   * uploaded field that has to match a stored field is no longer a field the
   * uploader controls.
   */
  private async loadOwnedAttachmentSources(
    userId: string,
    candidateIds: string[],
  ): Promise<
    Map<string, { provider: string; byteSize: number; sha256: string }>
  > {
    const owned = new Map<
      string,
      { provider: string; byteSize: number; sha256: string }
    >();
    if (candidateIds.length === 0) return owned;

    const rows: Array<{
      id: string;
      storage_provider: string;
      byte_size: string | number;
      sha256: string | null;
    }> = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        `SELECT id, storage_provider, byte_size, sha256
           FROM transaction_attachments
          WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [userId, candidateIds],
      ),
    );
    for (const row of rows) {
      owned.set(String(row.id), {
        provider: String(row.storage_provider),
        byteSize: Number(row.byte_size),
        sha256: String(row.sha256 ?? ""),
      });
    }
    return owned;
  }

  /**
   * Write one staged object, turning a provider failure into a dropped
   * attachment rather than an aborted restore.
   *
   * A bare `attachmentStorage.save` that throws mid-loop does two bad things at
   * once. It halts a restore that could have completed without this one
   * attachment -- the ledger is the point, and refusing the whole thing over a
   * receipt image is the wrong trade, the same one `stageAttachmentObjects`
   * already makes for a missing or corrupt object. And the throw escapes
   * `stageAttachmentObjects` before it can return `stagedKeys`, so every object
   * already staged this run is orphaned: the caller never receives the list its
   * `.catch` would have discarded.
   *
   * So a failed save is handled where it happens. The object under `key` is the
   * one the restored metadata would have named, so a partial write there is
   * exactly the leak this method exists to avoid -- delete it, best-effort, and
   * swallow a delete error the way the post-commit sweep does. The caller reads
   * the `false` and drops the row (counting it in `skipped`); the objects staged
   * before this one stay, still referenced by attachments that are restoring.
   *
   * Returns whether the bytes are now reachable under `key`.
   */
  private async tryStageAttachmentObject(
    userId: string,
    key: string,
    bytes: Buffer,
  ): Promise<boolean> {
    // The intent is committed before the put (the protocol of
    // `AttachmentsService.create`), so a process that dies before the restore
    // commits leaves a row the orphan sweeper can find. When it cannot be
    // recorded the bytes are not written: an object nothing can enumerate is the
    // leak this exists to prevent.
    try {
      await recordObjectIntent(
        this.dataSource,
        this.attachmentStorage.name,
        key,
        userId,
        RESTORE_STAGING_INTENT_LEASE_MS,
      );
    } catch (error) {
      this.logger.warn(
        `Could not record the staging intent for attachment object ${key} during ` +
          `restore; dropping the attachment: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return false;
    }
    try {
      await this.attachmentStorage.save(key, bytes);
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not stage attachment object ${key} during restore; dropping the ` +
          `attachment: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (await this.deleteStagedObject(key)) {
        await this.dropStagingIntent(key);
      }
      return false;
    }
  }

  /** Best-effort delete of one staged object; `true` when the object is gone. */
  private async deleteStagedObject(key: string): Promise<boolean> {
    try {
      await this.attachmentStorage.delete(key);
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not remove staged attachment object ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /** Best-effort: the bytes are gone, so the intent that guarded them goes too. */
  private dropStagingIntent(key: string): Promise<void> {
    return dropCommittedObjectIntent(
      this.dataSource,
      this.attachmentStorage.name,
      key,
      (message) =>
        this.logger.warn(
          `Could not drop the staging intent of attachment object ${key}: ${message}`,
        ),
    );
  }

  /**
   * Best-effort removal of objects staged for a restore that then failed.
   *
   * The intent goes only after a successful delete. When the delete fails the
   * intent stays, and the sweeper removes the bytes once its lease expires.
   */
  async discardStagedAttachmentObjects(stagedKeys: string[]): Promise<void> {
    for (const key of stagedKeys) {
      if (await this.deleteStagedObject(key)) {
        await this.dropStagingIntent(key);
      }
    }
  }
}
