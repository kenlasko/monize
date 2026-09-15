import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Which S3 destination a user's automatic backups are copied to.
 *
 * `deployment` uses the operator's bucket and the operator's credentials, so
 * every `s3*` column on this row stays null; `own` uses this row's bucket and
 * this row's encrypted credentials. `off` is the default and means no S3
 * destination at all.
 */
export type BackupOffsiteS3Mode = "off" | "deployment" | "own";

/**
 * One row per user: the off-machine destinations for a completed automatic
 * backup (`docs/specs/backup-off-machine.md` section 9).
 *
 * The two secret columns hold AES-256-GCM ciphertext produced by
 * `EncryptionService` under this instance's `ENCRYPTION_KEY`. They are never
 * returned to the client -- the settings API reports whether a secret is set,
 * never its value -- and the table is excluded from every backup artifact
 * (`INTENTIONALLY_EXCLUDED_TABLES`), because ciphertext under a key that does
 * not travel would restore populated and unreadable.
 *
 * The email destination is independent of the S3 one: a user may enable both
 * for a 3-2-1 arrangement, and neither loosens the rules for the other.
 */
@Entity("backup_offsite_settings")
export class BackupOffsiteSettings {
  @PrimaryColumn("uuid", { name: "user_id" })
  userId: string;

  @Column({ name: "s3_mode", type: "text", default: "off" })
  s3Mode: BackupOffsiteS3Mode;

  @Column({ name: "s3_bucket", type: "text", nullable: true })
  s3Bucket: string | null;

  @Column({ name: "s3_region", type: "text", nullable: true })
  s3Region: string | null;

  @Column({ name: "s3_prefix", type: "text", nullable: true })
  s3Prefix: string | null;

  @Column({ name: "s3_endpoint", type: "text", nullable: true })
  s3Endpoint: string | null;

  @Column({ name: "s3_force_path_style", default: false })
  s3ForcePathStyle: boolean;

  /** AES-256-GCM ciphertext under this instance's ENCRYPTION_KEY. */
  @Column({ name: "s3_access_key_id", type: "text", nullable: true })
  s3AccessKeyId: string | null;

  /** AES-256-GCM ciphertext under this instance's ENCRYPTION_KEY. */
  @Column({ name: "s3_secret_access_key", type: "text", nullable: true })
  s3SecretAccessKey: string | null;

  @Column({ name: "email_enabled", default: false })
  emailEnabled: boolean;

  @Column({ name: "email_to", type: "text", nullable: true })
  emailTo: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
