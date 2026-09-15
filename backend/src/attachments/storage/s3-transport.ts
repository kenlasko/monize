import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

/**
 * The transport half of talking to an S3-compatible endpoint: how the client is
 * built, how long an operation may run, and how a configured timeout is clamped.
 *
 * It exists because there is now more than one caller. `S3StorageProvider`
 * stores attachment bytes and needs `save`/`load`/`delete`; the backup egress
 * uploader (`backend/src/backup/offsite/backup-offsite-s3.uploader.ts`) may add
 * an object and must be unable to remove or replace one (INV-BACKUP-004). Those
 * two have opposite mutation surfaces and must not share a class -- but the
 * client construction, the aborting deadline and the retry ceiling are the same
 * concerns for both, and a second hand-rolled copy of them would drift from the
 * bound the attachment sweeper's quarantine window depends on.
 *
 * So the *transport* is shared here and the *operations* are not. Nothing in
 * this file constructs a command: a caller passes the command it is allowed to
 * send, which is what keeps the egress path's ban on deletes meaningful.
 */

/**
 * The longest a single S3 operation may run, end to end, before it is aborted.
 *
 * This is a *correctness* bound, not a tuning knob. The orphan sweeper quarantines
 * a swept upload intent for `LATE_WRITE_QUARANTINE_MS` (6 hours) and re-deletes the
 * key on each pass, on the assumption that a `PutObject` cannot land after the
 * quarantine retires the row. That assumption only holds if the put cannot still be
 * in flight six hours later (audit V4R3-003, DR-V4R3-03).
 *
 * The mechanism is an `AbortController` armed around the whole operation --
 * `withS3Deadline` below -- not the socket timers. Socket-level timeouts
 * (`connectionTimeout`/`requestTimeout`) are inactivity timers per attempt: an
 * endpoint that trickles one byte at a time keeps the socket busy forever without
 * ever tripping them, and the SDK retries on top, multiplying whatever bound they
 * did give. The abort signal spans connect, send, retries and body consumption, so
 * it is the number this comment can honestly promise. The socket timers are still
 * set, as hygiene, so an outright-dead peer fails fast instead of waiting for the
 * deadline.
 *
 * `ATTACHMENT_S3_REQUEST_TIMEOUT_MS` may shorten the deadline (tests point it at a
 * deliberately stalled endpoint; operators may prefer failing faster). It can never
 * lengthen it: the quarantine math depends on this ceiling, so a configured value
 * above it is clamped down by `clampS3Deadline`.
 */
export const S3_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Attempts per operation (the SDK default, made explicit because the quarantine
 * reasoning references it). Retries do not extend the deadline -- the abort signal
 * spans all of them -- so this only bounds how much work fits inside it.
 */
export const S3_MAX_ATTEMPTS = 3;

/** What a caller must decide before a client can be built. */
export interface S3TransportOptions {
  region?: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Already clamped -- see `clampS3Deadline`. */
  deadlineMs: number;
}

/**
 * Read a configured millisecond timeout, shorten-only.
 *
 * Anything absent, unparseable or non-positive is the ceiling; anything above
 * the ceiling is the ceiling. A deployment can make an operation fail faster and
 * cannot widen the window in which a late write may still land.
 */
export function clampS3Deadline(configured: string | undefined): number {
  const parsed = Number(configured ?? "");
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, S3_REQUEST_TIMEOUT_MS)
    : S3_REQUEST_TIMEOUT_MS;
}

/**
 * Build the client every S3 caller in this codebase uses.
 *
 * Credentials are passed only when both halves are present, so a partially
 * configured deployment falls back to the default AWS credential chain
 * (instance role, environment, ...) rather than signing with half a key pair.
 */
export function buildS3Client(options: S3TransportOptions): S3Client {
  return new S3Client({
    region: options.region ?? "us-east-1",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle,
    ...(options.credentials?.accessKeyId && options.credentials?.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
          },
        }
      : {}),
    maxAttempts: S3_MAX_ATTEMPTS,
    // Inactivity hygiene only; the enforced bound is withS3Deadline's abort.
    requestHandler: new NodeHttpHandler({
      connectionTimeout: options.deadlineMs,
      requestTimeout: options.deadlineMs,
    }),
  });
}

/**
 * Run one storage operation under an aborting total deadline.
 *
 * The signal is passed into `send` and stays armed until the callback settles,
 * so it covers connection, request body, every SDK retry, and -- for reads --
 * consuming the response body after `send` resolved, which no handler option
 * bounds. On abort the in-flight socket is destroyed, so a stalled `PutObject`
 * is dead, not merely disowned.
 *
 * A multi-call operation (a multipart upload) puts each call in its own
 * deadline: the bound is per S3 request, and one that covered the whole sequence
 * would make the ceiling depend on the size of the artifact.
 */
export async function withS3Deadline<T>(
  deadlineMs: number,
  operation: string,
  op: (options: { abortSignal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let deadlineFired = false;
  const timer = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, deadlineMs);
  timer.unref();
  try {
    return await op({ abortSignal: controller.signal });
  } catch (error) {
    if (deadlineFired) {
      // The SDK's own error is carried through rather than replaced. The abort is
      // what surfaced, but only the underlying error says whether the endpoint was
      // slow or the credentials were wrong, and those two must not look identical
      // in the log. (`Error`'s `cause` option would be the idiom; the backend
      // targets ES2021, which does not have it.)
      const underlying = error instanceof Error ? error.message : String(error);
      throw new Error(
        `S3 ${operation} exceeded its ${deadlineMs} ms deadline and was ` +
          `aborted (underlying error: ${underlying})`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
