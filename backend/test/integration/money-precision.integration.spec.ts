import { BadRequestException, ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource, EntityManager } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { AccountsService } from "@/accounts/accounts.service";
import { convertRowToTransfer } from "@/transactions/convert-to-transfer";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { CurrenciesService } from "@/currencies/currencies.service";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";
import { waitForLockWaiters } from "../helpers/race";

/**
 * Money at eight places, rounded per currency (`docs/specs/money-precision.md`
 * sections 5 and 6, INV-MONEY-001) against real PostgreSQL: a BTC wallet
 * (`decimal_places` 8) keeps satoshis on create, update, split, transfer and
 * convert-to-transfer, and refuses a ninth place; a CAD account (2 places,
 * money precision 4) accepts what it always has and still refuses a fifth. A
 * refused write leaves every row and balance as it was.
 *
 * Amounts are read back with `::text`, so a value is compared as PostgreSQL
 * stores it (`NUMERIC(24,8)`), not as a double.
 */
describe("Money precision per currency (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let service: TransactionsService;
  let accounts: AccountsService;
  let userId: string;
  let walletId: string;
  let secondWalletId: string;
  let chequingId: string;
  let feesId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  const storedAmount = async (id: string): Promise<string> =>
    (
      await db.query(
        `SELECT amount::text AS amount FROM transactions WHERE id = $1`,
        [id],
      )
    )[0].amount;
  const balance = async (accountId: string): Promise<string> =>
    (
      await db.query(
        `SELECT current_balance::text AS b FROM accounts WHERE id = $1`,
        [accountId],
      )
    )[0].b;
  const rowCount = async (accountId: string): Promise<number> =>
    Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM transactions WHERE account_id = $1`,
          [accountId],
        )
      )[0].n,
    );

  const createIn = (
    accountId: string,
    currencyCode: string,
    amount: number,
    extra: Record<string, unknown> = {},
  ) =>
    asUser(() =>
      service.create(userId, {
        accountId,
        transactionDate: "2026-01-15",
        amount,
        currencyCode,
        ...extra,
      } as never),
    );

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    db = module.get(DataSource);
    service = module.get(TransactionsService);
    accounts = module.get(AccountsService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "action_history",
      "transaction_splits",
      "transactions",
      "exchange_rates",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('CAD', 'Canadian Dollar', '$', 2)
       ON CONFLICT (code) DO UPDATE SET decimal_places = 2`,
    );
    // No quote symbol: nothing is asked of a provider; the rate a conversion
    // needs is stored by the test that needs it.
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, kind) VALUES
         ('BTC', 'Bitcoin', 'B', 8, 'CRYPTO')
       ON CONFLICT (code) DO UPDATE SET kind = 'CRYPTO', decimal_places = 8`,
    );
    userId = (await createTestUserDirect(db)).id;
    const wallet = (name: string) =>
      createTestAccount(db, userId, {
        name,
        accountType: "CRYPTO",
        currencyCode: "BTC",
        openingBalance: 0,
        currentBalance: 0,
      });
    walletId = (await wallet("Bitcoin Wallet")).id;
    secondWalletId = (await wallet("Cold Storage")).id;
    chequingId = (
      await createTestAccount(db, userId, {
        name: "Primary Chequing",
        currencyCode: "CAD",
        openingBalance: 5000,
        currentBalance: 5000,
      })
    ).id;
    feesId = (await createTestCategory(db, userId, { name: "Network fee" })).id;
  });

  describe("create", () => {
    it("stores a 2,500-sat BTC fee exactly and moves the wallet by it", async () => {
      const tx = await createIn(walletId, "BTC", -0.000025);

      expect(await storedAmount(tx.id)).toBe("-0.00002500");
      expect(await balance(walletId)).toBe("-0.00002500");
    });

    it("refuses a BTC amount with a ninth place and writes nothing", async () => {
      await expect(createIn(walletId, "BTC", -0.000025001)).rejects.toThrow(
        /BTC carries \(8\)/,
      );
      expect(await rowCount(walletId)).toBe(0);
      expect(await balance(walletId)).toBe("0.00000000");
    });

    it("accepts a CAD amount at three places and still refuses five", async () => {
      const tx = await createIn(chequingId, "CAD", 12.345);
      expect(await storedAmount(tx.id)).toBe("12.34500000");

      await expect(createIn(chequingId, "CAD", 12.34567)).rejects.toThrow(
        /CAD carries \(4\)/,
      );
      expect(await rowCount(chequingId)).toBe(1);
      expect(await balance(chequingId)).toBe("5012.34500000");
    });
  });

  describe("update", () => {
    it("moves the wallet by a one-satoshi edit, and a refused ninth place leaves the row", async () => {
      const tx = await createIn(walletId, "BTC", -0.000025);

      await asUser(() =>
        service.update(userId, tx.id, { amount: -0.00002501 } as never),
      );
      expect(await storedAmount(tx.id)).toBe("-0.00002501");
      expect(await balance(walletId)).toBe("-0.00002501");

      await expect(
        asUser(() =>
          service.update(userId, tx.id, { amount: -0.000025011 } as never),
        ),
      ).rejects.toThrow(/BTC carries \(8\)/);
      expect(await storedAmount(tx.id)).toBe("-0.00002501");
      expect(await balance(walletId)).toBe("-0.00002501");
    });

    it("still refuses a CAD amount at five places, leaving the row", async () => {
      const tx = await createIn(chequingId, "CAD", -42.5);

      await expect(
        asUser(() =>
          service.update(userId, tx.id, { amount: -42.50001 } as never),
        ),
      ).rejects.toThrow(/CAD carries \(4\)/);
      expect(await storedAmount(tx.id)).toBe("-42.50000000");
      expect(await balance(chequingId)).toBe("4957.50000000");
    });
  });

  describe("split", () => {
    const networkFeeSale = (fee: number) =>
      createIn(walletId, "BTC", -0.005025, {
        description: "Sold bitcoin",
        splits: [
          {
            transferAccountId: chequingId,
            amount: -0.005,
            transferTargetAmount: 650,
            memo: "Sold bitcoin",
          },
          { categoryId: feesId, amount: fee, memo: "Network fee" },
        ],
      });

    it("balances -0.00502500 as -0.00500000 and -0.00002500, and stores the wallet balance exactly", async () => {
      const parent = await networkFeeSale(-0.000025);

      expect(await storedAmount(parent.id)).toBe("-0.00502500");
      const lines: Array<{ kind: string; amount: string }> = await db.query(
        `SELECT kind, amount::text AS amount FROM transaction_splits
          WHERE transaction_id = $1 ORDER BY kind`,
        [parent.id],
      );
      expect(lines).toEqual([
        { kind: "category", amount: "-0.00002500" },
        { kind: "transfer", amount: "-0.00500000" },
      ]);
      // The counterpart is what arrived, as stated, at its implied rate.
      const leg = await db.manager.findOneOrFail(Transaction, {
        where: { accountId: chequingId },
      });
      expect(await storedAmount(leg.id)).toBe("650.00000000");
      expect(Number(leg.exchangeRate)).toBe(130000);

      expect(await balance(walletId)).toBe("-0.00502500");
      expect(await balance(chequingId)).toBe("5650.00000000");
    });

    it("refuses a fee line a satoshi short of the parent and writes nothing", async () => {
      await expect(networkFeeSale(-0.00002499)).rejects.toThrow(
        /must equal transaction amount/,
      );
      expect(await rowCount(walletId)).toBe(0);
      expect(await rowCount(chequingId)).toBe(0);
      expect(await balance(walletId)).toBe("0.00000000");
      expect(await balance(chequingId)).toBe("5000.00000000");
    });

    it("refuses a replacement line with a ninth place, leaving the split as it was", async () => {
      const parent = await networkFeeSale(-0.000025);

      await expect(
        asUser(() =>
          service.updateSplits(userId, parent.id, [
            {
              transferAccountId: chequingId,
              amount: -0.005,
              transferTargetAmount: 650,
            },
            { categoryId: feesId, amount: -0.000024999 },
            { categoryId: feesId, amount: -0.000000001 },
          ] as never),
        ),
      ).rejects.toThrow(/splits\[1\]\.amount/);

      const lines: Array<{ amount: string }> = await db.query(
        `SELECT amount::text AS amount FROM transaction_splits
          WHERE transaction_id = $1 ORDER BY kind`,
        [parent.id],
      );
      // category first, then transfer
      expect(lines.map((l) => l.amount)).toEqual([
        "-0.00002500",
        "-0.00500000",
      ]);
      expect(await balance(walletId)).toBe("-0.00502500");
      expect(await balance(chequingId)).toBe("5650.00000000");
    });
  });

  describe("transfer", () => {
    beforeEach(async () => {
      // Coin-first, as rates are stored: BTC->CAD 136000.1234567890.
      await db.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
         VALUES ('BTC', 'CAD', '2026-01-15', 136000.1234567890, 'test')`,
      );
    });

    const transfer = (extra: Record<string, unknown> = {}) =>
      asUser(() =>
        service.createTransfer(userId, {
          fromAccountId: chequingId,
          toAccountId: walletId,
          transactionDate: "2026-01-15",
          amount: 1700,
          ...extra,
        } as never),
      );

    it("converts 1,700 CAD into BTC at eight places when no amount arrived is stated", async () => {
      const { toTransaction } = await transfer();

      // 1700 CAD at the inverse of 136000.1234567890, kept to the satoshi:
      // four places would have stored 0.0125.
      expect(await storedAmount(toTransaction.id)).toBe("0.01249993");
      expect(await balance(walletId)).toBe("0.01249993");
      expect(await balance(chequingId)).toBe("3300.00000000");
    });

    it("stores a stated BTC amount as given, and refuses a ninth place writing no leg", async () => {
      const { toTransaction } = await transfer({ toAmount: 0.01249993 });
      expect(await storedAmount(toTransaction.id)).toBe("0.01249993");
      expect(Number(toTransaction.exchangeRate)).toBe(0.0000073529);

      await expect(transfer({ toAmount: 0.012499931 })).rejects.toThrow(
        /toAmount/,
      );
      expect(await rowCount(walletId)).toBe(1);
      expect(await rowCount(chequingId)).toBe(1);
      expect(await balance(walletId)).toBe("0.01249993");
    });

    it("moves satoshis between two wallets and refuses an edit with a ninth place", async () => {
      const { fromTransaction, toTransaction } = await asUser(() =>
        service.createTransfer(userId, {
          fromAccountId: walletId,
          toAccountId: secondWalletId,
          transactionDate: "2026-01-15",
          amount: 0.000025,
        } as never),
      );
      expect(await storedAmount(fromTransaction.id)).toBe("-0.00002500");
      expect(await storedAmount(toTransaction.id)).toBe("0.00002500");

      await expect(
        asUser(() =>
          service.updateTransfer(userId, fromTransaction.id, {
            amount: 0.000025001,
          }),
        ),
      ).rejects.toThrow(/BTC carries \(8\)/);
      expect(await storedAmount(fromTransaction.id)).toBe("-0.00002500");
      expect(await balance(walletId)).toBe("-0.00002500");
      expect(await balance(secondWalletId)).toBe("0.00002500");
    });
  });

  describe("convert to transfer", () => {
    const convert = (rowId: string, targetId: string, expected?: number) =>
      asUser(() =>
        withScopedDb(db, (m) =>
          convertRowToTransfer(m, accounts, userId, rowId, targetId, {
            clearCategory: true,
            expectedCounterpartAmount: expected,
          }),
        ),
      );

    it("creates the counterpart with the row's satoshis", async () => {
      const row = await createIn(walletId, "BTC", -0.000025);

      const { counterpartId } = await convert(row.id, secondWalletId, 0.000025);

      expect(await storedAmount(counterpartId)).toBe("0.00002500");
      expect(await balance(secondWalletId)).toBe("0.00002500");
      expect(await balance(walletId)).toBe("-0.00002500");
    });

    it("refuses a planned amount a satoshi off and writes nothing", async () => {
      const row = await createIn(walletId, "BTC", -0.000025);

      await expect(
        convert(row.id, secondWalletId, 0.00002501),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: "CONVERT_TO_TRANSFER_REFUSED",
        }),
      });
      expect(await rowCount(secondWalletId)).toBe(0);
      expect(await balance(secondWalletId)).toBe("0.00000000");
      const reread = await db.manager.findOneByOrFail(Transaction, {
        id: row.id,
      });
      expect(reread.isTransfer).toBe(false);
      expect(reread.linkedTransactionId).toBeNull();
    });
  });

  describe("a decimal-places lowering racing a write", () => {
    // The lowering gate (`CurrenciesService.assertDecimalPlacesFit`) locks the
    // currency row FOR UPDATE and then scans stored amounts; a writer reads
    // `decimal_places` FOR KEY SHARE inside its transaction
    // (`loadCurrencyPlaces`). Whichever takes the row first, the other waits,
    // and exactly one of them is refused: never an eight-place BTC row under a
    // four-place BTC.
    let currencies: CurrenciesService;

    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const btcPlaces = async (): Promise<number> =>
      Number(
        (
          await db.query(
            `SELECT decimal_places FROM currencies WHERE code = 'BTC'`,
          )
        )[0].decimal_places,
      );
    /** No stored BTC amount carries more places than BTC's money precision. */
    const expectConsistent = async () => {
      const [{ fitting }] = await db.query(
        `SELECT currency_min_decimal_places_in_use('BTC') AS fitting`,
      );
      expect(Number(fitting ?? 0)).toBeLessThanOrEqual(
        Math.max(4, await btcPlaces()),
      );
    };
    /**
     * Pause the first statement on any scoped manager whose SQL matches,
     * until `go` opens; `held` opens once it has run (`after`) or is about to
     * (`before`). The production code offers no hook between its lock and
     * what follows, so the statement itself is the seam.
     */
    const pauseOn = (
      matches: (sql: string) => boolean,
      when: "before" | "after",
    ) => {
      const held = gate();
      const go = gate();
      const original = EntityManager.prototype.query;
      let paused = false;
      jest
        .spyOn(EntityManager.prototype, "query")
        .mockImplementation(async function (
          this: EntityManager,
          sql: string,
          params?: unknown[],
        ) {
          if (paused || !matches(String(sql))) {
            return original.call(this, sql, params);
          }
          paused = true;
          if (when === "before") {
            held.open();
            await go.opened;
            return original.call(this, sql, params);
          }
          const result = await original.call(this, sql, params);
          held.open();
          await go.opened;
          return result;
        });
      return { held, go };
    };
    const lowerToFour = () =>
      asUser(() => currencies.update(userId, "BTC", { decimalPlaces: 4 }));

    beforeEach(async () => {
      currencies = new CurrenciesService(db, {} as FxProviderChain);
      // A system currency's places are not editable; the user's own coin is.
      await db.query(
        `UPDATE currencies SET created_by_user_id = $1 WHERE code = 'BTC'`,
        [userId],
      );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("refuses the write that waited on a lowering, at the new places", async () => {
      // The gate holds BTC FOR UPDATE here, between its lock and its scan.
      const { held, go } = pauseOn(
        (sql) => sql.includes("currency_min_decimal_places_in_use"),
        "before",
      );
      const lowering = lowerToFour();
      lowering.catch(() => undefined);
      await held.opened;

      let writeSettled = false;
      const write = createIn(walletId, "BTC", -0.12345678).finally(() => {
        writeSettled = true;
      });
      write.catch(() => undefined);
      await waitForLockWaiters(db, 1, { stop: () => writeSettled });
      go.open();

      const [loweringResult, writeResult] = await Promise.allSettled([
        lowering,
        write,
      ]);
      expect(loweringResult.status).toBe("fulfilled");
      expect(writeResult.status).toBe("rejected");
      const reason = (writeResult as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(BadRequestException);
      expect(String(reason.message)).toMatch(/BTC carries \(4\)/);
      expect(await btcPlaces()).toBe(4);
      expect(await rowCount(walletId)).toBe(0);
      expect(await balance(walletId)).toBe("0.00000000");
      await expectConsistent();
    });

    it("refuses the lowering that waited on a write at the old places", async () => {
      // The writer holds BTC FOR KEY SHARE here, after its places read and
      // before its INSERT.
      const { held, go } = pauseOn(
        (sql) =>
          sql.includes("decimal_places FROM currencies") &&
          sql.includes("FOR KEY SHARE"),
        "after",
      );
      const write = createIn(walletId, "BTC", -0.12345678);
      write.catch(() => undefined);
      await held.opened;

      let loweringSettled = false;
      const lowering = lowerToFour().finally(() => {
        loweringSettled = true;
      });
      lowering.catch(() => undefined);
      await waitForLockWaiters(db, 1, { stop: () => loweringSettled });
      go.open();

      const [writeResult, loweringResult] = await Promise.allSettled([
        write,
        lowering,
      ]);
      expect(writeResult.status).toBe("fulfilled");
      expect(loweringResult.status).toBe("rejected");
      expect((loweringResult as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
      expect(await btcPlaces()).toBe(8);
      const tx = (writeResult as PromiseFulfilledResult<Transaction>).value;
      expect(await storedAmount(tx.id)).toBe("-0.12345678");
      expect(await balance(walletId)).toBe("-0.12345678");
      await expectConsistent();
    });
  });

  describe("moving a row to an account in another currency", () => {
    let usdId: string;

    beforeEach(async () => {
      await db.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
           ('USD', 'US Dollar', '$', 2)
         ON CONFLICT (code) DO UPDATE SET decimal_places = 2`,
      );
      usdId = (
        await createTestAccount(db, userId, {
          name: "US Chequing",
          currencyCode: "USD",
          openingBalance: 0,
          currentBalance: 0,
        })
      ).id;
    });

    it("refuses carrying a -0.12345678 BTC row into a USD account, moving no balance", async () => {
      const tx = await createIn(walletId, "BTC", -0.12345678);

      await expect(
        asUser(() =>
          service.update(userId, tx.id, { accountId: usdId } as never),
        ),
      ).rejects.toThrow(/USD carries \(4\)/);
      expect(await storedAmount(tx.id)).toBe("-0.12345678");
      expect(await rowCount(usdId)).toBe(0);
      expect(await balance(walletId)).toBe("-0.12345678");
      expect(await balance(usdId)).toBe("0.00000000");
    });

    it("still moves a row at four places", async () => {
      const tx = await createIn(walletId, "BTC", -0.1234);

      await asUser(() =>
        service.update(userId, tx.id, { accountId: usdId } as never),
      );
      expect(await rowCount(usdId)).toBe(1);
      expect(await balance(walletId)).toBe("0.00000000");
      expect(await balance(usdId)).toBe("-0.12340000");
    });
  });
});
