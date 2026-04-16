import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, IsNull, Not } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { Account, AccountType } from "./entities/account.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { EmailService } from "../notifications/email.service";
import { mortgageReminderTemplate } from "../notifications/email-templates";
import { formatDateYMD } from "../common/date-utils";

/**
 * Service for handling mortgage term renewal reminders
 *
 * Runs daily to check for mortgages with term end dates approaching and
 * sends an email reminder to each affected user (respecting their
 * notificationEmail preference). Also logs each detected renewal so ops
 * can see what was processed even when SMTP is unavailable.
 */
@Injectable()
export class MortgageReminderService {
  private readonly logger = new Logger(MortgageReminderService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {}

  /**
   * Run daily at 8:00 AM to check for upcoming mortgage renewals
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async checkMortgageRenewals() {
    this.logger.log("Running mortgage renewal check...");

    const upcomingRenewals = await this.findUpcomingRenewals(60);

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
      try {
        const prefs = await this.preferencesRepository.findOne({
          where: { userId },
        });
        if (prefs && !prefs.notificationEmail) {
          skipCount++;
          continue;
        }

        const user = await this.usersRepository.findOne({
          where: { id: userId },
        });
        if (!user || !user.email) {
          skipCount++;
          continue;
        }

        const mortgageData = mortgages.map((m) => ({
          name: m.name,
          termEndDate: formatDateYMD(m.termEndDate!),
          daysUntilRenewal: this.getDaysUntilDate(m.termEndDate!),
        }));

        const html = mortgageReminderTemplate(
          user.firstName || "",
          mortgageData,
          appUrl,
        );
        const subject =
          mortgages.length === 1
            ? "Monize: 1 upcoming mortgage renewal"
            : `Monize: ${mortgages.length} upcoming mortgage renewals`;

        await this.emailService.sendMail(user.email, subject, html);
        sentCount++;
      } catch (error) {
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

    return this.accountsRepository
      .find({
        where: {
          accountType: AccountType.MORTGAGE,
          isClosed: false,
          termEndDate: Not(IsNull()),
        },
      })
      .then((accounts) =>
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
