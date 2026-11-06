import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * A cross-currency transfer line of a split posts what the user says arrived
 * (`transferTargetAmount`) at its implied rate, and both reads the transaction
 * form opens a split from -- `findOne` and the register's row query -- carry
 * that counterpart amount back, so an unedited re-save sends it again rather
 * than re-converting the line.
 *
 * The target account is in ZZZ, a currency no rate provider quotes, so no
 * USD->ZZZ rate exists or can be fetched: a line converted at the market rate
 * is refused, which is what proves a stated or carried figure, not a market
 * rate, is what posted. (A real currency made this depend on the network: with
 * a provider reachable, the in-transaction lookup fetched and stored rates.)
 */
describe("Split transfer received amount (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let usdId: string;
  let foreignId: string;
  let categoryId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    // An update records its undo entry without awaiting it; the last test's
    // must land before the connection closes.
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
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
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('USD', 'US Dollar', '$', 2),
         ('ZZZ', 'Unrated Test Currency', 'Z', 2)
       ON CONFLICT DO NOTHING`,
    );
    // A coin no provider is asked about here (no quote symbol), so only a
    // stated received amount can post a BTC line to USD.
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, kind) VALUES
         ('BTC', 'Bitcoin', 'B', 4, 'CRYPTO')
       ON CONFLICT (code) DO UPDATE SET kind = 'CRYPTO'`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    usdId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    foreignId = (
      await createTestAccount(dataSource, userId, {
        name: "Foreign Savings",
        currencyCode: "ZZZ",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    categoryId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
  });

  const splitsWith = (memo: string) => [
    { categoryId, amount: -60 },
    {
      transferAccountId: foreignId,
      amount: -40,
      transferTargetAmount: 35.5,
      memo,
    },
  ];

  async function createSplit(): Promise<Transaction> {
    return withUserContext(userId, () =>
      service.create(userId, {
        accountId: usdId,
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        splits: splitsWith("To Europe"),
      }),
    );
  }

  async function counterpart(): Promise<Transaction> {
    return dataSource.manager.findOneOrFail(Transaction, {
      where: { accountId: foreignId },
    });
  }

  it("posts the stated received amount at its implied rate", async () => {
    await createSplit();

    const leg = await counterpart();
    expect(Number(leg.amount)).toBe(35.5);
    expect(leg.currencyCode).toBe("ZZZ");
    expect(Number(leg.exchangeRate)).toBe(0.8875);
    const eur = await dataSource.manager.findOneByOrFail(Account, {
      id: foreignId,
    });
    expect(Number(eur.currentBalance)).toBe(35.5);
  });

  it("returns the received amount from findOne and from the register", async () => {
    const created = await createSplit();

    const one = await withUserContext(userId, () =>
      service.findOne(userId, created.id),
    );
    const transferLine = one.splits.find(
      (s) => s.transferAccountId === foreignId,
    );
    expect(Number(transferLine?.linkedTransaction?.amount)).toBe(35.5);

    const page = await withUserContext(userId, () =>
      service.findAll(userId, [usdId]),
    );
    const row = page.data.find((tx) => tx.id === created.id);
    const registerLine = row?.splits?.find(
      (s) => s.transferAccountId === foreignId,
    );
    expect(Number(registerLine?.linkedTransaction?.amount)).toBe(35.5);
    expect(registerLine?.linkedTransaction?.currencyCode).toBe("ZZZ");
  });

  it("keeps the recorded received amount when a re-save omits it", async () => {
    // What an AI or MCP split edit sends: the lines, no received amounts. No
    // USD->ZZZ rate is stored, so a re-conversion would be refused outright.
    const created = await createSplit();
    const withoutReceived = splitsWith("Renamed").map(
      ({ transferTargetAmount: _omitted, ...line }) => line,
    );

    await withUserContext(userId, () =>
      service.update(userId, created.id, { splits: withoutReceived }),
    );
    expect(Number((await counterpart()).amount)).toBe(35.5);

    await withUserContext(userId, () =>
      service.updateSplits(userId, created.id, withoutReceived),
    );
    const leg = await counterpart();
    expect(Number(leg.amount)).toBe(35.5);
    expect(Number(leg.exchangeRate)).toBe(0.8875);
  });

  it("re-converts a line whose amount changed rather than carrying its old figure", async () => {
    const created = await createSplit();

    // A changed line is not the recorded one; with no rate stored, the
    // re-conversion is refused instead of reusing 35.50 for 50.00.
    await expect(
      withUserContext(userId, () =>
        service.update(userId, created.id, {
          splits: [
            { categoryId, amount: -50 },
            { transferAccountId: foreignId, amount: -50 },
          ],
        }),
      ),
    ).rejects.toThrow(/exchange rate/i);
    expect(Number((await counterpart()).amount)).toBe(35.5);
  });

  it("carries nothing once the parent moves to another account", async () => {
    // Another USD account: same currency, but the recorded figure belonged to
    // the old account's transfer, so the line is re-converted -- and with no
    // USD->ZZZ rate stored, refused rather than posted at the old figure.
    const created = await createSplit();
    const otherUsdId = (
      await createTestAccount(dataSource, userId, { name: "Second chequing" })
    ).id;
    const withoutReceived = splitsWith("Moved").map(
      ({ transferTargetAmount: _omitted, ...line }) => line,
    );

    await expect(
      withUserContext(userId, () =>
        service.update(userId, created.id, {
          accountId: otherUsdId,
          splits: withoutReceived,
        }),
      ),
    ).rejects.toThrow(/exchange rate/i);
    expect(Number((await counterpart()).amount)).toBe(35.5);
  });

  it("gives a joint reader's register rows no counterpart either", async () => {
    await createSplit();
    const reader = (await createTestUserDirect(dataSource)).id;

    const page = await withUserContext(reader, () =>
      service.findAll(
        reader,
        [usdId],
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        50,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "date",
        "DESC",
        undefined,
        undefined,
        undefined,
        [usdId],
      ),
    );
    const line = page.data
      .flatMap((tx) => tx.splits ?? [])
      .find((s) => s.transferAccountId === foreignId);
    expect(line).toBeDefined();
    expect(line?.linkedTransaction ?? null).toBeNull();
  });

  it("gives a joint reader no counterpart of the owner's split lines", async () => {
    const created = await createSplit();
    const reader = (await createTestUserDirect(dataSource)).id;

    const seen = await withUserContext(reader, () =>
      service.findOne(reader, created.id, [usdId]),
    );
    const transferLine = seen.splits.find(
      (s) => s.transferAccountId === foreignId,
    );
    expect(transferLine).toBeDefined();
    expect(transferLine?.linkedTransaction ?? null).toBeNull();
  });

  it("posts a CRYPTO wallet's sale with a network-fee line: both legs and the balance deltas (crypto-accounts spec decision 9)", async () => {
    // Spec section 6, "Transfer with fee" sold to fiat: the split on the
    // wallet totals -0.0051 BTC, its transfer line -0.0050 BTC delivered
    // 650.00 USD, and its category line -0.0001 BTC is the fee.
    const walletId = (
      await createTestAccount(dataSource, userId, {
        name: "Bitcoin Wallet",
        accountType: "CRYPTO",
        currencyCode: "BTC",
        openingBalance: 0.0125,
        currentBalance: 0.0125,
      })
    ).id;
    const feeCategoryId = (
      await createTestCategory(dataSource, userId, { name: "Network fee" })
    ).id;

    const created = await withUserContext(userId, () =>
      service.create(userId, {
        accountId: walletId,
        transactionDate: "2026-01-15",
        amount: -0.0051,
        currencyCode: "BTC",
        description: "Sold bitcoin",
        splits: [
          {
            transferAccountId: usdId,
            amount: -0.005,
            transferTargetAmount: 650,
            memo: "Sold bitcoin",
          },
          { categoryId: feeCategoryId, amount: -0.0001, memo: "Network fee" },
        ],
      }),
    );

    // The wallet leg: one parent in BTC, two lines that sum to it.
    const parent = await dataSource.manager.findOneByOrFail(Transaction, {
      id: created.id,
    });
    expect(parent.currencyCode).toBe("BTC");
    expect(Number(parent.amount)).toBe(-0.0051);
    const lines: Array<{ kind: string; amount: string }> =
      await dataSource.query(
        `SELECT kind, amount FROM transaction_splits WHERE transaction_id = $1 ORDER BY kind`,
        [created.id],
      );
    expect(lines.map((l) => [l.kind, Number(l.amount)])).toEqual([
      ["category", -0.0001],
      ["transfer", -0.005],
    ]);

    // The chequing leg: what arrived, in USD, at the implied rate
    // roundFxRate(650 / 0.005) = 130000.
    const leg = await dataSource.manager.findOneOrFail(Transaction, {
      where: { accountId: usdId },
    });
    expect(leg.currencyCode).toBe("USD");
    expect(Number(leg.amount)).toBe(650);
    expect(Number(leg.exchangeRate)).toBe(130000);
    expect(leg.isTransfer).toBe(true);

    // Each account moved by its own leg: the wallet by the whole split, fee
    // included; chequing by what it received.
    const wallet = await dataSource.manager.findOneByOrFail(Account, {
      id: walletId,
    });
    expect(Number(wallet.currentBalance)).toBe(0.0074);
    const chequing = await dataSource.manager.findOneByOrFail(Account, {
      id: usdId,
    });
    expect(Number(chequing.currentBalance)).toBe(1650);
  });

  it("keeps the received amount across a re-save that sends it back", async () => {
    const created = await createSplit();

    await withUserContext(userId, () =>
      service.update(userId, created.id, {
        splits: splitsWith("Renamed"),
      }),
    );

    const leg = await counterpart();
    expect(Number(leg.amount)).toBe(35.5);
    expect(Number(leg.exchangeRate)).toBe(0.8875);
    const eur = await dataSource.manager.findOneByOrFail(Account, {
      id: foreignId,
    });
    expect(Number(eur.currentBalance)).toBe(35.5);
  });
});
