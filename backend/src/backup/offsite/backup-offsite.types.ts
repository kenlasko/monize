/**
 * The shapes the off-machine copy of a backup is described by.
 *
 * They are deliberately plain data rather than an entity or a DTO: one
 * destination is a deployment default read from configuration and another is a
 * user's own row with decrypted credentials, and the uploader must not be able
 * to tell the two apart -- it receives a resolved target and nothing else, so
 * there is no path in it that could reach a bucket the user did not choose.
 *
 * `docs/specs/backup-off-machine.md` is the contract these serve
 * (INV-BACKUP-004, INV-BACKUP-005).
 */

/** An S3 key pair, decrypted for the duration of one upload. */
export interface OffsiteS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * One resolved S3 destination: where the object goes and how the transport is
 * bounded. Credentials are optional so a deployment bucket can be reached
 * through an instance role instead of a stored key pair.
 */
export interface OffsiteS3Target {
  bucket: string;
  region?: string;
  /** Joined ahead of the caller's key; normalised to one trailing slash. */
  prefix?: string;
  /** Set for MinIO, R2, B2 and the like; unset for AWS. */
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: OffsiteS3Credentials;
  /** Per-request abort deadline, already clamped by `clampS3Deadline`. */
  deadlineMs: number;
  /** An artifact larger than this goes as a multipart upload. */
  multipartPartBytes: number;
}

/**
 * What one upload attempt achieved.
 *
 * - `uploaded` -- the destination verified these bytes under this key.
 * - `already-present` -- the key exists, so the conditional put was refused and
 *   nothing was overwritten. The uploader holds no read credential and so
 *   cannot say whose bytes are there; the caller decides by comparing its
 *   recorded digest (section 5 of the spec).
 * - `conflict` -- that comparison found a different digest under the key. It is
 *   part of this vocabulary because it is a durable off-site status, but
 *   `BackupOffsiteS3Uploader.upload` never returns it: only the caller holds the
 *   recorded digest the comparison needs.
 */
export type OffsiteUploadOutcome = "uploaded" | "already-present" | "conflict";

export interface OffsiteUploadResult {
  outcome: OffsiteUploadOutcome;
  /** The full key the attempt addressed, prefix included. */
  objectKey: string;
}
