import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { JobClaimService } from "../common/jobs/job-claim.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createJobClaimMock,
  TEST_LEASE_TOKEN,
} from "../test-helpers/job-claim-testing";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import {
  BankSyncAlreadyRunningException,
  BankSyncCredentialsUnavailableException,
} from "./bank-sync-errors";
import {
  BankSyncService,
  normalizeBankBalance,
  syncWindow,
} from "./bank-sync.service";
import { BankSyncPreviewService } from "./bank-sync-preview.service";
import {
  BankSyncPlanChangedException,
  BankSyncSelectionRefusedException,
  BankSyncWriterService,
} from "./bank-sync-writer.service";
import {
  ACCOUNT_ID,
  BANK_ACCOUNT_ID,
  bankAccountRow,
  bankTransaction,
  CONNECTION_ID,
  connectionRow,
  fakeProvider,
  fakeRegistry,
  OTHER_USER_ID,
  USER_ID,
} from "./bank-sync-testing";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";
import { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import {
  BankSyncProviderError,
  BankSyncProviderErrorKind,
} from "./providers/bank-sync-provider.errors";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/** Fake `Date` only: a fake `nextTick` or timer would deadlock the awaits below. */
const NOW = new Date("2026-09-30T12:00:00.000Z");
function pinClock() {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "nextTick",
      "queueMicrotask",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
      "hrtime",
      "performance",
    ],
  });
}

describe("syncWindow", () => {
  const today = "2026-09-30";

  it("starts at the cut-off before the first success", () => {
    expect(
      syncWindow({ syncFromDate: "2026-08-01", lastSuccessAt: null }, today),
    ).toEqual({ dateFrom: "2026-08-01", dateTo: today });
  });

  it("starts a week before the last success when that is later than the cut-off", () => {
    expect(
      syncWindow(
        {
          syncFromDate: "2026-08-01",
          lastSuccessAt: new Date("2026-09-20T23:59:00.000Z"),
        },
        today,
      ),
    ).toEqual({ dateFrom: "2026-09-13", dateTo: today });
  });

  it("never starts before the cut-off", () => {
    expect(
      syncWindow(
        {
          syncFromDate: "2026-09-19",
          lastSuccessAt: new Date("2026-09-20T00:00:00.000Z"),
        },
        today,
      ).dateFrom,
    ).toBe("2026-09-19");
  });

  it("clamps a future cut-off to today so the request is never inverted", () => {
    expect(
      syncWindow({ syncFromDate: "2026-12-01", lastSuccessAt: null }, today),
    ).toEqual({ dateFrom: today, dateTo: today });
  });

  it("starts today for a link with no cut-off", () => {
    expect(
      syncWindow({ syncFromDate: null, lastSuccessAt: null }, today).dateFrom,
    ).toBe(today);
  });
});

describe("normalizeBankBalance", () => {
  it("is null when the bank reported none", () => {
    expect(normalizeBankBalance(null)).toBeNull();
  });

  it("rounds to money precision and upper-cases the currency", () => {
    expect(
      normalizeBankBalance({
        amount: " -1234.56789 ",
        currencyCode: "pln",
        referenceDate: "2026-09-29",
        balanceType: "CLBD",
      }),
    ).toEqual({
      amount: -1234.5679,
      currencyCode: "PLN",
      referenceDate: "2026-09-29",
    });
  });

  it("keeps a zero balance: zero is a fact, unlike a missing one", () => {
    expect(
      normalizeBankBalance({
        amount: "0",
        currencyCode: "PLN",
        referenceDate: null,
        balanceType: null,
      })?.amount,
    ).toBe(0);
  });

  it.each(["abc", "1,5", "", "1e3", "99999999999999999"])(
    "treats the amount %p as not reported",
    (amount) => {
      expect(
        normalizeBankBalance({
          amount,
          currencyCode: "PLN",
          referenceDate: null,
          balanceType: null,
        }),
      ).toBeNull();
    },
  );

  it("treats a currency that is not three letters as not reported", () => {
    expect(
      normalizeBankBalance({
        amount: "1",
        currencyCode: "PL",
        referenceDate: null,
        balanceType: null,
      }),
    ).toBeNull();
  });

  it("drops a reference date that is not a calendar day", () => {
    expect(
      normalizeBankBalance({
        amount: "1",
        currencyCode: "PLN",
        referenceDate: "2026-02-30",
        balanceType: null,
      })?.referenceDate,
    ).toBeNull();
  });
});

describe("BankSyncService", () => {
  const provider = fakeProvider();
  const registry = fakeRegistry(provider);
  const credentials: jest.Mocked<
    Pick<BankSyncCredentialsService, "resolveCredentials">
  > = { resolveCredentials: jest.fn() };
  const writer: jest.Mocked<Pick<BankSyncWriterService, "write">> = {
    write: jest.fn(),
  };
  const previewer: jest.Mocked<Pick<BankSyncPreviewService, "build">> = {
    build: jest.fn(),
  };
  const jobClaims = createJobClaimMock();
  const netWorth: jest.Mocked<Pick<NetWorthService, "triggerDebouncedRecalc">> =
    { triggerDebouncedRecalc: jest.fn() };
  const linkRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
  const connectionRepo = { findOne: jest.fn() };
  const accountRepo = { findOne: jest.fn() };
  const { manager, dataSource } = createScopedDbMocks([
    [BankSyncAccount, linkRepo],
    [BankSyncConnection, connectionRepo],
    [Account, accountRepo],
  ]);

  const CREDS = { applicationId: "app-1", privateKeyPem: "PEM" };
  const OTHER_ACCOUNT_ID = "a0a0a0a0-0000-4000-8000-000000000002";

  let service: BankSyncService;

  const account = (over: Partial<Account> = {}): Account =>
    ({
      id: ACCOUNT_ID,
      userId: USER_ID,
      currencyCode: "PLN",
      isClosed: false,
      accountSubType: null,
      ...over,
    }) as Account;

  const statements = (needle: string) =>
    manager.query.mock.calls.filter((call) => String(call[0]).includes(needle));

  beforeEach(async () => {
    pinClock();
    jest.clearAllMocks();
    credentials.resolveCredentials.mockResolvedValue(CREDS);
    jobClaims.claimLease.mockResolvedValue(TEST_LEASE_TOKEN);
    linkRepo.findOne.mockResolvedValue(bankAccountRow());
    linkRepo.find.mockResolvedValue([]);
    linkRepo.save.mockImplementation(async (row: unknown) => row);
    connectionRepo.findOne.mockResolvedValue(connectionRow());
    accountRepo.findOne.mockResolvedValue(account());
    manager.query.mockResolvedValue([]);
    provider.fetchTransactions.mockResolvedValue([]);
    provider.fetchBalance.mockResolvedValue(null);
    writer.write.mockResolvedValue({ imported: 0, skipped: 0, excluded: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankSyncService,
        { provide: DataSource, useValue: dataSource },
        { provide: BankSyncCredentialsService, useValue: credentials },
        { provide: BankSyncProviderRegistry, useValue: registry },
        { provide: BankSyncWriterService, useValue: writer },
        { provide: BankSyncPreviewService, useValue: previewer },
        { provide: JobClaimService, useValue: jobClaims },
        { provide: NetWorthService, useValue: netWorth },
      ],
    }).compile();
    service = module.get(BankSyncService);
    // Expected failures are logged by design; keep the run quiet.
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "error").mockImplementation(() => undefined);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("linkAccount", () => {
    const link = (
      dto: { accountId: string | null; syncFromDate?: string | null },
      userId = USER_ID,
    ) => service.linkAccount(userId, BANK_ACCOUNT_ID, dto);

    beforeEach(() => {
      linkRepo.findOne.mockResolvedValue(
        bankAccountRow({ accountId: null, syncFromDate: null }),
      );
      manager.query.mockImplementation(async (sql: string) =>
        String(sql).includes("MAX(t.transaction_date)")
          ? [{ newest: null }]
          : [],
      );
    });

    const newestTransaction = (newest: string | null) =>
      manager.query.mockImplementation(async (sql: string) =>
        String(sql).includes("MAX(t.transaction_date)") ? [{ newest }] : [],
      );

    it("is 404 for a bank account that is not the caller's", async () => {
      linkRepo.findOne.mockResolvedValue(null);
      await expect(
        link({ accountId: ACCOUNT_ID }, OTHER_USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(linkRepo.findOne).toHaveBeenCalledWith({
        where: { id: BANK_ACCOUNT_ID, userId: OTHER_USER_ID },
        lock: { mode: "pessimistic_write" },
      });
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    it("links, defaulting the cut-off to DEFAULT_CUTOFF_LOOKBACK_DAYS ago for an empty account", async () => {
      const view = await link({ accountId: ACCOUNT_ID });
      expect(view.accountId).toBe(ACCOUNT_ID);
      expect(view.syncFromDate).toBe("2026-07-03");
    });

    it("defaults the cut-off to the day after the newest transaction", async () => {
      newestTransaction("2026-09-10");
      expect((await link({ accountId: ACCOUNT_ID })).syncFromDate).toBe(
        "2026-09-11",
      );
    });

    it("counts only rows that move money: the default reads the shared ledger predicate", async () => {
      await link({ accountId: ACCOUNT_ID });
      const [sql, params] = statements("MAX(t.transaction_date)")[0];
      expect(String(sql)).toContain("status != 'VOID'");
      expect(String(sql)).toContain("parent_transaction_id IS NULL");
      expect(params).toEqual([ACCOUNT_ID, USER_ID]);
    });

    it("caps a default that a future-dated row would push past today", async () => {
      newestTransaction("2026-12-24");
      expect((await link({ accountId: ACCOUNT_ID })).syncFromDate).toBe(
        "2026-09-30",
      );
    });

    it("honours the cut-off the user chose", async () => {
      expect(
        (await link({ accountId: ACCOUNT_ID, syncFromDate: "2026-01-15" }))
          .syncFromDate,
      ).toBe("2026-01-15");
    });

    it("treats a blank or null date as not chosen", async () => {
      expect(
        (await link({ accountId: ACCOUNT_ID, syncFromDate: "" })).syncFromDate,
      ).toBe("2026-07-03");
      expect(
        (await link({ accountId: ACCOUNT_ID, syncFromDate: null }))
          .syncFromDate,
      ).toBe("2026-07-03");
    });

    it("unlinks without touching the accounts table", async () => {
      linkRepo.findOne.mockResolvedValue(bankAccountRow());
      const view = await link({ accountId: null });
      expect(view.accountId).toBeNull();
      expect(accountRepo.findOne).not.toHaveBeenCalled();
    });

    it("refuses an account the caller does not own, writing nothing", async () => {
      accountRepo.findOne.mockResolvedValue(null);
      await expect(
        link({ accountId: OTHER_ACCOUNT_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(accountRepo.findOne).toHaveBeenCalledWith({
        where: { id: OTHER_ACCOUNT_ID, userId: USER_ID },
      });
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a closed account", async () => {
      accountRepo.findOne.mockResolvedValue(account({ isClosed: true }));
      await expect(link({ accountId: ACCOUNT_ID })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    it("refuses an investment brokerage account", async () => {
      accountRepo.findOne.mockResolvedValue(
        account({ accountSubType: AccountSubType.INVESTMENT_BROKERAGE }),
      );
      await expect(link({ accountId: ACCOUNT_ID })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    it("refuses an account whose currency differs from the bank account's known currency", async () => {
      accountRepo.findOne.mockResolvedValue(account({ currencyCode: "EUR" }));
      await expect(link({ accountId: ACCOUNT_ID })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    it("links across currency spellings, and when the bank account's currency is unknown", async () => {
      accountRepo.findOne.mockResolvedValue(account({ currencyCode: "pln" }));
      await expect(link({ accountId: ACCOUNT_ID })).resolves.toBeDefined();

      linkRepo.findOne.mockResolvedValue(
        bankAccountRow({
          accountId: null,
          syncFromDate: null,
          currencyCode: null,
        }),
      );
      accountRepo.findOne.mockResolvedValue(account({ currencyCode: "EUR" }));
      await expect(link({ accountId: ACCOUNT_ID })).resolves.toBeDefined();
    });

    it("refuses an account already linked to another bank account", async () => {
      manager.query.mockImplementation(async (sql: string) =>
        String(sql).includes("SELECT 1 FROM bank_sync_accounts")
          ? [{ "?column?": 1 }]
          : [],
      );
      await expect(link({ accountId: ACCOUNT_ID })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(linkRepo.save).not.toHaveBeenCalled();
    });

    it("translates the partial unique index violation into the same 400", async () => {
      linkRepo.save.mockRejectedValue(
        Object.assign(new Error("duplicate key"), {
          driverError: { code: "23505" },
        }),
      );
      const error = await link({ accountId: ACCOUNT_ID }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/already linked/i);
    });

    it("rethrows any other write failure", async () => {
      linkRepo.save.mockRejectedValue(new Error("connection reset"));
      await expect(link({ accountId: ACCOUNT_ID })).rejects.toThrow(
        "connection reset",
      );
    });

    describe("what a changed mapping forgets", () => {
      const synced = () =>
        bankAccountRow({
          lastSuccessAt: new Date("2026-09-20T00:00:00.000Z"),
          lastSyncedAt: new Date("2026-09-20T00:00:00.000Z"),
          lastSyncStatus: "succeeded",
          lastImportedCount: 5,
          lastSkippedCount: 2,
          lastRefusedCount: 1,
        });

      it("forgets the last success when the Monize account changes, so the window starts at the cut-off", async () => {
        const row = synced();
        linkRepo.findOne.mockResolvedValue(row);
        accountRepo.findOne.mockResolvedValue(
          account({ id: OTHER_ACCOUNT_ID }),
        );
        await link({ accountId: OTHER_ACCOUNT_ID });
        expect(row).toMatchObject({
          accountId: OTHER_ACCOUNT_ID,
          lastSuccessAt: null,
          lastSyncedAt: null,
          lastSyncStatus: null,
          lastImportedCount: 0,
        });
      });

      it("forgets it when the cut-off moves, so an earlier date is read", async () => {
        const row = synced();
        linkRepo.findOne.mockResolvedValue(row);
        await link({ accountId: ACCOUNT_ID, syncFromDate: "2026-01-01" });
        expect(row.syncFromDate).toBe("2026-01-01");
        expect(row.lastSuccessAt).toBeNull();
      });

      it("keeps everything when the same account and the same date are sent again", async () => {
        const row = synced();
        linkRepo.findOne.mockResolvedValue(row);
        await link({ accountId: ACCOUNT_ID, syncFromDate: row.syncFromDate });
        await link({ accountId: ACCOUNT_ID });
        expect(row.lastSuccessAt).toEqual(new Date("2026-09-20T00:00:00.000Z"));
        expect(row.lastImportedCount).toBe(5);
        expect(row.syncFromDate).toBe("2026-08-01");
      });
    });
  });

  describe("syncAccount", () => {
    const sync = (
      psu: { ipAddress: string; userAgent: string } | null = null,
    ) => service.syncAccount(USER_ID, BANK_ACCOUNT_ID, psu);

    it("reads the bank, plans, writes once and reports the result", async () => {
      provider.fetchTransactions.mockResolvedValue([
        bankTransaction({ entryReference: "ref-1" }),
        bankTransaction({ entryReference: "ref-2", currencyCode: "EUR" }),
        bankTransaction({ entryReference: "ref-3", booked: false }),
        bankTransaction({ entryReference: "ref-4", bookingDate: "2026-07-01" }),
      ]);
      provider.fetchBalance.mockResolvedValue({
        amount: "1500.5",
        currencyCode: "PLN",
        referenceDate: "2026-09-29",
        balanceType: "CLBD",
      });
      writer.write.mockResolvedValue({ imported: 1, skipped: 0, excluded: 0 });

      const result = await sync();

      expect(result).toEqual({
        bankAccountId: BANK_ACCOUNT_ID,
        imported: 1,
        skipped: 0,
        excluded: 0,
        refused: {
          missing_date: 0,
          future_date: 0,
          invalid_amount: 0,
          unknown_direction: 0,
          currency_mismatch: 1,
        },
        pending: 1,
        beforeCutoff: 1,
        bankBalance: {
          amount: "1500.5000",
          currencyCode: "PLN",
          referenceDate: "2026-09-29",
        },
      });
      expect(writer.write).toHaveBeenCalledTimes(1);
      const written = writer.write.mock.calls[0][0];
      expect(written).toMatchObject({
        userId: USER_ID,
        bankAccountId: BANK_ACCOUNT_ID,
        accountId: ACCOUNT_ID,
        // The cut-off read at step 1, for the write to compare under its lock.
        plannedSyncFromDate: "2026-08-01",
        plannedCurrencyCode: "PLN",
        balance: { amount: 1500.5, currencyCode: "PLN" },
      });
      // Only the booked, in-currency, in-window row is planned.
      expect(written.plan.planned.map((p) => p.externalKey)).toEqual([
        "ref:ref-1",
      ]);
    });

    it("asks the bank for the window from the cut-off to today, forwarding the PSU context", async () => {
      const psu = { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" };
      await sync(psu);
      expect(provider.fetchTransactions).toHaveBeenCalledWith(
        CREDS,
        "ext-1",
        { dateFrom: "2026-08-01", dateTo: "2026-09-30" },
        psu,
      );
      expect(provider.fetchBalance).toHaveBeenCalledWith(CREDS, "ext-1", psu);
    });

    it("sends no PSU context for the unattended daily sync", async () => {
      await sync(null);
      expect(provider.fetchTransactions.mock.calls[0][3]).toBeNull();
    });

    it("re-reads a week before the last success", async () => {
      linkRepo.findOne.mockResolvedValue(
        bankAccountRow({ lastSuccessAt: new Date("2026-09-25T08:00:00.000Z") }),
      );
      await sync();
      expect(provider.fetchTransactions.mock.calls[0][2]).toEqual({
        dateFrom: "2026-09-18",
        dateTo: "2026-09-30",
      });
    });

    it("takes the lease before it talks to the bank and gives it back after", async () => {
      const order: string[] = [];
      jobClaims.claimLease.mockImplementation(async () => {
        order.push("lease");
        return TEST_LEASE_TOKEN;
      });
      provider.fetchTransactions.mockImplementation(async () => {
        order.push("fetch");
        return [];
      });
      writer.write.mockImplementation(async () => {
        order.push("write");
        return { imported: 0, skipped: 0, excluded: 0 };
      });
      jobClaims.releaseLease.mockImplementation(async () => {
        order.push("release");
      });

      await sync();

      expect(order).toEqual(["lease", "fetch", "write", "release"]);
      expect(jobClaims.claimLease).toHaveBeenCalledWith(
        "bank_sync_account",
        USER_ID,
        BANK_ACCOUNT_ID,
        30 * 60 * 1000,
      );
      expect(jobClaims.releaseLease).toHaveBeenCalledWith(
        "bank_sync_account",
        USER_ID,
        BANK_ACCOUNT_ID,
        TEST_LEASE_TOKEN,
      );
    });

    it("asks nothing of the bank inside a transaction", async () => {
      let open = 0;
      dataSource.transaction.mockImplementation(
        async (fn: (m: unknown) => Promise<unknown>) => {
          open += 1;
          try {
            return await fn(manager);
          } finally {
            open -= 1;
          }
        },
      );
      const seen: number[] = [];
      provider.fetchTransactions.mockImplementation(async () => {
        seen.push(open);
        return [];
      });
      provider.fetchBalance.mockImplementation(async () => {
        seen.push(open);
        return null;
      });
      await sync();
      expect(seen).toEqual([0, 0]);
    });

    it("drops the derived balance state after the commit, only when something was created", async () => {
      writer.write.mockResolvedValue({ imported: 2, skipped: 0, excluded: 0 });
      await sync();
      expect(netWorth.triggerDebouncedRecalc).toHaveBeenCalledWith(
        ACCOUNT_ID,
        USER_ID,
      );

      netWorth.triggerDebouncedRecalc.mockClear();
      writer.write.mockResolvedValue({ imported: 0, skipped: 3, excluded: 0 });
      await sync();
      expect(netWorth.triggerDebouncedRecalc).not.toHaveBeenCalled();
    });

    it("does not recompute after a failed write", async () => {
      writer.write.mockRejectedValue(new Error("boom"));
      await expect(sync()).rejects.toThrow("boom");
      expect(netWorth.triggerDebouncedRecalc).not.toHaveBeenCalled();
    });

    it("leaves the stored balance alone when the balance read fails, and says the sync succeeded", async () => {
      provider.fetchBalance.mockRejectedValue(
        new BankSyncProviderError("unavailable", "balance endpoint down"),
      );
      const result = await sync();
      expect(result.bankBalance).toBeNull();
      expect(writer.write.mock.calls[0][0].balance).toBeNull();
    });

    it("treats an unusable balance as not reported", async () => {
      provider.fetchBalance.mockResolvedValue({
        amount: "n/a",
        currencyCode: "PLN",
        referenceDate: null,
        balanceType: null,
      });
      expect((await sync()).bankBalance).toBeNull();
    });

    describe("refusals before the bank is asked", () => {
      const nothingAsked = () => {
        expect(jobClaims.claimLease).not.toHaveBeenCalled();
        expect(provider.fetchTransactions).not.toHaveBeenCalled();
        expect(writer.write).not.toHaveBeenCalled();
      };

      it("is 404 for a bank account that is not the caller's", async () => {
        linkRepo.findOne.mockResolvedValue(null);
        await expect(
          service.syncAccount(OTHER_USER_ID, BANK_ACCOUNT_ID, null),
        ).rejects.toBeInstanceOf(NotFoundException);
        nothingAsked();
      });

      it("is 409 for an unlinked bank account", async () => {
        linkRepo.findOne.mockResolvedValue(bankAccountRow({ accountId: null }));
        await expect(sync()).rejects.toBeInstanceOf(ConflictException);
        nothingAsked();
      });

      it("is 409 when the linked Monize account is gone", async () => {
        accountRepo.findOne.mockResolvedValue(null);
        await expect(sync()).rejects.toBeInstanceOf(ConflictException);
        nothingAsked();
      });

      it("is 404 when the connection is gone", async () => {
        connectionRepo.findOne.mockResolvedValue(null);
        await expect(sync()).rejects.toBeInstanceOf(NotFoundException);
        nothingAsked();
      });

      it.each(["pending", "expired", "revoked", "failed"] as const)(
        "refuses a %s connection, recording it on the bank account",
        async (status) => {
          connectionRepo.findOne.mockResolvedValue(connectionRow({ status }));
          await expect(sync()).rejects.toBeInstanceOf(ConflictException);
          nothingAsked();
          expect(statements("last_sync_status = 'failed'")).toHaveLength(1);
        },
      );

      it("marks a lapsed consent expired in the same transaction as the read, and asks to renew it", async () => {
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ validUntil: new Date("2026-09-30T11:59:59.000Z") }),
        );

        const error = await sync().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).message).toMatch(/renew/i);
        const expire = statements("SET status = 'expired'")[0];
        expect(String(expire[0])).toContain("status = 'active'");
        expect(expire[1]).toEqual([CONNECTION_ID, USER_ID]);
        nothingAsked();
      });

      it("refuses a closed account and an investment brokerage account", async () => {
        accountRepo.findOne.mockResolvedValue(account({ isClosed: true }));
        await expect(sync()).rejects.toBeInstanceOf(BadRequestException);
        accountRepo.findOne.mockResolvedValue(
          account({ accountSubType: AccountSubType.INVESTMENT_BROKERAGE }),
        );
        await expect(sync()).rejects.toBeInstanceOf(BadRequestException);
        nothingAsked();
      });

      it("records a credentials failure and never takes the lease", async () => {
        credentials.resolveCredentials.mockRejectedValue(
          new BadRequestException("Enter your credentials"),
        );
        await expect(sync()).rejects.toBeInstanceOf(BadRequestException);
        nothingAsked();
        const failed = statements("last_sync_status = 'failed'")[0];
        expect(failed[1]).toEqual([
          BANK_ACCOUNT_ID,
          USER_ID,
          "Enter your credentials",
        ]);
      });
    });

    describe("the lease", () => {
      it("is a 409 when another sync of the account holds it, and asks nothing of the bank", async () => {
        jobClaims.claimLease.mockResolvedValue(null);

        const error = await sync().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect(error).toBeInstanceOf(BankSyncAlreadyRunningException);
        expect((error as ConflictException).message).toMatch(
          /already running/i,
        );
        expect(provider.fetchTransactions).not.toHaveBeenCalled();
        expect(writer.write).not.toHaveBeenCalled();
        // Not a failure of the account, and not ours to release.
        expect(statements("last_sync_status = 'failed'")).toHaveLength(0);
        expect(jobClaims.releaseLease).not.toHaveBeenCalled();
      });

      it("does not mask the result when the release fails", async () => {
        jobClaims.releaseLease.mockRejectedValue(new Error("db gone"));
        await expect(sync()).resolves.toMatchObject({ imported: 0 });
      });
    });

    describe("a failure after the lease", () => {
      const cases: Array<[BankSyncProviderErrorKind, number]> = [
        ["unauthorized", 400],
        ["session_expired", 409],
        ["rate_limited", 429],
        ["bad_request", 400],
        ["unavailable", 503],
        ["invalid_response", 502],
      ];

      it.each(cases)(
        "maps a %s provider failure to HTTP %i, records it and releases the lease",
        async (kind, status) => {
          provider.fetchTransactions.mockRejectedValue(
            new BankSyncProviderError(kind, `provider said ${kind}`, 500),
          );

          const error = await sync().catch((e: unknown) => e);

          expect((error as HttpException).getStatus()).toBe(status);
          const failed = statements("last_sync_status = 'failed'")[0];
          expect(failed[1]).toEqual([
            BANK_ACCOUNT_ID,
            USER_ID,
            `provider said ${kind}`,
          ]);
          expect(jobClaims.releaseLease).toHaveBeenCalledTimes(1);
          expect(writer.write).not.toHaveBeenCalled();
        },
      );

      it("marks the connection expired only when the provider says the consent is gone", async () => {
        provider.fetchTransactions.mockRejectedValue(
          new BankSyncProviderError("session_expired", "HTTP 401", 401),
        );
        await expect(sync()).rejects.toBeInstanceOf(ConflictException);
        const expire = statements("SET status = 'expired', last_error")[0];
        expect(String(expire[0])).toContain("status = 'active'");
        expect(expire[1]).toEqual([CONNECTION_ID, USER_ID, "HTTP 401"]);

        manager.query.mockClear();
        provider.fetchTransactions.mockRejectedValue(
          new BankSyncProviderError("unavailable", "down"),
        );
        await expect(sync()).rejects.toBeDefined();
        expect(statements("SET status = 'expired'")).toHaveLength(0);
      });

      it("records a refusal from the write and raises it, leaving the lease released", async () => {
        writer.write.mockRejectedValue(
          new ConflictException("linked to a different account"),
        );
        await expect(sync()).rejects.toBeInstanceOf(ConflictException);
        expect(statements("last_sync_status = 'failed'")[0][1]).toEqual([
          BANK_ACCOUNT_ID,
          USER_ID,
          "linked to a different account",
        ]);
        expect(jobClaims.releaseLease).toHaveBeenCalledTimes(1);
      });

      it("stores a fixed sentence, not the text, of an unexpected error", async () => {
        writer.write.mockRejectedValue(
          new Error("insert failed: password=hunter2"),
        );
        await expect(sync()).rejects.toThrow("hunter2");
        const stored = statements("last_sync_status = 'failed'")[0][1][2];
        expect(stored).not.toContain("hunter2");
      });

      it("still raises the original error when recording it fails", async () => {
        provider.fetchTransactions.mockRejectedValue(
          new BankSyncProviderError("unavailable", "down"),
        );
        manager.query.mockRejectedValue(new Error("db gone"));
        await expect(sync()).rejects.toBeInstanceOf(HttpException);
      });
    });
  });

  describe("linkDefaults", () => {
    const defaults = (accountId = ACCOUNT_ID, userId = USER_ID) =>
      service.linkDefaults(userId, BANK_ACCOUNT_ID, accountId);

    const newestTransaction = (newest: string | null) =>
      manager.query.mockImplementation(async (sql: string) =>
        String(sql).includes("MAX(t.transaction_date)") ? [{ newest }] : [],
      );

    it("answers the newest transaction and the day after it", async () => {
      newestTransaction("2026-09-10");
      await expect(defaults()).resolves.toEqual({
        newestTransactionDate: "2026-09-10",
        defaultSyncFromDate: "2026-09-11",
      });
    });

    it("answers no newest transaction and the lookback date for an empty account", async () => {
      newestTransaction(null);
      await expect(defaults()).resolves.toEqual({
        newestTransactionDate: null,
        defaultSyncFromDate: "2026-07-03",
      });
    });

    it("is the date a link without a chosen date gets: one definition", async () => {
      linkRepo.findOne.mockResolvedValue(
        bankAccountRow({ accountId: null, syncFromDate: null }),
      );
      newestTransaction("2026-09-10");
      const shown = await defaults();
      const linked = await service.linkAccount(USER_ID, BANK_ACCOUNT_ID, {
        accountId: ACCOUNT_ID,
      });
      expect(linked.syncFromDate).toBe(shown.defaultSyncFromDate);
    });

    it("writes nothing and reads only the caller's rows", async () => {
      newestTransaction("2026-09-10");
      await defaults();
      expect(linkRepo.save).not.toHaveBeenCalled();
      expect(linkRepo.findOne).toHaveBeenCalledWith({
        where: { id: BANK_ACCOUNT_ID, userId: USER_ID },
      });
      expect(accountRepo.findOne).toHaveBeenCalledWith({
        where: { id: ACCOUNT_ID, userId: USER_ID },
      });
      expect(statements("MAX(t.transaction_date)")[0][1]).toEqual([
        ACCOUNT_ID,
        USER_ID,
      ]);
    });

    it("is 404 for a bank account that is not the caller's", async () => {
      linkRepo.findOne.mockResolvedValue(null);
      await expect(defaults(ACCOUNT_ID, OTHER_USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(statements("MAX(t.transaction_date)")).toHaveLength(0);
    });

    it("is 400 for an account that is not the caller's", async () => {
      accountRepo.findOne.mockResolvedValue(null);
      await expect(defaults(OTHER_ACCOUNT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(statements("MAX(t.transaction_date)")).toHaveLength(0);
    });
  });

  describe("previewAccount", () => {
    const PREVIEW = { planFingerprint: "f".repeat(64) } as never;
    const preview = (
      psu: { ipAddress: string; userAgent: string } | null = null,
    ) => service.previewAccount(USER_ID, BANK_ACCOUNT_ID, psu);

    beforeEach(() => {
      previewer.build.mockResolvedValue(PREVIEW);
    });

    it("plans exactly what a sync plans and hands it to the previewer, writing nothing", async () => {
      provider.fetchTransactions.mockResolvedValue([
        bankTransaction({ entryReference: "ref-1" }),
        bankTransaction({ entryReference: "ref-2", currencyCode: "EUR" }),
        bankTransaction({ entryReference: "ref-3", booked: false }),
        bankTransaction({ entryReference: "ref-4", bookingDate: "2026-07-01" }),
      ]);
      provider.fetchBalance.mockResolvedValue({
        amount: "1500.5",
        currencyCode: "PLN",
        referenceDate: "2026-09-29",
        balanceType: "CLBD",
      });

      await expect(preview()).resolves.toBe(PREVIEW);

      expect(writer.write).not.toHaveBeenCalled();
      expect(netWorth.triggerDebouncedRecalc).not.toHaveBeenCalled();
      const input = previewer.build.mock.calls[0][0];
      expect(input).toMatchObject({
        userId: USER_ID,
        bankAccountId: BANK_ACCOUNT_ID,
        accountId: ACCOUNT_ID,
        plannedSyncFromDate: "2026-08-01",
        plannedCurrencyCode: "PLN",
        balance: { amount: 1500.5, currencyCode: "PLN" },
      });
      expect(input.explained.plan.planned.map((p) => p.externalKey)).toEqual([
        "ref:ref-1",
      ]);
      expect(input.explained.entries.map((e) => e.outcome)).toEqual([
        "planned",
        "refused",
        "pending",
        "before_cutoff",
      ]);
    });

    it("is a user-present read of the same window as a sync", async () => {
      const psu = { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" };
      await preview(psu);
      expect(provider.fetchTransactions).toHaveBeenCalledWith(
        CREDS,
        "ext-1",
        { dateFrom: "2026-08-01", dateTo: "2026-09-30" },
        psu,
      );
      expect(provider.fetchBalance).toHaveBeenCalledWith(CREDS, "ext-1", psu);
    });

    it("takes the sync's lease, so a preview during a sync is a 409, and gives it back", async () => {
      jobClaims.claimLease.mockResolvedValue(null);
      await expect(preview()).rejects.toBeInstanceOf(ConflictException);
      expect(provider.fetchTransactions).not.toHaveBeenCalled();
      expect(jobClaims.claimLease).toHaveBeenCalledWith(
        "bank_sync_account",
        USER_ID,
        BANK_ACCOUNT_ID,
        30 * 60 * 1000,
      );

      jobClaims.claimLease.mockResolvedValue(TEST_LEASE_TOKEN);
      await preview();
      expect(jobClaims.releaseLease).toHaveBeenCalledWith(
        "bank_sync_account",
        USER_ID,
        BANK_ACCOUNT_ID,
        TEST_LEASE_TOKEN,
      );
    });

    it("records no failure on the bank account, even when the bank fails", async () => {
      provider.fetchTransactions.mockRejectedValue(
        new BankSyncProviderError("unavailable", "down"),
      );
      await expect(preview()).rejects.toBeInstanceOf(HttpException);
      expect(statements("last_sync_status = 'failed'")).toHaveLength(0);
      expect(jobClaims.releaseLease).toHaveBeenCalledTimes(1);
    });

    it("refuses an unlinked bank account and a connection that cannot be read, asking nothing", async () => {
      linkRepo.findOne.mockResolvedValue(bankAccountRow({ accountId: null }));
      await expect(preview()).rejects.toBeInstanceOf(ConflictException);

      linkRepo.findOne.mockResolvedValue(bankAccountRow());
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "expired" }),
      );
      await expect(preview()).rejects.toBeInstanceOf(ConflictException);
      expect(jobClaims.claimLease).not.toHaveBeenCalled();
      expect(provider.fetchTransactions).not.toHaveBeenCalled();
      expect(statements("last_sync_status = 'failed'")).toHaveLength(0);
    });

    it("asks nothing of the bank inside a transaction", async () => {
      let open = 0;
      dataSource.transaction.mockImplementation(
        async (fn: (m: unknown) => Promise<unknown>) => {
          open += 1;
          try {
            return await fn(manager);
          } finally {
            open -= 1;
          }
        },
      );
      const seen: number[] = [];
      provider.fetchTransactions.mockImplementation(async () => {
        seen.push(open);
        return [];
      });
      await preview();
      expect(seen).toEqual([0]);
    });
  });

  describe("a sync that carries the preview's fingerprint", () => {
    const FINGERPRINT = "a".repeat(64);

    it("hands it to the write, which recomputes the plan under the row lock", async () => {
      await service.syncAccount(USER_ID, BANK_ACCOUNT_ID, null, FINGERPRINT);
      expect(writer.write.mock.calls[0][0].expectedFingerprint).toBe(
        FINGERPRINT,
      );
    });

    it("sends none when the caller has none (the daily sync)", async () => {
      await service.syncAccount(USER_ID, BANK_ACCOUNT_ID, null);
      expect(writer.write.mock.calls[0][0].expectedFingerprint).toBeUndefined();
    });

    it("answers the write's 409 as it is, and records no failed sync: nothing was attempted", async () => {
      writer.write.mockRejectedValue(
        new BankSyncPlanChangedException("the bank's data changed"),
      );
      await expect(
        service.syncAccount(USER_ID, BANK_ACCOUNT_ID, null, FINGERPRINT),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(statements("last_sync_status = 'failed'")).toHaveLength(0);
      expect(jobClaims.releaseLease).toHaveBeenCalledTimes(1);
    });
  });

  describe("a sync that carries the person's selection (spec section 7b)", () => {
    const FINGERPRINT = "a".repeat(64);
    const SELECTION = { importKeys: ["ref:a"], excludeKeys: ["ref:b"] };

    it("hands the selection to the write beside the fingerprint", async () => {
      await service.syncAccount(
        USER_ID,
        BANK_ACCOUNT_ID,
        null,
        FINGERPRINT,
        SELECTION,
      );
      const input = writer.write.mock.calls[0][0];
      expect(input.expectedFingerprint).toBe(FINGERPRINT);
      expect(input.selection).toEqual(SELECTION);
    });

    it("sends none when the caller has none: every new row is imported, as it always was", async () => {
      await service.syncAccount(USER_ID, BANK_ACCOUNT_ID, null, FINGERPRINT);
      expect(writer.write.mock.calls[0][0].selection).toBeUndefined();
    });

    it("refuses a key in both lists with 400 before the bank is read or the lease taken", async () => {
      await expect(
        service.syncAccount(USER_ID, BANK_ACCOUNT_ID, null, FINGERPRINT, {
          importKeys: ["ref:a"],
          excludeKeys: ["ref:a"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.fetchTransactions).not.toHaveBeenCalled();
      expect(jobClaims.claimLease).not.toHaveBeenCalled();
      expect(writer.write).not.toHaveBeenCalled();
    });

    it("answers the write's 400 for a key outside the plan as it is, and records no failed sync: nothing was attempted", async () => {
      writer.write.mockRejectedValue(
        new BankSyncSelectionRefusedException("not a new row"),
      );
      await expect(
        service.syncAccount(
          USER_ID,
          BANK_ACCOUNT_ID,
          null,
          FINGERPRINT,
          SELECTION,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(statements("last_sync_status = 'failed'")).toHaveLength(0);
      expect(jobClaims.releaseLease).toHaveBeenCalledTimes(1);
    });

    it("reports the rows it added to the exceptions", async () => {
      writer.write.mockResolvedValue({ imported: 1, skipped: 0, excluded: 3 });
      const result = await service.syncAccount(
        USER_ID,
        BANK_ACCOUNT_ID,
        null,
        FINGERPRINT,
        SELECTION,
      );
      expect(result).toMatchObject({ imported: 1, excluded: 3 });
    });

    it("still drops what depends on the balance only when a row was imported", async () => {
      writer.write.mockResolvedValue({ imported: 0, skipped: 0, excluded: 2 });
      await service.syncAccount(
        USER_ID,
        BANK_ACCOUNT_ID,
        null,
        FINGERPRINT,
        SELECTION,
      );
      expect(netWorth.triggerDebouncedRecalc).not.toHaveBeenCalled();
    });
  });

  describe("tagging with the bank's operation type (spec section 7b)", () => {
    it.each([true, false])(
      "gives the write the connection's setting (%p), for the user's sync and the daily one alike",
      async (tagOperationType) => {
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ tagOperationType }),
        );
        await service.syncAccount(USER_ID, BANK_ACCOUNT_ID, null);
        await service.syncAccountEntry(USER_ID, BANK_ACCOUNT_ID, null);
        expect(
          writer.write.mock.calls.map((call) => call[0].tagOperationType),
        ).toEqual([tagOperationType, tagOperationType]);
      },
    );

    it.each([true, false])(
      "gives the preview the connection's setting (%p)",
      async (tagOperationType) => {
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ tagOperationType }),
        );
        previewer.build.mockResolvedValue({} as never);
        await service.previewAccount(USER_ID, BANK_ACCOUNT_ID, null);
        expect(previewer.build.mock.calls[0][0].tagOperationType).toBe(
          tagOperationType,
        );
      },
    );
  });

  describe("the institution's profile (docs/future-plans/source-profiles.md)", () => {
    it.each([
      ["PKO Bank Polski", "PL", "pl/pko-bp"],
      ["  pko BANK   polski ", "pl", "pl/pko-bp"],
      ["Test Bank", "PL", "default"],
      ["PKO Bank Polski", "DE", "default"],
    ])(
      "hands the write and the preview the profile of %p (%s): %s",
      async (institutionName, institutionCountry, profileId) => {
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ institutionName, institutionCountry }),
        );
        previewer.build.mockResolvedValue({} as never);
        await service.syncAccount(USER_ID, BANK_ACCOUNT_ID, null);
        await service.syncAccountEntry(USER_ID, BANK_ACCOUNT_ID, null);
        await service.previewAccount(USER_ID, BANK_ACCOUNT_ID, null);
        expect([
          ...writer.write.mock.calls.map((call) => call[0].profile.id),
          previewer.build.mock.calls[0][0].profile.id,
        ]).toEqual([profileId, profileId, profileId]);
      },
    );
  });

  describe("removeExceptions (spec section 7b)", () => {
    it("deletes only the ledger rows that are exceptions, for the caller's linked account, under the bank account's lock", async () => {
      manager.query.mockResolvedValue([{ id: "l1" }, { id: "l2" }]);

      const result = await service.removeExceptions(USER_ID, BANK_ACCOUNT_ID, [
        "ref:a",
        "ref:b",
      ]);

      expect(result).toEqual({ removed: 2 });
      expect(linkRepo.findOne).toHaveBeenCalledWith({
        where: { id: BANK_ACCOUNT_ID, userId: USER_ID },
        lock: { mode: "pessimistic_write" },
      });
      const [sql, params] = manager.query.mock.calls[0];
      expect(String(sql)).toMatch(
        /^\s*DELETE FROM bank_sync_imported_transactions/,
      );
      expect(String(sql)).toContain("excluded_at IS NOT NULL");
      expect(String(sql)).toContain("transaction_id IS NULL");
      expect(String(sql)).toContain("external_key = ANY($3::varchar[])");
      expect(params).toEqual([USER_ID, ACCOUNT_ID, ["ref:a", "ref:b"]]);
    });

    it("counts only what was removed: a key that is not an exception removes nothing", async () => {
      manager.query.mockResolvedValue([]);
      await expect(
        service.removeExceptions(USER_ID, BANK_ACCOUNT_ID, ["ref:imported"]),
      ).resolves.toEqual({ removed: 0 });
    });

    it("sends each key once", async () => {
      await service.removeExceptions(USER_ID, BANK_ACCOUNT_ID, [
        "ref:a",
        "ref:a",
        "ref:b",
      ]);
      expect(manager.query.mock.calls[0][1][2]).toEqual(["ref:a", "ref:b"]);
    });

    it("is 404 for a bank account that is not the caller's, deleting nothing", async () => {
      linkRepo.findOne.mockResolvedValue(null);
      await expect(
        service.removeExceptions(USER_ID, BANK_ACCOUNT_ID, ["ref:a"]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("is 409 for a bank account that is not linked: there is no ledger to take them from", async () => {
      linkRepo.findOne.mockResolvedValue(bankAccountRow({ accountId: null }));
      await expect(
        service.removeExceptions(USER_ID, BANK_ACCOUNT_ID, ["ref:a"]),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("takes no lease and asks nothing of the bank", async () => {
      await service.removeExceptions(USER_ID, BANK_ACCOUNT_ID, ["ref:a"]);
      expect(jobClaims.claimLease).not.toHaveBeenCalled();
      expect(provider.fetchTransactions).not.toHaveBeenCalled();
    });
  });

  describe("syncAccountEntry", () => {
    const attempt = () =>
      jest.spyOn(
        service as unknown as {
          attemptAccountSync: BankSyncService["syncAccount"];
        },
        "attemptAccountSync",
      );

    it("answers the result of a sync that worked", async () => {
      const result = { bankAccountId: BANK_ACCOUNT_ID, imported: 2 };
      attempt().mockResolvedValue(result as never);
      await expect(
        service.syncAccountEntry(USER_ID, BANK_ACCOUNT_ID, null),
      ).resolves.toBe(result);
    });

    it("answers a failure as data with the provider's own kind as the code, never throwing", async () => {
      attempt().mockRejectedValue(
        new BankSyncProviderError("session_expired", "gone", 401),
      );
      const entry = await service.syncAccountEntry(
        USER_ID,
        BANK_ACCOUNT_ID,
        null,
      );
      // The HTTP mapping of the same failure is a 409 that loses the kind.
      expect(entry).toMatchObject({
        bankAccountId: BANK_ACCOUNT_ID,
        error: { code: "session_expired" },
      });
    });

    it("names a lost lease 'sync_running' and records nothing on the account", async () => {
      jobClaims.claimLease.mockResolvedValue(null);
      const entry = await service.syncAccountEntry(
        USER_ID,
        BANK_ACCOUNT_ID,
        null,
      );
      expect(entry).toMatchObject({
        bankAccountId: BANK_ACCOUNT_ID,
        error: { code: "sync_running" },
      });
      expect(provider.fetchTransactions).not.toHaveBeenCalled();
      expect(statements("last_sync_status = 'failed'")).toHaveLength(0);
    });

    it("names unreadable credentials 'credentials', not a generic refusal", async () => {
      credentials.resolveCredentials.mockRejectedValue(
        new BankSyncCredentialsUnavailableException("no credentials"),
      );
      const entry = await service.syncAccountEntry(
        USER_ID,
        BANK_ACCOUNT_ID,
        null,
      );
      expect(entry).toMatchObject({ error: { code: "credentials" } });
    });
  });

  describe("syncConnection", () => {
    // A bank account whose first import has been confirmed (it has a success):
    // the ones that still need their preview are built explicitly below.
    const linked = (id: string) =>
      bankAccountRow({
        id,
        connectionId: CONNECTION_ID,
        lastSuccessAt: new Date("2026-09-20T05:00:00.000Z"),
      });
    const unconfirmed = (id: string) =>
      bankAccountRow({ id, connectionId: CONNECTION_ID, lastSuccessAt: null });
    const ID_A = "b0b0b0b0-0000-4000-8000-00000000000a";
    const ID_B = "b0b0b0b0-0000-4000-8000-00000000000b";
    const ID_C = "b0b0b0b0-0000-4000-8000-00000000000c";

    /** `syncConnection` reports failures as data, so it calls the raw attempt. */
    const attempt = () =>
      jest.spyOn(
        service as unknown as {
          attemptAccountSync: BankSyncService["syncAccount"];
        },
        "attemptAccountSync",
      );

    function resultOf(id: string) {
      return {
        bankAccountId: id,
        imported: 1,
        skipped: 0,
        excluded: 0,
        refused: {
          missing_date: 0,
          future_date: 0,
          invalid_amount: 0,
          unknown_direction: 0,
          currency_mismatch: 0,
        },
        pending: 0,
        beforeCutoff: 0,
        bankBalance: null,
      };
    }

    it("is 404 for a connection that is not the caller's", async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.syncConnection(OTHER_USER_ID, CONNECTION_ID, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("syncs each linked bank account in turn and skips unlinked ones", async () => {
      linkRepo.find.mockResolvedValue([
        linked(ID_A),
        bankAccountRow({ id: ID_B, accountId: null }),
        linked(ID_C),
      ]);
      const spy = attempt().mockImplementation(async (_user, id) =>
        resultOf(id),
      );

      const results = await service.syncConnection(
        USER_ID,
        CONNECTION_ID,
        null,
      );

      expect(spy.mock.calls.map((call) => call[1])).toEqual([ID_A, ID_C]);
      expect(results.map((r) => r.bankAccountId)).toEqual([ID_A, ID_C]);
    });

    it("carries on after one account fails and answers one entry per linked account", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A), linked(ID_C)]);
      attempt().mockImplementation(async (_u, id) => {
        if (id === ID_A) throw new ConflictException("busy");
        return resultOf(id);
      });
      const results = await service.syncConnection(
        USER_ID,
        CONNECTION_ID,
        null,
      );
      expect(results).toEqual([
        {
          bankAccountId: ID_A,
          error: { code: "refused", message: "busy" },
        },
        resultOf(ID_C),
      ]);
    });

    it("keeps the provider's error kind as the code and the HTTP mapping's translated message, end to end", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A)]);
      provider.fetchTransactions.mockRejectedValue(
        new BankSyncProviderError("rate_limited", "429 from the bank", 429),
      );
      const [failed] = await service.syncConnection(
        USER_ID,
        CONNECTION_ID,
        null,
      );
      expect(failed).toEqual({
        bankAccountId: ID_A,
        error: {
          code: "rate_limited",
          message:
            "The bank or the provider limited how often this account can be read. Banks allow only a few unattended reads a day; try again later.",
        },
      });
      // The failure is still recorded on the bank account.
      expect(statements("last_sync_status = 'failed'")).toHaveLength(1);
    });

    it("reports a raw provider error under its kind", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A)]);
      attempt().mockRejectedValue(
        new BankSyncProviderError("unavailable", "gateway down", 502),
      );
      const [failed] = await service.syncConnection(
        USER_ID,
        CONNECTION_ID,
        null,
      );
      expect(failed).toEqual({
        bankAccountId: ID_A,
        error: {
          code: "unavailable",
          message:
            "The bank sync provider did not answer. Nothing was changed; try again later.",
        },
      });
    });

    it("never puts an unexpected error's own text in the answer", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A)]);
      attempt().mockRejectedValue(new Error("password=hunter2 at 10.0.0.1"));
      const [failed] = await service.syncConnection(
        USER_ID,
        CONNECTION_ID,
        null,
      );
      expect(failed).toEqual({
        bankAccountId: ID_A,
        error: {
          code: "unexpected",
          message:
            "The sync failed unexpectedly. The server log has the details.",
        },
      });
      expect(JSON.stringify(failed)).not.toContain("hunter2");
    });

    it("answers every failure as an entry when nothing succeeded, never as nothing new and never as a throw", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A), linked(ID_C)]);
      attempt().mockRejectedValue(new ConflictException("consent expired"));
      const results = await service.syncConnection(
        USER_ID,
        CONNECTION_ID,
        null,
      );
      expect(results).toEqual([
        {
          bankAccountId: ID_A,
          error: { code: "refused", message: "consent expired" },
        },
        {
          bankAccountId: ID_C,
          error: { code: "refused", message: "consent expired" },
        },
      ]);
    });

    it("throws before any account is attempted when the connection is not active", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A), linked(ID_C)]);
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "failed" }),
      );
      const spy = attempt();
      await expect(
        service.syncConnection(USER_ID, CONNECTION_ID, null),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(spy).not.toHaveBeenCalled();
    });

    it("throws before any account is attempted when the consent has lapsed, recording the lapse", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A)]);
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ validUntil: new Date(Date.now() - 1000) }),
      );
      const spy = attempt();
      await expect(
        service.syncConnection(USER_ID, CONNECTION_ID, null),
      ).rejects.toThrow(/expired or was withdrawn/);
      expect(spy).not.toHaveBeenCalled();
      expect(statements("SET status = 'expired'")).toHaveLength(1);
    });

    it("throws before any account is attempted when the credentials cannot be read", async () => {
      linkRepo.find.mockResolvedValue([linked(ID_A), linked(ID_C)]);
      credentials.resolveCredentials.mockRejectedValue(
        new BadRequestException("no credentials"),
      );
      const spy = attempt();
      await expect(
        service.syncConnection(USER_ID, CONNECTION_ID, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(spy).not.toHaveBeenCalled();
    });

    describe("a bank account that still needs its preview (spec section 7a)", () => {
      it("is reported as needs_preview and not synced, read or recorded", async () => {
        linkRepo.find.mockResolvedValue([
          linked(ID_A),
          unconfirmed(ID_B),
          linked(ID_C),
        ]);
        const spy = attempt().mockImplementation(async (_user, id) =>
          resultOf(id),
        );

        const results = await service.syncConnection(
          USER_ID,
          CONNECTION_ID,
          null,
        );

        // The others sync, in order; the unconfirmed one is never attempted.
        expect(spy.mock.calls.map((call) => call[1])).toEqual([ID_A, ID_C]);
        expect(results).toEqual([
          resultOf(ID_A),
          {
            bankAccountId: ID_B,
            error: {
              code: "needs_preview",
              message: expect.stringContaining("preview"),
            },
          },
          resultOf(ID_C),
        ]);
        expect(provider.fetchTransactions).not.toHaveBeenCalled();
        // Nothing was attempted, so nothing is recorded as a failed sync.
        expect(statements("last_sync_status = 'failed'")).toHaveLength(0);
      });

      it("reads nothing from the bank when every linked account needs its preview", async () => {
        linkRepo.find.mockResolvedValue([unconfirmed(ID_A), unconfirmed(ID_B)]);
        const spy = attempt();
        const results = await service.syncConnection(
          USER_ID,
          CONNECTION_ID,
          null,
        );
        expect(results.map((r) => "error" in r && r.error.code)).toEqual([
          "needs_preview",
          "needs_preview",
        ]);
        expect(spy).not.toHaveBeenCalled();
        // Nothing to sync, so the credentials are not even resolved.
        expect(credentials.resolveCredentials).not.toHaveBeenCalled();
        expect(provider.fetchTransactions).not.toHaveBeenCalled();
      });

      it("still imports the account when the person confirms it through the single-account sync", async () => {
        // The confirmation is `POST /bank-sync/accounts/:id/sync`, which is
        // `syncAccount`: only the connection-wide route and the daily sync skip.
        const spy = attempt().mockImplementation(async (_user, id) =>
          resultOf(id),
        );
        await expect(service.syncAccount(USER_ID, ID_B, null)).resolves.toEqual(
          resultOf(ID_B),
        );
        expect(spy).toHaveBeenCalledWith(
          USER_ID,
          ID_B,
          null,
          undefined,
          undefined,
        );
      });
    });

    it("answers an empty list for a connection with no linked account", async () => {
      linkRepo.find.mockResolvedValue([bankAccountRow({ accountId: null })]);
      await expect(
        service.syncConnection(USER_ID, CONNECTION_ID, null),
      ).resolves.toEqual([]);
    });
  });
});
