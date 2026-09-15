import { escapeHtml } from "../../common/escape-html.util";
import { defaultNumberT, NumberT } from "../../common/number-locale.util";
import { EmailT } from "../../i18n/email-translator";
import { BackupOffsiteTier } from "./entities/backup-offsite-upload.entity";

/**
 * The two emails the off-site email destination can send
 * (`docs/specs/backup-off-machine.md` section 5, email truth table).
 *
 * One carries the encrypted artifact and one explains why it does not. They are
 * pure functions returning both the subject and the body, because an email whose
 * subject was composed somewhere else drifts from the body it announces -- the
 * "no bytes attached" notice is exactly the mail a subject saying "your backup
 * is attached" would misdescribe.
 *
 * The recipient reads a filename, a size and a hash, none of which is prose:
 * every interpolated value goes through `escapeHtml` for the HTML body. A
 * subject line is not an HTML context, so it carries the raw value -- escaping
 * there would show the reader `&amp;` in their inbox.
 */

const BYTES_PER_MIB = 1024 * 1024;

/**
 * A byte count as the recipient reads it.
 *
 * MiB with one decimal, in the recipient's number convention, because the
 * figures this names -- an artifact and the bound it is measured against -- are
 * megabyte-scale and a reader comparing them needs the same unit on both. The
 * server has no shared byte formatter; the locale rule
 * (`src/common/number-locale.util.ts`) still applies to the number itself.
 */
function formatMebibytes(bytes: number, n: NumberT): string {
  return `${n.formatNumber(bytes / BYTES_PER_MIB, 1)} MiB`;
}

/** The retention tier, named for a reader rather than for the filename. */
function tierLabel(tier: BackupOffsiteTier, t: EmailT): string {
  switch (tier) {
    case "weekly":
      return t("emails.backupOffsite.tierWeekly", "weekly");
    case "monthly":
      return t("emails.backupOffsite.tierMonthly", "monthly");
    default:
      return t("emails.backupOffsite.tierDaily", "daily");
  }
}

const CELL =
  "padding: 10px 12px; border-bottom: 1px solid #e5e7eb; color: #374151;";
const LABEL = `${CELL} font-weight: 600; white-space: nowrap;`;
const FRAME =
  "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;";

/** One `<tr>` of the facts table. Both values are already escaped. */
function factRow(label: string, value: string): string {
  return `<tr><td style="${LABEL}">${label}</td><td style="${CELL}">${value}</td></tr>`;
}

/** What the mail carrying the artifact says about it. */
export interface BackupOffsiteCopyEmailData {
  /** The artifact's own name, always a `.mzbe` (encrypted) one. */
  filename: string;
  sizeBytes: number;
  /** SHA-256 of the exact attached bytes, hex. */
  digest: string;
  tier: BackupOffsiteTier;
  /** The day (or month) the artifact covers, already formatted. */
  dateLabel: string;
}

export interface BackupOffsiteEmailContent {
  subject: string;
  html: string;
}

/**
 * The backup itself, attached.
 *
 * Three things the recipient cannot work out from the attachment: that this is
 * an automatic copy rather than something they asked for just now, that the
 * bytes are useless without their backup password (nobody can re-key them --
 * see `docs/backup-restore-contract.md`), and how to turn the file back into an
 * account. The digest is here so a reader who keeps the mail can tell later
 * whether the attachment they still hold is the artifact this mail described.
 */
export function backupOffsiteCopyTemplate(
  t: EmailT,
  data: BackupOffsiteCopyEmailData,
  n: NumberT = defaultNumberT,
): BackupOffsiteEmailContent {
  const filename = escapeHtml(data.filename);
  const size = escapeHtml(formatMebibytes(data.sizeBytes, n));
  const digest = escapeHtml(data.digest);
  const tier = escapeHtml(tierLabel(data.tier, t));
  const dateLabel = escapeHtml(data.dateLabel);
  const subject = t(
    "emails.backupOffsite.copySubject",
    `Monize backup ${data.filename}`,
    { filename: data.filename },
  );
  const html = `
    <div style="${FRAME}">
      <h2 style="color: #1f2937;">${t("emails.backupOffsite.copyHeading", "Your Monize backup is attached")}</h2>
      <p style="color: #374151;">${t("emails.backupOffsite.copyIntro", `This is the automatic ${tier} backup of your Monize account for ${dateLabel}. The file is attached to this email.`, { tier, date: dateLabel })}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
        <tbody>
          ${factRow(t("emails.backupOffsite.labelFile", "File"), `<code>${filename}</code>`)}
          ${factRow(t("emails.backupOffsite.labelSize", "Size"), size)}
          ${factRow(t("emails.backupOffsite.labelTier", "Retention"), tier)}
          ${factRow(t("emails.backupOffsite.labelDigest", "SHA-256"), `<code style="word-break: break-all;">${digest}</code>`)}
        </tbody>
      </table>
      <p style="color: #374151;">${t("emails.backupOffsite.copyEncrypted", "The attachment is encrypted with your Monize backup password. It cannot be opened without that password, and Monize cannot recover it for you -- keep the password somewhere other than this mailbox.")}</p>
      <p style="color: #374151;">${t("emails.backupOffsite.copyRestore", "To restore it, open Monize, go to Settings, Backup &amp; Restore, upload this file and enter your backup password.")}</p>
      <p style="color: #6b7280; font-size: 14px;">${t("emails.backupOffsite.copyVerify", "The SHA-256 above is of the attached bytes, so you can check later that the copy you kept is the one this email delivered.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
  return { subject, html };
}

/** What the notice says when the artifact is too large to attach. */
export interface BackupOffsiteTooLargeEmailData {
  filename: string;
  sizeBytes: number;
  /** The configured bound, `BACKUP_EMAIL_MAX_BYTES`. */
  maxBytes: number;
  digest: string;
}

/**
 * The artifact was not attached, and nothing else was done instead.
 *
 * A link would need a read credential this feature deliberately does not have
 * (the plan's maintainer decision 6), so the honest mail says the copy did not
 * leave the machine by email and names what is unaffected. A notice that failed
 * to say so would read as a delivery -- the failure EXT-003 is about.
 */
export function backupOffsiteTooLargeTemplate(
  t: EmailT,
  data: BackupOffsiteTooLargeEmailData,
  n: NumberT = defaultNumberT,
): BackupOffsiteEmailContent {
  const filename = escapeHtml(data.filename);
  const size = escapeHtml(formatMebibytes(data.sizeBytes, n));
  const limit = escapeHtml(formatMebibytes(data.maxBytes, n));
  const digest = escapeHtml(data.digest);
  const subject = t(
    "emails.backupOffsite.tooLargeSubject",
    `Monize backup ${data.filename} was too large to email`,
    { filename: data.filename },
  );
  const html = `
    <div style="${FRAME}">
      <h2 style="color: #b45309;">${t("emails.backupOffsite.tooLargeHeading", "Your Monize backup was not emailed")}</h2>
      <p style="color: #374151;">${t("emails.backupOffsite.tooLargeIntro", `Today's backup is ${size}, which is over the ${limit} this deployment allows for an emailed backup (BACKUP_EMAIL_MAX_BYTES).`, { size, limit })}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 8px;">
        <tbody>
          ${factRow(t("emails.backupOffsite.labelFile", "File"), `<code>${filename}</code>`)}
          ${factRow(t("emails.backupOffsite.labelSize", "Size"), size)}
          ${factRow(t("emails.backupOffsite.labelLimit", "Email limit"), limit)}
          ${factRow(t("emails.backupOffsite.labelDigest", "SHA-256"), `<code style="word-break: break-all;">${digest}</code>`)}
        </tbody>
      </table>
      <p style="color: #374151;">${t("emails.backupOffsite.tooLargeNoBytes", "Nothing was attached to this email, and no download link is offered -- a link would need a credential that could read your backups back out of storage, which this feature does not hold.")}</p>
      <p style="color: #374151;">${t("emails.backupOffsite.tooLargeUnaffected", "The backup itself was written normally. The copy on this server is unaffected, and so is the copy on your S3 destination if you have one enabled.")}</p>
      <p style="color: #374151;">${t("emails.backupOffsite.tooLargeWhatToDo", "To keep an off-machine copy of a backup this size, download it from Settings, Backup &amp; Restore, enable the S3 destination, or ask your administrator to raise the email limit.")}</p>
      <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">-- Monize</p>
    </div>
  `;
  return { subject, html };
}
