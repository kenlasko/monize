import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from "typeorm";

/** One configured target kind for one user. A user may hold both. */
export type BackupOffsiteDestination = "s3" | "email";

/** The published tier of the artifact being copied; never `partial`. */
export type BackupOffsiteTier = "daily" | "weekly" | "monthly";

/**
 * Where one (user, destination, key) copy has got to.
 *
 * `pending` is claimable, `uploading` is claimed, and every other value is
 * terminal for this attempt. `failed` is durable and carries the digest, so the
 * reaper re-attempts the same bytes under the same key; `conflict` is the key
 * already holding *different* bytes, which is an anomaly to surface and never to
 * resolve by overwriting (`docs/specs/backup-off-machine.md` section 5).
 */
export type BackupOffsiteUploadStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "failed"
  | "conflict"
  | "skipped-unencrypted"
  | "skipped-too-large";

/**
 * One row per (user, destination, object key): the durable, attributable state
 * EXT-001/EXT-003 require for an off-machine copy of a backup artifact.
 *
 * The unique key on (userId, destination, objectKey) is the natural key of the
 * copy, and the object key carries the egress digest, so re-dispatching the same
 * bytes lands on this same row rather than creating a second one. The claim that
 * moves `status` from `pending` to `uploading` is a conditional UPDATE on the
 * current status, which is what makes exactly one of two replicas the winner.
 *
 * Instance-bound: the table is excluded from every backup artifact
 * (`INTENTIONALLY_EXCLUDED_TABLES`) because it describes this deployment's
 * egress, not portable user data.
 */
@Entity("backup_offsite_uploads")
// The natural key of the copy, and the arbiter of the claim's
// `INSERT ... ON CONFLICT (user_id, destination, object_key)`. Declared here as
// well as in the migration and schema.sql because the integration suite builds
// its schema from the entities: without the decorator the test database has no
// constraint for `ON CONFLICT` to match, and the single-winner race would have
// nothing to contend over (AGENTS.md, "declared in all three").
@Unique("uq_backup_offsite_uploads_user_dest_key", [
  "userId",
  "destination",
  "objectKey",
])
// The reaper selects failed rows aged by updated_at; the owner-facing list reads
// newest-first per user. Both mirror the migration's indexes.
@Index("idx_backup_offsite_uploads_status_updated", ["status", "updatedAt"])
@Index("idx_backup_offsite_uploads_user_created", ["userId", "createdAt"])
export class BackupOffsiteUpload {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @Column({ type: "text" })
  destination: BackupOffsiteDestination;

  /** S3: the full object key. Email: the artifact filename. */
  @Column({ name: "object_key", type: "text" })
  objectKey: string;

  @Column({ type: "text" })
  tier: BackupOffsiteTier;

  /** SHA-256 of the exact artifact bytes as written locally, hex. */
  @Column({ type: "char", length: 64 })
  digest: string;

  @Column({
    name: "size_bytes",
    type: "bigint",
    // BIGINT arrives from the pg driver as a string; the email destination
    // compares this against BACKUP_EMAIL_MAX_BYTES as a number.
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | null): number | null =>
        value === null ? null : Number(value),
    },
  })
  sizeBytes: number;

  @Column({ type: "text" })
  status: BackupOffsiteUploadStatus;

  @Column({ type: "int", default: 0 })
  attempts: number;

  @Column({ name: "last_error", type: "text", nullable: true })
  lastError: string | null;

  @Column({ name: "claimed_at", type: "timestamp", nullable: true })
  claimedAt: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
