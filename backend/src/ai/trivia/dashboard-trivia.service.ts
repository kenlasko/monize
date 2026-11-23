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
import { todayInTimezoneOrUtc } from "../../common/date-utils";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AiService } from "../ai.service";
import { TRIVIA_SYSTEM_PROMPT } from "../context/prompt-templates";
import {
  aiLanguageInstruction,
  aiLanguageName,
} from "../context/language-directive";
import { currentRequestLocale } from "../../i18n/request-locale";
import { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { TriviaPoolBuilder } from "./trivia-pool.builder";
import { dueTriviaUsers, TRIVIA_WIDGET_ID } from "./trivia-due-users";
import { keepForRewording } from "./trivia-kept";
import {
  orderForDisplay,
  selectDailyTrivia,
  yesterdayOf,
} from "./trivia-rotation";
import {
  buildTriviaPrompt,
  pickTriviaAngle,
  type TriviaPromptOptions,
} from "./trivia-prompt";
import { mergeTriviaItems, parseTriviaSentences } from "./trivia-sentences";
import type {
  DashboardTriviaResponse,
  TriviaFact,
  TriviaFigures,
  TriviaItem,
} from "./trivia.types";

/**
 * Users built at once by the daily job: each reads a whole portfolio and
 * holds up to `TRIVIA_READ_CONCURRENCY` connections, so a tick holds at most
 * six of the default pool of ten and requests keep the rest.
 */
export const TRIVIA_GENERATION_CONCURRENCY = 3;

@Injectable()
export class DashboardTriviaService {
  private readonly logger = new Logger(DashboardTriviaService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly aiService: AiService,
    private readonly jobClaims: JobClaimService,
    private readonly pool: TriviaPoolBuilder,
  ) {}

  /**
   * The stored list. A user the daily job has not reached yet (a new account,
   * the day this ships) gets a calculated one, stored so the next dashboard
   * load does not work it out again. So does a list a model worded in another
   * language than the reader now uses, until the next daily run. A list with
   * nothing in it is not stored, so a reader's first import shows up on the
   * next load rather than the next morning. No provider is called from a page
   * load.
   *
   * Which row counts as yesterday: the stored row, while its `generatedAt` is
   * on an earlier local day than the reader's today. Only the daily job
   * replaces such a row. A page load that finds one (the job has not reached
   * the reader yet, or missed) answers with a calculated list for today,
   * rotated away from the stored one, and stores nothing, so the job still
   * sees the real yesterday and still words the day's list. A rewording
   * rewrites a row of today and keeps its `generatedAt`, so the row stays what
   * it was.
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
    const timezone = (await this.pool.timezoneOf(userId)) ?? "UTC";
    const today = todayInTimezoneOrUtc(timezone);
    const stale =
      stored !== null &&
      todayInTimezoneOrUtc(timezone, stored.generatedAt) < today;
    if (stored && !stale && !this.needsRewording(stored, language)) {
      if (stored.language !== language)
        await this.saveLanguage(userId, language);
      return this.toResponse(stored);
    }

    const facts = await this.pool.build(userId, preferences, {
      today,
      mode: "page",
    });
    if (stored && stale) {
      if (stored.language !== language)
        await this.saveLanguage(userId, language);
      const selected = selectDailyTrivia(
        facts,
        yesterdayOf(stored),
        userId,
        today,
      );
      return this.toResponse(
        this.calculatedRow(userId, selected, language, today, new Date()),
      );
    }
    const kept = stored ? keepForRewording(stored, facts, userId, today) : [];
    const selected =
      kept.length > 0 ? kept : selectDailyTrivia(facts, null, userId, today);
    const row = this.calculatedRow(
      userId,
      selected,
      language,
      today,
      stored?.generatedAt ?? new Date(),
    );
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

  /**
   * The hourly tick. Each reader whose local day began within the last few
   * hours is offered to `generateForUser`, whose per-day claim lets one tick
   * (and one replica) build the day's list.
   */
  @Cron("17 * * * *")
  async handleDailyGeneration(): Promise<void> {
    // RLS: a cross-user fan-out over the active users, by timezone bucket.
    const due = await withSystemContext(() =>
      dueTriviaUsers(this.dataSource, new Date()),
    );
    if (due.length === 0) return;
    this.logger.log(`Dashboard trivia: ${due.length} users in their window`);
    await mapWithConcurrency(
      due,
      TRIVIA_GENERATION_CONCURRENCY,
      async ({ userId, timezone }) => {
        try {
          // RLS: each user's list is built and stored under that user, in
          // that user's timezone, so the day the reads call "today" is theirs.
          await withUserContext(
            userId,
            () => this.generateForUser(userId, timezone),
            timezone,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          this.logger.warn(
            `Failed to generate dashboard trivia for user ${userId}: ${message}`,
          );
        }
      },
    );
  }

  /**
   * One user's list for their local day. Every replica fires the cron, a
   * model call is paid for, and the user is reached on several ticks, so the
   * claim, keyed by the reader's local day, comes before any other read. It is
   * permanent for the day and not released on failure: yesterday's row stays
   * until tomorrow's run, which is what a list of trivia can afford.
   *
   * A reader who switched the trivia off, or has no Trivia widget on the
   * dashboard, never sees the list, so nothing is built or sent to their
   * provider. Their row goes, as does one with nothing
   * left to say, so the next dashboard load works out a current list.
   */
  async generateForUser(userId: string, timezone: string): Promise<void> {
    const today = todayInTimezoneOrUtc(timezone);
    const claimed = await this.jobClaims.claimOnce(
      JobClaimType.DashboardTrivia,
      userId,
      `daily:${today}`,
    );
    if (!claimed) return;

    const preferences = await this.loadPreferences(userId);
    const widgetShown =
      preferences?.dashboardWidgets?.includes(TRIVIA_WIDGET_ID) ?? false;
    if (preferences?.aiTriviaEnabled === false || !widgetShown) {
      await this.deleteRow(userId);
      return;
    }

    const pool = await this.pool.build(userId, preferences, {
      today,
      mode: "cron",
    });
    if (pool.length === 0) {
      await this.deleteRow(userId);
      return;
    }
    const stored = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DashboardTrivia).findOne({ where: { userId } }),
    );
    // A row written earlier today (a new reader's first load) is today's.
    const previous =
      stored && todayInTimezoneOrUtc(timezone, stored.generatedAt) < today
        ? stored
        : null;
    const selected = selectDailyTrivia(
      pool,
      yesterdayOf(previous),
      userId,
      today,
    );
    const language = await this.jobLanguage(userId, preferences);
    const aiItems = await this.phraseWithAi(userId, selected, language, {
      avoid: this.avoidSentences(previous),
      angle: pickTriviaAngle(userId, today),
    });
    const row: DashboardTrivia = {
      userId,
      items: mergeTriviaItems(
        orderForDisplay(selected, userId, today),
        aiItems,
      ),
      figures: this.figuresOf(selected),
      language: language ?? null,
      generatedAt: new Date(),
    };
    await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(DashboardTrivia).upsert(row, ["userId"]),
    );
  }

  /** A row of calculated sentences for `selected`, in the day's order. */
  private calculatedRow(
    userId: string,
    selected: TriviaFact[],
    language: string,
    today: string,
    generatedAt: Date,
  ): DashboardTrivia {
    return {
      userId,
      items: mergeTriviaItems(orderForDisplay(selected, userId, today), []),
      figures: this.figuresOf(selected),
      language,
      generatedAt,
    };
  }

  /**
   * Yesterday's model sentences, as stored: templates with `{placeholder}`
   * names, never text with figures filled in.
   */
  private avoidSentences(row: DashboardTrivia | null): string[] {
    if (!row || !Array.isArray(row.items)) return [];
    return row.items.flatMap((item) =>
      item?.source === "ai" && typeof item.text === "string" ? [item.text] : [],
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
    prompt: TriviaPromptOptions,
  ): Promise<TriviaItem[]> {
    try {
      const status = await this.aiService.getStatus(userId);
      if (!status.configured || status.relayActive) return [];
      const response = await this.aiService.complete(
        userId,
        {
          systemPrompt: TRIVIA_SYSTEM_PROMPT + aiLanguageInstruction(language),
          messages: [
            { role: "user", content: buildTriviaPrompt(facts, prompt) },
          ],
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
