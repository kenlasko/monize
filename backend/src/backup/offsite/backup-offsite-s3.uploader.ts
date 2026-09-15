import { Injectable, Logger } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import { tokenHashesEqual } from "../../auth/crypto.util";
import {
  buildS3Client,
  withS3Deadline,
} from "../../attachments/storage/s3-transport";
import { assertSafeStorageKey } from "../../attachments/storage/storage-key.util";
import { OffsiteS3Target, OffsiteUploadResult } from "./backup-offsite.types";

/**
 * Puts one backup artifact on an append-only S3 destination (INV-BACKUP-004,
 * INV-BACKUP-005; `docs/specs/backup-off-machine.md`).
 *
 * This is deliberately **not** `S3StorageProvider`. That class stores attachment
 * bytes and therefore implements `save`/`load`/`delete`; handing the egress path
 * a delete is exactly what the append-only invariant forbids. The two share the
 * transport (`s3-transport.ts` -- client construction, the aborting deadline,
 * the retry ceiling) and nothing else. This class has one public operation and
 * no mutation surface beyond adding an object:
 *
 * - Every write is conditional (`IfNoneMatch: "*"`), so even a mis-scoped
 *   credential cannot replace an object that is already there. A refused put is
 *   reported, never retried unconditionally.
 * - No object is ever read. There is no `GetObject` and no `HeadObject` here,
 *   because the credential this path is documented to use grants neither, and a
 *   uploader that needed a read would quietly widen the IAM policy operators
 *   were told to write. That is why a key that already exists is reported as
 *   `already-present` rather than reconciled here: only the caller, which holds
 *   the recorded digest, can tell "the same artifact is already off-machine"
 *   from a genuine conflict.
 * - **`AbortMultipartUpload` is not object deletion.** It discards an
 *   *incomplete* multipart upload -- parts that have been sent but never
 *   assembled into an object -- and cannot touch an existing object. It is in
 *   the documented IAM policy alongside `s3:PutObject` for exactly that reason:
 *   without it, a failed upload leaves parts accumulating and billable, with
 *   nothing able to clean them.
 *
 * `backup-offsite.guard.spec.ts` holds the import ban and the conditional-write
 * rule mechanically, so neither depends on this comment being read.
 */
@Injectable()
export class BackupOffsiteS3Uploader {
  private readonly logger = new Logger(BackupOffsiteS3Uploader.name);

  /**
   * Copy `body` to `target` under `key`, or report that the key is taken.
   *
   * `sha256Hex` is the egress digest: the SHA-256 of the exact local artifact
   * bytes, computed once at write time. It is declared to the destination so the
   * destination -- not this process -- is what verifies the bytes arrived
   * intact, which is the whole of EXT-002 here.
   *
   * Throws on anything else. A throw means the copy did not happen and the
   * caller records a durable `failed`; it never means "probably fine".
   */
  async upload(
    target: OffsiteS3Target,
    key: string,
    body: Buffer,
    sha256Hex: string,
  ): Promise<OffsiteUploadResult> {
    const digest = normalizedDigest(sha256Hex);
    const objectKey = `${normalizedPrefix(target.prefix)}${assertSafeOffsiteKey(key)}`;
    // One client per upload rather than a cached one: a target may carry a
    // user's own credentials, decrypted for this call only, and a client cached
    // across users would be a credential outliving the context it was decrypted
    // in.
    const client = buildS3Client({
      region: target.region,
      endpoint: target.endpoint,
      forcePathStyle: target.forcePathStyle,
      ...(target.credentials ? { credentials: target.credentials } : {}),
      deadlineMs: target.deadlineMs,
    });
    try {
      return body.length > target.multipartPartBytes
        ? await this.uploadMultipart(client, target, objectKey, body, digest)
        : await this.uploadSingle(client, target, objectKey, body, digest);
    } finally {
      client.destroy();
    }
  }

  /** One conditional, checksummed `PutObject`. */
  private async uploadSingle(
    client: S3Client,
    target: OffsiteS3Target,
    objectKey: string,
    body: Buffer,
    digest: { hex: string; base64: string },
  ): Promise<OffsiteUploadResult> {
    let response;
    try {
      response = await withS3Deadline(
        target.deadlineMs,
        "PutObject",
        (options) =>
          client.send(
            new PutObjectCommand({
              Bucket: target.bucket,
              Key: objectKey,
              Body: body,
              ContentLength: body.length,
              // The destination recomputes this over the bytes it received and
              // rejects a mismatch, so a corrupted transfer fails rather than
              // being recorded as a copy.
              ChecksumSHA256: digest.base64,
              // Append-only: refuse rather than replace.
              IfNoneMatch: "*",
            }),
            options,
          ),
      );
    } catch (error) {
      if (isPreconditionFailed(error)) {
        this.logger.log(
          `Off-site backup key ${objectKey} already exists; nothing was overwritten`,
        );
        return { outcome: "already-present", objectKey };
      }
      throw error;
    }

    // A 200 is not the verification; the echoed checksum is. An endpoint that
    // ignored the header would otherwise let an unverified copy be recorded as
    // done, which is the failure INV-BACKUP-005 exists to prevent. Compared in
    // constant time through the repository's digest-equality helper.
    if (!tokenHashesEqual(response.ChecksumSHA256 ?? null, digest.base64)) {
      throw new Error(
        `Off-site backup ${objectKey} was not verified: the destination ` +
          `answered with checksum ${response.ChecksumSHA256 ?? "(none)"} for ` +
          `declared SHA-256 ${digest.hex}`,
      );
    }
    return { outcome: "uploaded", objectKey };
  }

  /**
   * Create, upload each part with its own checksum, complete conditionally.
   *
   * Any failure after the create aborts the upload before rethrowing: the parts
   * already sent are chargeable and unreachable, and nothing else will ever come
   * back for them.
   */
  private async uploadMultipart(
    client: S3Client,
    target: OffsiteS3Target,
    objectKey: string,
    body: Buffer,
    digest: { hex: string; base64: string },
  ): Promise<OffsiteUploadResult> {
    const created = await withS3Deadline(
      target.deadlineMs,
      "CreateMultipartUpload",
      (options) =>
        client.send(
          new CreateMultipartUploadCommand({
            Bucket: target.bucket,
            Key: objectKey,
            ChecksumAlgorithm: "SHA256",
          }),
          options,
        ),
    );
    const uploadId = created.UploadId;
    if (!uploadId) {
      throw new Error(
        `Off-site backup ${objectKey} could not start: the destination returned no upload id`,
      );
    }

    try {
      const parts = await this.uploadParts(
        client,
        target,
        objectKey,
        uploadId,
        body,
        digest,
      );
      return await this.completeMultipart(
        client,
        target,
        objectKey,
        uploadId,
        parts,
      );
    } catch (error) {
      await this.abortQuietly(client, target, objectKey, uploadId);
      throw error;
    }
  }

  private async uploadParts(
    client: S3Client,
    target: OffsiteS3Target,
    objectKey: string,
    uploadId: string,
    body: Buffer,
    digest: { hex: string; base64: string },
  ): Promise<{ PartNumber: number; ETag: string; ChecksumSHA256: string }[]> {
    const parts: {
      PartNumber: number;
      ETag: string;
      ChecksumSHA256: string;
    }[] = [];
    // The whole-object hash, accumulated over the same slices the parts are cut
    // from. The single-put path gets this check for free -- the destination
    // rejects a body that does not match the declared digest -- but a multipart
    // upload declares only per-part checksums, so nothing on the far side would
    // notice the artifact landing under a key that names a different digest. On
    // an append-only destination that object could never be corrected.
    const whole = createHash("sha256");

    for (let offset = 0, number = 1; offset < body.length; number++) {
      const part = body.subarray(
        offset,
        Math.min(offset + target.multipartPartBytes, body.length),
      );
      offset += part.length;
      whole.update(part);
      const partChecksum = createHash("sha256").update(part).digest("base64");
      const uploaded = await withS3Deadline(
        target.deadlineMs,
        "UploadPart",
        (options) =>
          client.send(
            new UploadPartCommand({
              Bucket: target.bucket,
              Key: objectKey,
              UploadId: uploadId,
              PartNumber: number,
              Body: part,
              ContentLength: part.length,
              ChecksumSHA256: partChecksum,
            }),
            options,
          ),
      );
      if (
        !uploaded.ETag ||
        !tokenHashesEqual(uploaded.ChecksumSHA256 ?? null, partChecksum)
      ) {
        throw new Error(
          `Off-site backup ${objectKey} part ${number} was not verified: the ` +
            `destination answered with checksum ` +
            `${uploaded.ChecksumSHA256 ?? "(none)"} and etag ` +
            `${uploaded.ETag ?? "(none)"}`,
        );
      }
      parts.push({
        PartNumber: number,
        ETag: uploaded.ETag,
        ChecksumSHA256: partChecksum,
      });
    }

    const assembled = whole.digest("hex");
    if (assembled !== digest.hex) {
      throw new Error(
        `Off-site backup ${objectKey} was not sent: its bytes hash to ` +
          `${assembled}, not to the declared egress digest ${digest.hex}`,
      );
    }
    return parts;
  }

  private async completeMultipart(
    client: S3Client,
    target: OffsiteS3Target,
    objectKey: string,
    uploadId: string,
    parts: { PartNumber: number; ETag: string; ChecksumSHA256: string }[],
  ): Promise<OffsiteUploadResult> {
    let response;
    try {
      response = await withS3Deadline(
        target.deadlineMs,
        "CompleteMultipartUpload",
        (options) =>
          client.send(
            new CompleteMultipartUploadCommand({
              Bucket: target.bucket,
              Key: objectKey,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
              // The no-overwrite rule holds for multipart too: the completing
              // call is the one that would publish the object.
              IfNoneMatch: "*",
            }),
            options,
          ),
      );
    } catch (error) {
      if (isPreconditionFailed(error)) {
        this.logger.log(
          `Off-site backup key ${objectKey} already exists; the multipart upload was not completed`,
        );
        // The upload never became an object, so its parts are still incomplete
        // and still ours to clean up.
        await this.abortQuietly(client, target, objectKey, uploadId);
        return { outcome: "already-present", objectKey };
      }
      throw error;
    }

    // A completed multipart object's checksum is composite (`<base64>-<parts>`),
    // not the whole-object SHA-256, so it cannot be compared against the egress
    // digest -- the per-part checksums above are where the bytes were verified.
    // What it can still say is how many parts the destination assembled, and a
    // count that is not ours means the object is not the artifact.
    const assembledParts = Number(
      /-(\d+)$/.exec(response.ChecksumSHA256 ?? "")?.[1] ?? NaN,
    );
    if (Number.isFinite(assembledParts) && assembledParts !== parts.length) {
      throw new Error(
        `Off-site backup ${objectKey} was assembled from ${assembledParts} ` +
          `parts, not the ${parts.length} that were sent`,
      );
    }
    return { outcome: "uploaded", objectKey };
  }

  /**
   * Discard an incomplete multipart upload. Best effort: the failure being
   * handled is what the caller needs to see, and an abort that itself fails must
   * not replace it. What is left behind is parts, never an object.
   */
  private async abortQuietly(
    client: S3Client,
    target: OffsiteS3Target,
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await withS3Deadline(
        target.deadlineMs,
        "AbortMultipartUpload",
        (options) =>
          client.send(
            new AbortMultipartUploadCommand({
              Bucket: target.bucket,
              Key: objectKey,
              UploadId: uploadId,
            }),
            options,
          ),
      );
    } catch (error) {
      this.logger.warn(
        `Could not abort the multipart upload ${uploadId} for ${objectKey}; ` +
          `its parts may remain until the bucket's lifecycle rule removes them: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The egress digest in both forms, or a refusal. */
function normalizedDigest(sha256Hex: string): { hex: string; base64: string } {
  const hex = (sha256Hex ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      "An off-site backup upload needs the artifact's SHA-256 as 64 hex characters",
    );
  }
  return { hex, base64: Buffer.from(hex, "hex").toString("base64") };
}

/** A configured prefix, normalised to at most one trailing slash. */
function normalizedPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  for (const segment of trimmed.split("/")) assertSafePrefixSegment(segment);
  return `${trimmed}/`;
}

/** The key-prefix alphabet the DTO admits (`S3_KEY_PREFIX`): the safe key set plus interior dots. */
const SAFE_PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * One prefix segment, held to the same alphabet the settings DTO validates a
 * user's `s3Prefix` against -- letters, digits, dots, `_` and `-` -- rather than
 * to the attachment key alphabet, which forbids the dot a legal S3 prefix (and
 * the DTO) allows. A prefix the user was told is valid must not fail at the put.
 * `..` and empty segments are still refused, so a prefix cannot climb out of the
 * area it names even when it reached the uploader from the deployment env, which
 * the DTO never validated.
 */
function assertSafePrefixSegment(segment: string): void {
  if (!SAFE_PREFIX_SEGMENT.test(segment) || segment === "..") {
    throw new Error(
      `Refusing to address the off-site object key prefix segment ` +
        `${JSON.stringify(segment)}: it is outside the safe prefix alphabet`,
    );
  }
}

/**
 * Validate an egress object key, which is a *path* of shard segments ending in a
 * filename: `<ab>/<cd>/<userId>/monize-backup-<tier>-<date>-<digest12>.mzbe`.
 *
 * `assertSafeStorageKey` is the attachment rule -- one segment, from an alphabet
 * with no `.` and no `/` in it at all -- and it is what every segment but the
 * last is held to here, so the shard layout an egress key shares with the local
 * volume is validated by the same code that validates it for attachment bytes.
 * The last segment is a filename and must carry dots, so it gets the same
 * alphabet plus interior dots: no leading dot, no empty component, and therefore
 * no way to express `.` or `..`.
 *
 * A key reaching this uploader is server-composed today, which is precisely the
 * argument that was made for the attachment provider before a restore turned
 * `storage_key` into an attacker-supplied string. An append-only destination
 * cannot un-write the object a traversal would address.
 */
function assertSafeOffsiteKey(key: string): string {
  const segments = (key ?? "").split("/");
  const filename = segments.pop() ?? "";
  for (const segment of segments) assertSafeSegment(segment);
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(filename)) {
    throw new Error(
      `Refusing to address the off-site object key ${JSON.stringify(key)}: ` +
        "its last segment is not a backup filename",
    );
  }
  return key;
}

/** One path segment, held to the attachment providers' key alphabet. */
function assertSafeSegment(segment: string): void {
  try {
    assertSafeStorageKey(segment);
  } catch {
    throw new Error(
      `Refusing to address the off-site object key segment ` +
        `${JSON.stringify(segment)}: it is outside the safe key alphabet`,
    );
  }
}

/** True for the destination's "that key is already taken" answer. */
function isPreconditionFailed(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412
  );
}
