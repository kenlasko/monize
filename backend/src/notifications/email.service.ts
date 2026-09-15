import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";
import { resolvePositiveInt } from "../common/env-number.util";

/**
 * What this replica's own SMTP sends have done lately. Purely in-process --
 * the `SMTP_FAILURE` system alert that reads it dedupes across replicas at the
 * database, so per-replica memory is enough -- and only about *configured*
 * transport failures: an unconfigured deployment throws before the snapshot
 * and is a setup state, not a failure.
 *
 * A **recipient rejection is not a transport failure** and is counted
 * separately. `sendMail` rejects for both, but they are opposite facts: a
 * `550 mailbox full` means the relay answered and refused this address, while
 * `ECONNREFUSED` means nothing was delivered to anybody. Counting them
 * together told every administrator that "email delivery is failing" and that
 * "notifications are not being delivered" because one contact's mailbox was
 * full -- re-raised every fifteen minutes for a day, on an outbox that was
 * otherwise working. Same rule the provider breaker uses: an answer, however
 * bad, proves the host answered.
 */
export interface EmailFailureSnapshot {
  lastFailureAt: Date | null;
  /** Bounded copy of the last transport error's message. */
  lastFailureMessage: string | null;
  lastSuccessAt: Date | null;
  failuresSinceSuccess: number;
  /** Addresses the relay answered about and refused. Never raises the alert. */
  recipientRejections: number;
}

/**
 * One file carried by an email.
 *
 * Deliberately the narrow subset of nodemailer's attachment shape this codebase
 * needs -- a name, the bytes, and what they are -- rather than nodemailer's own
 * type: a caller must not be able to hand the transport a `path` or a `href`
 * and make the SMTP layer read a file or fetch a URL on its behalf.
 */
export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** Everything about a send beyond the address, the subject and the body. */
export interface SendMailOptions {
  attachments?: EmailAttachment[];
}

const FAILURE_MESSAGE_MAX_LENGTH = 300;

/**
 * Codes nodemailer reports when the message never reached the relay, plus
 * `EAUTH` -- credentials the server rejected outright, which is a deployment
 * fault that stops every send rather than one address failing.
 */
const TRANSPORT_FAILURE_CODES = new Set([
  "EAUTH",
  "ECONNECTION",
  "ECONNREFUSED",
  "EDNS",
  "ESOCKET",
  "ETIMEDOUT",
  "ETLS",
]);

/**
 * Whether this rejection says the deployment cannot send mail at all, as
 * opposed to this recipient or this message being refused.
 *
 * An SMTP `responseCode` means the relay answered: 4xx/5xx about a message is
 * that message's problem (a full mailbox, a rejected sender, a spam verdict),
 * not an outage -- except for an authentication failure, where the answer is
 * "these credentials are wrong" and nothing will ever be delivered. Anything
 * with no response at all is transport.
 */
export function isSmtpTransportFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSPORT_FAILURE_CODES.has(code)) {
    return true;
  }
  const responseCode = (error as { responseCode?: unknown } | null)
    ?.responseCode;
  return typeof responseCode !== "number";
}

const DEFAULT_SMTP_PORT = 587;
/** The only port that speaks TLS from the first byte; everything else is STARTTLS. */
const IMPLICIT_TLS_PORT = 465;
const MAX_TCP_PORT = 65535;

export interface ResolvedSmtpTransportSecurity {
  port: number;
  /** True for implicit TLS (TLS before the greeting), false for STARTTLS. */
  secure: boolean;
  /** A supplied port that was not a usable TCP port, so the default was used. */
  portInvalid: boolean;
}

/**
 * Decide the port and the TLS mode from the deployment's raw environment.
 *
 * `ConfigService` hands back `process.env` unchanged, so `SMTP_PORT` is the
 * **string** `"465"` in every real deployment and a number only in a test that
 * mocks the reader. `port === 465` is therefore false against Gmail's implicit
 * TLS port, the transport opens in cleartext and sends `EHLO`, and the relay --
 * which expects a TLS ClientHello -- hangs up without answering. Nodemailer
 * reports that as `Error: Unexpected socket close`, whose stack points at a
 * timer rather than at this decision. Coerce through `resolvePositiveInt`, the
 * repository's rule for every numeric environment variable.
 *
 * `SMTP_SECURE` is documented in `README.md` and shipped by the Helm
 * configmap, so it is read here: it can only turn implicit TLS *on*, for a
 * relay offering it on a non-standard port. It cannot turn it off, because
 * port 465 has no cleartext phase to fall back to and the chart's own default
 * is the string `"false"` -- honouring that literally would break exactly the
 * port-465 deployments this fix is for.
 */
export function resolveSmtpTransportSecurity(
  rawPort: unknown,
  rawSecure: unknown,
): ResolvedSmtpTransportSecurity {
  const resolved = resolvePositiveInt(rawPort, DEFAULT_SMTP_PORT);
  const outOfRange = resolved.value > MAX_TCP_PORT;
  const port = outOfRange ? DEFAULT_SMTP_PORT : resolved.value;
  const secureRequested =
    typeof rawSecure === "string"
      ? rawSecure.trim().toLowerCase() === "true"
      : rawSecure === true;
  return {
    port,
    secure: port === IMPLICIT_TLS_PORT || secureRequested,
    portInvalid: resolved.invalid || outOfRange,
  };
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private configured = false;
  private lastFailureAt: Date | null = null;
  private lastFailureMessage: string | null = null;
  private lastSuccessAt: Date | null = null;
  private failuresSinceSuccess = 0;
  private recipientRejections = 0;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const host = this.configService.get<string>("SMTP_HOST");
    const user = this.configService.get<string>("SMTP_USER");
    const password = this.configService.get<string>("SMTP_PASSWORD");

    if (!host || !user || !password) {
      this.logger.warn("SMTP not configured - email features disabled");
      return;
    }

    const { port, secure, portInvalid } = resolveSmtpTransportSecurity(
      this.configService.get("SMTP_PORT"),
      this.configService.get("SMTP_SECURE"),
    );
    if (portInvalid) {
      this.logger.warn(
        `SMTP_PORT must be an integer from 1 to ${MAX_TCP_PORT}; using ${DEFAULT_SMTP_PORT}`,
      );
    }

    const transportOptions: Record<string, unknown> = {
      host,
      port,
      secure,
      auth: { user, pass: password },
    };

    // Without implicit TLS, require the STARTTLS upgrade rather than falling
    // back to plaintext.
    if (!secure) {
      transportOptions.requireTLS = true;
    }

    this.transporter = nodemailer.createTransport(transportOptions);

    this.configured = true;
    this.logger.log("SMTP email transport configured");
  }

  getStatus(): { configured: boolean } {
    return { configured: this.configured };
  }

  /** Read by SystemAlertMonitorService's SMTP-health sweep. */
  getFailureSnapshot(): EmailFailureSnapshot {
    return {
      lastFailureAt: this.lastFailureAt,
      lastFailureMessage: this.lastFailureMessage,
      lastSuccessAt: this.lastSuccessAt,
      failuresSinceSuccess: this.failuresSinceSuccess,
      recipientRejections: this.recipientRejections,
    };
  }

  /**
   * Send one message, optionally carrying files.
   *
   * `options` is absent for every notification email: the message then goes out
   * with no `attachments` key at all, so nothing about the existing sends
   * changes. The off-site backup destination
   * (`src/backup/offsite/backup-offsite-email.sender.ts`) is what needs the
   * other branch -- the encrypted artifact itself is the mail.
   */
  async sendMail(
    to: string,
    subject: string,
    html: string,
    options?: SendMailOptions,
  ): Promise<void> {
    if (!this.transporter || !this.configured) {
      throw new Error("SMTP is not configured");
    }

    const from = this.configService.get<string>(
      "EMAIL_FROM",
      "noreply@monize.app",
    );
    const attachments = options?.attachments ?? [];
    try {
      await this.transporter.sendMail({
        from,
        to,
        subject,
        html,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    } catch (error) {
      // Record for the SMTP-health sweep, then rethrow unchanged -- callers
      // already own their per-recipient isolation and their own logging.
      if (isSmtpTransportFailure(error)) {
        this.lastFailureAt = new Date();
        this.lastFailureMessage = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, FAILURE_MESSAGE_MAX_LENGTH);
        this.failuresSinceSuccess += 1;
      } else {
        // The relay answered and refused this address or message. Counted so
        // the state is visible, never as evidence that delivery is broken.
        this.recipientRejections += 1;
      }
      throw error;
    }
    this.lastSuccessAt = new Date();
    this.failuresSinceSuccess = 0;
    this.logger.log(`Email sent to ${to}: ${subject}`);
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}
