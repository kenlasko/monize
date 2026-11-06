import { BadRequestException, ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import { CreateAccountDto } from "@/accounts/dto/create-account.dto";
import { NetWorthService } from "@/net-worth/net-worth.service";
import * as kindUtil from "@/accounts/account-currency-kind.util";
import { CurrenciesService } from "@/currencies/currencies.service";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";
import { waitForLockWaiters } from "../helpers/race";

/**
 * INV-CRYPTO-001 against real PostgreSQL: the account type and its
 * currency's kind agree (`docs/specs/crypto-accounts.md` section 5, first
 * table), on create and on update, and a refused write leaves nothing behind.
 * Then a CRYPTO wallet's balance reaches net worth as an asset, converted at
 * the coin's stored rate (spec decision 7).
 *
 * BTC and XQZ are CRYPTO currencies with no quote symbol. BTC's BTC->USD
 * rate is stored by the test where one is needed; XQZ is a code no provider
 * quotes, so the unpriced case cannot be answered from the network.
 */
describe("CRYPTO accounts (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let netWorth: NetWorthService;
  let userId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);
  const create = (dto: Partial<CreateAccountDto>) =>
    asUser(() =>
      accounts.create(userId, {
        name: "Account",
        openingBalance: 0,
        ...dto,
      } as CreateAccountDto),
    );
  const accountCount = async () =>
    Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1`,
          [userId],
        )
      )[0].n,
    );
  const reread = (id: string) => db.manager.findOneByOrFail(Account, { id });

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
    netWorth = module.get(NetWorthService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "action_history",
      "exchange_rates",
      "monthly_account_balances",
      "transactions",
      "accounts",
      "user_preferences",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, kind) VALUES
         ('BTC', 'Bitcoin', 'B', 4, 'CRYPTO'),
         ('XQZ', 'Unrated Test Coin', 'Q', 4, 'CRYPTO')
       ON CONFLICT (code) DO UPDATE SET kind = 'CRYPTO'`,
    );
    userId = (await createTestUserDirect(db)).id;
    await db.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'USD')`,
      [userId],
    );
  });

  const NOT_CRYPTO = Object.values(AccountType).filter(
    (t) => t !== AccountType.CRYPTO,
  );

  describe("create", () => {
    it("accepts a CRYPTO account in a CRYPTO currency", async () => {
      const saved = (await create({
        name: "Bitcoin Wallet",
        accountType: AccountType.CRYPTO,
        currencyCode: "BTC",
        openingBalance: 0.0125,
      })) as Account;

      const row = await reread(saved.id);
      expect(row.accountType).toBe(AccountType.CRYPTO);
      expect(row.currencyCode).toBe("BTC");
      expect(Number(row.currentBalance)).toBe(0.0125);
    });

    it("refuses a CRYPTO account in a FIAT currency, writing nothing", async () => {
      await expect(
        create({ accountType: AccountType.CRYPTO, currencyCode: "USD" }),
      ).rejects.toThrow(BadRequestException);
      expect(await accountCount()).toBe(0);
    });

    it.each(NOT_CRYPTO)(
      "refuses a %s account in a CRYPTO currency, writing nothing",
      async (accountType) => {
        await expect(
          create({ accountType, currencyCode: "BTC" }),
        ).rejects.toThrow(
          /BTC is a CRYPTO currency, which a .* account cannot hold/,
        );
        expect(await accountCount()).toBe(0);
      },
    );

    it("refuses an INVESTMENT pair in a CRYPTO currency, writing neither half", async () => {
      await expect(
        create({
          accountType: AccountType.INVESTMENT,
          currencyCode: "BTC",
          createInvestmentPair: true,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(await accountCount()).toBe(0);
    });

    it.each(NOT_CRYPTO.filter((t) => t !== AccountType.INVESTMENT))(
      "accepts a %s account in a FIAT currency",
      async (accountType) => {
        await create({ accountType, currencyCode: "USD" });
        expect(await accountCount()).toBe(1);
      },
    );
  });

  describe("update", () => {
    it("accepts a fresh CHEQUING account re-typed to CRYPTO together with a move to BTC", async () => {
      const { id } = await createTestAccount(db, userId, {
        accountType: "CHEQUING",
        currencyCode: "USD",
      });

      await asUser(() =>
        accounts.update(userId, id, {
          accountType: AccountType.CRYPTO,
          currencyCode: "BTC",
        }),
      );

      const row = await reread(id);
      expect(row.accountType).toBe(AccountType.CRYPTO);
      expect(row.currencyCode).toBe("BTC");
    });

    it("refuses a CRYPTO account moved to a FIAT currency, leaving the row as it was", async () => {
      const { id } = await createTestAccount(db, userId, {
        accountType: "CRYPTO",
        currencyCode: "BTC",
      });

      await expect(
        asUser(() => accounts.update(userId, id, { currencyCode: "USD" })),
      ).rejects.toThrow(BadRequestException);
      expect((await reread(id)).currencyCode).toBe("BTC");
    });

    it("refuses a FIAT account re-typed to CRYPTO in its fiat currency", async () => {
      const { id } = await createTestAccount(db, userId, {
        accountType: "CHEQUING",
        currencyCode: "USD",
      });

      await expect(
        asUser(() =>
          accounts.update(userId, id, { accountType: AccountType.CRYPTO }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect((await reread(id)).accountType).toBe(AccountType.CHEQUING);
    });

    it("refuses a CRYPTO account re-typed to CHEQUING in its coin", async () => {
      const { id } = await createTestAccount(db, userId, {
        accountType: "CRYPTO",
        currencyCode: "BTC",
      });

      await expect(
        asUser(() =>
          accounts.update(userId, id, { accountType: AccountType.CHEQUING }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect((await reread(id)).accountType).toBe(AccountType.CRYPTO);
    });

    it.each(NOT_CRYPTO)(
      "refuses a %s account moved to a CRYPTO currency, leaving the row as it was",
      async (accountType) => {
        const { id } = await createTestAccount(db, userId, {
          accountType,
          currencyCode: "USD",
        });

        await expect(
          asUser(() => accounts.update(userId, id, { currencyCode: "BTC" })),
        ).rejects.toThrow(/BTC is a CRYPTO currency/);
        const row = await reread(id);
        expect(row.currencyCode).toBe("USD");
        expect(row.accountType).toBe(accountType);
      },
    );

    it("refuses an INVESTMENT pair moved to a CRYPTO currency, mirroring nothing to the partner", async () => {
      const { cashAccount, brokerageAccount } = (await create({
        name: "Brokerage",
        accountType: AccountType.INVESTMENT,
        currencyCode: "USD",
        createInvestmentPair: true,
      })) as { cashAccount: Account; brokerageAccount: Account };

      await expect(
        asUser(() =>
          accounts.update(userId, cashAccount.id, { currencyCode: "BTC" }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect((await reread(cashAccount.id)).currencyCode).toBe("USD");
      expect((await reread(brokerageAccount.id)).currencyCode).toBe("USD");
    });

    it("never pairs a CRYPTO account: a pair half re-typed to CRYPTO in BTC is refused", async () => {
      const { cashAccount, brokerageAccount } = (await create({
        name: "Brokerage",
        accountType: AccountType.INVESTMENT,
        currencyCode: "USD",
        createInvestmentPair: true,
      })) as { cashAccount: Account; brokerageAccount: Account };

      await expect(
        asUser(() =>
          accounts.update(userId, cashAccount.id, {
            accountType: AccountType.CRYPTO,
            currencyCode: "BTC",
          }),
        ),
      ).rejects.toThrow(/which a INVESTMENT account cannot hold/);
      const cash = await reread(cashAccount.id);
      expect(cash.accountType).toBe(AccountType.INVESTMENT);
      expect(cash.currencyCode).toBe("USD");
      expect((await reread(brokerageAccount.id)).currencyCode).toBe("USD");
    });
  });

  describe("net worth", () => {
    it("counts a CRYPTO wallet's balance as an asset, converted at the coin's stored rate", async () => {
      await createTestAccount(db, userId, {
        name: "Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      });
      await createTestAccount(db, userId, {
        name: "Bitcoin Wallet",
        accountType: "CRYPTO",
        currencyCode: "BTC",
        openingBalance: 0.0125,
        currentBalance: 0.0125,
      });
      // BTC sorts before USD: the canonical orientation is BTC->USD.
      await db.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
         VALUES ('BTC', 'USD', CURRENT_DATE, 100000, 'test')`,
      );
      await asUser(() => netWorth.recalculateAllAccounts(userId));

      const summary = await asUser(() => accounts.getSummary(userId));
      // 1,000.00 + 0.0125 BTC * 100,000 = 2,250.00 USD.
      expect(summary.fxComplete).toBe(true);
      expect(summary.totalAssets).toBe(2250);
      expect(summary.totalLiabilities).toBe(0);
      expect(summary.netWorth).toBe(2250);

      const months = await asUser(() => netWorth.getMonthlyNetWorth(userId));
      const latest = months[months.length - 1];
      expect(latest.byAccountType[AccountType.CRYPTO]).toBe(1250);
      expect(latest.assets).toBe(2250);
    });

    it("leaves an unpriced coin out of the total rather than counting it at 1 or 0", async () => {
      await createTestAccount(db, userId, {
        name: "Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      });
      await createTestAccount(db, userId, {
        name: "Coin Wallet",
        accountType: "CRYPTO",
        currencyCode: "XQZ",
        openingBalance: 0.0125,
        currentBalance: 0.0125,
      });
      await asUser(() => netWorth.recalculateAllAccounts(userId));

      const summary = await asUser(() => accounts.getSummary(userId));
      expect(summary.fxComplete).toBe(false);
      expect(summary.totalAssets).toBeNull();
      expect(summary.knownAssetsSubtotal).toBe(1000);
      expect(summary.missingRatePairs).toEqual(["XQZ->USD"]);
    });
  });

  /**
   * VER-002: the kind read and the kind change serialize on the currencies
   * row. An account writer reads the kind FOR KEY SHARE; the kind gate locks
   * the row FOR UPDATE and checks for references in a later statement. Each
   * case pins one interleaving on two real connections, holding one side
   * inside its transaction (a spy between its lock and its commit) until the
   * other is lock-blocked: whichever went first, the second is refused and no
   * mismatched account commits. With a plain read of the kind, both commit.
   */
  describe("a kind change racing an account write", () => {
    const CODE = "ZQK";
    let currencies: CurrenciesService;

    const kindOf = async () =>
      (await db.query(`SELECT kind FROM currencies WHERE code = $1`, [CODE]))[0]
        .kind as string;
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };

    beforeEach(async () => {
      currencies = new CurrenciesService(db, {} as FxProviderChain);
      await db.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, kind, created_by_user_id)
         VALUES ($1, 'Race Test Currency', 'Z', 2, 'FIAT', $2)
         ON CONFLICT (code) DO UPDATE
           SET kind = 'FIAT', quote_symbol = NULL, created_by_user_id = $2`,
        [CODE, userId],
      );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("refuses the account write that waited on a kind change to CRYPTO", async () => {
      const held = gate();
      const go = gate();
      const service = currencies as unknown as {
        isReferencedByData: (...args: unknown[]) => Promise<boolean>;
      };
      const original = service.isReferencedByData.bind(currencies);
      // The kind change holds the currencies row FOR UPDATE here, between
      // its lock and its reference check.
      jest
        .spyOn(service, "isReferencedByData")
        .mockImplementationOnce(async (...args: unknown[]) => {
          held.open();
          await go.opened;
          return original(...args);
        });

      const kindChange = asUser(() =>
        currencies.update(userId, CODE, { kind: "CRYPTO" }),
      );
      kindChange.catch(() => undefined);
      await held.opened;

      let accountSettled = false;
      const accountWrite = create({
        accountType: AccountType.CHEQUING,
        currencyCode: CODE,
      }).finally(() => {
        accountSettled = true;
      });
      accountWrite.catch(() => undefined);
      await waitForLockWaiters(db, 1, { stop: () => accountSettled });
      go.open();

      const [kindResult, accountResult] = await Promise.allSettled([
        kindChange,
        accountWrite,
      ]);
      expect(kindResult.status).toBe("fulfilled");
      expect(accountResult.status).toBe("rejected");
      expect((accountResult as PromiseRejectedResult).reason).toBeInstanceOf(
        BadRequestException,
      );
      expect(await kindOf()).toBe("CRYPTO");
      expect(await accountCount()).toBe(0);
    });

    it("refuses the kind change that waited on an account write in the old kind", async () => {
      const held = gate();
      const go = gate();
      const original = kindUtil.assertAccountCurrencyKindIn;
      // The account writer holds the currencies row FOR KEY SHARE here, after
      // its kind read and before its INSERT.
      jest
        .spyOn(kindUtil, "assertAccountCurrencyKindIn")
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          held.open();
          await go.opened;
        });

      const accountWrite = create({
        accountType: AccountType.CHEQUING,
        currencyCode: CODE,
      });
      accountWrite.catch(() => undefined);
      await held.opened;

      let kindSettled = false;
      const kindChange = asUser(() =>
        currencies.update(userId, CODE, { kind: "CRYPTO" }),
      ).finally(() => {
        kindSettled = true;
      });
      kindChange.catch(() => undefined);
      await waitForLockWaiters(db, 1, { stop: () => kindSettled });
      go.open();

      const [accountResult, kindResult] = await Promise.allSettled([
        accountWrite,
        kindChange,
      ]);
      expect(accountResult.status).toBe("fulfilled");
      expect(kindResult.status).toBe("rejected");
      expect((kindResult as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(await kindOf()).toBe("FIAT");
      expect(await accountCount()).toBe(1);
    });
  });
});
