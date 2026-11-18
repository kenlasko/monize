import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { Account } from "@/accounts/entities/account.entity";
import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { MnyImportJobService } from "@/import/mny/mny-import-job.service";
import { MnyImportService } from "@/import/mny/mny-import.service";
import { MnyStagingService } from "@/import/mny/mny-staging.service";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ImportStagedFile } from "@/import/mny/entities/import-staged-file.entity";
import { KmyParserService } from "@/import/kmy/kmy-parser.service";
import { KmyImportController } from "@/import/kmy/kmy-import.controller";
import { readKmyFixture } from "@/import/kmy/__fixtures__/kmy-fixtures";
import { readMnyFixture } from "@/import/mny/__fixtures__/mny-fixtures";
import { withUserContext } from "@/common/db/with-context";

describe("kmy import: the reference's section 18 file (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;
  let importService: MnyImportService;
  let staging: MnyStagingService;
  let jobs: MnyImportJobService;
  let module: TestingModule;
  const { stage, awaitJob, runKmy, balanceOf } = h;

  beforeAll(() => {
    ({ dataSource, userId, importService, staging, jobs, module } = h);
  });

  it("reproduces the ground truth with every verification delta 0", async () => {
    const job = await runKmy(readKmyFixture("syntheticKmy"));

    expect(job).toMatchObject({ status: "completed", dataCommitted: true });
    expect(job.sourceFormat).toBe("kmy");
    const result = job.result!;
    // Exact lengths first: the loops below pass on an empty array.
    expect(result.verification).toHaveLength(5);
    expect(result.verification.map((line) => line.accountName).sort()).toEqual([
      "Brokerage Account - Brokerage",
      "Brokerage Account - Cash",
      "Checking",
      "EUR Savings",
      "Old Savings",
    ]);
    for (const line of result.verification) {
      expect(line.delta).toBe(0);
      expect(line.matches).toBe(true);
      expect(line.mappedBalance).toBe(line.expectedBalance);
      expect(line.mappedDiffers).toBe(false);
    }
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      accountName: "Brokerage Account - Brokerage",
      symbol: "EXC",
      lotQuantity: 15,
      importedQuantity: 15,
      delta: 0,
      matches: true,
    });

    expect(await balanceOf("Checking")).toBe(2804.5);
    expect(await balanceOf("EUR Savings")).toBe(1000);
    expect(await balanceOf("Brokerage Account - Cash")).toBe(647.5);
    expect(await balanceOf("Old Savings")).toBe(0);
    expect(await balanceOf("Brokerage Account - Brokerage")).toBe(0);
  });

  it("holds 15 shares at a total cost of 378.75 after the canonical fold", async () => {
    await runKmy(readKmyFixture("syntheticKmy"));
    const rows: { quantity: string; average_cost: string; symbol: string }[] =
      await dataSource.query(
        `SELECT h.quantity, h.average_cost, s.symbol
             FROM holdings h
             JOIN accounts a ON a.id = h.account_id
             JOIN securities s ON s.id = h.security_id
            WHERE a.user_id = $1 AND h.quantity <> 0`,
        [userId],
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("EXC");
    expect(Number(rows[0].quantity)).toBe(15);
    expect(Number(rows[0].quantity) * Number(rows[0].average_cost)).toBeCloseTo(
      378.75,
      4,
    );
  });

  it("writes the expected rows, prices, rate, reconcile dates and closed account", async () => {
    const job = await runKmy(readKmyFixture("syntheticKmy"));
    const result = job.result!;

    expect(result.accountsCreated).toBe(5);
    expect(result.investmentTransactionsCreated).toBe(4);
    expect(result.transfersLinked).toBe(3);
    expect(result.billsCreated).toBe(1);
    expect(result.pricesImported).toBeGreaterThan(0);

    const investmentActions: { action: string }[] = await dataSource.query(
      `SELECT action FROM investment_transactions WHERE user_id = $1
          ORDER BY transaction_date, created_at`,
      [userId],
    );
    expect(investmentActions.map((r) => r.action).sort()).toEqual(
      ["BUY", "DIVIDEND", "SELL", "SPLIT"].sort(),
    );

    const prices: { source: string }[] = await dataSource.query(
      `SELECT p.source FROM security_prices p JOIN securities s ON s.id = p.security_id
          WHERE s.symbol = 'EXC'`,
    );
    expect(prices.length).toBeGreaterThanOrEqual(2);
    expect(new Set(prices.map((p) => p.source))).toEqual(
      new Set(["kmy_import"]),
    );

    const rates: {
      from_currency: string;
      to_currency: string;
      rate: string;
      source: string;
    }[] = await dataSource.query(
      `SELECT from_currency, to_currency, rate, source FROM exchange_rates`,
    );
    expect(rates).toHaveLength(1);
    expect(rates[0]).toMatchObject({
      from_currency: "EUR",
      to_currency: "USD",
      source: "kmy_import",
    });
    expect(Number(rates[0].rate)).toBeCloseTo(1.1, 8);

    const eurLeg: { exchange_rate: string; amount: string }[] =
      await dataSource.query(
        `SELECT t.exchange_rate, t.amount FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.user_id = $1 AND a.name = 'EUR Savings'`,
        [userId],
      );
    expect(eurLeg).toHaveLength(1);
    expect(Number(eurLeg[0].amount)).toBe(1000);
    // Spec 5.6.4: the receiving leg carries roundFxRate(1000 / 1100).
    expect(Number(eurLeg[0].exchange_rate)).toBeCloseTo(0.9090909091, 10);

    const reconciled: { n: string }[] = await dataSource.query(
      `SELECT count(*) AS n FROM transactions
          WHERE user_id = $1 AND reconciled_date = '2024-01-31'`,
      [userId],
    );
    expect(Number(reconciled[0].n)).toBeGreaterThan(0);

    const old = await dataSource
      .getRepository(Account)
      .findOneOrFail({ where: { userId, name: "Old Savings" } });
    expect(old.isClosed).toBe(true);
  });

  it("tags the job and staged row kmy and removes the staged bytes", async () => {
    const staged = await stage(readKmyFixture("syntheticKmy"));
    const row = await dataSource
      .getRepository(ImportStagedFile)
      .findOneOrFail({ where: { id: staged.id } });
    expect(row.sourceFormat).toBe("kmy");

    const started = await withUserContext(userId, () =>
      importService.start(userId, {
        stagedFileId: staged.id,
        sourceFormat: "kmy",
      }),
    );
    const job = await awaitJob(started.id);
    const stored = await dataSource
      .getRepository(ImportJob)
      .findOneOrFail({ where: { id: job.id } });
    expect(stored.sourceFormat).toBe("kmy");
    expect(
      await dataSource
        .getRepository(ImportStagedFile)
        .count({ where: { userId } }),
    ).toBe(0);
  });

  it("refuses a re-upload of the same bytes while the rows exist", async () => {
    expect((await runKmy(readKmyFixture("syntheticKmy"))).status).toBe(
      "completed",
    );
    const again = await stage(readKmyFixture("syntheticKmy"));
    const refusal = withUserContext(userId, () =>
      importService.start(userId, {
        stagedFileId: again.id,
        sourceFormat: "kmy",
      }),
    );
    await expect(refusal).rejects.toThrow(ConflictException);
    await expect(refusal).rejects.toThrow(/already imported/i);
  });

  it("lets the same bytes in again when the start replaces existing data", async () => {
    expect((await runKmy(readKmyFixture("syntheticKmy"))).status).toBe(
      "completed",
    );
    // `deleteData` is stubbed: the stub removes the imported rows, not the
    // job and staged rows the running import needs.
    h.stubWipe();
    const second = await runKmy(readKmyFixture("syntheticKmy"), {
      wipeExistingData: true,
    });
    expect(second).toMatchObject({
      status: "completed",
      dataCommitted: true,
    });
  });

  it("is refused by the other format's start, in both directions", async () => {
    const money = await stage(
      readMnyFixture("money2008"),
      "money2008.mny",
      "mny",
    );
    await expect(
      withUserContext(userId, () =>
        importService.start(userId, {
          stagedFileId: money.id,
          sourceFormat: "kmy",
        }),
      ),
    ).rejects.toThrow(NotFoundException);

    const kmy = await stage(readKmyFixture("syntheticKmy"));
    await expect(
      withUserContext(userId, () =>
        importService.start(userId, { stagedFileId: kmy.id }),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it("the controller 404s a Money staged id on discard and leaves it in place", async () => {
    const controller = new KmyImportController(
      staging,
      module.get(KmyParserService),
      jobs,
      importService,
    );
    const money = await stage(
      readMnyFixture("money2008"),
      "money2008.mny",
      "mny",
    );
    await expect(
      withUserContext(userId, () =>
        controller.discard({ user: { id: userId } }, money.id),
      ),
    ).rejects.toThrow(NotFoundException);
    expect(
      await dataSource
        .getRepository(ImportStagedFile)
        .count({ where: { id: money.id } }),
    ).toBe(1);
  });
});
