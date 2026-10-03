import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import {
  JobClaimService,
  JobClaimType,
} from "../../common/jobs/job-claim.service";
import { tr } from "../../i18n/translate";
import { EmailReceiptAiService } from "../ai/email-receipt-ai.service";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";
import {
  ImapMailboxClient,
  type FetchedMessage,
  type FetchSinceResult,
} from "../imap/imap-mailbox-client";
import { extractMailText } from "../imap/mail-text.util";
import { EmailReceiptMailboxService } from "../mailbox/email-receipt-mailbox.service";
import {
  describeFailure,
  EmailReceiptPipelineService,
} from "../pipeline/email-receipt-pipeline.service";
import {
  resolveEmailReceiptPollLimits,
  type EmailReceiptPollLimits,
} from "./email-receipt-poll-limits";

/** One poll of one mailbox holds its lease this long at most (design INV-RECEIPT-006). */
export const POLL_LEASE_MS = 10 * 60_000;
/** No new work is started once this much of the lease is spent. */
const LEASE_WORK_BUDGET_MS = 8 * 60_000;
/** A first sync reads what arrived in the last 30 days (design 3.4). */
const FIRST_SYNC_DAYS = 30;
/** Stored emails processed, and emails re-matched, per poll. */
export const MAX_PROCESSED_PER_POLL = 100;
export const MAX_REMATCHED_PER_POLL = 100;
/** An unmatched email is retried for this many days after it arrived (design 3.8). */
const REMATCH_DAYS = 30;
const DAY_MS = 86_400_000;

/** What one poll did. `busy` is a poll that found another holding the lease. */
export interface EmailReceiptPollOutcome {
  ok: boolean;
  busy: boolean;
  /** Emails stored this poll (a UID already stored is not counted). */
  fetched: number;
  /** Messages stored as `skipped` (too large, or undecodable). */
  skipped: number;
  /** Stored emails the pipeline acted on. */
  processed: number;
  /** Why the mailbox could not be read, bounded and free of secrets. */
  error?: string;
}

/** The answer to "Poll now": the outcome, or the error. */
export type EmailReceiptPollNowResult = Omit<
  EmailReceiptPollOutcome,
  "busy"
> & {
  busy?: boolean;
};

interface ReceiptRow {
  messageId: string | null;
  fromAddress: string;
  fromDomain: string;
  subject: string;
  receivedAt: Date;
  bodyText: string;
  uid: string;
  status: "pending" | "skipped";
  statusReason: "too_large" | "undecodable" | null;
}

const EMPTY: EmailReceiptPollOutcome = {
  ok: true,
  busy: false,
  fetched: 0,
  skipped: 0,
  processed: 0,
};

/**
 * The poll of the receipts mailboxes (design sections 6 and 8): every 15
 * minutes, per enabled mailbox, under a per-mailbox lease, read what arrived
 * since the cursor, store it, run the pipeline over what is pending, retry what
 * did not match, and (mode `automatic`) take the bounded AI step.
 *
 * What stops a second replica repeating it (docs/concurrency-and-idempotency.md
 * section 7): `claimLease(EmailReceiptPoll, userId, mailboxId)`, taken per
 * mailbox and released by its token in a `finally`, so the loser does nothing;
 * and, underneath it, `UNIQUE (mailbox_id, uid_validity, uid)` with
 * `ON CONFLICT DO NOTHING`, so a message read twice is stored once
 * (INV-RECEIPT-002). The in-process `running` flag only stops this replica
 * stacking ticks; it decides nothing.
 *
 * Identity: the fan-out is `withSystemContext` (it lists every user's enabled
 * mailbox), and each mailbox runs under `withUserContext(userId)`, the lease
 * included (a lease is database access too). A failure for one user is logged
 * and the loop goes on; the failure line is the mailbox's own bounded,
 * secret-free one (`describeMailboxFailure`), never the password.
 */
@Injectable()
export class EmailReceiptPollService {
  private readonly logger = new Logger(EmailReceiptPollService.name);
  private readonly limits: EmailReceiptPollLimits =
    resolveEmailReceiptPollLimits(process.env, this.logger);
  /** Whether a tick is in flight on this replica. */
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailbox: EmailReceiptMailboxService,
    private readonly imap: ImapMailboxClient,
    private readonly jobClaims: JobClaimService,
    private readonly pipeline: EmailReceiptPipelineService,
    private readonly ai: EmailReceiptAiService,
  ) {}

  @Cron("*/15 * * * *")
  async pollAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const mailboxes = await withSystemContext(() =>
        this.mailbox.listEnabledMailboxes(),
      );
      for (const { id, userId } of mailboxes) {
        try {
          await withUserContext(userId, () =>
            this.pollMailbox(userId, id, { requireEnabled: true }),
          );
        } catch (error) {
          this.logger.warn(
            `Receipt poll failed user=${userId} (${describeFailure(error)})`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Receipt poll could not list the mailboxes (${describeFailure(error)})`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * "Poll now": the same code path as the cron, under the caller's own request
   * identity. The lease makes it a no-op while a cron run (or another press)
   * holds the mailbox, and makes a concurrent cron run a no-op while this one
   * does. A mailbox that is switched off, or cannot be read, is an `ok: false`
   * result with the reason, not an exception; a user with no mailbox is a 404.
   */
  async pollNow(userId: string): Promise<EmailReceiptPollNowResult> {
    const view = await this.mailbox.getView(userId);
    if (!view) {
      throw new NotFoundException(
        tr(
          "errors.emailReceipts.mailboxNotFound",
          "No mailbox is set up for this account.",
        ),
      );
    }
    if (!view.enabled) {
      return {
        ...EMPTY,
        ok: false,
        error: tr(
          "errors.emailReceipts.pollMailboxDisabled",
          "The mailbox is switched off. Turn it on in the mailbox settings to poll it.",
        ),
      };
    }
    const outcome = await this.pollMailbox(userId, view.id, {
      requireEnabled: true,
    });
    if (outcome.busy) {
      return {
        ...outcome,
        ok: false,
        error: tr(
          "errors.emailReceipts.pollBusy",
          "The mailbox is being read right now. Try again in a minute.",
        ),
      };
    }
    return outcome;
  }

  /**
   * One mailbox under its lease. The caller has seeded the identity (the cron's
   * `withUserContext`, or the request's own), so the lease claim and its
   * release, like everything inside, find one.
   */
  async pollMailbox(
    userId: string,
    mailboxId: string,
    options: { requireEnabled: boolean },
  ): Promise<EmailReceiptPollOutcome> {
    const leaseToken = await this.jobClaims.claimLease(
      JobClaimType.EmailReceiptPoll,
      userId,
      mailboxId,
      POLL_LEASE_MS,
    );
    if (leaseToken === null) return { ...EMPTY, busy: true };
    const deadline = Date.now() + LEASE_WORK_BUDGET_MS;
    try {
      return await this.pollLeased(userId, mailboxId, options, deadline);
    } finally {
      try {
        await this.jobClaims.releaseLease(
          JobClaimType.EmailReceiptPoll,
          userId,
          mailboxId,
          leaseToken,
        );
      } catch (error) {
        // The lease expires on its own; a failed release costs one quiet tick.
        this.logger.warn(
          `Could not release the receipt poll lease user=${userId} (${describeFailure(error)})`,
        );
      }
    }
  }

  private async pollLeased(
    userId: string,
    mailboxId: string,
    options: { requireEnabled: boolean },
    deadline: number,
  ): Promise<EmailReceiptPollOutcome> {
    let loaded;
    try {
      loaded = await this.mailbox.loadConnection(userId);
    } catch (error) {
      const line = await this.mailbox.recordPollFailure(
        userId,
        mailboxId,
        error,
      );
      return { ...EMPTY, ok: false, error: line };
    }
    if (!loaded || loaded.mailboxId !== mailboxId) return { ...EMPTY };
    if (options.requireEnabled && !loaded.enabled) return { ...EMPTY };

    const outcome: EmailReceiptPollOutcome = { ...EMPTY };
    try {
      const fetched = await this.imap.fetchSince(
        loaded.connection,
        loaded.cursor,
        {
          sinceDate: new Date(Date.now() - FIRST_SYNC_DAYS * DAY_MS),
          maxMessages: this.limits.maxMessages,
          maxBytes: this.limits.maxMessageBytes,
        },
      );
      const stored = await this.ingest(userId, mailboxId, fetched);
      outcome.fetched = stored.stored;
      outcome.skipped = stored.skipped;
      await this.mailbox.recordPollSuccess(userId, mailboxId);
    } catch (error) {
      // The cursor did not move (it moves only in the insert transaction), so
      // the next poll reads the same messages again.
      const line = await this.mailbox.recordPollFailure(
        userId,
        mailboxId,
        error,
        loaded.secrets,
      );
      this.logger.warn(
        `Receipt poll could not read a mailbox user=${userId}: ${line}`,
      );
      outcome.ok = false;
      outcome.error = line;
    }

    // What is stored can be processed whether or not the mailbox answered.
    const seen = new Set<string>();
    for (const id of await this.selectPending(userId, mailboxId)) {
      if (Date.now() > deadline) break;
      seen.add(id);
      await this.processOne(userId, id, ["pending"], outcome);
    }
    for (const id of await this.selectRematch(userId, mailboxId)) {
      if (Date.now() > deadline) break;
      if (seen.has(id)) continue;
      await this.processOne(userId, id, ["unmatched", "review"], outcome);
    }

    if (loaded.aiMode === "automatic" && Date.now() <= deadline) {
      try {
        await this.ai.runAutomaticStep(userId);
      } catch (error) {
        this.logger.warn(
          `Receipt AI step failed user=${userId} (${describeFailure(error)})`,
        );
      }
    }
    return outcome;
  }

  /**
   * Store the messages and move the cursor in ONE transaction (INV-RECEIPT-002):
   * a failure anywhere rolls both back and the next poll reads the same UIDs; a
   * UID stored already is skipped by `ON CONFLICT DO NOTHING`. A message that is
   * too large or cannot be decoded is stored `skipped` so its UID is consumed.
   */
  private async ingest(
    userId: string,
    mailboxId: string,
    fetched: FetchSinceResult,
  ): Promise<{ stored: number; skipped: number }> {
    const now = new Date();
    const rows: ReceiptRow[] = [];
    for (const message of fetched.messages) {
      rows.push(await this.toRow(message, now));
    }
    for (const skipped of fetched.skipped) {
      rows.push(skippedRow(skipped.uid, skipped.reason, now));
    }
    return withScopedDb(this.dataSource, async (m) => {
      let stored = 0;
      let skipped = 0;
      for (const row of rows) {
        const inserted = returnedRows<{ id: string }>(
          await m.query(
            `INSERT INTO email_receipts
               (user_id, mailbox_id, uid_validity, uid, message_id, from_address,
                from_domain, subject, received_at, body_text, status, status_reason)
             VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (mailbox_id, uid_validity, uid) DO NOTHING
             RETURNING id`,
            [
              userId,
              mailboxId,
              fetched.uidValidity,
              row.uid,
              row.messageId,
              row.fromAddress,
              row.fromDomain,
              row.subject,
              row.receivedAt,
              row.bodyText,
              row.status,
              row.statusReason,
            ],
          ),
        );
        if (inserted.length === 0) continue;
        if (row.status === "skipped") skipped++;
        else stored++;
      }
      await this.mailbox.advanceCursor(userId, mailboxId, {
        uidValidity: fetched.uidValidity,
        lastUid: fetched.highestUid,
      });
      return { stored, skipped };
    });
  }

  private async toRow(message: FetchedMessage, now: Date): Promise<ReceiptRow> {
    try {
      const mail = await extractMailText(message.source);
      return {
        messageId: mail.messageId,
        fromAddress: mail.fromAddress,
        fromDomain: mail.fromDomain,
        subject: mail.subject,
        receivedAt: pickReceivedAt(mail.date, message.internalDate, now),
        bodyText: mail.text,
        uid: message.uid,
        status: "pending",
        statusReason: null,
      };
    } catch {
      return skippedRow(message.uid, "undecodable", message.internalDate);
    }
  }

  private async processOne(
    userId: string,
    receiptId: string,
    statuses: readonly EmailReceiptStatus[],
    outcome: EmailReceiptPollOutcome,
  ): Promise<void> {
    try {
      const result = await this.pipeline.process(userId, receiptId, {
        onlyWhenStatusIn: statuses,
      });
      if (!result.unchanged) outcome.processed++;
    } catch (error) {
      this.logger.warn(
        `Receipt ${receiptId} could not be processed (${describeFailure(error)})`,
      );
    }
  }

  private async selectPending(
    userId: string,
    mailboxId: string,
  ): Promise<string[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `SELECT id
             FROM email_receipts
            WHERE user_id = $1
              AND mailbox_id = $2
              AND status = 'pending'
            ORDER BY received_at DESC, id
            LIMIT $3`,
          [userId, mailboxId, MAX_PROCESSED_PER_POLL],
        ),
      ),
    );
    return rows.map((row) => row.id);
  }

  /**
   * Emails worth another look: `unmatched` ones that arrived in the last 30
   * days (the bank transaction usually arrives later than the email), and
   * `review` ones that stand behind no transaction or behind a request that no
   * longer exists (a restore). A request that was dismissed, expired or applied
   * still exists and is left alone.
   */
  private async selectRematch(
    userId: string,
    mailboxId: string,
  ): Promise<string[]> {
    const rows = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string }>(
        await m.query(
          `SELECT r.id
             FROM email_receipts r
            WHERE r.user_id = $1
              AND r.mailbox_id = $2
              AND (
                (r.status = 'unmatched'
                  AND r.received_at > CURRENT_TIMESTAMP - ($4::int * INTERVAL '1 day'))
                OR (r.status = 'review'
                  AND (r.transaction_id IS NULL
                       OR NOT EXISTS (
                            SELECT 1
                              FROM ai_review_requests q
                             WHERE q.id = r.ai_review_request_id
                               AND q.user_id = r.user_id)))
              )
            ORDER BY r.received_at DESC, r.id
            LIMIT $3`,
          [userId, mailboxId, MAX_REMATCHED_PER_POLL, REMATCH_DAYS],
        ),
      ),
    );
    return rows.map((row) => row.id);
  }
}

/**
 * When the email was written: its Date header when that is a real date no later
 * than a day from now (a forwarded order keeps the shop's date, which is what
 * the match window is about), else the server's own arrival time.
 */
export function pickReceivedAt(
  header: Date | null,
  internalDate: Date,
  now: Date,
): Date {
  if (header !== null && header.getTime() <= now.getTime() + DAY_MS) {
    return header;
  }
  return Number.isNaN(internalDate.getTime()) ? now : internalDate;
}

function skippedRow(
  uid: string,
  reason: "too_large" | "undecodable",
  receivedAt: Date,
): ReceiptRow {
  return {
    messageId: null,
    fromAddress: "",
    fromDomain: "",
    subject: "",
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    bodyText: "",
    uid,
    status: "skipped",
    statusReason: reason,
  };
}
