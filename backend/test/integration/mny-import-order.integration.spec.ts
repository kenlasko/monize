import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";

import { HoldingsService } from "@/securities/holdings.service";
import { INVESTMENT_REPLAY_ORDER_SQL } from "@/securities/investment-replay.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  investmentData,
  mnyAccount,
  mnyCurrency,
  mnyDefaults,
  mnyInvestmentDetail,
  mnySecurity,
  mnyTransaction,
  referenceData,
  transactionData,
} from "@/import/mny/__fixtures__/mny-row-builders";
import {
  cashKeyByAccountKey,
  currencyCodesByHandle,
  mapAccounts,
} from "@/import/mny/map/map-reference";
import { mapSecurities } from "@/import/mny/map/map-securities";
import { mapInvestments } from "@/import/mny/map/map-investments";
import { mapTransactions } from "@/import/mny/map/map-transactions";
import {
  applyInvestmentCashSources,
  tradesByHandle,
} from "@/import/mny/map/investment-cash";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "@/import/mny/model/mny-import-options";
import { MNY_ACTION } from "@/import/mny/model/mny-actions";
import { MnyTransaction } from "@/import/mny/model/mny-rows";
import { writeAccounts } from "@/import/mny/writers/write-reference";
import { writeTransactions } from "@/import/mny/writers/write-transactions";
import {
  writeInvestments,
  writeSecurities,
} from "@/import/mny/writers/write-investments";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * S1 for Money: every row one import writes shares `created_at`, so the
 * canonical replay (`INVESTMENT_REPLAY_ORDER`: date, created_at, id) breaks a
 * same-day tie on the row id. Money records no stock split as a share movement
 * (`SEC_SPLIT` is not applied), so the order-sensitive same-day pair here is a
 * sell and a buy: on 100 shares bought at 10, selling 100 and then buying 100
 * at 20 leaves 100 at an average cost of 20; buying first leaves 100 at 15.
 * The ids must put the rows in Money's own order, date then `htrn` (the
 * transaction id Money allocates in entry order), not in random order and not
 * in the physical row order the reader returns.
 *
 * The rows go through the real mappers in the parser's order, the real
 * writers and the canonical holdings rebuild in one scoped transaction, as
 * `MnyImportService.runImport` runs them.
 */
describe("mny import: same-day investment rows replay in Money's order (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;

  const BROKERAGE = 5;
  const SLEEVE = 6;
  // Ten securities, so a random tie-break gets every one right with a chance
  // of 1 in 1024: the case is deterministic in practice before the fix.
  const SECURITIES = 10;
  const securityHandle = (i: number) => 100 + i;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot(INTEGRATION_TYPEORM_OPTIONS),
      ],
    }).compile();
    dataSource = module.get(DataSource);
    userId = (await createTestUserDirect(dataSource)).id;
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('USD', 'USD', '$', 2, true) ON CONFLICT (code) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "holdings",
      "investment_transactions",
      "transaction_splits",
      "transactions",
      "securities",
      "accounts",
    ]);
  });

  const inTransaction = <T>(
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> => withUserContext(userId, () => withScopedDb(dataSource, fn));

  const trade = (
    handle: number,
    security: number,
    date: string,
    action: number,
    amount: number,
  ): MnyTransaction =>
    mnyTransaction({
      handle,
      account: BROKERAGE,
      security,
      date,
      action,
      amount,
    });

  it("folds a same-day sell and buy in htrn order, whatever the physical row order", async () => {
    const reference = referenceData({
      currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
      defaults: mnyDefaults({ defaultCurrency: 1 }),
      accounts: [
        mnyAccount({
          handle: BROKERAGE,
          type: 5,
          name: "Brokerage",
          relatedAccount: SLEEVE,
        }),
        mnyAccount({
          handle: SLEEVE,
          type: 0,
          name: "Brokerage (Cash)",
          relatedAccount: BROKERAGE,
        }),
      ],
    });
    const indices = Array.from({ length: SECURITIES }, (_, i) => i);
    // In the reader's (physical) order the buy comes first, but its htrn is
    // the larger: Money entered the sell first.
    const rows = transactionData({
      transactions: indices.flatMap((i) => [
        trade(1000 + i, securityHandle(i), "2024-01-02", MNY_ACTION.BUY, 1000),
        trade(3000 + i, securityHandle(i), "2024-03-01", MNY_ACTION.BUY, 2000),
        trade(2000 + i, securityHandle(i), "2024-03-01", MNY_ACTION.SELL, 2500),
      ]),
    });
    const tables = investmentData({
      securities: indices.map((i) =>
        mnySecurity({ handle: securityHandle(i), symbol: `S${i}` }),
      ),
      investmentDetails: indices.flatMap((i) => [
        mnyInvestmentDetail({
          transaction: 1000 + i,
          price: 10,
          quantity: 100,
        }),
        mnyInvestmentDetail({
          transaction: 3000 + i,
          price: 20,
          quantity: 100,
        }),
        mnyInvestmentDetail({
          transaction: 2000 + i,
          price: 25,
          quantity: 100,
        }),
      ]),
    });

    const accounts = mapAccounts(reference, DEFAULT_MNY_IMPORT_OPTIONS, "USD");
    const securities = mapSecurities({
      securities: tables.securities,
      currencyByHandle: currencyCodesByHandle(reference),
      baseCurrency: "USD",
      activeHandles: new Set(indices.map(securityHandle)),
    });
    const mappedInvestments = mapInvestments({
      transactions: rows,
      investments: tables,
      accounts,
      securities,
      bills: [],
      exchangeRates: [],
    });
    const transactions = mapTransactions({
      transactions: rows,
      accountKeyByHandle: accounts.keyByHandle,
      currencyByHandle: accounts.currencyByHandle,
      bills: [],
      cashKeyByAccountKey: cashKeyByAccountKey(accounts),
      tradesByHandle: tradesByHandle(mappedInvestments),
    });
    const investments = applyInvestmentCashSources(
      mappedInvestments,
      transactions.investmentCashSources,
    );

    await inTransaction(async (manager) => {
      const writtenAccounts = await writeAccounts(
        manager,
        userId,
        accounts.accounts,
      );
      const writtenSecurities = await writeSecurities(
        manager,
        userId,
        securities.securities,
      );
      const writtenTransactions = await writeTransactions(manager, userId, {
        transactions: transactions.transactions,
        accountIdByKey: writtenAccounts.idByKey,
        categoryIdByHandle: new Map(),
        payeeIdByHandle: new Map(),
        payeeNameByHandle: new Map(),
        tagIdByHandle: new Map(),
      });
      const written = await writeInvestments(manager, userId, {
        transactions: investments.transactions,
        accountIdByKey: writtenAccounts.idByKey,
        securityIdByHandle: writtenSecurities.idByHandle,
        categoryIdByHandle: new Map(),
        payeeIdByHandle: new Map(),
        payeeNameByHandle: new Map(),
        symbolByHandle: new Map(
          indices.map((i) => [securityHandle(i), `S${i}`]),
        ),
        writtenTransactionIds: writtenTransactions.writtenTransactionIds,
        writtenSplitIds: writtenTransactions.writtenSplitIds,
        tagIdByHandle: new Map(),
      });
      // The canonical rebuild, on the import's own manager, as the service
      // runs it after the investment writer.
      await new HoldingsService(
        null as never,
        null as never,
        dataSource,
      ).rebuildAccountsFromTransactions(
        userId,
        [...written.brokerageAccountIds],
        manager,
      );
    });

    const held: { symbol: string; quantity: string; average_cost: string }[] =
      await dataSource.query(
        `SELECT s.symbol, h.quantity, h.average_cost FROM holdings h
           JOIN securities s ON s.id = h.security_id
           JOIN accounts a ON a.id = h.account_id
          WHERE a.user_id = $1 ORDER BY s.symbol`,
        [userId],
      );
    expect(
      held.map((row) => [
        row.symbol,
        Number(row.quantity),
        Number(row.average_cost),
      ]),
    ).toEqual(indices.map((i) => [`S${i}`, 100, 20]));

    // The mapper's replay order (what the pre-commit check folds) is the
    // database's replay order, row for row.
    const replayed: { id: string; security_id: string; action: string }[] =
      await dataSource.query(
        `SELECT id, security_id, action FROM investment_transactions
          WHERE user_id = $1
          ORDER BY ${INVESTMENT_REPLAY_ORDER_SQL}`,
        [userId],
      );
    expect(replayed.map((row) => row.id)).toEqual(
      investments.transactions.map((row) => row.id),
    );
    const symbols: { id: string; symbol: string }[] = await dataSource.query(
      `SELECT id, symbol FROM securities WHERE user_id = $1`,
      [userId],
    );
    const symbolOf = new Map(symbols.map((row) => [row.id, row.symbol]));
    for (const i of indices) {
      expect(
        replayed
          .filter((row) => symbolOf.get(row.security_id) === `S${i}`)
          .map((row) => row.action),
      ).toEqual(["BUY", "SELL", "BUY"]);
    }
  });
});
