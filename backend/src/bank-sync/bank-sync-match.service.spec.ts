import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { BankSyncMatchService } from "./bank-sync-match.service";
import { BankSyncService } from "./bank-sync.service";
import {
  ACCOUNT_ID,
  BANK_ACCOUNT_ID,
  bankAccountRow,
  CONNECTION_ID,
  connectionRow,
  fakeProvider,
  fakeRegistry,
  USER_ID,
} from "./bank-sync-testing";
import { BankSyncAccount } from "./entities/bank-sync-account.entity";
import { BankSyncConnection } from "./entities/bank-sync-connection.entity";
import { BankSyncProviderError } from "./providers/bank-sync-provider.errors";
import type { BankAccountDescriptor } from "./providers/bank-sync-provider.interface";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const IBAN = "PL61109010140000071219812874";
const NRB = "61 1090 1014 0000 0712 1981 2874";
const OTHER_BANK_ACCOUNT_ID = "b0b0b0b0-0000-4000-8000-000000000002";
const OTHER_ACCOUNT_ID = "a0a0a0a0-0000-4000-8000-000000000002";
const THIRD_ACCOUNT_ID = "a0a0a0a0-0000-4000-8000-000000000003";
const PSU = { ipAddress: "203.0.113.4", userAgent: "Mozilla/5.0" };
const CREDS = { applicationId: "app-1", privateKeyPem: "PEM" };

describe("BankSyncMatchService", () => {
  const provider = fakeProvider();
  const registry = fakeRegistry(provider);
  const credentials: jest.Mocked<
    Pick<BankSyncCredentialsService, "resolveCredentials">
  > = { resolveCredentials: jest.fn() };
  const bankSync: jest.Mocked<Pick<BankSyncService, "linkAccount">> = {
    linkAccount: jest.fn(),
  };
  const connectionRepo = { findOne: jest.fn() };
  const bankAccountRepo = { find: jest.fn() };
  const accountRepo = { find: jest.fn() };
  const { manager, dataSource } = createScopedDbMocks([
    [BankSyncConnection, connectionRepo],
    [BankSyncAccount, bankAccountRepo],
    [Account, accountRepo],
  ]);

  let service: BankSyncMatchService;

  const unlinked = (over: Partial<BankSyncAccount> = {}) =>
    bankAccountRow({
      accountId: null,
      syncFromDate: null,
      accountIdentifier: IBAN,
      ...over,
    });

  const monize = (over: Partial<Account> = {}): Account =>
    ({
      id: ACCOUNT_ID,
      userId: USER_ID,
      accountNumber: NRB,
      currencyCode: "PLN",
      isClosed: false,
      accountSubType: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      ...over,
    }) as Account;

  /** `find` on the bank accounts answers the connection's rows, then the user's. */
  function bankAccounts(rows: BankSyncAccount[], linkedIds: string[] = []) {
    bankAccountRepo.find.mockImplementation(
      async (options: { select?: object }) =>
        options.select ? linkedIds.map((accountId) => ({ accountId })) : rows,
    );
  }

  const run = (fetchMissing = false) =>
    service.match(USER_ID, CONNECTION_ID, { fetchMissing, psu: PSU });

  beforeEach(async () => {
    jest.clearAllMocks();
    credentials.resolveCredentials.mockResolvedValue(CREDS);
    connectionRepo.findOne.mockResolvedValue(connectionRow());
    bankAccounts([unlinked()]);
    accountRepo.find.mockResolvedValue([monize()]);
    manager.query.mockResolvedValue([]);
    bankSync.linkAccount.mockResolvedValue({} as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankSyncMatchService,
        { provide: DataSource, useValue: dataSource },
        { provide: BankSyncCredentialsService, useValue: credentials },
        { provide: BankSyncProviderRegistry, useValue: registry },
        { provide: BankSyncService, useValue: bankSync },
      ],
    }).compile();
    service = module.get(BankSyncMatchService);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
  });

  describe("linking", () => {
    it("links the one account whose number names the identifier, through the ordinary link path with the default cut-off", async () => {
      await expect(run()).resolves.toEqual({
        linked: [{ bankAccountId: BANK_ACCOUNT_ID, accountId: ACCOUNT_ID }],
        suggestions: [],
      });
      // No date is sent: linkAccount defaults the cut-off (spec section 7).
      expect(bankSync.linkAccount).toHaveBeenCalledWith(
        USER_ID,
        BANK_ACCOUNT_ID,
        { accountId: ACCOUNT_ID },
      );
    });

    it("writes the link only through linkAccount, never itself", async () => {
      await run();
      expect(
        manager.query.mock.calls.filter((c) =>
          /UPDATE bank_sync_accounts/.test(String(c[0])),
        ),
      ).toHaveLength(0);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("links nothing and offers every candidate when two accounts match", async () => {
      accountRepo.find.mockResolvedValue([
        monize(),
        monize({ id: OTHER_ACCOUNT_ID, accountNumber: IBAN }),
      ]);
      await expect(run()).resolves.toEqual({
        linked: [],
        suggestions: [
          {
            bankAccountId: BANK_ACCOUNT_ID,
            accountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
          },
        ],
      });
      expect(bankSync.linkAccount).not.toHaveBeenCalled();
    });

    it("leaves a bank account that is already linked alone", async () => {
      bankAccounts([unlinked({ accountId: OTHER_ACCOUNT_ID })]);
      await expect(run()).resolves.toEqual({ linked: [], suggestions: [] });
      expect(bankSync.linkAccount).not.toHaveBeenCalled();
    });

    it("does not offer an account another bank account is linked to", async () => {
      bankAccounts([unlinked()], [ACCOUNT_ID]);
      await expect(run()).resolves.toEqual({ linked: [], suggestions: [] });
    });

    it("skips closed, brokerage and other-currency accounts", async () => {
      accountRepo.find.mockResolvedValue([
        monize({ isClosed: true }),
        monize({
          id: OTHER_ACCOUNT_ID,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        }),
        monize({ id: THIRD_ACCOUNT_ID, currencyCode: "EUR" }),
      ]);
      await expect(run()).resolves.toEqual({ linked: [], suggestions: [] });
    });

    it("reads only the caller's own accounts and bank accounts", async () => {
      await run();
      expect(connectionRepo.findOne).toHaveBeenCalledWith({
        where: { id: CONNECTION_ID, userId: USER_ID },
      });
      expect(accountRepo.find.mock.calls[0][0].where).toEqual({
        userId: USER_ID,
        isClosed: false,
      });
      for (const [options] of bankAccountRepo.find.mock.calls) {
        expect(options.where.userId).toBe(USER_ID);
      }
    });

    it("is 404 for a connection that is not the caller's", async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      await expect(run()).rejects.toBeInstanceOf(NotFoundException);
    });

    it("logs and skips a link the ordinary path refuses, still linking the others", async () => {
      bankAccounts([
        unlinked(),
        unlinked({
          id: OTHER_BANK_ACCOUNT_ID,
          externalAccountId: "ext-2",
          accountIdentifier: "DE89370400440532013000",
        }),
      ]);
      accountRepo.find.mockResolvedValue([
        monize(),
        monize({
          id: OTHER_ACCOUNT_ID,
          accountNumber: "DE89 3704 0044 0532 0130 00",
        }),
      ]);
      bankSync.linkAccount.mockRejectedValueOnce(
        new BadRequestException("That account is already linked."),
      );

      const result = await run();

      expect(result.linked).toEqual([
        { bankAccountId: OTHER_BANK_ACCOUNT_ID, accountId: OTHER_ACCOUNT_ID },
      ]);
      expect(bankSync.linkAccount).toHaveBeenCalledTimes(2);
      expect(service["logger"].warn).toHaveBeenCalledTimes(1);
    });

    it("each link is its own call, in the order of the bank accounts", async () => {
      bankAccounts([
        unlinked(),
        unlinked({
          id: OTHER_BANK_ACCOUNT_ID,
          externalAccountId: "ext-2",
          accountIdentifier: "DE89370400440532013000",
        }),
      ]);
      accountRepo.find.mockResolvedValue([
        monize({
          id: OTHER_ACCOUNT_ID,
          accountNumber: "DE89 3704 0044 0532 0130 00",
        }),
        monize(),
      ]);
      const result = await run();
      expect(result.linked.map((l) => l.bankAccountId)).toEqual([
        BANK_ACCOUNT_ID,
        OTHER_BANK_ACCOUNT_ID,
      ]);
    });
  });

  describe("without fetchMissing (after the callback)", () => {
    it("asks the provider nothing and leaves an account without an identifier out", async () => {
      bankAccounts([unlinked({ accountIdentifier: null })]);
      await expect(run(false)).resolves.toEqual({
        linked: [],
        suggestions: [],
      });
      expect(provider.fetchAccountDetails).not.toHaveBeenCalled();
      expect(credentials.resolveCredentials).not.toHaveBeenCalled();
    });
  });

  describe("with fetchMissing (match on request)", () => {
    const details = (
      over: Partial<BankAccountDescriptor> = {},
    ): BankAccountDescriptor => ({
      externalAccountId: "ext-1",
      identificationHash: "hash-1",
      displayName: null,
      identifierMasked: "**** 2874",
      accountIdentifier: IBAN,
      cashAccountType: "CACC",
      currencyCode: "PLN",
      ...over,
    });

    /** First read: no identifier yet. After the UPDATE: the stored one. */
    function identifierArrivesWithDetails() {
      let stored = false;
      bankAccountRepo.find.mockImplementation(
        async (options: { select?: object }) =>
          options.select
            ? []
            : [unlinked({ accountIdentifier: stored ? IBAN : null })],
      );
      manager.query.mockImplementation(async (sql: string) => {
        if (/UPDATE bank_sync_accounts/.test(String(sql))) stored = true;
        return [];
      });
    }

    it("reads the details outside any transaction, stores them, then matches and links", async () => {
      identifierArrivesWithDetails();
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
      provider.fetchAccountDetails.mockImplementation(async () => {
        seen.push(open);
        return details();
      });

      const result = await run(true);

      expect(seen).toEqual([0]);
      expect(provider.fetchAccountDetails).toHaveBeenCalledWith(
        CREDS,
        "ext-1",
        PSU,
      );
      const update = manager.query.mock.calls.find((c) =>
        /UPDATE bank_sync_accounts/.test(String(c[0])),
      )!;
      expect(update[1]).toEqual([
        BANK_ACCOUNT_ID,
        USER_ID,
        IBAN,
        "CACC",
        "PLN",
      ]);
      expect(String(update[0])).toContain("user_id = $2");
      expect(result.linked).toEqual([
        { bankAccountId: BANK_ACCOUNT_ID, accountId: ACCOUNT_ID },
      ]);
    });

    it("keeps what is stored when the bank states nothing (COALESCE)", async () => {
      identifierArrivesWithDetails();
      provider.fetchAccountDetails.mockResolvedValue(
        details({ accountIdentifier: null, cashAccountType: null }),
      );
      await run(true);
      const update = manager.query.mock.calls.find((c) =>
        /UPDATE bank_sync_accounts/.test(String(c[0])),
      )!;
      expect(String(update[0])).toMatch(
        /account_identifier = COALESCE\(\$3, account_identifier\)/,
      );
      expect(String(update[0])).toMatch(
        /cash_account_type = COALESCE\(\$4, cash_account_type\)/,
      );
      expect(String(update[0])).toMatch(
        /currency_code = COALESCE\(currency_code, \$5\)/,
      );
    });

    it("reads details only for unlinked accounts that lack an identifier", async () => {
      bankAccounts([
        unlinked({ accountIdentifier: null, id: OTHER_BANK_ACCOUNT_ID }),
        unlinked({ accountIdentifier: null, accountId: OTHER_ACCOUNT_ID }),
        unlinked({ accountIdentifier: IBAN, externalAccountId: "ext-3" }),
      ]);
      provider.fetchAccountDetails.mockResolvedValue(details());
      await run(true);
      expect(provider.fetchAccountDetails).toHaveBeenCalledTimes(1);
    });

    it("asks the provider nothing when every account already has its identifier", async () => {
      await run(true);
      expect(provider.fetchAccountDetails).not.toHaveBeenCalled();
      expect(credentials.resolveCredentials).not.toHaveBeenCalled();
    });

    it("refuses a connection that cannot be read when details are needed, before asking the bank", async () => {
      bankAccounts([unlinked({ accountIdentifier: null })]);
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "expired" }),
      );
      await expect(run(true)).rejects.toBeInstanceOf(ConflictException);
      expect(provider.fetchAccountDetails).not.toHaveBeenCalled();

      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ validUntil: new Date(Date.now() - 1000) }),
      );
      await expect(run(true)).rejects.toBeInstanceOf(ConflictException);
    });

    it("goes on past an account whose details cannot be read, and matches the others", async () => {
      bankAccounts([
        unlinked({ accountIdentifier: null }),
        unlinked({
          id: OTHER_BANK_ACCOUNT_ID,
          externalAccountId: "ext-2",
          accountIdentifier: null,
        }),
      ]);
      provider.fetchAccountDetails
        .mockRejectedValueOnce(new BankSyncProviderError("unavailable", "down"))
        .mockResolvedValueOnce(details({ externalAccountId: "ext-2" }));
      await expect(run(true)).resolves.toBeDefined();
      expect(provider.fetchAccountDetails).toHaveBeenCalledTimes(2);
      expect(service["logger"].warn).toHaveBeenCalledTimes(1);
    });

    it("reports the bank's failure, not 'no match', when no details could be read at all", async () => {
      bankAccounts([unlinked({ accountIdentifier: null })]);
      provider.fetchAccountDetails.mockRejectedValue(
        new BankSyncProviderError("unavailable", "down"),
      );
      await expect(run(true)).rejects.toMatchObject({ status: 503 });
      expect(bankSync.linkAccount).not.toHaveBeenCalled();
    });
  });
});
