import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
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

@Injectable()
export class BillReminderService {
  private readonly logger = new Logger(BillReminderService.name);

  constructor(
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepo: Repository<ScheduledTransaction>,
    @InjectRepository(User)
    private usersRepo: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepo: Repository<UserPreference>,
    private emailService: EmailService,
    private configService: ConfigService,
    private readonly i18n: I18nService,
  ) {}

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
      this.scheduledTransactionsRepo.find({
        where: { isActive: true, autoPost: false },
        relations: ["payee", "overrides"],
      }),
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
      try {
        // Check if user has email notifications enabled.
        // RLS (task C2): per-user reads run under the user's own context.
        const prefs = await withUserContext(userId, () =>
          this.preferencesRepo.findOne({
            where: { userId },
          }),
        );
        if (prefs && !prefs.notificationEmail) {
          skipCount++;
          continue;
        }

        const user = await withUserContext(userId, () =>
          this.usersRepo.findOne({ where: { id: userId } }),
        );
        if (!user || !user.email) {
          skipCount++;
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
        sentCount++;
      } catch (error) {
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
