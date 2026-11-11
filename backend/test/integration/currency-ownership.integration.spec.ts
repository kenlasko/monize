import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CurrenciesService } from "@/currencies/currencies.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";
import { UsersService } from "@/users/users.service";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * Who owns a currency row, against real PostgreSQL (A26-M17, A26-S09-06,
 * A26-S13-06, A26-M25, A26-S13-05).
 *
 * - A user's action never creates a currency every other user is offered: a known
 *   ISO code becomes an inactive reference row, anything else is the user's own.
 * - Choosing a default currency that has no row yet works on a fresh instance:
 *   the row exists before the preference that points at it is written.
 * - Deleting a user never turns their custom currencies into active system
 *   currencies: an unreferenced one is removed, a referenced one is deactivated.
 *
 * The harness builds tables from the entities, which carry neither
 * `user_preferences.default_currency -> currencies(code)` nor
 * `currencies.created_by_user_id -> users(id) ON DELETE SET NULL` (nor the
 * `user_currency_preferences.user_id -> users(id) ON DELETE CASCADE`); they are
 * added here with the definitions from database/schema.sql and dropped afterwards.
 */
describe("currency ownership (integration)", () => {
  const PASSWORD = "TestPassword123!";

  let module: TestingModule;
  let dataSource: DataSource;
  let currencies: CurrenciesService;
  let users: UsersService;

  const moduleRefStub = {
    get: jest.fn((token: unknown) => {
      if (token === CurrenciesService) return currencies;
      if (token === ExchangeRateService) {
        return { refreshAllRates: jest.fn(() => Promise.resolve()) };
      }
      throw new Error("unexpected module lookup");
    }),
  };

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    currencies = new CurrenciesService(dataSource, {} as FxProviderChain);
    users = new UsersService(
      dataSource,
      { isBreached: jest.fn(() => Promise.resolve(false)) } as never,
      moduleRefStub as never,
      { isDemo: false } as never,
      {} as never,
      {} as never,
      {} as never,
      { get: (_key: string, fallback?: unknown) => fallback } as never,
    );

    await dataSource.query(
      `ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS test_user_preferences_default_currency_fkey`,
    );
    await dataSource.query(
      `ALTER TABLE user_preferences ADD CONSTRAINT test_user_preferences_default_currency_fkey
         FOREIGN KEY (default_currency) REFERENCES currencies(code)`,
    );
    await dataSource.query(
      `ALTER TABLE user_currency_preferences DROP CONSTRAINT IF EXISTS test_ucp_user_id_fkey`,
    );
    await dataSource.query(
      `ALTER TABLE user_currency_preferences ADD CONSTRAINT test_ucp_user_id_fkey
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`,
    );
    await dataSource.query(
      `ALTER TABLE currencies DROP CONSTRAINT IF EXISTS test_currencies_created_by_user_id_fkey`,
    );
    await dataSource.query(
      `ALTER TABLE currencies ADD CONSTRAINT test_currencies_created_by_user_id_fkey
         FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL`,
    );
  });

  afterAll(async () => {
    await cleanTables(dataSource, [
      "user_currency_preferences",
      "user_preferences",
      "currencies",
      "users",
    ]);
    await dataSource.query(
      `ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS test_user_preferences_default_currency_fkey`,
    );
    await dataSource.query(
      `ALTER TABLE user_currency_preferences DROP CONSTRAINT IF EXISTS test_ucp_user_id_fkey`,
    );
    await dataSource.query(
      `ALTER TABLE currencies DROP CONSTRAINT IF EXISTS test_currencies_created_by_user_id_fkey`,
    );
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "user_currency_preferences",
      "user_preferences",
      "currencies",
      "users",
    ]);
    // A fresh instance holds only the bootstrap currency.
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
       VALUES ('USD', 'US Dollar', '$', 2, true, NULL)`,
    );
  });

  const codesOf = async (userId: string, includeInactive = false) =>
    (
      await withUserContext(userId, () =>
        currencies.findAll(userId, includeInactive),
      )
    ).map((c) => c.code);

  const currencyRow = async (code: string) => {
    const rows: Array<{
      is_active: boolean;
      created_by_user_id: string | null;
    }> = await dataSource.query(
      `SELECT is_active, created_by_user_id FROM currencies WHERE code = $1`,
      [code],
    );
    return rows[0];
  };

  const newUser = async () => {
    const user = await createTestUserDirect(dataSource);
    // The default-currency FK needs a preferences row to exist; the app writes
    // it at registration.
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'USD')`,
      [user.id],
    );
    return user;
  };

  it("A26-S13-05: a first default currency other than USD saves on a fresh instance, offered to nobody else", async () => {
    const a = await newUser();
    const b = await newUser();

    const saved = await withUserContext(a.id, () =>
      users.updatePreferences(a.id, { defaultCurrency: "PLN" }),
    );

    expect(saved.defaultCurrency).toBe("PLN");
    expect(await currencyRow("PLN")).toEqual({
      is_active: false,
      created_by_user_id: null,
    });
    expect(await codesOf(a.id)).toContain("PLN");
    expect(await codesOf(b.id)).not.toContain("PLN");
  });

  it("A26-S09-06: a code outside ISO 4217 that a user's action introduces is that user's own currency", async () => {
    const a = await newUser();
    const b = await newUser();

    await withUserContext(a.id, () =>
      currencies.ensureCurrencyForUser(a.id, "ZZZ"),
    );

    expect(await currencyRow("ZZZ")).toEqual({
      is_active: true,
      created_by_user_id: a.id,
    });
    expect(await codesOf(a.id)).toContain("ZZZ");
    expect(await codesOf(b.id)).not.toContain("ZZZ");
    expect(await codesOf(b.id, true)).not.toContain("ZZZ");
  });

  it("A26-S13-06: deleting the creator removes an unreferenced custom currency", async () => {
    const a = await newUser();
    const b = await newUser();
    await withUserContext(a.id, () =>
      currencies.create(a.id, {
        code: "PTS",
        name: "Family Points",
        symbol: "P",
      }),
    );

    await withUserContext(a.id, () =>
      users.deleteAccount(a.id, { password: PASSWORD }),
    );

    expect(await currencyRow("PTS")).toBeUndefined();
    expect(await codesOf(b.id)).not.toContain("PTS");
    expect(await codesOf(b.id, true)).not.toContain("PTS");
  });

  it("A26-S13-06: deleting the creator deactivates a custom currency another user still holds", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    await withUserContext(a.id, () =>
      currencies.create(a.id, {
        code: "PTS",
        name: "Family Points",
        symbol: "P",
      }),
    );
    await withUserContext(b.id, () =>
      currencies.create(b.id, {
        code: "PTS",
        name: "Family Points",
        symbol: "P",
      }),
    );

    await withUserContext(a.id, () =>
      users.deleteAccount(a.id, { password: PASSWORD }),
    );

    expect(await currencyRow("PTS")).toEqual({
      is_active: false,
      created_by_user_id: null,
    });
    expect(await codesOf(b.id)).toContain("PTS");
    expect(await codesOf(c.id)).not.toContain("PTS");
  });

  it("A26-S13-06: a user row deleted directly (the admin path) leaves its referenced currency inactive", async () => {
    const a = await newUser();
    const b = await newUser();
    await withUserContext(a.id, () =>
      currencies.create(a.id, {
        code: "PTS",
        name: "Family Points",
        symbol: "P",
      }),
    );
    await withUserContext(b.id, () =>
      currencies.create(b.id, {
        code: "PTS",
        name: "Family Points",
        symbol: "P",
      }),
    );

    // The harness's user_preferences -> users key has no ON DELETE CASCADE (the
    // schema's does), so the preference row goes first.
    await dataSource.query(`DELETE FROM user_preferences WHERE user_id = $1`, [
      a.id,
    ]);
    await dataSource.query(`DELETE FROM users WHERE id = $1`, [a.id]);

    expect(await currencyRow("PTS")).toEqual({
      is_active: false,
      created_by_user_id: null,
    });
  });

  /**
   * M3: `currencies` is shared and only a coin's creator edits it, so the
   * coin's first price symbol decides the price of every holder's wallet.
   * Refused once another user holds the code, through the real
   * `currency_code_used_by_other_users`.
   */
  describe("a coin's first price symbol", () => {
    const symbolOf = async (code: string) =>
      (
        await dataSource.query(
          `SELECT quote_symbol FROM currencies WHERE code = $1`,
          [code],
        )
      )[0]?.quote_symbol ?? null;

    const addCoin = (userId: string, code: string) =>
      withUserContext(userId, () =>
        currencies.create(userId, {
          code,
          name: "Some Coin",
          symbol: code,
          kind: "CRYPTO",
        }),
      );

    it("is set by the creator of a coin nobody else holds", async () => {
      const a = await newUser();
      await addCoin(a.id, "SOY");

      await withUserContext(a.id, () =>
        currencies.update(a.id, "SOY", { quoteSymbol: "SOL-USD" }),
      );

      expect(await symbolOf("SOY")).toBe("SOL-USD");
    });

    it("is refused once another user holds the coin, and nothing is written", async () => {
      const a = await newUser();
      const b = await newUser();
      await addCoin(a.id, "SOX");
      await addCoin(b.id, "SOX");

      await expect(
        withUserContext(a.id, () =>
          currencies.update(a.id, "SOX", { quoteSymbol: "BTC-USD" }),
        ),
      ).rejects.toThrow(/while other users hold it/);

      expect(await symbolOf("SOX")).toBeNull();
    });
  });
});
