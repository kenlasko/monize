import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { User } from "../users/entities/user.entity";
import { EmailService } from "./email.service";
import { billReminderTemplate } from "./email-templates";
import { emailTranslator } from "../i18n/email-translator";
import { DEFAULT_LOCALE } from "../i18n/config";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { withScopedDb } from "../common/db/scoped-db";
import {
  JobClaimService,
  JobClaimType,
} from "../common/jobs/job-claim.service";
import { createHash } from "node:crypto";

/**
 * How long one replica holds the right to send this user's bill reminder.
 *
 * A lease, so a replica killed between claiming and sending costs a retry window
 * rather than the delivery. It only has to outlast an SMTP round trip; whether the
 * work is still owed is decided by the delivery record, not by the lease
 * (audit RV4-006).
 *
 * The resulting contract is at-least-once: a process killed after SMTP accepted
 * but before the record committed re-sends next run. For a reminder that is the
 * right trade -- a duplicate nudge is an annoyance, a missed mortgage renewal is
 * not. See docs/cron-jobs.md.
 */
const REMINDER_LEASE_MS = 10 * 60 * 1000;

@Injectable()
export class BillReminderService {
  private readonly logger = new Logger(BillReminderService.name);

  constructor(
    private dataSource: DataSource,
    private emailService: EmailService,
    private configService: ConfigService,
    private readonly i18n: I18nService,
    private readonly jobClaims: JobClaimService,
  ) {}

  /**
   * Release a lease a send did not use, so the next run can retry.
   *
   * Addressed by the lease token, not only by the work: a stalled worker must not
   * delete a lease another replica has retaken (audit DR-RRV4-01).
   */
  private async releaseClaim(
    userId: string,
    claimKey: string,
    leaseToken: string,
  ): Promise<void> {
    await this.jobClaims
      .releaseLease(JobClaimType.BillReminder, userId, claimKey, leaseToken)
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed to release bill-reminder claim for user ${userId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendBillReminders(): Promise<void> {
    if (!this.emailService.getStatus().configured) {
      this.logger.debug("SMTP not configured, skipping bill reminders");
      return;
    }

    this.logger.log("Running bill reminder check...");

    // Only manual bills (autoPost = false) that are active.
    // RLS (task C2): cross-user fan-out over every user's manual bills.
    const manualBills = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(ScheduledTransaction).find({
          where: { isActive: true, autoPost: false },
          relations: ["payee", "overrides"],
        }),
      ),
    );

    if (manualBills.length === 0) {
      this.logger.log("No manual bills found");
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Group bills by userId where due date is within reminderDaysBefore window
    const billsByUser = new Map<string, ScheduledTransaction[]>();

    for (const bill of manualBills) {
      // Check for an override matching the next due date (user may have changed the date)
      const nextDueDateStr = String(bill.nextDueDate).split("T")[0];
      const override = bill.overrides?.find(
        (o) => String(o.originalDate).split("T")[0] === nextDueDateStr,
      );
      const effectiveDueDate = override
        ? new Date(override.overrideDate)
        : new Date(bill.nextDueDate);
      effectiveDueDate.setHours(0, 0, 0, 0);

      const daysUntilDue = Math.ceil(
        (effectiveDueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (daysUntilDue >= 0 && daysUntilDue <= bill.reminderDaysBefore) {
        const existing = billsByUser.get(bill.userId) || [];
        existing.push(bill);
        billsByUser.set(bill.userId, existing);
      }
    }

    if (billsByUser.size === 0) {
      this.logger.log("No bills due within reminder windows");
      return;
    }

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    let sentCount = 0;
    let skipCount = 0;

    for (const [userId, bills] of billsByUser) {
      // Claim this user's reminder for today before doing anything that leaves
      // the process.
      //
      // Every backend replica fires this cron (docs/cron-jobs.md), and nothing
      // here recorded that a reminder had been sent -- so two healthy replicas
      // both selected the same due bills and both emailed them. Not a rare race:
      // the *normal* outcome of running more than one replica (audit P4-018).
      //
      // The key is the local date plus a hash of what the email says, so a bill
      // that becomes due later the same day still produces a reminder while an
      // identical run does not.
      const claimKey = buildReminderClaimKey(bills);
      // A **lease**, not a permanent claim, plus a durable delivery record.
      //
      // `claimOnce` was taken before the send and was the only record that the
      // send was owed, so a replica killed in between left a permanent row that
      // every later run read as "already handled" -- the bill reminder was never
      // sent and nothing could notice, because the row could not tell "I sent
      // this" from "I intended to" (audit RV4-006). The lease bounds *doing* the
      // work; `delivered_at`, written after the send and re-read here, is what
      // says it was done.
      const claimed = await this.jobClaims.claimLease(
        JobClaimType.BillReminder,
        userId,
        claimKey,
        REMINDER_LEASE_MS,
      );
      if (!claimed) {
        skipCount++;
        continue;
      }
      const leaseToken = claimed;
      if (
        await this.jobClaims.wasDelivered(
          JobClaimType.BillReminder,
          userId,
          claimKey,
        )
      ) {
        // Already sent, durably. Hand the lease back rather than holding it for
        // its whole TTL.
        skipCount++;
        await this.releaseClaim(userId, claimKey, leaseToken);
        continue;
      }

      try {
        // Check if user has email notifications enabled.
        // RLS (task C2): per-user reads run under the user's own context.
        const prefs = await withUserContext(userId, () =>
          withScopedDb(this.dataSource, (manager) =>
            manager.getRepository(UserPreference).findOne({
              where: { userId },
            }),
          ),
        );
        if (prefs && !prefs.notificationEmail) {
          skipCount++;
          await this.releaseClaim(userId, claimKey, leaseToken);
          continue;
        }

        const user = await withUserContext(userId, () =>
          withScopedDb(this.dataSource, (manager) =>
            manager.getRepository(User).findOne({ where: { id: userId } }),
          ),
        );
        if (!user || !user.email) {
          skipCount++;
          await this.releaseClaim(userId, claimKey, leaseToken);
          continue;
        }

        const billData = bills.map((b) => {
          const dueDateStr = String(b.nextDueDate).split("T")[0];
          const ov = b.overrides?.find(
            (o) => String(o.originalDate).split("T")[0] === dueDateStr,
          );
          const rawAmount = Number(ov?.amount ?? b.amount);
          return {
            payee: b.payee?.name || b.payeeName || b.name,
            amount: Math.abs(rawAmount),
            dueDate: ov ? String(ov.overrideDate).split("T")[0] : dueDateStr,
            currencyCode: b.currencyCode,
            isIncome: rawAmount > 0,
          };
        });

        const lang = prefs?.language || DEFAULT_LOCALE;
        const t = emailTranslator(this.i18n, lang);
        const html = billReminderTemplate(
          user.firstName || "",
          billData,
          appUrl,
          t,
        );
        const subject =
          bills.length === 1
            ? t(
                "emails.billReminder.subjectOne",
                "Monize: 1 upcoming bill needs attention",
              )
            : t(
                "emails.billReminder.subjectMany",
                `Monize: ${bills.length} upcoming bills need attention`,
                { count: bills.length },
              );

        await this.emailService.sendMail(user.email, subject, html);
        // The delivery record, after the side effect and never before it.
        await this.jobClaims.markDelivered(
          JobClaimType.BillReminder,
          userId,
          claimKey,
          leaseToken,
        );
        sentCount++;
      } catch (error) {
        // Hand the claim back. Claiming first is what makes the send
        // exactly-once, but it must not turn a transient SMTP outage into a
        // silently skipped day -- which is what the pre-claim code got for free
        // by never recording anything.
        await this.releaseClaim(userId, claimKey, leaseToken);
        this.logger.error(
          `Failed to send bill reminder to user ${userId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    this.logger.log(
      `Bill reminders complete: ${sentCount} sent, ${skipCount} skipped`,
    );
  }
}

/**
 * The delivery key for one user's bill reminder: today's date plus a digest of
 * exactly what the email will say.
 *
 * The date alone would suppress a legitimate second reminder when another bill
 * falls due later the same day. The digest alone would let the same set be
 * re-sent tomorrow. Together they mean "this reminder, today", which is what the
 * claim is asserting.
 */
export function buildReminderClaimKey(
  bills: readonly ScheduledTransaction[],
): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const fingerprint = [...bills]
    .map((b) => `${b.id}:${String(b.nextDueDate).split("T")[0]}:${b.amount}`)
    .sort()
    .join("|");
  const digest = createHash("sha256")
    .update(fingerprint)
    .digest("hex")
    .slice(0, 32);
  return `${date}#${digest}`;
}
