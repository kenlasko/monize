import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThan, IsNull, Not } from 'typeorm';
import { Account, AccountType } from './entities/account.entity';

/**
 * Service for handling mortgage term renewal reminders
 *
 * Runs daily to check for mortgages with term end dates approaching
 * and logs reminders. When a full notification system is implemented,
 * this will create actual user notifications.
 */
@Injectable()
export class MortgageReminderService {
  private readonly logger = new Logger(MortgageReminderService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
  ) {}

  /**
   * Run daily at 8:00 AM to check for upcoming mortgage renewals
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async checkMortgageRenewals() {
    this.logger.log('Running mortgage renewal check...');

    const upcomingRenewals = await this.findUpcomingRenewals(60);

    if (upcomingRenewals.length === 0) {
      this.logger.log('No upcoming mortgage renewals found');
      return;
    }

    for (const mortgage of upcomingRenewals) {
      const daysUntilRenewal = this.getDaysUntilDate(mortgage.termEndDate!);
      this.logger.warn(
        `Mortgage renewal reminder: ${mortgage.name} (User: ${mortgage.userId}) ` +
          `- Term ends in ${daysUntilRenewal} days on ${mortgage.termEndDate!.toISOString().split('T')[0]}`,
      );

      // TODO: When notification system is implemented, create a notification here
      // await this.notificationsService.create({
      //   userId: mortgage.userId,
      //   type: 'MORTGAGE_RENEWAL',
      //   title: 'Mortgage Term Renewal Approaching',
      //   message: `Your mortgage term for "${mortgage.name}" ends on ${mortgage.termEndDate.toLocaleDateString()}. Contact your lender to discuss renewal options.`,
      //   accountId: mortgage.id,
      //   expiresAt: new Date(mortgage.termEndDate.getTime() + 30 * 24 * 60 * 60 * 1000), // Expire 30 days after term end
      // });
    }

    this.logger.log(`Found ${upcomingRenewals.length} mortgage(s) with upcoming renewals`);
  }

  /**
   * Find all mortgages with term end dates within the specified number of days
   */
  async findUpcomingRenewals(daysAhead: number): Promise<Account[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + daysAhead);

    return this.accountsRepository.find({
      where: {
        accountType: AccountType.MORTGAGE,
        isClosed: false,
        termEndDate: Not(IsNull()),
      },
    }).then(accounts =>
      accounts.filter(account => {
        if (!account.termEndDate) return false;
        const termEnd = new Date(account.termEndDate);
        termEnd.setHours(0, 0, 0, 0);
        return termEnd >= today && termEnd <= futureDate;
      })
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
      mortgages: upcomingRenewals.map(m => ({
        id: m.id,
        name: m.name,
        termEndDate: m.termEndDate!.toISOString().split('T')[0],
        daysUntilRenewal: this.getDaysUntilDate(m.termEndDate!),
      })),
    };
  }
}
