import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId, bondProgramId } from "@/bonds/bond-instrument-id";
import { BondPriceService } from "@/bonds/bond-price.service";
import { BondValuationService } from "@/bonds/bond-valuation.service";
import { acquireAdvisoryLock, LockScope } from "@/common/db/locks";
import { withScopedDb } from "@/common/db/scoped-db";
import {
  withPreserveTimestamps,
  withSystemContext,
  withUserContext,
} from "@/common/db/with-context";
import { todayYMD } from "@/common/date-utils";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { SecurityPriceService } from "@/securities/security-price.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  deleteBondInstrumentBypassingImmutability,
  deleteBondProgramBypassingImmutability,
  insertBondProgram,
  storeFixtureSeries,
} from "../helpers/integration-setup";

/**
 * Phase 3 (spec 12) against a real PostgreSQL: the conditional upsert, the stale
 * delete and the ownership predicate are properties of SQL that a mocked manager
 * cannot show (docs/verification-contract.md, INV-BOND-005).
 *
 * The expected prices are computed here from the issue letter's own formula with
 * integers -- 100 x (1 + 0.044 a / 365), half-up to the cent, for a days into
 * the first 365-day period -- never read back from the code under test.
 */
describe("bond engine prices (integration, INV-BOND-005)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let dataSource: DataSource;
  let prices: BondPriceService;
  let valuation: BondValuationService;
  let securities: SecuritiesService;
  let priceService: SecurityPriceService;
  let catalog: BondCatalogService;
  let investments: InvestmentTransactionsService;
  let history: ActionHistoryService;

  let userId: string;
  let otherUserId: string;
  let accountId: string;
  let securityId: string;
  const TOS_ID = bondInstrumentId("PL", "PL_MF", "TOS1029");
  const TOS_PROGRAM = bondProgramId("PL", "PL_MF", "TOS");
  const EDO_ID = bondInstrumentId("PL", "PL_MF", "EDO1036");
  const EDO_PROGRAM = bondProgramId("PL", "PL_MF", "EDO");
  const realFetch = global.fetch;

  /** Per-bond gross value `a` days into a 365-day period, in cents. */
  function grossCents(a: number): bigint {
    const num = 10000n * (365000n + 44n * BigInt(a));
    return (2n * num + 365000n) / (2n * 365000n);
  }
  /** A cent amount as the NUMERIC(24,10) text PostgreSQL returns. */
  const cents = (c: bigint) =>
    `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}00000000`;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
    prices = module.get(BondPriceService);
    valuation = module.get(BondValuationService);
    securities = module.get(SecuritiesService);
    priceService = module.get(SecurityPriceService);
    catalog = module.get(BondCatalogService);
    investments = module.get(InvestmentTransactionsService);
    history = module.get(ActionHistoryService);
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "security_prices",
      "investment_transactions",
      "securities",
      "accounts",
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true), ('USD', 'US Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    await storeFixtureSeries(dataSource, catalog);

    userId = (await createTestUserDirect(dataSource)).id;
    otherUserId = (await createTestUserDirect(dataSource)).id;

    const accounts = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'PLN', 0, 0)
       RETURNING id`,
      [userId],
    );
    accountId = accounts[0].id;

    securityId = await insertSecurity("TOS1029", TOS_PROGRAM);
  });

  async function insertSecurity(
    symbol: string,
    programId: string | null,
    owner = userId,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
       VALUES ($1, $2, $2, 'BOND', 'PLN', $3)
       RETURNING id`,
      [owner, symbol, programId],
    );
    return rows[0].id;
  }

  async function ledger(
    action: string,
    date: string,
    quantity: number,
    id = securityId,
    /** The series the row names; none for a security that is not linked yet. */
    series: string | null = TOS_ID,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $8, $4, $5, $6, 100, $7, 'UNRECONCILED')`,
      [userId, accountId, id, action, date, quantity, quantity * 100, series],
    );
  }

  const recompute = (today: string, id = securityId) =>
    withUserContext(userId, () =>
      prices.recomputeSecurity(userId, id, { today }),
    );

  async function priceRows(id = securityId) {
    return dataSource.query(
      `SELECT TO_CHAR(price_date, 'YYYY-MM-DD') AS d, close_price::text AS p, source, xmin::text AS x
         FROM security_prices WHERE security_id = $1 ORDER BY price_date`,
      [id],
    );
  }

  it("stores each instrument under its deterministic id", async () => {
    const rows = await dataSource.query(
      `SELECT id FROM bond_instruments WHERE series_code = 'TOS1029'`,
    );
    expect(rows).toEqual([{ id: TOS_ID }]);
  });

  describe("recompute", () => {
    it("writes one bond_engine row per day, equal to the letter's value per bond", async () => {
      await ledger("BUY", "2026-10-15", 25);

      const result = await recompute("2027-04-15");

      const rows = await priceRows();
      // 2026-10-15 .. 2027-04-15 inclusive: 182 days elapsed, 183 rows.
      expect(rows).toHaveLength(183);
      expect(result).toEqual({ written: 183, deleted: 0 });
      expect(new Set(rows.map((r: { source: string }) => r.source))).toEqual(
        new Set(["bond_engine"]),
      );
      expect(rows[0]).toMatchObject({ d: "2026-10-15", p: "100.0000000000" });
      // The TOS value 182 days in: round(100 x (1 + 0.044 x 182 / 365), 2).
      expect(grossCents(182)).toBe(10219n);
      expect(rows[182]).toMatchObject({ d: "2027-04-15", p: "102.1900000000" });
      for (const a of [1, 17, 90, 181]) {
        expect(rows[a].p).toBe(cents(grossCents(a)));
      }
    });

    it("prices each day on the lots held that day: a sale ends the prices, a purchase restarts them", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await ledger("SELL", "2026-10-20", 10);
      await ledger("BUY", "2026-10-25", 5);

      await recompute("2026-10-26");

      const dates = (await priceRows()).map((r: { d: string }) => r.d);
      expect(dates).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-18",
        "2026-10-19",
        "2026-10-25",
        "2026-10-26",
      ]);
    });

    it("replaces every non-manual row of its days (a provider's, a trade's) with NULL adjusted_close, never a manual one, and counts only what it wrote (R3)", async () => {
      await ledger("BUY", "2026-10-15", 25);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, adjusted_close, source)
         VALUES ($1, '2026-10-20', 999, NULL, 'manual'),
                ($1, '2026-10-21', 888, NULL, 'buy'),
                ($1, '2026-10-22', 777, 777, 'yahoo_finance'),
                ($1, '2026-10-23', 666, NULL, NULL)`,
        [securityId],
      );

      const result = await recompute("2026-10-25");

      const byDate = new Map(
        (await priceRows()).map((r: { d: string }) => [r.d, r]),
      );
      // The user's own price always wins.
      expect(byDate.get("2026-10-20")).toMatchObject({
        p: "999.0000000000",
        source: "manual",
      });
      // A trade price is one lot's price and a provider's quote is not the
      // holding's value: the engine's value is the security's price.
      expect(byDate.get("2026-10-21")).toMatchObject({
        p: cents(grossCents(6)),
        source: "bond_engine",
      });
      expect(byDate.get("2026-10-22")).toMatchObject({
        p: cents(grossCents(7)),
        source: "bond_engine",
      });
      // A legacy row with no source is not a manual price: NULL <> 'manual'
      // is NULL in SQL, so the predicate must be IS DISTINCT FROM.
      expect(byDate.get("2026-10-23")).toMatchObject({
        p: cents(grossCents(8)),
        source: "bond_engine",
      });
      const adjusted = await dataSource.query(
        `SELECT adjusted_close FROM security_prices WHERE security_id = $1 AND source = 'bond_engine'`,
        [securityId],
      );
      expect(
        adjusted.every(
          (r: { adjusted_close: unknown }) => r.adjusted_close === null,
        ),
      ).toBe(true);
      // 11 days, one of them the user's.
      expect(result).toEqual({ written: 10, deleted: 0 });
    });

    it("a manual price written over an engine row keeps no adjusted close of the engine's (R3)", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-17");
      // A row from before the engine stored NULL (adjusted_close = close).
      await dataSource.query(
        `UPDATE security_prices SET adjusted_close = close_price WHERE security_id = $1 AND price_date = '2026-10-16'`,
        [securityId],
      );

      await withUserContext(userId, () =>
        priceService.createManualPrice(
          securityId,
          { priceDate: "2026-10-16", closePrice: 123 },
          userId,
        ),
      );

      const rows = await dataSource.query(
        `SELECT source, close_price::text AS p, adjusted_close FROM security_prices
          WHERE security_id = $1 AND price_date = '2026-10-16'`,
        [securityId],
      );
      expect(rows).toEqual([
        { source: "manual", p: "123.0000000000", adjusted_close: null },
      ]);

      // The engine does not take it back.
      await recompute("2026-10-17");
      expect(
        (await priceRows()).find((r: { d: string }) => r.d === "2026-10-16"),
      ).toMatchObject({ source: "manual", p: "123.0000000000" });
    });

    it("does not rewrite a day whose price is unchanged, and corrects one that differs", async () => {
      await ledger("BUY", "2026-10-15", 25);
      await recompute("2026-10-20");
      const before = await priceRows();

      await expect(recompute("2026-10-20")).resolves.toEqual({
        written: 0,
        deleted: 0,
      });
      expect(await priceRows()).toEqual(before);

      // A stale engine row (an old terms version, say) is corrected in place.
      await dataSource.query(
        `UPDATE security_prices SET close_price = 1 WHERE security_id = $1 AND price_date = '2026-10-17'`,
        [securityId],
      );
      await expect(recompute("2026-10-20")).resolves.toEqual({
        written: 1,
        deleted: 0,
      });
      expect((await priceRows())[2]).toMatchObject({
        d: "2026-10-17",
        p: cents(grossCents(2)),
      });
    });

    it("deletes bond_engine rows of days that no longer have a price, and nothing else", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-17', 999, 'manual')`,
        [securityId],
      );
      await recompute("2026-10-20");
      expect(await priceRows()).toHaveLength(6);

      // The purchase is voided: no lots, no price on any day.
      await dataSource.query(
        `UPDATE investment_transactions SET status = 'VOID' WHERE security_id = $1`,
        [securityId],
      );
      const result = await recompute("2026-10-20");

      expect(result).toEqual({ written: 0, deleted: 5 });
      expect(await priceRows()).toEqual([
        expect.objectContaining({ d: "2026-10-17", source: "manual" }),
      ]);
    });

    it("moves the holding account's updated_at marker in the same transaction", async () => {
      await ledger("BUY", "2026-10-15", 10);
      // Under app.preserve_timestamps the updated_at trigger keeps the supplied
      // value. Without it the trigger re-stamped this to its transaction's
      // start, and the recompute's transaction could start within the same
      // millisecond, so the two read back equal.
      await withUserContext(userId, () =>
        withPreserveTimestamps(() =>
          withScopedDb(dataSource, (m) =>
            m.query(
              `UPDATE accounts SET updated_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
              [accountId],
            ),
          ),
        ),
      );
      // A recompute dispatched in the background by an earlier write may already
      // have priced these days, leaving the one below nothing to write and so
      // no reason to move the marker. With the engine rows gone, any recompute
      // that runs after the read below has rows to write and must move it.
      await dataSource.query(
        `DELETE FROM security_prices WHERE security_id = $1 AND source = 'bond_engine'`,
        [securityId],
      );
      const before = await dataSource.query(
        `SELECT updated_at FROM accounts WHERE id = $1`,
        [accountId],
      );
      await recompute("2026-10-20");
      const after = await dataSource.query(
        `SELECT updated_at FROM accounts WHERE id = $1`,
        [accountId],
      );
      expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(
        new Date(before[0].updated_at).getTime(),
      );
    });

    it("prices nothing for a lot with no derivable quantity: a split names why, and earlier days stay priced", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await ledger("SPLIT", "2026-10-18", 2);
      await recompute("2026-10-22");
      expect((await priceRows()).map((r: { d: string }) => r.d)).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
      ]);
      const view = await withUserContext(userId, () =>
        valuation.valueSecurity(userId, securityId, "2026-10-22"),
      );
      expect(view.refusal).toMatchObject({ code: "SPLIT" });
    });
  });

  describe("another user's security", () => {
    it("cannot be valued, recomputed or read by a user who does not own it", async () => {
      await ledger("BUY", "2026-10-15", 25);

      await expect(
        withUserContext(otherUserId, () =>
          valuation.valueSecurity(otherUserId, securityId, "2027-04-15"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withUserContext(otherUserId, () =>
          prices.recomputeSecurity(otherUserId, securityId, {
            today: "2027-04-15",
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await priceRows()).toEqual([]);

      // The owner reads the same ledger: 25 bonds, 182 days in, 25 x 102.19.
      const owner = await withUserContext(userId, () =>
        valuation.valueSecurity(userId, securityId, "2027-04-15"),
      );
      expect(owner.totals).toMatchObject({
        quantity: 25,
        grossValue: "2554.75",
      });
      expect(owner.lots[0].valuation.earlyRedemptionValue).toBe("2529.75");
    });

    it("answers 404 for an unlinked security, exactly like a foreign one", async () => {
      const plain = await insertSecurity("PLAIN", null);
      await expect(
        withUserContext(userId, () =>
          valuation.valueSecurity(userId, plain, "2027-04-15"),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("quote providers never price a linked security (D)", () => {
    afterEach(() => {
      global.fetch = realFetch;
    });

    it("skips it in every refresh path, while an unlinked security beside it is still asked for", async () => {
      const fetchSpy = jest
        .fn()
        .mockRejectedValue(new Error("network disabled"));
      global.fetch = fetchSpy as never;
      // The strongest opt-in a user can give a provider.
      await dataSource.query(
        `UPDATE securities SET quote_provider = 'yahoo', skip_price_updates = false WHERE id = $1`,
        [securityId],
      );

      const all = await priceService.refreshAllPrices();
      const selected = await withUserContext(userId, () =>
        priceService.refreshPricesForSecurities([securityId]),
      );
      const settled = await priceService.settleDailyBars();
      const filled = await withUserContext(userId, () =>
        priceService.ensurePricesForDate([securityId], "2026-10-01"),
      );
      const backfill = await withSystemContext(() =>
        priceService.backfillHistoricalPrices(),
      );

      expect(all.totalSecurities).toBe(0);
      expect(selected.totalSecurities).toBe(0);
      expect(settled.totalSecurities).toBe(0);
      expect(filled).toBe(0);
      expect(backfill.totalSecurities).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Not vacuous: the same call for an unlinked security does ask.
      const plain = await insertSecurity("PLAIN", null);
      const asked = await withUserContext(userId, () =>
        priceService.refreshPricesForSecurities([plain, securityId]),
      );
      expect(asked.totalSecurities).toBe(1);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe("linking through the security API (C)", () => {
    it("refuses a missing instrument and a currency mismatch before writing, then prices the link after commit", async () => {
      const plain = await insertSecurity("LINKME", null);
      // Inside the series' sale window (October 2026).
      await ledger("BUY", "2026-10-05", 10, plain, null);

      const update = (dto: Parameters<SecuritiesService["update"]>[2]) =>
        withUserContext(userId, () => securities.update(userId, plain, dto));

      await expect(
        update({
          bondProgramId: "99999999-9999-5999-8999-999999999999",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await dataSource.query(
        `UPDATE securities SET currency_code = 'USD' WHERE id = $1`,
        [plain],
      );
      await expect(update({ bondProgramId: TOS_PROGRAM })).rejects.toThrow(
        /recorded in USD.*priced in PLN/,
      );
      expect(await priceRows(plain)).toEqual([]);
      expect(
        (
          await dataSource.query(
            `SELECT bond_program_id FROM securities WHERE id = $1`,
            [plain],
          )
        )[0].bond_program_id,
      ).toBeNull();

      // Currency and link together, in the instrument's currency: committed,
      // then priced up to today (the request recomputes after its commit).
      const linked = await update({
        currencyCode: "PLN",
        bondProgramId: TOS_PROGRAM,
      });
      expect(linked.bondProgramId).toBe(TOS_PROGRAM);
      const rows = await priceRows(plain);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0]).toMatchObject({ d: "2026-10-05", source: "bond_engine" });
      expect(rows[rows.length - 1].d).toBe(todayYMD());

      // A currency change of a linked security is refused; unlinking first is the way.
      await expect(update({ currencyCode: "USD" })).rejects.toThrow(
        /stays in the instrument's currency \(PLN\)/,
      );
    });

    it("refuses deleting a catalog program that a security points at, by fk_securities_bond_program and nothing else (ON DELETE RESTRICT)", async () => {
      // A program with no series, so no other foreign key can be what refuses.
      const bare = await insertBondProgram(dataSource, "BARE");
      await insertSecurity("BARE", bare);
      await expect(
        deleteBondProgramBypassingImmutability(
          dataSource,
          `DELETE FROM bond_programs WHERE id = $1`,
          [bare],
        ),
      ).rejects.toThrow(/"fk_securities_bond_program"/);

      // Unlinked, the same row deletes: the constraint is the only guard.
      await dataSource.query(
        `UPDATE securities SET bond_program_id = NULL WHERE bond_program_id = $1`,
        [bare],
      );
      await deleteBondProgramBypassingImmutability(
        dataSource,
        `DELETE FROM bond_programs WHERE id = $1`,
        [bare],
      );
    });

    it("refuses deleting a series that a transaction names, by fk_investment_transactions_bond_instrument and nothing else (ON DELETE RESTRICT)", async () => {
      // A series with no terms version and no period rate, in a program no
      // security links to, so no other foreign key can be what refuses.
      const program = await insertBondProgram(dataSource, "BARE2");
      const bare = await dataSource.query(
        `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
         VALUES ('PL', 'PL_MF', 'BARE2', $1, 'BARE0000', 'PLN', 'RETAIL_REDEEMABLE') RETURNING id`,
        [program],
      );
      await ledger("BUY", "2026-10-15", 10, securityId, bare[0].id);
      await expect(
        deleteBondInstrumentBypassingImmutability(
          dataSource,
          `DELETE FROM bond_instruments WHERE id = $1`,
          [bare[0].id],
        ),
      ).rejects.toThrow(/"fk_investment_transactions_bond_instrument"/);
      await dataSource.query(
        `UPDATE investment_transactions SET bond_instrument_id = NULL WHERE bond_instrument_id = $1`,
        [bare[0].id],
      );
      await deleteBondInstrumentBypassingImmutability(
        dataSource,
        `DELETE FROM bond_instruments WHERE id = $1`,
        [bare[0].id],
      );
    });

    it("unlinking deletes the engine's rows in the same transaction and leaves the user's own prices and the other sources on days the engine did not price", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-17', 999, 'manual'), ($1, '2026-10-16', 100, 'buy')`,
        [securityId],
      );
      await recompute("2026-10-20");
      expect(
        (await priceRows()).map((r: { source: string }) => r.source),
      ).toContain("bond_engine");

      await withUserContext(userId, () =>
        securities.update(userId, securityId, { bondProgramId: null }),
      );

      // The trade's row of the 16th was the engine's day, replaced by the
      // engine's value; only the user's own price is left.
      expect(await priceRows()).toEqual([
        expect.objectContaining({ d: "2026-10-17", source: "manual" }),
      ]);
      // Nothing re-creates them: the security is no longer the engine's, and an
      // explicit recompute refuses it.
      await expect(recompute("2026-10-20")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await priceRows()).toHaveLength(1);
    });

    it("moving the link to another instrument replaces the old instrument's prices with the new one's", async () => {
      await ledger("BUY", "2026-10-01", 10);
      await recompute("2026-10-05");
      const before = await priceRows();
      expect(before).toHaveLength(5);

      await withUserContext(userId, () =>
        securities.update(userId, securityId, {
          bondProgramId: bondProgramId("PL", "PL_MF", "ROS"),
        }),
      );

      const after = await priceRows();
      expect(
        after.every((r: { source: string }) => r.source === "bond_engine"),
      ).toBe(true);
      // Priced from the new instrument, up to today: not the TOS rows left over.
      expect(after[after.length - 1].d).toBe(todayYMD());
      expect(after.slice(0, 5).map((r: { p: string }) => r.p)).not.toEqual(
        before.map((r: { p: string }) => r.p),
      );
    });
  });

  describe("recomputes of one security are serialized and read the link under the lock (#55, #70)", () => {
    it("a recompute that starts while an unlink holds the lock waits, then finds no link and refuses", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-20");
      expect(await priceRows()).toHaveLength(6);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));

      // The unlink's transaction: the engine lock first, then the delete and the
      // link change, committed only when the gate opens.
      const unlink = withUserContext(userId, () =>
        withScopedDb(dataSource, async (m) => {
          await prices.clearEnginePrices(m, userId, securityId);
          await m.query(
            `UPDATE securities SET bond_program_id = NULL WHERE id = $1`,
            [securityId],
          );
          locked();
          await gate;
        }),
      );
      await lockHeld;

      let settled = false;
      const waiting = recompute("2026-10-25").then(
        () => {
          settled = true;
          return "resolved";
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await new Promise((r) => setTimeout(r, 400));
      // Not finished: it is queued behind the lock, not racing the unlink.
      expect(settled).toBe(false);

      release();
      await unlink;
      const outcome = await waiting;
      expect(outcome).toBeInstanceOf(NotFoundException);
      // It wrote nothing after the unlink deleted the engine's rows.
      expect(await priceRows()).toEqual([]);
    });

    it("two recomputes of the same security queue on the lock; the key is per security", async () => {
      await ledger("BUY", "2026-10-15", 10);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockHeld = new Promise<void>((resolve) => (locked = resolve));
      const holder = withUserContext(userId, () =>
        withScopedDb(dataSource, async (m) => {
          await acquireAdvisoryLock(
            m,
            LockScope.BondPriceRecompute,
            securityId,
          );
          locked();
          await gate;
        }),
      );
      await lockHeld;

      // A different security's recompute is not held up.
      const other = await insertSecurity("TOS-OTHER", TOS_PROGRAM);
      await ledger("BUY", "2026-10-15", 3, other);
      await expect(recompute("2026-10-17", other)).resolves.toEqual({
        written: 3,
        deleted: 0,
      });

      let settled = false;
      const same = recompute("2026-10-17").then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      release();
      await holder;
      await same;
      expect(await priceRows()).toHaveLength(3);
    });
  });

  describe("a transaction price and the engine, in either order of writing (INV-BOND-005)", () => {
    const buyOn20th = () =>
      dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2026-10-20', 5, 100.5, 502.5, 'UNRECONCILED')`,
        [userId, accountId, securityId],
      );

    it("a trade recorded after the engine priced the day does not replace the engine's row: a trade is one lot's price, not the holding's value", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-22");
      const engineRow = (await priceRows())[5];
      expect(engineRow).toMatchObject({
        d: "2026-10-20",
        source: "bond_engine",
      });

      await buyOn20th();
      await withUserContext(userId, () =>
        priceService.upsertTransactionPrice(securityId, "2026-10-20"),
      );
      expect((await priceRows())[5]).toEqual(engineRow);

      // The new purchase changes the lots from the 20th, so the next recompute
      // reprices those days -- and the 20th stays the engine's, not the trade's.
      await expect(recompute("2026-10-22")).resolves.toMatchObject({
        written: 3,
      });
      const after = (await priceRows())[5];
      expect(after).toMatchObject({ d: "2026-10-20", source: "bond_engine" });
      expect(after.p).not.toBe("100.5000000000");
    });

    it("a trade recorded before the engine runs is replaced by the engine's row (the other order ends the same)", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await buyOn20th();
      await withUserContext(userId, () =>
        priceService.upsertTransactionPrice(securityId, "2026-10-20"),
      );
      expect(await priceRows()).toEqual([
        expect.objectContaining({ d: "2026-10-20", source: "buy" }),
      ]);
      await recompute("2026-10-22");
      expect((await priceRows())[5]).toMatchObject({
        d: "2026-10-20",
        source: "bond_engine",
      });
    });

    it("the bulk transaction-price backfill replaces neither an engine row nor a manual one", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-22");
      await dataSource.query(
        `UPDATE security_prices SET source = 'manual', close_price = 999 WHERE security_id = $1 AND price_date = '2026-10-16'`,
        [securityId],
      );
      await withSystemContext(() => priceService.backfillTransactionPrices());
      const byDate = new Map(
        (await priceRows()).map((r: { d: string }) => [r.d, r]),
      );
      // The BUY's own day keeps the engine's value over the trade's price.
      expect(byDate.get("2026-10-15")).toMatchObject({ source: "bond_engine" });
      expect(byDate.get("2026-10-16")).toMatchObject({ source: "manual" });
      expect(byDate.get("2026-10-17")).toMatchObject({ source: "bond_engine" });
    });
  });

  describe("a provider write re-checks the link when it writes (#44)", () => {
    const bars = [
      {
        date: new Date("2026-10-16T00:00:00.000Z"),
        open: null,
        high: null,
        low: null,
        close: 55,
        adjClose: null,
        volume: null,
      },
      {
        date: new Date("2026-10-17T00:00:00.000Z"),
        open: null,
        high: null,
        low: null,
        close: 56,
        adjClose: null,
        volume: null,
      },
    ];
    type Writers = {
      bulkUpsertPrices: (s: unknown, p: unknown, src: string) => Promise<void>;
      savePriceData: (s: unknown, d: string, q: unknown) => Promise<unknown>;
    };
    const writers = () => priceService as unknown as Writers;

    it("a history write for a security linked since its list was loaded writes nothing, and does not replace the engine's rows", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-17");
      const before = await priceRows();
      expect(before).toHaveLength(3);

      // The job loaded this security while it was unlinked; it is linked now.
      await withUserContext(userId, () =>
        writers().bulkUpsertPrices(
          { id: securityId, userId },
          bars,
          "yahoo_finance",
        ),
      );
      expect(await priceRows()).toEqual(before);
    });

    it("a quote write for a linked security writes nothing either", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-17");
      const before = await priceRows();
      await expect(
        withUserContext(userId, () =>
          writers().savePriceData({ id: securityId, userId }, "2026-10-17", {
            symbol: "TOS1029",
            regularMarketPrice: 77,
          }),
        ),
      ).resolves.toMatchObject({ source: "bond_engine" });
      expect(await priceRows()).toEqual(before);
    });

    // Each layer is pinned on its own (a removal of either must fail here):
    // the link re-check at the write, and the source guard on the row replaced.
    it("a provider bar on a day the engine has no row for (before the purchase) creates no row for a linked security, in a history write and in a quote write", async () => {
      await ledger("BUY", "2026-10-15", 10);
      await recompute("2026-10-17");
      const before = await priceRows();

      await withUserContext(userId, () =>
        writers().bulkUpsertPrices(
          { id: securityId, userId },
          [{ ...bars[0], date: new Date("2026-10-14T00:00:00.000Z") }],
          "yahoo_finance",
        ),
      );
      // The quote write has nothing to return for a linked security.
      await expect(
        withUserContext(userId, () =>
          writers().savePriceData({ id: securityId, userId }, "2026-10-14", {
            symbol: "TOS1029",
            regularMarketPrice: 77,
          }),
        ),
      ).rejects.toThrow(/Failed to persist price/);

      expect(await priceRows()).toEqual(before);
    });

    it("a provider never replaces a bond_engine row even where the link check sees no link (a link committed after the statement's snapshot)", async () => {
      const racing = await insertSecurity("RACING", null);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-16', 100.01, 'bond_engine')`,
        [racing],
      );
      const before = await priceRows(racing);

      await withUserContext(userId, () =>
        writers().bulkUpsertPrices(
          { id: racing, userId },
          [bars[0]],
          "yahoo_finance",
        ),
      );
      await withUserContext(userId, () =>
        writers().savePriceData({ id: racing, userId }, "2026-10-16", {
          symbol: "RACING",
          regularMarketPrice: 77,
        }),
      );

      expect(await priceRows(racing)).toEqual(before);
    });

    it("an unlinked security still gets its provider rows, and a manual price is still protected", async () => {
      const plain = await insertSecurity("PLAIN", null);
      await dataSource.query(
        `INSERT INTO security_prices (security_id, price_date, close_price, source)
         VALUES ($1, '2026-10-17', 999, 'manual')`,
        [plain],
      );
      await withUserContext(userId, () =>
        writers().bulkUpsertPrices(
          { id: plain, userId },
          bars,
          "yahoo_finance",
        ),
      );
      expect(await priceRows(plain)).toEqual([
        expect.objectContaining({
          d: "2026-10-16",
          p: "55.0000000000",
          source: "yahoo_finance",
        }),
        expect.objectContaining({
          d: "2026-10-17",
          p: "999.0000000000",
          source: "manual",
        }),
      ]);
    });
  });

  describe("transfers keep their lot's purchase date (spec 12.2)", () => {
    let otherAccount: string;

    beforeEach(async () => {
      otherAccount = (
        await dataSource.query(
          `INSERT INTO accounts (user_id, account_type, account_sub_type, name, currency_code, current_balance, opening_balance)
           VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Second', 'PLN', 0, 0) RETURNING id`,
          [userId],
        )
      )[0].id;
      await ledger("BUY", "2026-10-15", 10);
    });

    const leg = async (
      account: string,
      action: string,
      status = "UNRECONCILED",
      series: string | null = null,
    ): Promise<string> =>
      (
        await dataSource.query(
          `INSERT INTO investment_transactions
             (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
           VALUES ($1, $2, $3, $6, $4, '2026-11-01', 10, 100, 1000, $5) RETURNING id`,
          [userId, account, securityId, action, status, series],
        )
      )[0].id;

    const link = (from: string, to: string) =>
      dataSource.query(
        `UPDATE investment_transactions SET linked_transaction_id = $2 WHERE id = $1`,
        [from, to],
      );

    const priceOn = async (date: string) =>
      (await priceRows()).find((r: { d: string }) => r.d === date);

    it("a linked pair, stored on both legs, leaves the original purchase date: accrual continues from 2026-10-15", async () => {
      const out = await leg(accountId, "TRANSFER_OUT");
      const inn = await leg(otherAccount, "TRANSFER_IN");
      await link(out, inn);
      await link(inn, out);
      await recompute("2026-11-05");
      // 21 days since the purchase, not 4 since the transfer.
      expect((await priceOn("2026-11-05"))?.p).toBe(cents(grossCents(21)));
    });

    it("a pair linked from one leg only is the same pair", async () => {
      const out = await leg(accountId, "TRANSFER_OUT");
      const inn = await leg(otherAccount, "TRANSFER_IN");
      await link(inn, out);
      await recompute("2026-11-05");
      expect((await priceOn("2026-11-05"))?.p).toBe(cents(grossCents(21)));
    });

    it("an unlinked pair is not paired, and the lot restarts at the transfer", async () => {
      await leg(accountId, "TRANSFER_OUT");
      // An unpaired TRANSFER_IN names its series: the transfer date is not a
      // purchase date to infer one from (INV-BOND-007).
      await leg(otherAccount, "TRANSFER_IN", "UNRECONCILED", TOS_ID);
      await recompute("2026-11-05");
      // Not the original lot's accrual: a lot dated the transfer day, 4 days in.
      const priced = await priceOn("2026-11-05");
      expect(priced).toBeDefined();
      expect(priced?.p).not.toBe(cents(grossCents(21)));
      expect(priced?.p).toBe(cents(grossCents(4)));
    });

    it("an unpaired TRANSFER_IN without a series makes the lots unknown, never inferred from the transfer date", async () => {
      await leg(accountId, "TRANSFER_OUT");
      await leg(otherAccount, "TRANSFER_IN");
      await recompute("2026-11-05");
      expect(await priceOn("2026-11-05")).toBeUndefined();
    });

    it("a leg that is VOID is not a partner: the other leg stands alone", async () => {
      const out = await leg(accountId, "TRANSFER_OUT");
      const inn = await leg(otherAccount, "TRANSFER_IN", "VOID");
      await link(out, inn);
      await recompute("2026-11-05");
      // The remaining TRANSFER_OUT removed the lot: no price after the transfer.
      expect(await priceOn("2026-11-05")).toBeUndefined();
    });
  });

  describe("the daily job", () => {
    it("recomputes every user's linked securities, one failure not stopping the rest", async () => {
      await ledger("BUY", "2026-10-15", 10);
      const otherAccount = await dataSource.query(
        `INSERT INTO accounts (user_id, account_type, account_sub_type, name, currency_code, current_balance, opening_balance)
         VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'B2', 'PLN', 0, 0) RETURNING id`,
        [otherUserId],
      );
      const otherSecurity = await insertSecurity(
        "TOS-B",
        TOS_PROGRAM,
        otherUserId,
      );
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2026-10-16', 4, 100, 400, 'UNRECONCILED')`,
        [otherUserId, otherAccount[0].id, otherSecurity],
      );

      const result = await withSystemContext(() =>
        prices.recomputeAll({ today: "2026-10-20" }),
      );

      expect(result).toEqual({ securities: 2, failed: 0 });
      expect(await priceRows(securityId)).toHaveLength(6);
      expect(await priceRows(otherSecurity)).toHaveLength(5);
    });

    it("one security failing for real leaves the others' prices written", async () => {
      await ledger("BUY", "2026-10-15", 10);
      // A series with no terms version: valuing a security whose rows name it
      // fails inside the transaction, as stored reference data gone wrong would.
      const brokenProgram = await insertBondProgram(dataSource, "BROKENP");
      const bare = await dataSource.query(
        `INSERT INTO bond_instruments (issuer_country_code, issuer_code, program_code, bond_program_id, series_code, currency_code, marketability)
         VALUES ('PL', 'PL_MF', 'BROKENP', $1, 'BROKEN00', 'PLN', 'RETAIL_REDEEMABLE') RETURNING id`,
        [brokenProgram],
      );
      const broken = await insertSecurity("BROKEN", brokenProgram, otherUserId);
      const otherAccount = await dataSource.query(
        `INSERT INTO accounts (user_id, account_type, account_sub_type, name, currency_code, current_balance, opening_balance)
         VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'B3', 'PLN', 0, 0) RETURNING id`,
        [otherUserId],
      );
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, $4, 'BUY', '2026-10-16', 4, 100, 400, 'UNRECONCILED')`,
        [otherUserId, otherAccount[0].id, broken, bare[0].id],
      );

      const result = await withSystemContext(() =>
        prices.recomputeAll({ today: "2026-10-20" }),
      );

      expect(result).toEqual({ securities: 2, failed: 1 });
      expect(await priceRows(securityId)).toHaveLength(6);
      expect(await priceRows(broken)).toEqual([]);
    });
  });

  describe("inflation scenarios (spec 13.3)", () => {
    let edoSecurityId: string;

    beforeEach(async () => {
      await dataSource.query(
        `INSERT INTO benchmark_series (code, kind, publisher, source_url, unit)
         VALUES ('PL_CPI_GUS_YOY', 'MONTHLY', 'GUS', 'https://example.test/cpi', 'FRACTION')
         ON CONFLICT (code) DO NOTHING`,
      );
      await dataSource.query(
        `INSERT INTO benchmark_values (benchmark_code, observation_date, value, source_url, retrieved_at)
         VALUES ('PL_CPI_GUS_YOY', '2027-08-01', 0.0340000000, 'https://example.test/cpi', NOW())
         ON CONFLICT (benchmark_code, observation_date) DO UPDATE SET value = EXCLUDED.value`,
      );
      edoSecurityId = await insertSecurity("EDO1036", EDO_PROGRAM);
      await ledger("BUY", "2026-10-01", 10, edoSecurityId, EDO_ID);
    });

    const scenarios = (values: string[], owner = userId) =>
      withUserContext(owner, () =>
        valuation.scenariosOf(
          owner,
          edoSecurityId,
          "PL_CPI_GUS_YOY",
          values,
          "2027-10-16",
        ),
      );

    it("a higher assumption raises the maturity value and the inflation interest, and leaves the known periods alone", async () => {
      const result = await scenarios(["0", "0.05"]);
      const [low, high] = result.scenarios;
      // Computed independently with python fractions (10 bonds).
      expect(low).toEqual({
        value: "0",
        maturityValue: "1301.00",
        totalInterest: "301.00",
        fixedInterest: "53.50",
        benchmarkInterest: "35.82",
        addendInterest: "211.68",
        announcedInterest: "0.00",
      });
      expect(high).toEqual({
        value: "0.05",
        maturityValue: "1907.90",
        totalInterest: "907.86",
        fixedInterest: "53.50",
        benchmarkInterest: "605.44",
        addendInterest: "248.92",
        announcedInterest: "0.00",
      });
    });

    it("the valuation follows the assumption on the same lots", async () => {
      const v = await withUserContext(userId, () =>
        valuation.valueSecurity(
          userId,
          edoSecurityId,
          "2027-10-16",
          new Map([["PL_CPI_GUS_YOY", "0.05"]]),
        ),
      );
      expect(v.lots[0].valuation.maturityValueProjected).toBe("1907.90");
    });

    it("answers 404 for another user's security", async () => {
      await expect(scenarios(["0"], otherUserId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("lots per account (R6)", () => {
    it("a sale in one account leaves the other account's older lot priced, and the price blends every account", async () => {
      const second = (
        await dataSource.query(
          `INSERT INTO accounts (user_id, account_type, account_sub_type, name, currency_code, current_balance, opening_balance)
           VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Second', 'PLN', 0, 0) RETURNING id`,
          [userId],
        )
      )[0].id;
      const insertIn = (
        account: string,
        action: string,
        date: string,
        quantity: number,
      ) =>
        dataSource.query(
          `INSERT INTO investment_transactions
             (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
           VALUES ($1, $2, $3, $4, $5, $6, 100, $7, 'UNRECONCILED')`,
          [userId, account, securityId, action, date, quantity, quantity * 100],
        );
      await insertIn(accountId, "BUY", "2026-10-01", 10); // the older lot
      await insertIn(second, "BUY", "2026-10-20", 10);
      await insertIn(second, "SELL", "2026-10-25", 10);

      await recompute("2026-10-26");

      const byDate = new Map<string, { p: string }>(
        (await priceRows()).map((r: { d: string; p: string }) => [r.d, r]),
      );
      // Blend of both lots on the 20th: 19 days into lot 1 (100.23 per bond),
      // 0 into lot 2 (100.00): (100.23 x 10 + 100.00 x 10) / 20 = 100.115.
      expect(grossCents(19)).toBe(10023n);
      expect(byDate.get("2026-10-20")!.p).toBe("100.1150000000");
      // After the sale in the second account, the older lot of the first is left.
      expect(byDate.get("2026-10-26")!.p).toBe(cents(grossCents(25)));
    });
  });

  describe("a ledger write on a linked security reprices it after the commit (R7)", () => {
    const buyDto = (over: Record<string, unknown> = {}) => ({
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2026-10-05",
      quantity: 10,
      price: 100,
      commission: 0,
      ...over,
    });

    it("create, void, un-void and delete each leave the engine's rows in step with the ledger", async () => {
      expect(await priceRows()).toEqual([]);

      const row = await withUserContext(userId, () =>
        investments.create(userId, buyDto()),
      );
      const created = await priceRows();
      expect(created.length).toBeGreaterThan(1);
      expect(created[0]).toMatchObject({
        d: "2026-10-05",
        source: "bond_engine",
      });

      await withUserContext(userId, () =>
        investments.updateStatus(userId, row.id, "VOID" as never),
      );
      expect(await priceRows()).toEqual([]);

      await withUserContext(userId, () =>
        investments.updateStatus(userId, row.id, "UNRECONCILED" as never),
      );
      expect((await priceRows()).length).toBe(created.length);

      await withUserContext(userId, () => investments.remove(userId, row.id));
      expect(await priceRows()).toEqual([]);
    });

    it("an edit of the date moves the first priced day; a bulk batch reprices once per security", async () => {
      const row = await withUserContext(userId, () =>
        investments.create(userId, buyDto()),
      );
      await withUserContext(userId, () =>
        investments.update(userId, row.id, { transactionDate: "2026-10-08" }),
      );
      expect((await priceRows())[0]).toMatchObject({ d: "2026-10-08" });

      const spy = jest.spyOn(prices, "recomputeSecurity");
      try {
        await withUserContext(userId, () =>
          investments.createBulk(userId, [
            buyDto({ transactionDate: "2026-10-02" }),
            buyDto({ transactionDate: "2026-10-03" }),
          ]),
        );
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect((await priceRows())[0]).toMatchObject({ d: "2026-10-02" });
    });
  });

  describe("the link rules of the security API (R8, R15, R16, R32)", () => {
    const update = (
      dto: Parameters<SecuritiesService["update"]>[2],
      id = securityId,
    ) => withUserContext(userId, () => securities.update(userId, id, dto));

    it("R8: only a BOND is linked; a linked security cannot leave BOND unless it unlinks in the same request", async () => {
      const etf = await insertSecurity("ETFX", null);
      await dataSource.query(
        `UPDATE securities SET security_type = 'ETF' WHERE id = $1`,
        [etf],
      );
      await expect(update({ bondProgramId: TOS_PROGRAM }, etf)).rejects.toThrow(
        /Only a security of type Bond/,
      );

      await ledger("BUY", "2026-10-05", 10);
      await recompute("2026-10-08");
      const before = await priceRows();
      await expect(update({ securityType: "ETF" })).rejects.toThrow(
        /Only a security of type Bond/,
      );
      expect(await priceRows()).toEqual(before);

      await update({ securityType: "ETF", bondProgramId: null });
      expect(await priceRows()).toEqual([]);
    });

    it("R15: a security whose trades are not priced per bond is not linked", async () => {
      const legacy = await insertSecurity("LEGACY", null);
      // 1000 units at 1.00 (currency units): the quantity is not a number of bonds.
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2026-10-05', 1000, 1.00, 1000, 'UNRECONCILED')`,
        [userId, accountId, legacy],
      );
      await expect(
        update({ bondProgramId: TOS_PROGRAM }, legacy),
      ).rejects.toThrow(/not numbers of bonds/);
      expect(await priceRows(legacy)).toEqual([]);

      // The exchange price of a bond (99.90 per 100 face) is within the band.
      const proper = await insertSecurity("PROPER", null);
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, 'BUY', '2026-10-05', 10, 99.90, 999, 'UNRECONCILED')`,
        [userId, accountId, proper],
      );
      await expect(
        update({ bondProgramId: TOS_PROGRAM }, proper),
      ).resolves.toMatchObject({ bondProgramId: TOS_PROGRAM });
    });

    it("R16: the same instrument in capitals is no change: the engine's rows are neither deleted nor rewritten", async () => {
      await ledger("BUY", "2026-10-05", 10);
      await recompute("2026-10-08");
      const before = await priceRows();

      const result = await update({ bondProgramId: TOS_PROGRAM.toUpperCase() });

      expect(result.bondProgramId).toBe(TOS_PROGRAM);
      expect(await priceRows()).toEqual(before);
    });

    it("R32: an update that read the security unlinked, while a concurrent link committed, neither puts the stale link back nor drops the link's prices", async () => {
      await ledger("BUY", "2026-10-05", 10);
      const plain = await insertSecurity("STALE", null);
      await ledger("BUY", "2026-10-05", 10, plain, null);

      // Request B is in flight with a snapshot that saw the security unlinked...
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = securities.findOne.bind(securities);
      const spy = jest
        .spyOn(securities, "findOne")
        .mockImplementationOnce(async (u: string, id: string) => {
          const stale = await original(u, id);
          await gate;
          return stale;
        });
      const rename = update({ name: "Renamed" }, plain);
      // ...request A links and is priced after its commit.
      await new Promise((r) => setTimeout(r, 100));
      await update({ bondProgramId: TOS_PROGRAM }, plain);
      expect((await priceRows(plain)).length).toBeGreaterThan(0);
      release();
      await rename;
      spy.mockRestore();

      const row = await dataSource.query(
        `SELECT name, bond_program_id FROM securities WHERE id = $1`,
        [plain],
      );
      expect(row[0]).toEqual({ name: "Renamed", bond_program_id: TOS_PROGRAM });
      expect((await priceRows(plain)).length).toBeGreaterThan(0);
    });
  });

  describe("undo of a security edit restores the link under the same rules (R4)", () => {
    it("undoing a currency-and-link edit restores both, deletes the engine's rows, and leaves no linked security in another currency", async () => {
      const usd = await insertSecurity("USDBOND", null);
      await dataSource.query(
        `UPDATE securities SET currency_code = 'USD' WHERE id = $1`,
        [usd],
      );
      await ledger("BUY", "2026-10-05", 10, usd, null);
      await withUserContext(userId, () =>
        securities.update(userId, usd, {
          currencyCode: "PLN",
          bondProgramId: TOS_PROGRAM,
        }),
      );
      await settlePendingHistoryWrites();
      expect((await priceRows(usd)).length).toBeGreaterThan(0);

      await withUserContext(userId, () => history.undo(userId));

      const row = await dataSource.query(
        `SELECT currency_code, bond_program_id FROM securities WHERE id = $1`,
        [usd],
      );
      expect(row[0]).toEqual({
        currency_code: "USD",
        bond_program_id: null,
      });
      expect(await priceRows(usd)).toEqual([]);
      const mismatched = await dataSource.query(
        `SELECT 1 FROM securities s JOIN bond_programs b ON b.id = s.bond_program_id
          WHERE s.currency_code <> b.currency_code`,
      );
      expect(mismatched).toEqual([]);

      // Redo applies the edit again, through the same guard, and prices it.
      await withUserContext(userId, () => history.redo(userId));
      expect((await priceRows(usd)).length).toBeGreaterThan(0);
    });

    it("an undo whose restored state is not a valid link is refused with a code and writes nothing", async () => {
      await ledger("BUY", "2026-10-05", 10);
      await recompute("2026-10-08");
      const before = await priceRows();
      // A recorded state that names the link but not its currency.
      await withUserContext(userId, () =>
        history.record(userId, {
          entityType: "security",
          entityId: securityId,
          action: "update",
          beforeData: {
            id: securityId,
            bondProgramId: TOS_PROGRAM,
            currencyCode: "USD",
            securityType: "BOND",
          },
          afterData: { id: securityId },
          description: "Updated security",
        }),
      );

      await expect(
        withUserContext(userId, () => history.undo(userId)),
      ).rejects.toThrow(/cannot be undone because the bond link/);
      expect(await priceRows()).toEqual(before);
      const row = await dataSource.query(
        `SELECT currency_code FROM securities WHERE id = $1`,
        [securityId],
      );
      expect(row[0].currency_code).toBe("PLN");
    });
  });

  describe("one definition of today (R17)", () => {
    it("without an explicit day, the last day priced is the date in the timezone of the user's preferences", async () => {
      await ledger("BUY", "2026-10-05", 10);
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, timezone) VALUES ($1, 'Pacific/Kiritimati')
         ON CONFLICT (user_id) DO UPDATE SET timezone = EXCLUDED.timezone`,
        [userId],
      );
      await withUserContext(userId, () =>
        prices.recomputeSecurity(userId, securityId),
      );
      const east = (await priceRows()).map((r: { d: string }) => r.d);

      await dataSource.query(
        `UPDATE user_preferences SET timezone = 'Pacific/Pago_Pago' WHERE user_id = $1`,
        [userId],
      );
      await withUserContext(userId, () =>
        prices.recomputeSecurity(userId, securityId),
      );
      const west = (await priceRows()).map((r: { d: string }) => r.d);

      // +14h and -11h are always a day apart or the same day, never the server's
      // own date for both: the rows follow the preference (and the cron, which
      // passes no day either, ends on the same one for this user).
      const last = (rows: string[]) => rows[rows.length - 1];
      expect(last(east) >= last(west)).toBe(true);
      expect(last(west)).toBe(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Pacific/Pago_Pago",
        }).format(new Date()),
      );
    });
  });
});
