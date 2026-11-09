import { randomInt } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import {
  withSystemContext,
  withUserContext,
} from "../../common/db/with-context";
import {
  JobClaimService,
  JobClaimType,
} from "../../common/jobs/job-claim.service";
import { mapWithConcurrency } from "../../common/concurrency.util";
import { preferredCurrency } from "../../common/default-currency.util";
import { AccountsService } from "../../accounts/accounts.service";
import { Account, AccountType } from "../../accounts/entities/account.entity";
import { NetWorthService } from "../../net-worth/net-worth.service";
import {
  PortfolioService,
  PortfolioSummary,
} from "../../securities/portfolio.service";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AiService } from "../ai.service";
import { TRIVIA_SYSTEM_PROMPT } from "../context/prompt-templates";
import {
  aiLanguageInstruction,
  aiLanguageName,
} from "../context/language-directive";
import { currentRequestLocale } from "../../i18n/request-locale";
import { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { buildTriviaFacts, TriviaAsset } from "./trivia-facts";
import {
  buildTriviaPrompt,
  mergeTriviaItems,
  parseTriviaSentences,
} from "./trivia-sentences";
import type {
  DashboardTriviaResponse,
  TriviaFact,
  TriviaFigures,
  TriviaItem,
} from "./trivia.types";

/** Users built at once by the daily job: each reads a whole portfolio. */
const TRIVIA_GENERATION_CONCURRENCY = 5;

/** The hero's key in `dashboardWidgetConfig`; the frontend's `DASHBOARD_HERO_WIDGET_ID`. */
const DASHBOARD_HERO_WIDGET_ID = "dashboard-hero";

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

@Injectable()
export class DashboardTriviaService {
  private readonly logger = new Logger(DashboardTriviaService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly accountsService: AccountsService,
    private readonly netWorthService: NetWorthService,
    private readonly portfolioService: PortfolioService,
    private readonly aiService: AiService,
    private readonly jobClaims: JobClaimService,
  ) {}

  /**
   * The stored list. A user the daily job has not reached yet (a new account,
   * the day this ships) gets a calculated one, stored so the next dashboard
   * load does not work it out again. So does a list a model worded in another
   * language than the reader now uses, until the next daily run. A list with nothing in it is not stored,
   * so a reader's first import shows up on the next load rather than the next
   * morning. No provider is called from a page load.
   */
  async getTrivia(userId: string): Promise<DashboardTriviaResponse> {
    const preferences = await this.loadPreferences(userId);
    if (preferences?.aiTriviaEnabled === false) {
      return { items: [], figures: {}, generatedAt: new Date().toISOString() };
    }

    const stored = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DashboardTrivia).findOne({ where: { userId } }),
    );
    const language = this.readerLanguage(preferences);
    if (stored && !this.needsRewording(stored, language)) {
      if (stored.language !== language)
        await this.saveLanguage(userId, language);
      return this.toResponse(stored);
    }

    const facts = await this.loadFacts(userId, preferences);
    const row: DashboardTrivia = {
      userId,
      items: shuffled(mergeTriviaItems(facts, [])),
      figures: this.figuresOf(facts),
      language,
      generatedAt: new Date(),
    };
    if (row.items.length === 0) return this.toResponse(row);
    if (stored) {
      await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(DashboardTrivia).upsert(row, ["userId"]),
      );
      return this.toResponse(row);
    }
    // A daily run landing meanwhile holds the better list, so never replace one.
    await withScopedDb(this.dataSource, (manager) =>
      manager
        .createQueryBuilder()
        .insert()
        .into(DashboardTrivia)
        .values(row)
        .orIgnore()
        .execute(),
    );
    return this.toResponse(row);
  }

  @Cron("30 6 * * *")
  async handleDailyGeneration(): Promise<void> {
    this.logger.log("Starting daily dashboard trivia generation");
    // RLS: a cross-user fan-out over the active users.
    const userIds = await withSystemContext(() => this.getActiveUserIds());
    await mapWithConcurrency(
      userIds,
      TRIVIA_GENERATION_CONCURRENCY,
      async (userId) => {
        try {
          // RLS: each user's list is built and stored under that user.
          await withUserContext(userId, () => this.generateForUser(userId));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          this.logger.warn(
            `Failed to generate dashboard trivia for user ${userId}: ${message}`,
          );
        }
      },
    );
    this.logger.log(
      `Daily dashboard trivia generation complete for ${userIds.length} users`,
    );
  }

  /**
   * One user's list for the day. Every replica fires the cron, and a model call
   * is paid for, so the claim comes first. It is permanent for the day and not
   * released on failure: yesterday's row stays until tomorrow's run, which is
   * what a list of trivia can afford.
   *
   * A reader who switched the trivia or the hero off never sees the list, so
   * nothing is built or sent to their provider. Their row goes, as does one with nothing
   * left to say, so the next dashboard load works out a current list.
   */
  async generateForUser(userId: string): Promise<void> {
    const preferences = await this.loadPreferences(userId);
    const hero = preferences?.dashboardWidgetConfig?.[
      DASHBOARD_HERO_WIDGET_ID
    ] as { enabled?: unknown } | undefined;
    if (preferences?.aiTriviaEnabled === false || hero?.enabled === false) {
      await this.deleteRow(userId);
      return;
    }

    const day = new Date().toISOString().slice(0, 10);
    const claimed = await this.jobClaims.claimOnce(
      JobClaimType.DashboardTrivia,
      userId,
      `daily:${day}`,
    );
    if (!claimed) return;

    const facts = await this.loadFacts(userId, preferences);
    if (facts.length === 0) {
      await this.deleteRow(userId);
      return;
    }
    const language = await this.jobLanguage(userId, preferences);
    const aiItems = await this.phraseWithAi(userId, facts, language);
    const row: DashboardTrivia = {
      userId,
      items: shuffled(mergeTriviaItems(facts, aiItems)),
      figures: this.figuresOf(facts),
      language: language ?? null,
      generatedAt: new Date(),
    };
    await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DashboardTrivia).upsert(row, ["userId"]),
    );
  }

  /** The language a reader sees now: the request knows what their browser asks for. */
  private readerLanguage(preferences: UserPreference | null): string {
    const language = preferences?.language;
    return !language || language === "browser"
      ? currentRequestLocale()
      : language;
  }

  /** The job has no browser, so a reader following theirs gets the one last seen. */
  private async jobLanguage(
    userId: string,
    preferences: UserPreference | null,
  ): Promise<string | undefined> {
    if (preferences?.language !== "browser") return preferences?.language;
    const stored = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DashboardTrivia).findOne({ where: { userId } }),
    );
    return stored?.language ?? undefined;
  }

  /**
   * A model's sentences are in the language they were written in; calculated
   * ones come from the reader's own catalog and are never out of step. Compared
   * by the language a model would write, so `en` and `en-GB` are one language.
   */
  private needsRewording(row: DashboardTrivia, language: string): boolean {
    return (
      row.items.some((item) => item.source === "ai") &&
      aiLanguageName(row.language) !== aiLanguageName(language)
    );
  }

  private async saveLanguage(userId: string, language: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DashboardTrivia).update({ userId }, { language }),
    );
  }

  private loadPreferences(userId: string): Promise<UserPreference | null> {
    return withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );
  }

  private async deleteRow(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DashboardTrivia).delete({ userId }),
    );
  }

  private async loadFacts(
    userId: string,
    preferences: UserPreference | null,
  ): Promise<TriviaFact[]> {
    const currency = preferredCurrency(preferences);

    const months = await this.netWorthService.getMonthlyNetWorth(
      userId,
      undefined,
      undefined,
      undefined,
      { fetchMissing: false },
    );
    const portfolio = await this.loadPortfolio(userId);
    const accounts = await this.accountsService.findAll(userId);

    return buildTriviaFacts({
      currency,
      months,
      portfolio,
      otherAssets: this.otherAssets(accounts, currency),
      portfolioInNetWorth: !accounts.some(
        (a) =>
          a.accountType === AccountType.INVESTMENT && a.excludeFromNetWorth,
      ),
    });
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
        !a.isClosed &&
        !a.excludeFromNetWorth,
    );
    if (assets.some((a) => a.currencyCode !== currency)) return null;
    return assets.map((a) => ({
      name: a.name,
      value: Number(a.currentBalance),
    }));
  }

  /**
   * The model's sentences, or none: no provider, the relay (a prompt to the
   * user's own agent every morning is not something they asked for, so it is
   * also kept out of the fall-through), or a provider that failed. The
   * calculated sentences stand in for all of it.
   */
  private async phraseWithAi(
    userId: string,
    facts: TriviaFact[],
    language: string | undefined,
  ): Promise<TriviaItem[]> {
    try {
      const status = await this.aiService.getStatus(userId);
      if (!status.configured || status.relayActive) return [];
      const response = await this.aiService.complete(
        userId,
        {
          systemPrompt: TRIVIA_SYSTEM_PROMPT + aiLanguageInstruction(language),
          messages: [{ role: "user", content: buildTriviaPrompt(facts) }],
          maxTokens: 4096,
          temperature: 0.7,
          responseFormat: "json",
        },
        "dashboard_trivia",
        { skipRelay: true },
      );
      return parseTriviaSentences(response.content, facts);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Trivia model call failed for user ${userId}: ${message}`,
      );
      return [];
    }
  }

  private async getActiveUserIds(): Promise<string[]> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager
        .createQueryBuilder()
        .select("u.id", "userId")
        .from("users", "u")
        .where("u.is_active = true")
        .getRawMany<{ userId: string }>(),
    );
    return rows.map((r) => r.userId);
  }

  private figuresOf(facts: TriviaFact[]): TriviaFigures {
    return Object.assign({}, ...facts.map((f) => f.figures)) as TriviaFigures;
  }

  private toResponse(row: DashboardTrivia): DashboardTriviaResponse {
    return {
      items: row.items,
      figures: row.figures,
      generatedAt: row.generatedAt.toISOString(),
    };
  }
}
