import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { getEffectiveTimezoneOfUser } from "../../common/users-by-timezone.util";
import { AccountsService } from "../../accounts/accounts.service";
import { NetWorthService } from "../../net-worth/net-worth.service";
import { PortfolioService } from "../../securities/portfolio.service";
import type { UserPreference } from "../../users/entities/user-preference.entity";
import {
  fullDailyInput,
  fullLedgerInput,
} from "./__fixtures__/trivia-pool.fixture";
import { TriviaDailyLoader } from "./trivia-daily.loader";
import { TriviaLedgerLoader } from "./trivia-ledger.loader";
import { TriviaPoolBuilder } from "./trivia-pool.builder";

jest.mock("../../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("../../common/users-by-timezone.util", () => ({
  getEffectiveTimezoneOfUser: jest.fn(),
}));

describe("TriviaPoolBuilder", () => {
  const userId = "user-1";
  const prefs = { defaultCurrency: "CAD" } as UserPreference;
  let accounts: jest.Mocked<Pick<AccountsService, "findAll">>;
  let netWorth: jest.Mocked<Pick<NetWorthService, "getMonthlyNetWorth">>;
  let portfolio: jest.Mocked<Pick<PortfolioService, "getPortfolioSummary">>;
  let ledger: jest.Mocked<Pick<TriviaLedgerLoader, "load">>;
  let daily: jest.Mocked<Pick<TriviaDailyLoader, "load">>;
  let builder: TriviaPoolBuilder;

  beforeEach(() => {
    (withScopedDb as jest.Mock).mockImplementation(
      (_ds: DataSource, fn: (m: EntityManager) => unknown) =>
        fn({} as EntityManager),
    );
    (getEffectiveTimezoneOfUser as jest.Mock).mockResolvedValue("Asia/Tokyo");
    accounts = { findAll: jest.fn().mockResolvedValue([]) };
    netWorth = { getMonthlyNetWorth: jest.fn().mockResolvedValue([]) };
    portfolio = { getPortfolioSummary: jest.fn().mockResolvedValue(null) };
    ledger = { load: jest.fn().mockResolvedValue(fullLedgerInput()) };
    daily = { load: jest.fn().mockResolvedValue(fullDailyInput()) };
    builder = new TriviaPoolBuilder(
      {} as DataSource,
      accounts as unknown as AccountsService,
      netWorth as unknown as NetWorthService,
      portfolio as unknown as PortfolioService,
      ledger as unknown as TriviaLedgerLoader,
      daily as unknown as TriviaDailyLoader,
    );
  });

  it("resolves the reader's timezone", async () => {
    await expect(builder.timezoneOf(userId)).resolves.toBe("Asia/Tokyo");
    expect(getEffectiveTimezoneOfUser).toHaveBeenCalledWith({}, userId);
  });

  it("skips the bills read in page mode, and reads it in cron mode", async () => {
    await builder.build(userId, prefs, { today: "2026-11-19", mode: "page" });
    expect(daily.load).toHaveBeenLastCalledWith(
      userId,
      "CAD",
      "2026-11-19",
      expect.objectContaining({ bills: false }),
    );
    await builder.build(userId, prefs, { today: "2026-11-19", mode: "cron" });
    expect(daily.load).toHaveBeenLastCalledWith(
      userId,
      "CAD",
      "2026-11-19",
      expect.objectContaining({ bills: true }),
    );
  });

  it("hands the day to every loader, and the payee report to the daily one", async () => {
    await builder.build(userId, prefs, { today: "2026-11-20", mode: "cron" });
    expect(ledger.load).toHaveBeenCalledWith(userId, "CAD", "2026-11-20");
    expect(daily.load).toHaveBeenCalledWith(
      userId,
      "CAD",
      "2026-11-20",
      expect.objectContaining({
        spendingByPayee: fullLedgerInput().spendingByPayee,
      }),
    );
  });

  it("concatenates the ledger and daily facts", async () => {
    const facts = await builder.build(userId, prefs, {
      today: "2026-11-19",
      mode: "cron",
    });
    const ids = facts.map((f) => f.id);
    expect(ids).toContain("spendingTopCategory");
    expect(ids).toContain("spendingLastDay");
  });

  it("still builds when the portfolio cannot be read", async () => {
    portfolio.getPortfolioSummary.mockRejectedValue(new Error("nope"));
    await expect(
      builder.build(userId, prefs, { today: "2026-11-19", mode: "page" }),
    ).resolves.not.toHaveLength(0);
  });
});
