import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import { clampS3Deadline } from "../../attachments/storage/s3-transport";
import { withScopedDb } from "../../common/db/scoped-db";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { tr } from "../../i18n/translate";
import {
  normalizeOffsitePrefix,
  resolveDeploymentS3Target,
  resolveEmailMaxBytes,
  resolveMultipartPartBytes,
} from "./backup-offsite-config";
import { OffsiteS3Target } from "./backup-offsite.types";
import { BackupOffsiteSettings } from "./entities/backup-offsite-settings.entity";
import { BackupOffsiteUpload } from "./entities/backup-offsite-upload.entity";
import {
  BackupOffsiteSettingsView,
  UpdateBackupOffsiteSettingsDto,
} from "./dto/update-backup-offsite-settings.dto";

/**
 * Why a user has no S3 destination right now. Four answers, not one `null`:
 * the dispatcher records a durable, attributable state per artifact (EXT-003),
 * and "you turned it off" is not the same event as "your stored credentials can
 * no longer be decrypted".
 */
export type OffsiteS3Unavailable =
  | "off"
  | "deployment-unconfigured"
  | "own-incomplete"
  | "credentials-unreadable";

/** A resolved destination, or the reason there is none. */
export type OffsiteS3Resolution =
  | { target: OffsiteS3Target }
  | { target: null; reason: OffsiteS3Unavailable };

/** The largest `limit` `listUploads` will honour, whatever a caller asks for. */
const MAX_UPLOAD_PAGE = 200;

/**
 * A user's off-machine backup destinations: reading them, changing them, and
 * resolving them into something the dispatcher can act on
 * (`docs/specs/backup-off-machine.md` sections 4, 7 and 9).
 *
 * Three rules shape the whole class.
 *
 * **A secret leaves this class in exactly one direction.** The two credential
 * columns hold AES-256-GCM ciphertext; `getView` reports whether each is set and
 * nothing more, and the only method that decrypts is `resolveS3Target`, whose
 * result goes to the uploader rather than to a response. There is no method
 * here that returns a credential to a caller in the HTTP path, which is what
 * makes "never returned to the client" a property of the code rather than a
 * habit of its callers.
 *
 * **A refusal happens before the write.** `update` loads, applies, checks and
 * saves inside one `withScopedDb` transaction, so a rejected change has not
 * already stored half of itself -- the rule in
 * `docs/backend/database-access-and-tenancy.md`. Every check names the thing the
 * user or the operator has to change: the variable, the field, the key.
 *
 * **An unreadable credential is not a licence to use somebody else's bucket.**
 * A rotated `ENCRYPTION_KEY` leaves a user's stored key pair undecryptable;
 * `resolveS3Target` answers `credentials-unreadable` and the dispatcher records
 * a failure. Falling back to the deployment bucket would put one user's backup
 * somewhere they never chose (spec section 7).
 */
@Injectable()
export class BackupOffsiteSettingsService {
  private readonly logger = new Logger(BackupOffsiteSettingsService.name);

  /**
   * The deployment's destination and the two byte bounds, read once.
   *
   * Once, because the environment does not change under a running process and a
   * misconfiguration should be logged on boot rather than on every save. The
   * transport bounds are kept separately from the target because a user on
   * `own` needs them even where the deployment configured no bucket of its own.
   */
  private readonly deploymentTarget: OffsiteS3Target | null;
  private readonly multipartPartBytes: number;
  private readonly emailMaxBytesValue: number;
  /**
   * The per-request abort deadline, already shortened to the ceiling
   * `s3-transport.ts` documents. Read whether or not this deployment has a
   * bucket of its own, because a user on `own` is still held to it.
   */
  private readonly deadlineMs: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {
    const get = (name: string): string | undefined =>
      this.configService.get<string>(name);
    const onInvalid = (message: string): void => this.logger.warn(message);
    this.deploymentTarget = resolveDeploymentS3Target(get, onInvalid);
    this.multipartPartBytes = resolveMultipartPartBytes(get, onInvalid);
    this.emailMaxBytesValue = resolveEmailMaxBytes(get, onInvalid);
    this.deadlineMs = clampS3Deadline(get("BACKUP_S3_REQUEST_TIMEOUT_MS"));
  }

  /** The caller's own destinations, with neither credential in the answer. */
  async getView(userId: string): Promise<BackupOffsiteSettingsView> {
    const row = await this.scoped(BackupOffsiteSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    return this.toView(row);
  }

  /**
   * Apply a change to the caller's destinations, or refuse it.
   *
   * One transaction: load-or-seed, apply, refuse, save. The refusals are the
   * point at which "off by default" becomes "on and actually usable" -- a
   * destination that is enabled but cannot be reached is worse than one that is
   * off, because the user believes they have an off-machine copy.
   */
  async update(
    userId: string,
    dto: UpdateBackupOffsiteSettingsDto,
  ): Promise<BackupOffsiteSettingsView> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(BackupOffsiteSettings);
      const row =
        (await repo.findOne({ where: { userId } })) ?? this.seedRow(userId);

      if (dto.s3Mode !== undefined) row.s3Mode = dto.s3Mode;
      if (dto.s3Bucket !== undefined) row.s3Bucket = blankToNull(dto.s3Bucket);
      if (dto.s3Region !== undefined) row.s3Region = blankToNull(dto.s3Region);
      if (dto.s3Prefix !== undefined) row.s3Prefix = blankToNull(dto.s3Prefix);
      if (dto.s3Endpoint !== undefined) {
        row.s3Endpoint = blankToNull(dto.s3Endpoint);
      }
      if (dto.s3ForcePathStyle !== undefined) {
        row.s3ForcePathStyle = dto.s3ForcePathStyle;
      }
      if (dto.emailEnabled !== undefined) row.emailEnabled = dto.emailEnabled;
      if (dto.emailTo !== undefined) row.emailTo = blankToNull(dto.emailTo);

      // Forgetting comes first, so "clear these and set those" in one request
      // stores the new pair rather than dropping it.
      if (dto.clearS3Credentials) {
        row.s3AccessKeyId = null;
        row.s3SecretAccessKey = null;
      }

      // A blank credential is a field the form left alone, not an instruction to
      // forget one: the value is never rendered back, so the input is empty on
      // every load and an empty-means-clear reading would wipe a working
      // destination on the next unrelated save. `clearS3Credentials` is the
      // instruction.
      const accessKeyId = blankToNull(dto.s3AccessKeyId);
      const secretAccessKey = blankToNull(dto.s3SecretAccessKey);
      if (
        (accessKeyId || secretAccessKey) &&
        !this.encryptionService.isConfigured()
      ) {
        throw new BadRequestException(
          tr(
            "errors.backup.offsiteEncryptionKeyRequired",
            "This server cannot store S3 credentials because ENCRYPTION_KEY is not set. Ask an administrator to configure it, or use the deployment's bucket.",
          ),
        );
      }
      if (accessKeyId) {
        row.s3AccessKeyId = this.encryptionService.encrypt(accessKeyId);
      }
      if (secretAccessKey) {
        row.s3SecretAccessKey = this.encryptionService.encrypt(secretAccessKey);
      }

      this.assertDestinationUsable(row);

      const saved = await repo.save(row);
      return this.toView(saved);
    });
  }

  /**
   * The destination one user's completed artifact is copied to, ready for the
   * uploader, or the reason there is none.
   *
   * The uploader receives a resolved target and nothing else -- it cannot tell a
   * deployment bucket from a user's own -- so this is the only place the choice
   * between them is made, and the only place a stored credential is decrypted.
   */
  async resolveS3Target(userId: string): Promise<OffsiteS3Resolution> {
    const row = await this.scoped(BackupOffsiteSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    const mode = row?.s3Mode ?? "off";

    if (mode === "off") return { target: null, reason: "off" };

    if (mode === "deployment") {
      return this.deploymentTarget
        ? { target: this.deploymentTarget }
        : { target: null, reason: "deployment-unconfigured" };
    }

    if (!row?.s3Bucket || !row.s3AccessKeyId || !row.s3SecretAccessKey) {
      return { target: null, reason: "own-incomplete" };
    }

    let credentials: { accessKeyId: string; secretAccessKey: string };
    try {
      credentials = {
        accessKeyId: this.encryptionService.decrypt(row.s3AccessKeyId),
        secretAccessKey: this.encryptionService.decrypt(row.s3SecretAccessKey),
      };
    } catch {
      // Never the deployment bucket instead: this user chose their own, and a
      // copy of their backup in somebody else's bucket is not a lesser failure
      // than no copy at all (spec section 7). The error itself is not logged --
      // it is raised by a decrypt over a credential -- only the fact.
      this.logger.warn(
        `Off-site S3 credentials for user ${userId} could not be decrypted; ` +
          "no copy will be made until they are re-entered.",
      );
      return { target: null, reason: "credentials-unreadable" };
    }

    return {
      target: {
        bucket: row.s3Bucket,
        ...(row.s3Region ? { region: row.s3Region } : {}),
        ...(normalizeOffsitePrefix(row.s3Prefix)
          ? { prefix: normalizeOffsitePrefix(row.s3Prefix) }
          : {}),
        ...(row.s3Endpoint ? { endpoint: row.s3Endpoint } : {}),
        forcePathStyle: row.s3ForcePathStyle,
        credentials,
        // The transport bounds are the operator's for every destination alike:
        // a user's own bucket does not get to hold a connection open longer
        // than the deployment allows.
        deadlineMs: this.deadlineMs,
        multipartPartBytes: this.multipartPartBytes,
      },
    };
  }

  /** Where an emailed copy goes, or `null` when the user wants none. */
  async resolveEmail(userId: string): Promise<{ to: string } | null> {
    const row = await this.scoped(BackupOffsiteSettings, (repo) =>
      repo.findOne({ where: { userId } }),
    );
    return row?.emailEnabled && row.emailTo ? { to: row.emailTo } : null;
  }

  /** The largest artifact emailed as an attachment (`BACKUP_EMAIL_MAX_BYTES`). */
  emailMaxBytes(): number {
    return this.emailMaxBytesValue;
  }

  /**
   * The caller's recent off-machine copies, newest first -- the per-destination
   * status list the plan's surface shows instead of a retention count the
   * application cannot know.
   */
  async listUploads(
    userId: string,
    limit = 50,
  ): Promise<BackupOffsiteUpload[]> {
    const take = Math.min(
      Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 1, 1),
      MAX_UPLOAD_PAGE,
    );
    return this.scoped(BackupOffsiteUpload, (repo) =>
      repo.find({ where: { userId }, order: { createdAt: "DESC" }, take }),
    );
  }

  /**
   * Refuse a destination the dispatcher could not use, naming what to change.
   *
   * Every branch is a state the user can be in *after* this request, not a shape
   * of the request itself, which is why it cannot live on the DTO: enabling
   * email in one save and clearing the address in another would pass two valid
   * payloads into a row that sends a backup nowhere.
   */
  private assertDestinationUsable(row: BackupOffsiteSettings): void {
    if (row.s3Mode === "deployment" && !this.deploymentTarget) {
      throw new BadRequestException(
        tr(
          "errors.backup.offsiteDeploymentBucketUnset",
          "This server has no off-site backup bucket of its own. Ask an administrator to set BACKUP_S3_BUCKET, or use your own bucket.",
        ),
      );
    }
    if (row.s3Mode === "own") {
      if (!row.s3Bucket) {
        throw new BadRequestException(
          tr(
            "errors.backup.offsiteOwnBucketRequired",
            "Enter the bucket your backups should be copied to.",
          ),
        );
      }
      if (!row.s3AccessKeyId || !row.s3SecretAccessKey) {
        throw new BadRequestException(
          tr(
            "errors.backup.offsiteOwnCredentialsRequired",
            "Enter an access key id and a secret access key for your bucket.",
          ),
        );
      }
    }
    if (row.emailEnabled && !row.emailTo) {
      throw new BadRequestException(
        tr(
          "errors.backup.offsiteEmailAddressRequired",
          "Enter the address your backups should be emailed to.",
        ),
      );
    }
  }

  /**
   * The row a user who has never configured a destination is treated as having:
   * everything off. Seeded rather than defaulted per field so an update that
   * touches one field still lands on a complete row.
   */
  private seedRow(userId: string): BackupOffsiteSettings {
    const row = new BackupOffsiteSettings();
    row.userId = userId;
    row.s3Mode = "off";
    row.s3Bucket = null;
    row.s3Region = null;
    row.s3Prefix = null;
    row.s3Endpoint = null;
    row.s3ForcePathStyle = false;
    row.s3AccessKeyId = null;
    row.s3SecretAccessKey = null;
    row.emailEnabled = false;
    row.emailTo = null;
    return row;
  }

  /**
   * The response shape, which is where the masking actually happens: each
   * credential becomes a boolean here and the ciphertext is left behind.
   */
  private toView(row: BackupOffsiteSettings | null): BackupOffsiteSettingsView {
    return {
      s3Mode: row?.s3Mode ?? "off",
      s3Bucket: row?.s3Bucket ?? null,
      s3Region: row?.s3Region ?? null,
      s3Prefix: row?.s3Prefix ?? null,
      s3Endpoint: row?.s3Endpoint ?? null,
      s3ForcePathStyle: row?.s3ForcePathStyle ?? false,
      s3AccessKeyIdSet: Boolean(row?.s3AccessKeyId),
      s3SecretAccessKeySet: Boolean(row?.s3SecretAccessKey),
      emailEnabled: row?.emailEnabled ?? false,
      emailTo: row?.emailTo ?? null,
      deploymentS3Available: this.deploymentTarget !== null,
      encryptionConfigured: this.encryptionService.isConfigured(),
    };
  }

  /**
   * One repository call in its own short scoped transaction -- the same shape
   * `AutoBackupService.scoped` uses, and the RLS-compliant replacement for an
   * injected repository.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }
}

/** A text field the form sent empty is a cleared column, not an empty string. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
