import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { expandOccurrenceSlots } from "../common/scheduled-occurrences";
import { todayYMD } from "../common/date-utils";
import { reminderWindowThrough } from "../scheduled-transactions/reminder-window";
import { UserPreference } from "../users/entities/user-preference.entity";
import { User } from "../users/entities/user.entity";
import { NotificationCategory } from "../notification-center/entities/notification.entity";
import { NotificationPreferenceService } from "../notification-center/notification-preference.service";
import { EmailService } from "./email.service";
import { billReminderTemplate } from "./email-templates";
import { numberFormatterFor } from "../common/number-locale.util";
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
    // Which occurrence is due, when it falls and what it will cost -- all from
    // the one server-side occurrence contract rather than the persisted snapshot
    // or a private copy of the override rules (issue #1247).
    @Inject(forwardRef(() => ScheduledOccurrenceService))
    private readonly occurrences: ScheduledOccurrenceService,
    private readonly notificationPreferences: NotificationPreferenceService,
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
          // `splits` is what tells the effective-amount resolver whether a
          // schedule's cash total re-prices at the current FX rate (issue
          // #1247); without it an embedded-investment schedule looks fixed.
          relations: ["payee", "overrides", "splits"],
        }),
      ),
    );

    if (manualBills.length === 0) {
      this.logger.log("No manual bills found");
      return;
    }

    // Group bills by userId where an occurrence falls inside the bill's own
    // reminder window. One "today", as a YYYY-MM-DD string: the local-midnight
    // `Date` this used to keep beside it fed the old day-count comparison and was
    // left behind when the expander replaced it -- two "today"s that are not
    // interchangeable is how the wrong one gets picked up.
    const billsByUser = new Map<string, ScheduledTransaction[]>();

    // ONE date for the whole run, read once and passed down.
    //
    // The two passes each used to call `todayYMD()` for themselves, so a run that
    // crossed local midnight between them asked two different questions: pass one
    // selected against D and pass two re-expanded against D+1, dropping every
    // bill due exactly on D. The survivors were emailed and `delivered_at` was
    // written for a claim key fingerprinted on the FULL set -- and the next run,
    // now on D+1, no longer selects the D bill either, so its reminder was never
    // sent and nothing recorded that it was owed. A window is only reproducible
    // if the date it is measured from is a value, not a second clock read.
    const todayStr = todayYMD();
    for (const bill of manualBills) {
      // "Is this bill due inside its own reminder window" is a question about an
      // OCCURRENCE, so it is asked through the one expander: the override that
      // matters is the one on the recurrence slot, and it may have moved the
      // occurrence's date (issue #1247). This half runs cross-user, so it cannot
      // price anything -- `deliverForUser` does that under the owner's identity.
      // The window bound goes through `reminderWindowThrough`, which owns the
      // nullable column (null is "due today only") and the ceiling. A raw
      // `addDaysYMD` on an unbounded value produced "NaN-NaN-NaN", and the
      // expander's text comparison read that as "every bill is due today".
      //
      // Each bill on its own: this pass spans every user, so one row that
      // cannot be expanded is logged and passed over rather than ending the run
      // for everybody (backend/CLAUDE.md, per-user isolation).
      let due: readonly unknown[];
      try {
        due = expandOccurrenceSlots(bill, bill.overrides ?? [], {
          from: todayStr,
          through: reminderWindowThrough(todayStr, bill.reminderDaysBefore),
          maxOccurrences: 1,
        });
      } catch (error) {
        this.logger.warn(
          `Bill reminder skipped scheduled transaction ${bill.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (due.length > 0) {
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
      // The whole per-user body runs under this user's identity, claims
      // included.
      //
      // `JobClaimService` reaches the database through `withScopedDb` like any
      // other caller, so it needs an ambient context to spend -- and the
      // `withSystemContext` above covers only the cross-user fan-out read. With
      // the claims left outside a context, `withScopedDb` threw
      // `MISSING_CONTEXT_MESSAGE` on the first user with a due bill and, because
      // the throw was outside the try, took the rest of the run with it: no
      // reminder was sent to anybody. Wrapping the body is what makes the claim,
      // the delivery record and the release share one identity with the reads
      // between them.
      //
      // The claim and delivery checks run before `deliverForUser`'s own catch,
      // so one user's failure there is caught here and the loop moves on.
      let sent = false;
      try {
        sent = await withUserContext(userId, () =>
          this.deliverForUser(userId, bills, appUrl, todayStr),
        );
      } catch (error) {
        this.logger.error(
          `Bill reminder failed for user ${userId}`,
          error instanceof Error ? error.stack : error,
        );
      }
      if (sent) sentCount++;
      else skipCount++;
    }

    this.logger.log(
      `Bill reminders complete: ${sentCount} sent, ${skipCount} skipped`,
    );
  }

  /**
   * Claim, send and record one user's bill reminder. Returns whether an email
   * was sent, so the caller can count it.
   *
   * Runs inside the caller's `withUserContext`: every database call below, the
   * job claims included, spends that identity.
   */
  private async deliverForUser(
    userId: string,
    bills: readonly ScheduledTransaction[],
    appUrl: string,
    /**
     * The run's date, from the caller. Deliberately NOT read here: this pass and
     * the selecting pass have to measure their windows from the same day, and a
     * second `todayYMD()` is how they came to disagree across midnight.
     */
    todayStr: string,
  ): Promise<boolean> {
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
    const claimKey = buildReminderClaimKey(bills, todayStr);
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
      return false;
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
      await this.releaseClaim(userId, claimKey, leaseToken);
      return false;
    }

    try {
      // A bill reminder is the PAYMENTS category. Email is gated by the
      // per-category matrix and the global email master switch together, and
      // the resolver reads both. RLS (task C2): this per-user body already runs
      // under the user's own context, and the resolver's nested withScopedDb
      // joins it.
      const emailEnabled = await this.notificationPreferences.resolveEmail(
        userId,
        NotificationCategory.PAYMENTS,
      );
      if (!emailEnabled) {
        await this.releaseClaim(userId, claimKey, leaseToken);
        return false;
      }

      // The user's stored locale for the reminder copy, composed off-request.
      const prefs = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(UserPreference).findOne({ where: { userId } }),
      );

      const user = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(User).findOne({ where: { id: userId } }),
      );
      if (!user || !user.email) {
        await this.releaseClaim(userId, claimKey, leaseToken);
        return false;
      }

      // What each occurrence would actually post, and when, from the one
      // server-side occurrence contract (issue #1247). The persisted `amount` is
      // a snapshot at whatever rate was current when it was written, so a
      // reminder built from it can name a figure the posting will not use -- and
      // the occurrence the user re-dated is not the one the template describes.
      // The direction comes from the occurrence too (`directionAmount`), which is
      // the occurrence's own amount when known and the snapshot's sign only when
      // it is not.
      //
      // `todayStr` is the caller's, so this window and the selecting pass's are
      // measured from one day.
      // Reduced rather than spread: `Math.max(...xs)` over a per-user array is a
      // stack-depth limit disguised as an aggregate, and this array is as long as
      // the user's manual-bill list.
      //
      // No clamp here: `reminderWindowThrough` owns the ceiling, and its own doc
      // says why it lives there rather than at a call site. A second copy of the
      // bound is a second thing to move when the bound moves.
      const longestWindow = bills.reduce(
        (widest, b) => Math.max(widest, b.reminderDaysBefore ?? 0),
        0,
      );
      const occurrences = await this.occurrences.expand(userId, [...bills], {
        from: todayStr,
        through: reminderWindowThrough(todayStr, longestWindow),
        maxOccurrences: 1,
      });
      const billData = occurrences.map((occurrence) => {
        const schedule = occurrence.schedule;
        return {
          payee: schedule.payee?.name || schedule.payeeName || schedule.name,
          amount:
            occurrence.amount === null ? null : Math.abs(occurrence.amount),
          dueDate: occurrence.dueDate,
          currencyCode: occurrence.currencyCode,
          // The occurrence's own direction. This read the occurrence's amount
          // with the SCHEDULE's as its fallback, which is neither the same
          // question nor the same row: an override re-pricing a -200 charge into
          // a +500 refund, on a pair whose rate cannot be resolved, fell through
          // to the schedule and the email called the refund an expense.
          // `null` travels: an unpriceable mixed-sign occurrence posts on either
          // side of zero, so the row shows a neutral badge rather than asserting
          // an expense the data cannot support (issue #1247 re-audit).
          isIncome:
            occurrence.directionAmount === null
              ? null
              : occurrence.directionAmount > 0,
          // Labelled in the email as an estimate (issue #2096).
          estimated: occurrence.estimated,
        };
      });

      // Nothing to say means nothing to send, and nothing to record.
      //
      // The two halves of this cron each ask their own question: the cross-user
      // pass selects bills against one `todayStr`, and this pass re-expands them
      // under the owner's identity against its own. They can disagree -- the run
      // crosses midnight, an override moves in between, a long-overdue daily
      // schedule truncates at the walk guard -- and the old code then sent an
      // email with an empty table under a subject counted from the pre-expansion
      // list ("1 upcoming bill needs attention"), and wrote `delivered_at` for a
      // claim key fingerprinted on those same bills. That record is what makes
      // the reminder single-shot, so the genuine one could never be sent again
      // that day. Hand the lease back instead and let the next run decide.
      if (billData.length === 0) {
        this.logger.warn(
          `Bill reminder for user ${userId} matched ${bills.length} bill(s) in the ` +
            `cross-user pass but no occurrence under the owner's own window; ` +
            `nothing sent, claim released`,
        );
        await this.releaseClaim(userId, claimKey, leaseToken);
        return false;
      }

      // A PARTIAL disagreement is sent, and said out loud.
      //
      // With one pinned date the two passes ask the same question, so a bill that
      // drops out here did so for a real reason -- an override moved its
      // occurrence, or the walk guard truncated a long-overdue daily schedule --
      // and a bill that is no longer due is one there is nothing to remind about.
      // So the email carries the survivors and `delivered_at` still settles the
      // claim key, which fingerprints the pass-one set. What must not happen is
      // this passing unremarked: the claim key covering more bills than the email
      // listed is exactly the shape of the empty-email defect above, one bill
      // short of it, and the log line is how a recurring cause gets noticed.
      if (billData.length < bills.length) {
        this.logger.warn(
          `Bill reminder for user ${userId}: ${bills.length} bill(s) selected, ` +
            `${billData.length} with an occurrence to report; emailing those and ` +
            `settling the claim for the selected set`,
        );
      }

      const lang = prefs?.language || DEFAULT_LOCALE;
      const t = emailTranslator(this.i18n, lang);
      // The amounts follow the recipient's number locale, not the server's:
      // translated copy around an `en-US` figure is the defect in issue #1316.
      const n = numberFormatterFor(prefs?.numberFormat, prefs?.language);
      const html = billReminderTemplate(
        user.firstName || "",
        billData,
        appUrl,
        t,
        n,
      );
      // Counted from what the email actually lists, not from what phase one
      // selected: the two can differ, and the subject is a claim about the body.
      const subject =
        billData.length === 1
          ? t(
              "emails.billReminder.subjectOne",
              "Monize: 1 upcoming bill needs attention",
            )
          : t(
              "emails.billReminder.subjectMany",
              `Monize: ${billData.length} upcoming bills need attention`,
              { count: billData.length },
            );

      await this.emailService.sendMail(user.email, subject, html);
      // The delivery record, after the side effect and never before it.
      await this.jobClaims.markDelivered(
        JobClaimType.BillReminder,
        userId,
        claimKey,
        leaseToken,
      );
      return true;
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
      return false;
    }
  }
}

/**
 * The delivery key for one user's bill reminder: today's date plus a digest of
 * WHICH bills it covers.
 *
 * The date alone would suppress a legitimate second reminder when another bill
 * falls due later the same day. The digest alone would let the same set be
 * re-sent tomorrow. Together they mean "this reminder, today", which is what the
 * claim is asserting.
 *
 * Deliberately fingerprinted on the stored scalars rather than on the effective
 * amounts the email quotes: the claim answers "have we already reminded this
 * user about these bills today", and a mid-day exchange-rate move is not a
 * second reminder to send (issue #1247).
 *
 * `todayStr` is the RUN's date, supplied by the caller and never read here.
 * This was the last clock read in the cron, and it governs the value the whole
 * single-shot guarantee rests on: with the two expansion passes pinned but the
 * key still reading `new Date()` per user, a run spanning local midnight claimed
 * the early users under `key(D)` and the rest under `key(D+1)` while every
 * window was measured from D -- so the next run re-selected a user emailed at
 * 23:59:59, found no delivery record under its own `key(D+1)`, and sent the same
 * reminder twice. Pinning the windows and leaving the key unpinned moved the
 * midnight bug rather than fixing it.
 */
export function buildReminderClaimKey(
  bills: readonly ScheduledTransaction[],
  todayStr: string,
): string {
  const date = todayStr;
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
