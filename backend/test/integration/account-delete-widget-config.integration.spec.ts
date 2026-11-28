import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * Audit #2365 (b): dashboard_widget_config is JSONB with no foreign key, so a
 * deleted account's id stayed in a widget's `accountIds`. The widget then sent
 * an id that matches nothing and drew an empty chart instead of every account.
 */
describe("Account delete strips the id from dashboard widget config (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let history: ActionHistoryService;
  let userId: string;
  let a: string;
  let b: string;

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "user_preferences",
      "transactions",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    a = (await createTestAccount(db, userId, { name: "A" })).id;
    b = (await createTestAccount(db, userId, { name: "B" })).id;
  });

  it("removes only the deleted id, from every widget slice that names it", async () => {
    const config = {
      spending: { range: "3m", accountIds: [a, b] },
      portfolio: { range: "1y", accountIds: [a] },
      hero: { portfolioAccountIds: [b, a], showReturn: true },
      untouched: { range: "1m", accountIds: [b] },
    };
    await db.query(
      `INSERT INTO user_preferences (user_id, dashboard_widget_config)
       VALUES ($1, $2::jsonb)`,
      [userId, JSON.stringify(config)],
    );

    await withUserContext(userId, () => accounts.delete(userId, a));
    await settlePendingHistoryWrites();

    const [{ dashboard_widget_config: after }] = await db.query(
      `SELECT dashboard_widget_config FROM user_preferences WHERE user_id = $1`,
      [userId],
    );
    expect(after).toEqual({
      spending: { range: "3m", accountIds: [b] },
      portfolio: { range: "1y", accountIds: [] },
      hero: { portfolioAccountIds: [b], showReturn: true },
      untouched: { range: "1m", accountIds: [b] },
    });
  });

  it("does not write the preferences row when no widget names the account", async () => {
    await db.query(
      `INSERT INTO user_preferences (user_id, dashboard_widget_config, updated_at)
       VALUES ($1, $2::jsonb, '2020-01-01')`,
      [userId, JSON.stringify({ spending: { accountIds: [b] } })],
    );

    await withUserContext(userId, () => accounts.delete(userId, a));
    await settlePendingHistoryWrites();

    const [row] = await db.query(
      `SELECT to_char(updated_at, 'YYYY') AS year FROM user_preferences WHERE user_id = $1`,
      [userId],
    );
    expect(row.year).toBe("2020");
  });

  it("undo puts the id back only into slices that still exist and lack it", async () => {
    await db.query(
      `INSERT INTO user_preferences (user_id, dashboard_widget_config)
       VALUES ($1, $2::jsonb)`,
      [
        userId,
        JSON.stringify({
          spending: { accountIds: [a, b] },
          portfolio: { accountIds: [a] },
          hero: { portfolioAccountIds: [a] },
        }),
      ],
    );
    await withUserContext(userId, () => accounts.delete(userId, a));
    // Meanwhile the user removed the portfolio widget and re-picked a for hero.
    await db.query(
      `UPDATE user_preferences SET dashboard_widget_config = $2::jsonb WHERE user_id = $1`,
      [
        userId,
        JSON.stringify({
          spending: { accountIds: [b] },
          hero: { portfolioAccountIds: [a] },
        }),
      ],
    );

    await settlePendingHistoryWrites();
    await withUserContext(userId, () => history.undo(userId));

    const [{ dashboard_widget_config: after }] = await db.query(
      `SELECT dashboard_widget_config FROM user_preferences WHERE user_id = $1`,
      [userId],
    );
    expect(after).toEqual({
      spending: { accountIds: [b, a] },
      hero: { portfolioAccountIds: [a] },
    });
  });
});
