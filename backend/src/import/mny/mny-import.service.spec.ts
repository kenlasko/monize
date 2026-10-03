import { ConflictException, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { CurrenciesService } from "../../currencies/currencies.service";
import { UsersService } from "../../users/users.service";
import { ImportPostProcessingService } from "../import-post-processing.service";
import { MnyStagedFileMissingError } from "./mny-errors";
import {
  JobRunContext,
  MnyImportJobService,
  importAlreadyRunningException,
} from "./mny-import-job.service";
import { MnyImportService } from "./mny-import.service";
import { MnyParsedFile, MnyParserService } from "./mny-parser.service";
import { MnyStagingService } from "./mny-staging.service";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";
import {
  applyDeferredClosures,
  writeAccounts,
  writeCategories,
  writePayees,
} from "./writers/write-reference";
import {
  writeAccountBalances,
  writeTransactions,
} from "./writers/write-transactions";
import { writeInvestments, writeSecurities } from "./writers/write-investments";
import {
  writeExchangeRates,
  writeSecurityPrices,
} from "./writers/write-prices";
import { writeBills } from "./writers/write-bills";
import { writeLoans } from "./writers/write-loans";
import { HoldingsService } from "../../securities/holdings.service";
import { TransactionRulesApplierService } from "../../transaction-rules/transaction-rules-applier.service";

jest.mock("../../common/db/scoped-db", () => ({
  withScopedDb: jest.fn(),
  runOutsideActiveScopedManager: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("../../common/db/with-context", () => ({
  withUserContext: <T>(_userId: string, fn: () => T): T => fn(),
  withSystemContext: <T>(fn: () => T): T => fn(),
}));

jest.mock("./writers/write-reference", () => ({
  writeAccounts: jest.fn(),
  writeCategories: jest.fn(),
  writePayees: jest.fn(),
  applyDeferredClosures: jest.fn(),
}));

jest.mock("./writers/write-transactions", () => ({
  writeTransactions: jest.fn(),
  writeAccountBalances: jest.fn(),
}));

jest.mock("./writers/write-investments", () => ({
  writeSecurities: jest.fn(),
  writeInvestments: jest.fn(),
}));

jest.mock("./writers/write-prices", () => ({
  writeSecurityPrices: jest.fn(),
  writeExchangeRates: jest.fn(),
}));

jest.mock("./writers/write-bills", () => ({
  writeBills: jest.fn(),
}));

jest.mock("./writers/write-loans", () => ({
  writeLoans: jest.fn(),
}));

const mockedScopedDb = withScopedDb as jest.MockedFunction<typeof withScopedDb>;
const mockedWriteAccounts = writeAccounts as jest.MockedFunction<
  typeof writeAccounts
>;
const mockedWriteCategories = writeCategories as jest.MockedFunction<
  typeof writeCategories
>;
const mockedWritePayees = writePayees as jest.MockedFunction<
  typeof writePayees
>;
const mockedWriteTransactions = writeTransactions as jest.MockedFunction<
  typeof writeTransactions
>;
const mockedWriteBalances = writeAccountBalances as jest.MockedFunction<
  typeof writeAccountBalances
>;
const mockedClosures = applyDeferredClosures as jest.MockedFunction<
  typeof applyDeferredClosures
>;
const mockedWriteSecurities = writeSecurities as jest.MockedFunction<
  typeof writeSecurities
>;
const mockedWriteInvestments = writeInvestments as jest.MockedFunction<
  typeof writeInvestments
>;
const mockedWritePrices = writeSecurityPrices as jest.MockedFunction<
  typeof writeSecurityPrices
>;
const mockedWriteRates = writeExchangeRates as jest.MockedFunction<
  typeof writeExchangeRates
>;
const mockedWriteBills = writeBills as jest.MockedFunction<typeof writeBills>;
const mockedWriteLoans = writeLoans as jest.MockedFunction<typeof writeLoans>;

/**
 * The orchestration around the writers: what runs before the job row exists,
 * what runs inside the one import transaction, and what the verification report
 * says. The writers themselves and the SQL they emit are covered by their own
 * specs and by `test/integration/mny-import.integration.spec.ts`.
 */
function parsedFile(overrides: Partial<MnyParsedFile> = {}): MnyParsedFile {
  return {
    era: "money2005",
    passwordProtected: false,
    options: DEFAULT_MNY_IMPORT_OPTIONS,
    baseCurrency: "CAD",
    accounts: {
      baseCurrency: "CAD",
      currencyCodes: ["CAD"],
      accounts: [
        {
          key: "acct-1",
          handle: 1,
          name: "Chequing",
          moneyName: "Chequing",
          accountType: "CHEQUING",
          accountSubType: null,
          currencyCode: "CAD",
          openingBalance: 0,
          creditLimit: null,
          closed: false,
          closedDate: null,
          favourite: false,
          description: null,
          linkedKey: null,
        },
      ],
      keyByHandle: new Map([[1, "acct-1"]]),
      currencyByHandle: new Map([[1, "CAD"]]),
      skipped: 0,
      warnings: [],
    },
    transactions: {
      transactions: [],
      referencedPayees: new Set(),
      referencedCategories: new Set(),
      transfersLinked: 4,
      skipped: 1,
      deferredInvestments: 2,
      investmentCashSources: new Map(),
      warnings: [],
    },
    categories: {
      categories: [
        {
          handle: 10,
          parentName: null,
          name: "Groceries",
          fullName: "Groceries",
          isIncome: false,
        },
      ],
      byHandle: new Map([
        [
          10,
          {
            handle: 10,
            parentName: null,
            name: "Groceries",
            fullName: "Groceries",
            isIncome: false,
          },
        ],
      ]),
      skipped: 0,
      warnings: [],
    },
    payees: {
      payees: [{ handle: 5, name: "Loblaws" }],
      nameByHandle: new Map([[5, "Loblaws"]]),
      skipped: 0,
      warnings: [],
    },
    securities: {
      securities: [
        {
          handle: 20,
          symbol: "VOO",
          moneySymbol: "VOO",
          name: "Vanguard S&P 500",
          currencyCode: "CAD",
          skipPriceUpdates: false,
        },
      ],
      byHandle: new Map(),
      skipped: 0,
      warnings: [],
    },
    investments: {
      transactions: [],
      referencedSecurities: new Set(),
      referencedPayees: new Set(),
      referencedCategories: new Set(),
      transfersPaired: 0,
      skipped: 0,
      warnings: [],
    },
    bills: {
      bills: [],
      seriesInFile: 0,
      skipped: 0,
      supported: true,
      warnings: [],
    },
    loans: { loans: [], warnings: [] },
    rawPrices: [],
    rawExchangeRates: [],
    currencyByHandle: new Map([[1, "CAD"]]),
    holdingChecks: [],
    currencyCodes: ["CAD"],
    expectedBalances: new Map([["acct-1", 120.5]]),
    transactionCounts: new Map([["acct-1", 3]]),
    investmentCounts: new Map(),
    fileCounts: {
      accounts: 1,
      payees: 1,
      categories: 1,
      securities: 0,
      securityPrices: 0,
      exchangeRates: 0,
      bills: 0,
      transactions: 0,
    },
    missingTables: [],
    missingFields: [],
    warnings: [],
    ...overrides,
  } as MnyParsedFile;
}

describe("MnyImportService", () => {
  let staging: Record<string, jest.Mock>;
  let parser: Record<string, jest.Mock>;
  let jobs: Record<string, jest.Mock>;
  let postProcessing: Record<string, jest.Mock>;
  let usersService: Record<string, jest.Mock>;
  let currencies: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let rulesApplier: Record<string, jest.Mock>;
  let accountRepo: Record<string, jest.Mock>;
  let preferenceRepo: Record<string, jest.Mock>;
  let service: MnyImportService;

  const context: JobRunContext = {
    jobId: "job-1",
    userId: "user-1",
    // The attempt's fencing token: the commit checkpoint presents it, and a
    // mismatch rolls the import back rather than committing behind the reaper's
    // back (audit RV4-001).
    attemptToken: "9f1b7c2e-0000-4000-8000-abcdefabcdef",
    reportProgress: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    staging = {
      findInfo: jest.fn().mockResolvedValue({ id: "staged-1" }),
      loadBytes: jest.fn().mockResolvedValue(Buffer.from("bytes")),
      remove: jest.fn().mockResolvedValue(true),
    };
    parser = { parse: jest.fn().mockReturnValue(parsedFile()) };
    jobs = {
      hasActiveJob: jest.fn().mockResolvedValue(false),
      create: jest.fn().mockResolvedValue({ id: "job-1" }),
      discard: jest.fn().mockResolvedValue(undefined),
      runClaimed: jest.fn().mockResolvedValue(true),
      fail: jest.fn().mockResolvedValue(undefined),
      // Written INSIDE the import transaction, so it commits with the rows it
      // describes: a failure after that commit must not be offered as a retry
      // that re-imports the whole file (audit P4-002). The refusal path -- a
      // fenced checkpoint matching zero rows -- is a property of real
      // transactions and is asserted in
      // test/integration/mny-import-job.integration.spec.ts.
      markDataCommitted: jest.fn().mockResolvedValue(undefined),
    };
    postProcessing = { run: jest.fn().mockResolvedValue(undefined) };
    usersService = { deleteData: jest.fn().mockResolvedValue(undefined) };
    currencies = {
      ensureSystemCurrency: jest.fn().mockResolvedValue(undefined),
    };

    accountRepo = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: "account-1", currentBalance: "120.5000" }]),
    };
    preferenceRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };

    const manager = {
      getRepository: jest.fn((entity: { name?: string }) =>
        entity?.name === "UserPreference" ? preferenceRepo : accountRepo,
      ),
    } as unknown as EntityManager;
    mockedScopedDb.mockImplementation((_dataSource, fn) => fn(manager));

    mockedWriteAccounts.mockResolvedValue({
      idByKey: new Map([["acct-1", "account-1"]]),
      created: 1,
      reused: 0,
    });
    mockedWriteCategories.mockResolvedValue({
      idByFullName: new Map([["Groceries", "category-1"]]),
      created: 1,
    });
    mockedWritePayees.mockResolvedValue({
      idByName: new Map([["Loblaws", "payee-1"]]),
      created: 1,
    });
    mockedWriteTransactions.mockResolvedValue({
      transactionsCreated: 7,
      splitsCreated: 2,
      linksApplied: 4,
      affectedAccountIds: new Set(["account-1"]),
      writtenTransactionIds: new Set<string>(),
      writtenSplitIds: new Set<string>(),
    });
    mockedWriteBalances.mockResolvedValue(1);
    mockedClosures.mockResolvedValue(0);
    mockedWriteSecurities.mockResolvedValue({
      idByHandle: new Map([[20, "security-1"]]),
      created: 1,
      reused: 0,
    });
    mockedWriteInvestments.mockResolvedValue({
      investmentTransactionsCreated: 3,
      cashTransactionsCreated: 2,
      linksApplied: 1,
      affectedAccountIds: new Set(["account-1"]),
      brokerageAccountIds: new Set(["account-1"]),
    });
    mockedWritePrices.mockResolvedValue(11);
    mockedWriteRates.mockResolvedValue(5);
    mockedWriteBills.mockResolvedValue({ created: 0, reused: 0 });
    mockedWriteLoans.mockResolvedValue({ updated: 0 });

    holdingsService = {
      rebuildAccountsFromTransactions: jest.fn().mockResolvedValue(undefined),
    };

    rulesApplier = {
      loadRulesFor: jest.fn().mockResolvedValue([]),
      applyToNew: jest.fn().mockResolvedValue([]),
    };

    service = new MnyImportService(
      {} as DataSource,
      staging as unknown as MnyStagingService,
      parser as unknown as MnyParserService,
      jobs as unknown as MnyImportJobService,
      postProcessing as unknown as ImportPostProcessingService,
      usersService as unknown as UsersService,
      currencies as unknown as CurrenciesService,
      holdingsService as unknown as HoldingsService,
      rulesApplier as unknown as TransactionRulesApplierService,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
  });

  afterEach(() => jest.clearAllMocks());

  describe("start", () => {
    it("rejects a staged file that expired or never belonged to the caller", async () => {
      staging.findInfo.mockResolvedValue(null);

      await expect(
        service.start("user-1", { stagedFileId: "staged-1" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(jobs.create).not.toHaveBeenCalled();
    });

    it("gives the friendly 409 without a doomed insert when an import is already active", async () => {
      // The advisory pre-check. It cannot decide anything -- two requests can
      // both read false here -- but when it does see an active job it saves the
      // INSERT the unique index would refuse anyway.
      jobs.hasActiveJob.mockResolvedValue(true);

      await expect(
        service.start("user-1", { stagedFileId: "staged-1" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(jobs.create).not.toHaveBeenCalled();
    });

    it("passes the 409 through when only the insert catches the race", async () => {
      // The regression guard for P4-001. `hasActiveJob()` before an
      // unconditional insert is a check-then-act: two simultaneous starts both
      // counted zero, and both used to insert -- one file imported twice. The
      // advisory count sees nothing here, because the other request has not
      // committed yet; `create` refuses on the partial unique index instead.
      // This is the only path that can distinguish a real concurrent start.
      jobs.create.mockRejectedValue(importAlreadyRunningException());

      await expect(
        service.start("user-1", { stagedFileId: "staged-1" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(jobs.runClaimed).not.toHaveBeenCalled();
    });

    it("does not wipe when the losing request's insert is refused", async () => {
      // The wipe is behind the lock, so the request that did not get the job
      // row cannot delete the winner's data out from under it.
      jobs.create.mockRejectedValue(importAlreadyRunningException());

      await expect(
        service.start("user-1", {
          stagedFileId: "staged-1",
          options: { wipeExistingData: true },
          wipeCredentials: { password: "hunter2" },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(usersService.deleteData).not.toHaveBeenCalled();
    });

    it("creates the job with resolved options and starts it in the background", async () => {
      const job = await service.start("user-1", { stagedFileId: "staged-1" });

      expect(job).toEqual({ id: "job-1" });
      expect(jobs.create).toHaveBeenCalledWith(
        "user-1",
        "staged-1",
        expect.objectContaining({ wipeExistingData: false }),
      );
      expect(jobs.runClaimed).toHaveBeenCalledWith(
        "user-1",
        "job-1",
        expect.any(Function),
      );
    });

    it("wipes only once the job row holds the lock, and never stores the credentials", async () => {
      await service.start("user-1", {
        stagedFileId: "staged-1",
        options: { wipeExistingData: true },
        wipeCredentials: { password: "hunter2" },
      });

      expect(usersService.deleteData).toHaveBeenCalledWith(
        "user-1",
        {
          password: "hunter2",
          oidcIdToken: undefined,
          deleteAccounts: true,
          deleteCategories: true,
          deletePayees: true,
        },
        // Its own re-authentication purpose: this wipe is confirmed in the
        // import wizard, so an artifact obtained for the Settings "delete my
        // data" flow must not drive it (P2-005).
        "import-wipe",
        // And its own initiator. Left to default to "user-request", the wipe
        // takes the maintenance lease, whose active-import check sees the
        // pending job this same request just created -- so `wipeExistingData`
        // 409'd against itself and could never start. The import already holds
        // the exclusion, via `LockScope.UserImport` and its job row.
        "mny-import",
      );
      // The wipe re-authenticates, so its credentials must not reach
      // import_jobs.options.
      const [, , options] = jobs.create.mock.calls[0];
      expect(JSON.stringify(options)).not.toContain("hunter2");
      // The row is this user's import lock, so a destructive wipe runs behind
      // it -- never before it, where two concurrent requests could both wipe.
      expect(jobs.create.mock.invocationCallOrder[0]).toBeLessThan(
        usersService.deleteData.mock.invocationCallOrder[0],
      );
      // ...and still outside the job body, so the password is never persisted.
      expect(usersService.deleteData.mock.invocationCallOrder[0]).toBeLessThan(
        jobs.runClaimed.mock.invocationCallOrder[0],
      );
    });

    it("fails the request, not a background job, when re-authentication fails", async () => {
      usersService.deleteData.mockRejectedValue(new Error("bad password"));

      await expect(
        service.start("user-1", {
          stagedFileId: "staged-1",
          options: { wipeExistingData: true },
        }),
      ).rejects.toThrow("bad password");
      expect(jobs.runClaimed).not.toHaveBeenCalled();
    });

    it("gives the import slot back when the wipe is refused", async () => {
      // Otherwise the pending row it took blocks every import this user starts
      // until it has been stale long enough for the next start to reap it --
      // for a job that will never run, over a request that already errored.
      usersService.deleteData.mockRejectedValue(new Error("bad password"));

      await expect(
        service.start("user-1", {
          stagedFileId: "staged-1",
          options: { wipeExistingData: true },
        }),
      ).rejects.toThrow("bad password");
      expect(jobs.discard).toHaveBeenCalledWith("user-1", "job-1");
    });

    it("still reports the wipe failure when the slot cannot be given back", async () => {
      usersService.deleteData.mockRejectedValue(new Error("bad password"));
      jobs.discard.mockRejectedValue(new Error("pool exhausted"));

      await expect(
        service.start("user-1", {
          stagedFileId: "staged-1",
          options: { wipeExistingData: true },
        }),
      ).rejects.toThrow("bad password");
    });

    it("does not wipe when the option is off", async () => {
      await service.start("user-1", { stagedFileId: "staged-1" });

      expect(usersService.deleteData).not.toHaveBeenCalled();
    });

    it("logs rather than throws when the background start fails", async () => {
      const error = jest.spyOn(service["logger"], "error");
      jobs.runClaimed.mockRejectedValue(new Error("pool exhausted"));

      await service.start("user-1", { stagedFileId: "staged-1" });
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("pool exhausted"),
      );
    });

    it("fails the job when the background start never got going", async () => {
      // Otherwise the row sits pending until it goes stale, and the wizard
      // polls a row that says `pending` for the whole staleness window with no
      // error to explain why nothing is happening.
      jobs.runClaimed.mockRejectedValue(new Error("pool exhausted"));

      await service.start("user-1", { stagedFileId: "staged-1" });
      await Promise.resolve();
      await Promise.resolve();

      expect(jobs.fail).toHaveBeenCalledWith(
        "job-1",
        "mnyImportFailed",
        "pool exhausted",
        true,
      );
    });

    it("swallows a failure to record the failure, rather than rejecting unhandled", async () => {
      jobs.runClaimed.mockRejectedValue(new Error("pool exhausted"));
      jobs.fail.mockRejectedValue(new Error("still down"));

      await expect(
        service.start("user-1", { stagedFileId: "staged-1" }),
      ).resolves.toBeDefined();
      await Promise.resolve();
      await Promise.resolve();
    });

    it("runs the import as the job body", async () => {
      const runImport = jest
        .spyOn(service, "runImport")
        .mockResolvedValue({} as never);

      await service.start("user-1", { stagedFileId: "staged-1" });
      await jobs.runClaimed.mock.calls[0][2](context);

      expect(runImport).toHaveBeenCalledWith(
        "user-1",
        "staged-1",
        expect.objectContaining({ wipeExistingData: false }),
        context,
      );
    });
  });

  describe("runImport", () => {
    const run = () =>
      service.runImport(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        context,
      );

    it("logs where the time and the memory went", async () => {
      // Task M4.1's acceptance numbers can only be measured on a real Money
      // Plus file, which cannot be committed -- so the import measures itself
      // and the maintainer's run is what gets recorded.
      const log = jest.spyOn(service["logger"], "log");

      await run();

      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(
          /\.mny import timing: [\d.]+ MiB file, .*total \d+ ms; peak rss [\d.]+ MiB \([\d.]+x file size\)/,
        ),
      );
    });

    it("fails cleanly when the staged bytes are gone", async () => {
      staging.loadBytes.mockResolvedValue(null);

      await expect(run()).rejects.toBeInstanceOf(MnyStagedFileMissingError);
    });

    it("checkpoints the commit inside the import transaction", async () => {
      // The regression guard for P4-002. `writeAll` commits, then
      // post-processing, verification, staged-byte removal and the terminal
      // status write all happen outside it -- and a failure in any of them used
      // to leave every imported row in place while the job still advertised
      // itself as retryable. The mapper generates fresh UUIDs on every parse and
      // nothing on an imported row identifies its source, so the retry inserted
      // the file a second time.
      await run();

      expect(jobs.markDataCommitted).toHaveBeenCalledWith(
        expect.anything(),
        "job-1",
        context.attemptToken,
      );
      // Inside the transaction, before it commits -- which is what makes the
      // checkpoint land with the rows rather than after them.
      expect(jobs.markDataCommitted.mock.invocationCallOrder[0]).toBeLessThan(
        postProcessing.run.mock.invocationCallOrder[0],
      );
    });

    it("re-parses the staged bytes rather than trusting the preview", async () => {
      await run();

      expect(parser.parse).toHaveBeenCalledWith(
        expect.objectContaining({
          buffer: expect.any(Buffer),
          options: DEFAULT_MNY_IMPORT_OPTIONS,
          userDefaultCurrency: "CAD",
        }),
      );
    });

    it("falls back to USD when the user has no currency preference", async () => {
      preferenceRepo.findOne.mockResolvedValue(null);

      await run();

      expect(parser.parse).toHaveBeenCalledWith(
        expect.objectContaining({ userDefaultCurrency: "USD" }),
      );
    });

    // Not just the accounts' currencies: a security can be denominated in one no
    // account uses, and `exchange_rates` has a foreign key to `currencies` on
    // both sides.
    it("ensures every currency the file names before the transaction opens", async () => {
      parser.parse.mockReturnValue(
        parsedFile({ currencyCodes: ["CAD", "USD"] }),
      );

      await run();

      expect(currencies.ensureSystemCurrency).toHaveBeenCalledWith("CAD");
      expect(currencies.ensureSystemCurrency).toHaveBeenCalledWith("USD");
    });

    it("writes reference data, then transactions, then balances, then closures", async () => {
      await run();

      const order = [
        mockedWriteAccounts,
        mockedWriteCategories,
        mockedWritePayees,
        mockedWriteTransactions,
        mockedWriteBalances,
        mockedClosures,
      ].map((mock) => mock.mock.invocationCallOrder[0]);

      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("resolves the transaction writer's handle maps from the reference writers", async () => {
      await run();

      const [, , input] = mockedWriteTransactions.mock.calls[0];
      expect(input.accountIdByKey.get("acct-1")).toBe("account-1");
      expect(input.categoryIdByHandle.get(10)).toBe("category-1");
      expect(input.payeeIdByHandle.get(5)).toBe("payee-1");
      expect(input.payeeNameByHandle.get(5)).toBe("Loblaws");
    });

    it("forwards chunk progress to the job", async () => {
      await run();

      const [, , input] = mockedWriteTransactions.mock.calls[0];
      await input.onProgress?.(500, 1000);

      expect(context.reportProgress).toHaveBeenCalledWith({
        phase: "transactions",
        processed: 500,
        total: 1000,
      });
    });

    it("writes balances only for accounts that got an id", async () => {
      parser.parse.mockReturnValue(
        parsedFile({
          expectedBalances: new Map([
            ["acct-1", 120.5],
            ["acct-excluded", 9],
          ]),
        }),
      );

      await run();

      const [, balances] = mockedWriteBalances.mock.calls[0];
      expect([...balances]).toEqual([["account-1", 120.5]]);
    });

    it("hands post-processing only the accounts that were touched", async () => {
      await run();

      expect(postProcessing.run).toHaveBeenCalledWith(
        "user-1",
        false,
        new Set(["account-1"]),
      );
    });

    it("deletes the staged bytes once the import succeeds", async () => {
      await run();

      expect(staging.remove).toHaveBeenCalledWith("user-1", "staged-1");
    });

    it("checkpoints data_committed on the write transaction's own manager, under this attempt's token", async () => {
      // The regression this pins: the column, the migration preflight branching
      // on it and its integration spec all shipped with nothing setting it, so
      // every superseded or stalled job was retired `retryable = true` -- even
      // one whose rows were already in the ledger, where Retry imports the file
      // a second time.
      //
      // The manager matters as much as the call. Written on any other connection
      // the flag would commit independently of the rows it describes, which is
      // the failure it exists to prevent: it would claim a commit that rolled
      // back.
      //
      // And the token matters as much as the manager: it is the whole fence. An
      // unconditional checkpoint asks whether the rows are written, never whether
      // this worker is still the one allowed to write them, so a worker the
      // reaper already gave up on committed the file anyway -- beside a job row
      // inviting the retry that imports it a second time (audit RV4-001).
      await run();

      expect(jobs.markDataCommitted).toHaveBeenCalledTimes(1);
      const [manager, jobId, attemptToken] =
        jobs.markDataCommitted.mock.calls[0];
      expect(jobId).toBe("job-1");
      expect(attemptToken).toBe(context.attemptToken);
      // The manager the write transaction handed the writers, not a fresh one.
      expect(manager).toBe(mockedWriteAccounts.mock.calls[0][0]);
    });

    it("checkpoints last, after every writer has run", async () => {
      // The checkpoint is also the fence, and a fence that refuses has to roll
      // the import back -- which it can only do while the transaction is still
      // open. Placed before a writer it would leave that writer's rows outside
      // what the refusal undoes.
      await run();

      const checkpoint = jobs.markDataCommitted.mock.invocationCallOrder[0];
      for (const writer of [
        mockedWriteAccounts,
        mockedWriteTransactions,
        mockedWriteInvestments,
      ]) {
        expect(writer.mock.invocationCallOrder[0]).toBeLessThan(checkpoint);
      }
    });

    it("reports what was created and skipped", async () => {
      const result = await run();

      expect(result).toMatchObject({
        accountsCreated: 1,
        categoriesCreated: 1,
        payeesCreated: 1,
        transactionsCreated: 7,
        splitsCreated: 2,
        transfersLinked: 4,
        securitiesCreated: 1,
        investmentTransactionsCreated: 3,
        pricesImported: 11,
        exchangeRatesImported: 5,
        // Phase 3 fills this; reported as zero so the shape does not change.
        billsCreated: 0,
        existingDataRemoved: false,
        skipped: { accounts: 0, payees: 0, categories: 0, transactions: 1 },
      });
    });

    it("verifies each account's balance against the file", async () => {
      const result = await run();

      expect(result.verification).toEqual([
        {
          accountName: "Chequing",
          accountType: "CHEQUING",
          accountId: "account-1",
          expectedBalance: 120.5,
          importedBalance: 120.5,
          delta: 0,
          transactionCount: 3,
          matches: true,
        },
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("raises a balance mismatch as a warning", async () => {
      accountRepo.find.mockResolvedValue([
        { id: "account-1", currentBalance: "100.0000" },
      ]);

      const result = await run();

      expect(result.verification[0]).toMatchObject({
        delta: -20.5,
        matches: false,
      });
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "balanceMismatch", count: 1 }),
      ]);
    });

    it("treats an account that never got a row as an unverifiable zero", async () => {
      const base = parsedFile();
      parser.parse.mockReturnValue(
        parsedFile({
          accounts: {
            ...base.accounts,
            accounts: [
              ...base.accounts.accounts,
              {
                ...base.accounts.accounts[0],
                key: "acct-2",
                handle: 2,
                name: "Visa",
                moneyName: "Visa",
              },
            ],
          },
          expectedBalances: new Map([
            ["acct-1", 120.5],
            ["acct-2", 40],
          ]),
        }),
      );

      const result = await run();

      expect(result.verification[1]).toMatchObject({
        accountName: "Visa",
        accountId: null,
        importedBalance: 0,
        delta: -40,
        matches: false,
      });
    });

    it("skips the balance query entirely when nothing was written", async () => {
      mockedWriteAccounts.mockResolvedValue({
        idByKey: new Map(),
        created: 0,
        reused: 0,
      });

      const result = await run();

      expect(result.verification).toEqual([]);
      expect(accountRepo.find).not.toHaveBeenCalled();
    });

    it("carries the parser's own warnings into the report", async () => {
      parser.parse.mockReturnValue(
        parsedFile({
          warnings: [{ code: "unknownAccountType", subject: "at=99" }],
        }),
      );

      const result = await run();

      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "unknownAccountType", count: 1 }),
      );
    });

    it("records that existing data was wiped when the option was set", async () => {
      const result = await service.runImport(
        "user-1",
        "staged-1",
        { ...DEFAULT_MNY_IMPORT_OPTIONS, wipeExistingData: true },
        context,
      );

      expect(result.existingDataRemoved).toBe(true);
    });
  });

  describe("transaction rules", () => {
    const mapped = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      handle: 1,
      accountKey: "acct-1",
      transactionDate: "2025-01-15",
      amount: -10,
      currencyCode: "CAD",
      status: "UNRECONCILED",
      payeeHandle: 5,
      categoryHandle: null,
      description: null,
      referenceNumber: null,
      isTransfer: false,
      linkedTransactionId: null,
      splits: [],
      collapsedTradeHandle: null,
      ...over,
    });

    it("runs one bulk pass over the regular rows, after writeTransactions and before the investments", async () => {
      const rules = [{ id: "rule-1" }];
      rulesApplier.loadRulesFor.mockResolvedValue(rules);
      const base = parsedFile();
      parser.parse.mockReturnValue({
        ...base,
        transactions: {
          ...base.transactions,
          transactions: [
            mapped("tx-1"),
            mapped("tx-2", { payeeHandle: null }),
            mapped("tx-transfer", { isTransfer: true }),
            mapped("tx-cash", {}),
          ],
          investmentCashSources: new Map([
            [
              9,
              {
                transactionId: "tx-cash",
                splitId: null,
              },
            ],
          ]),
        },
      });
      mockedWriteTransactions.mockResolvedValue({
        transactionsCreated: 4,
        splitsCreated: 0,
        linksApplied: 0,
        affectedAccountIds: new Set(["account-1"]),
        writtenTransactionIds: new Set([
          "tx-1",
          "tx-2",
          "tx-transfer",
          "tx-cash",
        ]),
        writtenSplitIds: new Set<string>(),
      });

      await service.runImport(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        context,
      );

      expect(rulesApplier.loadRulesFor).toHaveBeenCalledTimes(1);
      expect(rulesApplier.applyToNew).toHaveBeenCalledTimes(1);
      const [manager, userId, ids, source, options] =
        rulesApplier.applyToNew.mock.calls[0];
      expect(manager).toBeDefined();
      expect(userId).toBe("user-1");
      expect(ids).toEqual(["tx-1", "tx-2"]);
      expect(source).toBe("import");
      expect(options.rules).toBe(rules);
      expect(options.payeeTextById.get("tx-1")).toBe("Loblaws");
      expect(options.payeeTextById.get("tx-2")).toBeNull();
      expect(
        rulesApplier.applyToNew.mock.invocationCallOrder[0],
      ).toBeGreaterThan(mockedWriteTransactions.mock.invocationCallOrder[0]);
      expect(rulesApplier.applyToNew.mock.invocationCallOrder[0]).toBeLessThan(
        mockedWriteInvestments.mock.invocationCallOrder[0],
      );
    });

    it("hands the accounts a structural rule action moved to the post-commit recompute", async () => {
      rulesApplier.loadRulesFor.mockResolvedValue([{ id: "rule-1" }]);
      const base = parsedFile();
      parser.parse.mockReturnValue({
        ...base,
        transactions: {
          ...base.transactions,
          transactions: [mapped("tx-1")],
        },
      });
      rulesApplier.applyToNew.mockResolvedValue([
        {
          transactionId: "tx-1",
          effects: { trace: [] },
          affectedAccountIds: ["loan-account"],
        },
      ]);
      mockedWriteTransactions.mockResolvedValue({
        transactionsCreated: 1,
        splitsCreated: 0,
        linksApplied: 0,
        affectedAccountIds: new Set(["account-1"]),
        writtenTransactionIds: new Set(["tx-1"]),
        writtenSplitIds: new Set<string>(),
      });

      await service.runImport(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        context,
      );

      const affected = postProcessing.run.mock.calls[0][2] as Set<string>;
      expect(affected.has("loan-account")).toBe(true);
      expect(affected.has("account-1")).toBe(true);
    });

    it("does nothing when no row was written", async () => {
      await service.runImport(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        context,
      );
      expect(rulesApplier.loadRulesFor).not.toHaveBeenCalled();
      expect(rulesApplier.applyToNew).not.toHaveBeenCalled();
    });
  });

  describe("investments", () => {
    const run = () =>
      service.runImport(
        "user-1",
        "staged-1",
        DEFAULT_MNY_IMPORT_OPTIONS,
        context,
      );

    it("writes securities and investments after transactions, prices last", async () => {
      await run();

      const order = [
        mockedWriteTransactions,
        mockedWriteSecurities,
        mockedWriteInvestments,
        mockedWritePrices,
        mockedWriteRates,
        mockedWriteBalances,
        mockedClosures,
      ].map((mock) => mock.mock.invocationCallOrder[0]);

      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("gives the investment writer the same handle maps the transactions used", async () => {
      await run();

      const [, , input] = mockedWriteInvestments.mock.calls[0];
      expect(input.securityIdByHandle.get(20)).toBe("security-1");
      expect(input.categoryIdByHandle.get(10)).toBe("category-1");
      expect(input.payeeIdByHandle.get(5)).toBe("payee-1");
      expect(input.symbolByHandle.get(20)).toBe("VOO");
    });

    // Holdings come only from the canonical rebuild, on the import
    // transaction's own manager: a second connection would deadlock against it.
    it("rebuilds holdings for the brokerage accounts inside the transaction", async () => {
      await run();

      expect(
        holdingsService.rebuildAccountsFromTransactions,
      ).toHaveBeenCalledWith("user-1", ["account-1"], expect.anything());
      // The third argument is the import transaction's own EntityManager, not
      // a QueryRunner shim (the union was dropped when this module converted).
      const [, , manager] = (
        holdingsService.rebuildAccountsFromTransactions as jest.Mock
      ).mock.calls[0];
      expect(manager).toBeDefined();
      expect(manager.getRepository).toBeDefined();
    });

    it("does not rebuild holdings when no brokerage account was touched", async () => {
      mockedWriteInvestments.mockResolvedValue({
        investmentTransactionsCreated: 0,
        cashTransactionsCreated: 0,
        linksApplied: 0,
        affectedAccountIds: new Set<string>(),
        brokerageAccountIds: new Set<string>(),
      });

      await run();

      expect(
        holdingsService.rebuildAccountsFromTransactions,
      ).not.toHaveBeenCalled();
    });

    it("honours the price and exchange-rate toggles", async () => {
      parser.parse.mockReturnValue(
        parsedFile({
          options: {
            ...DEFAULT_MNY_IMPORT_OPTIONS,
            importPrices: false,
            importExchangeRates: false,
          },
        }),
      );

      const result = await run();

      expect(mockedWritePrices).not.toHaveBeenCalled();
      expect(mockedWriteRates).not.toHaveBeenCalled();
      expect(result.pricesImported).toBe(0);
      expect(result.exchangeRatesImported).toBe(0);
    });

    it("asks post-processing for the price backfill only when investments landed", async () => {
      const base = parsedFile();
      parser.parse.mockReturnValue(
        parsedFile({
          investments: {
            ...base.investments,
            transactions: [
              {
                id: "inv-1",
              } as unknown as (typeof base.investments.transactions)[number],
            ],
          },
        }),
      );

      await run();

      expect(postProcessing.run).toHaveBeenCalledWith(
        "user-1",
        true,
        expect.any(Set),
      );
    });

    it("reports each holding against Money's open lots", async () => {
      accountRepo.find.mockImplementation((options: { select?: string[] }) =>
        options.select?.includes("quantity")
          ? [
              {
                accountId: "account-1",
                securityId: "security-1",
                quantity: "10.00000000",
              },
            ]
          : [{ id: "account-1", currentBalance: "120.5000" }],
      );
      parser.parse.mockReturnValue(
        parsedFile({
          holdingChecks: [
            {
              accountKey: "acct-1",
              securityHandle: 20,
              symbol: "VOO",
              lotQuantity: 10,
              replayQuantity: 10,
              delta: 0,
              matches: true,
            },
          ],
        }),
      );

      const result = await run();

      expect(result.holdings).toEqual([
        {
          accountName: "Chequing",
          symbol: "VOO",
          lotQuantity: 10,
          replayQuantity: 10,
          importedQuantity: 10,
          delta: 0,
          matches: true,
        },
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("raises a holdings mismatch as a warning rather than failing", async () => {
      accountRepo.find.mockImplementation((options: { select?: string[] }) =>
        options.select?.includes("quantity")
          ? [
              {
                accountId: "account-1",
                securityId: "security-1",
                quantity: "4.00000000",
              },
            ]
          : [{ id: "account-1", currentBalance: "120.5000" }],
      );
      parser.parse.mockReturnValue(
        parsedFile({
          holdingChecks: [
            {
              accountKey: "acct-1",
              securityHandle: 20,
              symbol: "VOO",
              lotQuantity: 10,
              replayQuantity: 10,
              delta: 0,
              matches: true,
            },
          ],
        }),
      );

      const result = await run();

      expect(result.holdings[0]).toMatchObject({
        importedQuantity: 4,
        delta: -6,
        matches: false,
      });
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "holdingsMismatch", count: 1 }),
      );
    });

    it("reports no holdings when the file has no LOT table", async () => {
      const result = await run();

      expect(result.holdings).toEqual([]);
    });
  });

  describe("bills", () => {
    /**
     * Two detected-active candidates the wizard can tick independently.
     *
     * `parsed.options.bills` is what the service obeys, not the options handed
     * to `runImport`: the parser resolves the request's selection against the
     * candidates it actually found, so the fixture mirrors that.
     */
    function withBills(selection: number[]) {
      const bill = (handle: number) => ({
        handle,
        seriesKey: handle,
        status: 0,
        name: `Bill ${handle}`,
        accountKey: "acct-1",
        payeeHandle: null,
        categoryHandle: null,
        amount: -50,
        currencyCode: "CAD",
        frequency: "MONTHLY" as never,
        approximate: false,
        nextDueDate: "2026-08-02",
        endDate: null,
        description: null,
        isTransfer: false,
        transferAccountKey: null,
        investment: null,
        splits: [],
      });

      parser.parse.mockReturnValue(
        parsedFile({
          options: { ...DEFAULT_MNY_IMPORT_OPTIONS, bills: selection },
          bills: {
            bills: [bill(7), bill(8)],
            seriesInFile: 2,
            skipped: 3,
            supported: true,
            warnings: [],
          },
        }),
      );
    }

    it("writes only the bills the wizard selected", async () => {
      withBills([7]);
      mockedWriteBills.mockResolvedValue({ created: 1, reused: 0 });

      const result = await service.runImport(
        "user-1",
        "staged-1",
        { ...DEFAULT_MNY_IMPORT_OPTIONS, bills: [7] },
        context,
      );

      // The unticked bill never reaches the writer, so it is absent from the
      // database rather than created inactive (PR #192 issue 2).
      expect(
        mockedWriteBills.mock.calls[0][2].bills.map((b) => b.handle),
      ).toEqual([7]);
      expect(result.billsCreated).toBe(1);
    });

    it("writes nothing when the user unticked every bill", async () => {
      withBills([]);

      await service.runImport(
        "user-1",
        "staged-1",
        { ...DEFAULT_MNY_IMPORT_OPTIONS, bills: [] },
        context,
      );

      expect(mockedWriteBills.mock.calls[0][2].bills).toEqual([]);
    });

    it("reports bill series the mapper could not use as skipped", async () => {
      withBills([7, 8]);

      const result = await service.runImport(
        "user-1",
        "staged-1",
        { ...DEFAULT_MNY_IMPORT_OPTIONS, bills: [7, 8] },
        context,
      );

      expect(result.skipped.bills).toBe(3);
    });
  });
});
