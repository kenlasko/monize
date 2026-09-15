import { Injectable, Logger } from "@nestjs/common";
import { I18nService } from "nestjs-i18n";

import { numberFormatterFor } from "../../common/number-locale.util";
import { emailTranslator } from "../../i18n/email-translator";
import { EmailService } from "../../notifications/email.service";
import {
  classifyBackupFileName,
  isEncryptedBackupFileName,
} from "../backup-file-names";
import {
  backupOffsiteCopyTemplate,
  backupOffsiteTooLargeTemplate,
} from "./backup-offsite-email.templates";
import { BackupOffsiteTier } from "./entities/backup-offsite-upload.entity";

/** One artifact, and the mailbox it is being copied to. */
export interface BackupOffsiteEmailInput {
  to: string;
  /** The recipient's stored `user_preferences.language`. */
  recipientLang: string;
  /** The artifact's filename; must be an encrypted (`.mzbe`) one. */
  filename: string;
  /** The exact artifact bytes as written locally. */
  body: Buffer;
  /** The artifact's size, as measured locally. */
  sizeBytes: number;
  /** The egress digest: SHA-256 of those bytes, hex. */
  digest: string;
  tier: BackupOffsiteTier;
  /** `BACKUP_EMAIL_MAX_BYTES`, already resolved by the caller. */
  maxBytes: number;
}

/**
 * What one attempt achieved, in the off-site status vocabulary
 * (`entities/backup-offsite-upload.entity.ts`). A failure is a throw, not a
 * third value: the caller records `failed` with the digest so the retry reaches
 * the same bytes.
 */
export interface BackupOffsiteEmailResult {
  outcome: "uploaded" | "skipped-too-large";
}

/**
 * The email destination of the off-machine backup copy
 * (`docs/specs/backup-off-machine.md` section 5, the email truth table).
 *
 * Two things make this a class rather than a call to `EmailService` at the
 * dispatch site.
 *
 * - **It refuses a plaintext artifact itself.** INV-BACKUP-002 belongs to the
 *   dispatcher, which selects candidates by extension, but an artifact leaving
 *   the machine carries third-party API keys in the clear inside it, and a
 *   refusal is worth only as much as its least-guarded entry point. A `.json.gz`
 *   reaching this method is a bug on the path that called it; it throws rather
 *   than emailing the account's secrets to a mailbox.
 * - **`uploaded` is returned only after `sendMail` resolved.** SMTP acceptance
 *   is the strongest verification this medium offers -- there is no checksum to
 *   compare, the way the S3 destination has -- so it is the whole of EXT-002
 *   here, and reporting it before the call returned would record a copy nobody
 *   has. A throw propagates unchanged, and the caller writes `failed`.
 *
 * Over the bound there is a third outcome and it is deliberately not a failure:
 * the notice is sent, no bytes and no link go with it, and the status says
 * `skipped-too-large` (the plan's maintainer decision 6).
 */
@Injectable()
export class BackupOffsiteEmailSender {
  private readonly logger = new Logger(BackupOffsiteEmailSender.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly i18n: I18nService,
  ) {}

  async send(
    input: BackupOffsiteEmailInput,
  ): Promise<BackupOffsiteEmailResult> {
    assertEncrypted(input.filename);
    assertMeasuredBytes(input);

    // Composed outside any request: the locale is the recipient's stored
    // preference, never a request's.
    const t = emailTranslator(this.i18n, input.recipientLang);
    const n = numberFormatterFor(null, input.recipientLang);

    if (input.sizeBytes > input.maxBytes) {
      const { subject, html } = backupOffsiteTooLargeTemplate(
        t,
        {
          filename: input.filename,
          sizeBytes: input.sizeBytes,
          maxBytes: input.maxBytes,
          digest: input.digest,
        },
        n,
      );
      await this.emailService.sendMail(input.to, subject, html);
      this.logger.warn(
        `Off-site backup ${input.filename} is ${input.sizeBytes} bytes, over ` +
          `the ${input.maxBytes}-byte email bound; a notice was sent instead ` +
          `and no copy left the machine by email`,
      );
      return { outcome: "skipped-too-large" };
    }

    const { subject, html } = backupOffsiteCopyTemplate(
      t,
      {
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        digest: input.digest,
        tier: input.tier,
        dateLabel: artifactDateLabel(input.filename, input.tier),
      },
      n,
    );
    await this.emailService.sendMail(input.to, subject, html, {
      attachments: [
        {
          filename: input.filename,
          content: input.body,
          // The artifact is an encrypted envelope, not a document any client
          // should try to render or a relay should try to rewrite.
          contentType: "application/octet-stream",
        },
      ],
    });
    // Reached only because `sendMail` resolved: the relay accepted the message
    // with these bytes on it.
    this.logger.log(
      `Off-site backup ${input.filename} was emailed (${input.sizeBytes} bytes, sha256 ${input.digest})`,
    );
    return { outcome: "uploaded" };
  }
}

/** INV-BACKUP-002, held at this entry point too. */
function assertEncrypted(filename: string): void {
  if (!isEncryptedBackupFileName(filename)) {
    throw new Error(
      `Refusing to email the backup artifact ${JSON.stringify(filename)}: ` +
        "only an encrypted .mzbe artifact may leave the machine (INV-BACKUP-002)",
    );
  }
}

/**
 * The bytes being attached are the bytes that were measured.
 *
 * `sizeBytes` is what the bound is applied to, so a body that is not that size
 * would let an artifact past a limit computed for a different one -- and would
 * put a digest in the mail that is not of its attachment.
 */
function assertMeasuredBytes(input: BackupOffsiteEmailInput): void {
  if (input.body.length !== input.sizeBytes) {
    throw new Error(
      `Refusing to email the backup artifact ${JSON.stringify(input.filename)}: ` +
        `its body is ${input.body.length} bytes, not the ${input.sizeBytes} ` +
        "bytes that were measured and bounded",
    );
  }
}

/**
 * The period the artifact covers, read out of its own name -- the same source
 * retention and the owner-facing listing read it from. A monthly artifact covers
 * a month, so it is labelled as one rather than as the first day of it; a name
 * this module did not write has no period to state, and the filename stands in
 * for it.
 */
function artifactDateLabel(filename: string, tier: BackupOffsiteTier): string {
  const classified = classifyBackupFileName(filename);
  if (!classified) return filename;
  const iso = classified.date.toISOString().slice(0, 10);
  return tier === "monthly" ? iso.slice(0, 7) : iso;
}
