import { clampS3Deadline } from "../../attachments/storage/s3-transport";
import { resolvePositiveInt } from "../../common/env-number.util";
import { OffsiteS3Target } from "./backup-offsite.types";

/**
 * The deployment half of an off-machine backup destination: the operator's
 * bucket and the two byte-size knobs both destination kinds are bounded by
 * (`docs/specs/backup-off-machine.md` section 7, the plan's "Configuration").
 *
 * Every function here is pure over a `(name) => string | undefined` getter
 * rather than reading `process.env` or holding a `ConfigService`, for the reason
 * `restore-queue-config.ts` gives: the decisions this file makes -- what "no
 * deployment bucket" means, whether half a key pair signs anything, what a part
 * size below S3's floor is clamped to -- are the ones worth testing, and a
 * module that reaches for the ambient environment can only be tested by mutating
 * it. `BackupOffsiteSettingsService` passes `ConfigService.get` in; the spec
 * passes a plain object.
 *
 * Nothing here decides a *user's* destination. A user on `own` supplies their
 * own bucket and their own credentials, and only the transport bounds below are
 * shared with them -- so a user's target can never inherit the operator's
 * credential by omission.
 */

/** How a caller supplies configuration. Returns `undefined` when unset. */
export type OffsiteEnvGetter = (name: string) => string | undefined;

/** What one numeric knob declares: a name, a default, a floor and a sentence. */
export interface BackupOffsiteKnobSpec {
  readonly envVar: string;
  readonly default: number;
  /** The smallest value the destination itself accepts; a lower one is raised. */
  readonly minimum: number;
  readonly description: string;
}

/**
 * The byte-size knobs of the off-machine copy, declared as data beside their
 * documentation per the numeric-knob rule in
 * `docs/backend/modules-and-runtime.md`.
 */
export const BACKUP_OFFSITE_KNOBS = {
  /**
   * The part size a multipart upload is cut into, and therefore the size above
   * which an artifact goes multipart at all.
   *
   * The floor is S3's, not ours: every part but the last must be at least 5 MiB,
   * and a smaller one is refused by the destination with `EntityTooSmall` after
   * the parts have already been sent. A configured value below it is raised to
   * it and reported, because failing the upload of a backup to honour a number
   * the destination will not accept helps nobody.
   */
  multipartPartBytes: {
    envVar: "BACKUP_S3_MULTIPART_PART_BYTES",
    default: 16 * 1024 * 1024,
    minimum: 5 * 1024 * 1024,
    description: "bytes per part of a multipart off-site backup upload",
  },
  /**
   * The largest artifact that is emailed as an attachment.
   *
   * Above it the user receives a notice naming the artifact and its size and no
   * bytes at all (`skipped-too-large`, spec section 5). The default is the size
   * most relays accept before the message is rejected somewhere the sender
   * cannot see; an operator who knows their relay takes more may raise it.
   */
  emailMaxBytes: {
    envVar: "BACKUP_EMAIL_MAX_BYTES",
    default: 20 * 1024 * 1024,
    minimum: 1,
    description: "largest backup artifact emailed as an attachment, in bytes",
  },
} as const satisfies Record<string, BackupOffsiteKnobSpec>;

export type BackupOffsiteKnob = keyof typeof BACKUP_OFFSITE_KNOBS;

/** Told about a value that was supplied but could not be used as supplied. */
export type OnInvalidOffsiteConfig = (message: string) => void;

/**
 * Resolve one declared knob: default when unset, reported when unreadable,
 * raised to the floor when below it.
 */
function resolveKnob(
  get: OffsiteEnvGetter,
  knob: BackupOffsiteKnob,
  onInvalid?: OnInvalidOffsiteConfig,
): number {
  const spec: BackupOffsiteKnobSpec = BACKUP_OFFSITE_KNOBS[knob];
  const raw = get(spec.envVar);
  const { value, invalid } = resolvePositiveInt(raw, spec.default);
  if (invalid) {
    onInvalid?.(
      `Could not read ${spec.envVar}="${raw}" as a positive integer ` +
        `(${spec.description}); using ${spec.default}.`,
    );
    return spec.default;
  }
  if (value < spec.minimum) {
    onInvalid?.(
      `${spec.envVar}=${value} is below the smallest value the destination ` +
        `accepts (${spec.description}); using ${spec.minimum}.`,
    );
    return spec.minimum;
  }
  return value;
}

/** Bytes per part of a multipart off-site upload, never below S3's 5 MiB floor. */
export function resolveMultipartPartBytes(
  get: OffsiteEnvGetter,
  onInvalid?: OnInvalidOffsiteConfig,
): number {
  return resolveKnob(get, "multipartPartBytes", onInvalid);
}

/** The largest artifact emailed as an attachment rather than described in a notice. */
export function resolveEmailMaxBytes(
  get: OffsiteEnvGetter,
  onInvalid?: OnInvalidOffsiteConfig,
): number {
  return resolveKnob(get, "emailMaxBytes", onInvalid);
}

/** A configured value, with blank and whitespace-only read as unset. */
function text(get: OffsiteEnvGetter, name: string): string | undefined {
  const value = get(name)?.trim();
  return value ? value : undefined;
}

/**
 * A key prefix, normalised to at most one trailing slash -- the same shape
 * `S3StorageProvider` gives `ATTACHMENT_S3_PREFIX`, so an operator who has
 * configured one bucket has configured both the same way.
 *
 * Exported because a user's own destination stores its prefix in a column and
 * has to arrive at the uploader in the same shape the deployment's does; two
 * spellings of "one trailing slash" is how the two would come to address
 * different keys for the same artifact.
 */
export function normalizeOffsitePrefix(
  prefix: string | null | undefined,
): string | undefined {
  if (!prefix) return undefined;
  const trimmed = prefix.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : undefined;
}

/**
 * The deployment's own S3 destination, or `null` when this deployment has none.
 *
 * The bucket is the switch: no `BACKUP_S3_BUCKET`, no deployment destination,
 * whatever else is set. That is what lets `s3Mode = "deployment"` be refused at
 * save time with an error naming the variable (spec section 7) instead of
 * failing silently at 02:00 against a bucket nobody configured.
 *
 * Credentials are passed only when **both** halves are present. Half a key pair
 * is not a credential, and signing with one would fail in a way that reads like
 * a permissions problem; omitting them entirely is a deliberate, documented
 * state -- the default AWS credential chain (instance role, shared config, the
 * `AWS_*` variables), which is how a deployment on EC2 or EKS is meant to reach
 * its own bucket.
 */
export function resolveDeploymentS3Target(
  get: OffsiteEnvGetter,
  onInvalid?: OnInvalidOffsiteConfig,
): OffsiteS3Target | null {
  const bucket = text(get, "BACKUP_S3_BUCKET");
  if (!bucket) return null;

  const accessKeyId = text(get, "BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = text(get, "BACKUP_S3_SECRET_ACCESS_KEY");
  const credentials =
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey }
      : undefined;
  if (!credentials && (accessKeyId || secretAccessKey)) {
    onInvalid?.(
      "Only one of BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY is " +
        "set; the off-site backup destination will use the default credential " +
        "chain instead of half a key pair.",
    );
  }

  const region = text(get, "BACKUP_S3_REGION");
  const endpoint = text(get, "BACKUP_S3_ENDPOINT");
  const prefix = normalizeOffsitePrefix(text(get, "BACKUP_S3_PREFIX"));

  return {
    bucket,
    ...(region ? { region } : {}),
    ...(prefix ? { prefix } : {}),
    ...(endpoint ? { endpoint } : {}),
    // A boolean environment variable is compared as the string it is: the
    // typed `get<boolean>` reads as a conversion and is only an assertion.
    forcePathStyle: get("BACKUP_S3_FORCE_PATH_STYLE")?.trim() === "true",
    ...(credentials ? { credentials } : {}),
    // Shorten-only, and clamped by the same helper the attachment provider uses,
    // so no deployment can widen the window in which a put may still land.
    deadlineMs: clampS3Deadline(get("BACKUP_S3_REQUEST_TIMEOUT_MS")),
    multipartPartBytes: resolveMultipartPartBytes(get, onInvalid),
  };
}
