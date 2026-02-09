import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { User } from "../users/entities/user.entity";
import { EmailService } from "./email.service";
import { billReminderTemplate } from "./email-templates";

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
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendBillReminders(): Promise<void> {
    if (!this.emailService.getStatus().configured) {
      this.logger.debug("SMTP not configured, skipping bill reminders");
      return;
    }

    this.logger.log("Running bill reminder check...");

    // Only manual bills (autoPost = false) that are active
    const manualBills = await this.scheduledTransactionsRepo.find({
      where: { isActive: true, autoPost: false },
      relations: ["payee"],
    });

    if (manualBills.length === 0) {
      this.logger.log("No manual bills found");
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Group bills by userId where due date is within reminderDaysBefore window
    const billsByUser = new Map<string, ScheduledTransaction[]>();

    for (const bill of manualBills) {
      const dueDate = new Date(bill.nextDueDate);
      dueDate.setHours(0, 0, 0, 0);

      const daysUntilDue = Math.ceil(
        (dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
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
        // Check if user has email notifications enabled
        const prefs = await this.preferencesRepo.findOne({
          where: { userId },
        });
        if (prefs && !prefs.notificationEmail) {
          skipCount++;
          continue;
        }

        const user = await this.usersRepo.findOne({ where: { id: userId } });
        if (!user || !user.email) {
          skipCount++;
          continue;
        }

        const billData = bills.map((b) => ({
          payee: b.payee?.name || b.payeeName || b.name,
          amount: Math.abs(Number(b.amount)),
          dueDate: String(b.nextDueDate).split("T")[0],
          currencyCode: b.currencyCode,
        }));

        const html = billReminderTemplate(
          user.firstName || "",
          billData,
          appUrl,
        );
        const subject =
          bills.length === 1
            ? "Monize: 1 upcoming bill needs attention"
            : `Monize: ${bills.length} upcoming bills need attention`;

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
