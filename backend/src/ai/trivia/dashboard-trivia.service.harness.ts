import { DataSource } from "typeorm";
import { DashboardTriviaService } from "./dashboard-trivia.service";
import { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { TriviaPoolBuilder } from "./trivia-pool.builder";
import { emptyWindowedReads } from "./trivia-windowed-reads";

/**
 * Spec support for the `dashboard-trivia.service.*.spec.ts` suites: the
 * service built over doubles, as one `DashboardTriviaService` suite once did
 * before it was split by behaviour.
 *
 * Importing this module installs the four `jest.mock` calls below for the
 * importing spec, so a spec must import it BEFORE anything that loads the
 * service, and must not repeat them.
 */

/** The transaction manager `withScopedDb` hands every callback. */
export const manager: Record<string, any> = {};
jest.mock("../../common/db/scoped-db", () => ({
  withScopedDb: (_ds: unknown, fn: (m: unknown) => unknown) => fn(manager),
}));
/** The locale the request carries; a spec sets `.current`. */
export const requestLocale = { current: "en" };
jest.mock("../../i18n/request-locale", () => ({
  currentRequestLocale: () => requestLocale.current,
}));
jest.mock("../../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
  withUserContext: jest.fn((_id: string, fn: () => unknown) => fn()),
}));
jest.mock("../../common/users-by-timezone.util", () => ({
  getEffectiveTimezoneOfUser: jest.fn(),
  getUsersByEffectiveTimezone: jest.fn(),
}));

/**
 * A fact a model sentence covers is shown once: no calculated item may stand
 * beside the sentence for the same fact id.
 */
export function expectNoCalculatedBesideCoveringSentence(
  items: { source: string; factId?: string; factIds?: string[] }[],
): void {
  const covered = new Set(
    items.flatMap((i) => (i.source === "ai" ? (i.factIds ?? []) : [])),
  );
  expect(covered.size).toBeGreaterThan(0);
  expect(
    items.filter(
      (i) => i.source === "calculated" && covered.has(i.factId as string),
    ),
  ).toEqual([]);
}

export const userId = "user-1";
export const aiReply = (text: string) =>
  JSON.stringify({ trivia: [{ topic: "netWorth", text }] });

const months = [
  { month: "2025-01-01", assets: 100, netWorth: 100, fxComplete: true },
  { month: "2025-02-01", assets: 200, netWorth: 200, fxComplete: true },
];

export interface ServiceHarness {
  readonly prefRepo: { findOne: jest.Mock };
  readonly triviaRepo: Record<string, jest.Mock>;
  readonly insertQb: Record<string, jest.Mock>;
  readonly selectQb: Record<string, jest.Mock>;
  readonly accounts: Record<string, jest.Mock>;
  readonly netWorth: Record<string, jest.Mock>;
  readonly portfolio: Record<string, jest.Mock>;
  readonly ai: Record<string, jest.Mock>;
  readonly jobClaims: Record<string, jest.Mock>;
  readonly ledger: Record<string, jest.Mock>;
  readonly daily: Record<string, jest.Mock>;
  readonly service: DashboardTriviaService;
}

/**
 * Registers the `beforeEach` that rebuilds every double and the service, and
 * returns the live view of them (a getter per double, so it always reads the
 * current test's instance).
 */
export function useServiceHarness(): ServiceHarness {
  let prefRepo: { findOne: jest.Mock };
  let triviaRepo: Record<string, jest.Mock>;
  let insertQb: Record<string, jest.Mock>;
  let selectQb: Record<string, jest.Mock>;
  let accounts: Record<string, jest.Mock>;
  let netWorth: Record<string, jest.Mock>;
  let portfolio: Record<string, jest.Mock>;
  let ai: Record<string, jest.Mock>;
  let jobClaims: Record<string, jest.Mock>;
  let ledger: Record<string, jest.Mock>;
  let daily: Record<string, jest.Mock>;
  let service: DashboardTriviaService;

  beforeEach(() => {
    prefRepo = {
      findOne: jest.fn().mockResolvedValue({
        defaultCurrency: "CAD",
        language: "fr",
        dashboardWidgets: ["trivia"],
      }),
    };
    triviaRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    };
    insertQb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    selectQb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ userId }, { userId: "user-2" }]),
    };
    manager.getRepository = jest.fn((entity: unknown) =>
      entity === DashboardTrivia
        ? triviaRepo
        : entity === UserPreference
          ? prefRepo
          : {},
    );
    manager.createQueryBuilder = jest.fn(() => insertQb);
    accounts = { findAll: jest.fn().mockResolvedValue([]) };
    netWorth = { getMonthlyNetWorth: jest.fn().mockResolvedValue(months) };
    portfolio = { getPortfolioSummary: jest.fn().mockResolvedValue(null) };
    ai = {
      getStatus: jest
        .fn()
        .mockResolvedValue({ configured: true, relayActive: false }),
      complete: jest
        .fn()
        .mockResolvedValue({ content: aiReply("Peak {currentHigh}") }),
    };
    jobClaims = { claimOnce: jest.fn().mockResolvedValue(true) };
    // Nothing from the rest of the ledger unless a test asks for it.
    ledger = {
      load: jest.fn().mockResolvedValue({
        currency: "CAD",
        spendingByCategory: null,
        spendingByPayee: null,
        incomeVsExpenses: null,
        incomeBySource: null,
        windowed: emptyWindowedReads(),
        records: null,
        warranties: null,
      }),
    };
    daily = {
      load: jest.fn().mockResolvedValue({
        currency: "CAD",
        today: "2026-11-19",
        monthToDate: null,
        lastDay: null,
        lastSevenDays: null,
        biggestPurchase: null,
        lastSpendDate: null,
        sincePayee: null,
        bills: null,
        budget: null,
        topMover: null,
      }),
    };
    (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue("UTC");
    // Not imported: `with-context` is import-restricted outside the allowlist.
    jest
      .requireMock("../../common/db/with-context")
      .withUserContext.mockClear();
    const pool = new TriviaPoolBuilder(
      {} as DataSource,
      accounts as never,
      netWorth as never,
      portfolio as never,
      ledger as never,
      daily as never,
      {
        load: jest.fn().mockResolvedValue({
          accountFirstDates: null,
          transactionsRecordedBefore: null,
          yearAgoMonth: null,
        }),
      } as never,
    );
    service = new DashboardTriviaService(
      {} as DataSource,
      ai as never,
      jobClaims as never,
      pool,
    );
  });

  return {
    get prefRepo() {
      return prefRepo;
    },
    get triviaRepo() {
      return triviaRepo;
    },
    get insertQb() {
      return insertQb;
    },
    get selectQb() {
      return selectQb;
    },
    get accounts() {
      return accounts;
    },
    get netWorth() {
      return netWorth;
    },
    get portfolio() {
      return portfolio;
    },
    get ai() {
      return ai;
    },
    get jobClaims() {
      return jobClaims;
    },
    get ledger() {
      return ledger;
    },
    get daily() {
      return daily;
    },
    get service() {
      return service;
    },
  };
}
