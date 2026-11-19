import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { preferredCurrency } from "../../common/default-currency.util";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { AccountsService } from "../../accounts/accounts.service";
import { accountCarriesBalance } from "../../accounts/account-carries-balance";
import { Account, AccountType } from "../../accounts/entities/account.entity";
import { NetWorthService } from "../../net-worth/net-worth.service";
import {
  PortfolioService,
  PortfolioSummary,
} from "../../securities/portfolio.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { buildTriviaFacts, TriviaAsset } from "./trivia-facts";
import { buildLedgerTriviaFacts } from "./trivia-ledger-facts";
import { buildDailyTriviaFacts } from "./trivia-daily-facts";
import { buildRankedTriviaFacts } from "./trivia-ranked-facts";
import { pickAll } from "./trivia-windowed-reads";
import { buildEquivalenceTriviaFacts } from "./trivia-equivalence-facts";
import { buildCalendarTriviaFacts } from "./trivia-calendar-facts";
import { TriviaCalendarLoader } from "./trivia-calendar.loader";
import { TriviaDailyLoader } from "./trivia-daily.loader";
import { TriviaLedgerLoader } from "./trivia-ledger.loader";
import type { TriviaFact } from "./trivia.types";

export interface TriviaPoolOptions {
  /** The reader's day. */
  today: string;
  /** A page load skips the bills read, which may fetch rates. */
  mode: "cron" | "page";
}

/**
 * Assembles every fact a reader can be shown today: the net worth and
 * investment facts, the ledger's, and the ones that move with the day. Which
 * of them are shown is the rotation's business.
 */
@Injectable()
export class TriviaPoolBuilder {
  private readonly logger = new Logger(TriviaPoolBuilder.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly accountsService: AccountsService,
    private readonly netWorthService: NetWorthService,
    private readonly portfolioService: PortfolioService,
    private readonly ledger: TriviaLedgerLoader,
    private readonly daily: TriviaDailyLoader,
    private readonly calendar: TriviaCalendarLoader,
  ) {}

  /** The reader's effective timezone, which dates the cron's per-user body. */
  timezoneOf(userId: string): Promise<string | null> {
    return withScopedDb(this.dataSource, (m) =>
      getEffectiveTimezoneOfUser(m, userId),
    );
  }

  async build(
    userId: string,
    preferences: UserPreference | null,
    options: TriviaPoolOptions,
  ): Promise<TriviaFact[]> {
    const { today, mode } = options;
    const currency = preferredCurrency(preferences);

    const months = await this.netWorthService.getMonthlyNetWorth(
      userId,
      undefined,
      undefined,
      undefined,
      { fetchMissing: false },
    );
    const portfolio = await this.loadPortfolio(userId);
    // Closed accounts too: a closed asset still carrying a value ranks, as it
    // counts in net worth. The portfolio flag reads the open accounts.
    const allAccounts = await this.accountsService.findAll(userId, true);
    const accounts = allAccounts.filter((a) => !a.isClosed);

    // The window and rank of each rotating family, chosen before any read.
    const picks = pickAll(userId, today);
    const ledger = await this.ledger.load(userId, currency, today, picks);
    const daily = await this.daily.load(userId, currency, today, {
      bills: mode === "cron",
      spendingByPayee: ledger.spendingByPayee,
    });

    const calendar = await this.calendar.load(userId, currency, today);

    const facts = [
      ...buildTriviaFacts({
        currency,
        months,
        portfolio,
        otherAssets: this.otherAssets(allAccounts, currency),
        portfolioInNetWorth: !accounts.some(
          (a) =>
            a.accountType === AccountType.INVESTMENT && a.excludeFromNetWorth,
        ),
      }),
      // Spending, income, records and warranties: the rest of Monize.
      ...buildLedgerTriviaFacts(ledger),
      // The top and ranked categories, payees and sources, over a rotating window.
      ...buildRankedTriviaFacts({
        currency,
        picks,
        windowed: ledger.windowed,
        m12: ledger,
      }),
      // What moves with each day.
      ...buildDailyTriviaFacts(daily),
      // Anniversaries, milestones and the year-ago comparisons.
      ...buildCalendarTriviaFacts({
        today,
        currency,
        months,
        records: ledger.records,
        warranties: ledger.warranties,
        calendar,
      }),
      // Comparisons the server works out, so the model never has to.
      ...buildEquivalenceTriviaFacts({
        today,
        currency,
        ledger,
        portfolio,
      }),
    ];
    // The countdown and "the next warranty to run out" are one warranty said twice.
    return facts.some((f) => f.id === "warrantiesExpiresSoon")
      ? facts.filter((f) => f.id !== "warrantiesNextExpiry")
      : facts;
  }

  /** A portfolio that cannot be read leaves out its facts, and only those. */
  private async loadPortfolio(
    userId: string,
  ): Promise<PortfolioSummary | null> {
    try {
      return await this.portfolioService.getPortfolioSummary(userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Trivia could not read the portfolio for user ${userId}: ${message}`,
      );
      return null;
    }
  }

  /** `null` when a balance in another currency makes the accounts unrankable. */
  private otherAssets(
    accounts: Account[],
    currency: string,
  ): TriviaAsset[] | null {
    const assets = accounts.filter(
      (a) =>
        a.accountType === AccountType.ASSET &&
        // A closed asset still carrying a value counts, as in net worth.
        accountCarriesBalance(a) &&
        !a.excludeFromNetWorth,
    );
    if (assets.some((a) => a.currencyCode !== currency)) return null;
    return assets.map((a) => ({
      name: a.name,
      value: Number(a.currentBalance),
    }));
  }
}
