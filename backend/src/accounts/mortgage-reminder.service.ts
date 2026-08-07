import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource, IsNull, Not } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { Account, AccountType } from "./entities/account.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { EmailService } from "../notifications/email.service";
import { mortgageReminderTemplate } from "../notifications/email-templates";
import { formatDateYMD } from "../common/date-utils";
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
 * Service for handling mortgage term renewal reminders
 *
 * Runs daily to check for mortgages with term end dates approaching and
 * sends an email reminder to each affected user (respecting their
 * notificationEmail preference). Also logs each detected renewal so ops
 * can see what was processed even when SMTP is unavailable.
 */
/**
 * How long one replica holds the right to send this user's mortgage renewal notice.
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
export class MortgageReminderService {
  private readonly logger = new Logger(MortgageReminderService.name);

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
      .releaseLease(JobClaimType.MortgageReminder, userId, claimKey, leaseToken)
      .catch((error: unknown) =>
        this.logger.warn(
          `Failed to release mortgage-reminder claim for user ${userId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  /**
   * Run daily at 8:00 AM to check for upcoming mortgage renewals
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async checkMortgageRenewals() {
    this.logger.log("Running mortgage renewal check...");

    // RLS (task C2): cross-user fan-out over every user's mortgages.
    const upcomingRenewals = await withSystemContext(() =>
      this.findUpcomingRenewals(60),
    );

    if (upcomingRenewals.length === 0) {
      this.logger.log("No upcoming mortgage renewals found");
      return;
    }

    for (const mortgage of upcomingRenewals) {
      const daysUntilRenewal = this.getDaysUntilDate(mortgage.termEndDate!);
      this.logger.warn(
        `Mortgage renewal reminder: ${mortgage.name} (User: ${mortgage.userId}) ` +
          `- Term ends in ${daysUntilRenewal} days on ${formatDateYMD(mortgage.termEndDate!)}`,
      );
    }

    this.logger.log(
      `Found ${upcomingRenewals.length} mortgage(s) with upcoming renewals`,
    );

    if (!this.emailService.getStatus().configured) {
      this.logger.debug(
        "SMTP not configured, skipping mortgage renewal emails",
      );
      return;
    }

    // Group mortgages by userId so each user receives a single email
    const mortgagesByUser = new Map<string, Account[]>();
    for (const mortgage of upcomingRenewals) {
      const existing = mortgagesByUser.get(mortgage.userId) || [];
      existing.push(mortgage);
      mortgagesByUser.set(mortgage.userId, existing);
    }

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    let sentCount = 0;
    let skipCount = 0;

    for (const [userId, mortgages] of mortgagesByUser) {
      // Claim before sending -- see BillReminderService for the reasoning. Every
      // replica fires this cron, so without a durable record two healthy pods
      // both email the same renewal notice (audit P4-018).
      const claimKey = buildMortgageReminderClaimKey(mortgages);
      // A **lease**, not a permanent claim, plus a durable delivery record.
      //
      // `claimOnce` was taken before the send and was the only record that the
      // send was owed, so a replica killed in between left a permanent row that
      // every later run read as "already handled" -- the mortgage reminder was never
      // sent and nothing could notice, because the row could not tell "I sent
      // this" from "I intended to" (audit RV4-006). The lease bounds *doing* the
      // work; `delivered_at`, written after the send and re-read here, is what
      // says it was done.
      const claimed = await this.jobClaims.claimLease(
        JobClaimType.MortgageReminder,
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
          JobClaimType.MortgageReminder,
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
        // RLS (task C2): per-user reads run under the user's own context.
        const prefs = await withUserContext(userId, () =>
          withScopedDb(this.dataSource, (m) =>
            m.getRepository(UserPreference).findOne({
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
          withScopedDb(this.dataSource, (m) =>
            m.getRepository(User).findOne({
              where: { id: userId },
            }),
          ),
        );
        if (!user || !user.email) {
          skipCount++;
          await this.releaseClaim(userId, claimKey, leaseToken);
          continue;
        }

        const mortgageData = mortgages.map((m) => ({
          name: m.name,
          termEndDate: formatDateYMD(m.termEndDate!),
          daysUntilRenewal: this.getDaysUntilDate(m.termEndDate!),
        }));

        const lang = prefs?.language || DEFAULT_LOCALE;
        const t = emailTranslator(this.i18n, lang);
        const html = mortgageReminderTemplate(
          user.firstName || "",
          mortgageData,
          appUrl,
          t,
        );
        const subject =
          mortgages.length === 1
            ? t(
                "emails.mortgageReminder.subject",
                "Monize: 1 upcoming mortgage renewal",
              )
            : t(
                "emails.mortgageReminder.subjectPlural",
                `Monize: ${mortgages.length} upcoming mortgage renewals`,
                { count: mortgages.length },
              );

        await this.emailService.sendMail(user.email, subject, html);
        // The delivery record, after the side effect and never before it.
        await this.jobClaims.markDelivered(
          JobClaimType.MortgageReminder,
          userId,
          claimKey,
          leaseToken,
        );
        sentCount++;
      } catch (error) {
        // A transient SMTP failure returns the day rather than consuming it.
        await this.releaseClaim(userId, claimKey, leaseToken);
        this.logger.error(
          `Failed to send mortgage reminder to user ${userId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    this.logger.log(
      `Mortgage reminders complete: ${sentCount} sent, ${skipCount} skipped`,
    );
  }

  /**
   * Find all mortgages with term end dates within the specified number of days
   */
  async findUpcomingRenewals(daysAhead: number): Promise<Account[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + daysAhead);

    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: {
          accountType: AccountType.MORTGAGE,
          isClosed: false,
          termEndDate: Not(IsNull()),
        },
      }),
    ).then((accounts) =>
      accounts.filter((account) => {
        if (!account.termEndDate) return false;
        const termEnd = new Date(account.termEndDate);
        termEnd.setHours(0, 0, 0, 0);
        return termEnd >= today && termEnd <= futureDate;
      }),
    );
  }

  /**
   * Calculate days until a given date
   */
  private getDaysUntilDate(date: Date): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const diffTime = targetDate.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Manual trigger to check renewals (useful for testing)
   */
  async triggerRenewalCheck(): Promise<{
    count: number;
    mortgages: Array<{
      id: string;
      name: string;
      termEndDate: string;
      daysUntilRenewal: number;
    }>;
  }> {
    const upcomingRenewals = await this.findUpcomingRenewals(60);

    return {
      count: upcomingRenewals.length,
      mortgages: upcomingRenewals.map((m) => ({
        id: m.id,
        name: m.name,
        termEndDate: formatDateYMD(m.termEndDate!),
        daysUntilRenewal: this.getDaysUntilDate(m.termEndDate!),
      })),
    };
  }
}

/**
 * The delivery key for one user's mortgage-renewal notice: today's date plus a
 * digest of which mortgages and which term-end dates it names.
 *
 * Same shape as the bill reminder's key, and for the same reason: the date alone
 * suppresses a legitimate second notice when another mortgage enters the window
 * today, and the digest alone would let the same notice repeat tomorrow.
 */
export function buildMortgageReminderClaimKey(
  mortgages: readonly Account[],
): string {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const fingerprint = [...mortgages]
    .map((m) => `${m.id}:${formatDateYMD(m.termEndDate!)}`)
    .sort()
    .join("|");
  const digest = createHash("sha256")
    .update(fingerprint)
    .digest("hex")
    .slice(0, 32);
  return `${date}#${digest}`;
}
