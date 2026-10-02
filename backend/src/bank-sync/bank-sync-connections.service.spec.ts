import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  AUTH_STATE_TTL_MS,
  MAX_CONSENT_VALIDITY_DAYS,
  SECONDS_PER_DAY,
} from "./bank-sync.constants";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { BankSyncMatchService } from "./bank-sync-match.service";
import {
  BankSyncConnectionsService,
  consentValiditySeconds,
  hashAuthState,
  newAuthState,
} from "./bank-sync-connections.service";
import {
  bankAccountRow,
  BANK_ACCOUNT_ID,
  CONNECTION_ID,
  connectionRow,
  fakeProvider,
  fakeRegistry,
  institution,
  OTHER_USER_ID,
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

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe("consentValiditySeconds", () => {
  const cap = MAX_CONSENT_VALIDITY_DAYS * SECONDS_PER_DAY;

  it("asks for the institution's maximum when it is below the cap", () => {
    expect(consentValiditySeconds(90 * SECONDS_PER_DAY)).toBe(
      90 * SECONDS_PER_DAY,
    );
  });

  it("caps a longer maximum at 180 days", () => {
    expect(consentValiditySeconds(365 * SECONDS_PER_DAY)).toBe(cap);
  });

  it.each([null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "asks for the cap when the bank stated %p",
    (stated) => {
      expect(consentValiditySeconds(stated)).toBe(cap);
    },
  );
});

describe("auth state", () => {
  it("is 32 random bytes as base64url, distinct every time", () => {
    const a = newAuthState();
    const b = newAuthState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("is stored as its SHA-256 hex", () => {
    expect(hashAuthState("abc")).toBe(sha256("abc"));
  });
});

describe("BankSyncConnectionsService", () => {
  const provider = fakeProvider();
  const registry = fakeRegistry(provider);
  const credentials: jest.Mocked<
    Pick<BankSyncCredentialsService, "resolveCredentials" | "redirectUrl">
  > = {
    resolveCredentials: jest.fn(),
    redirectUrl: jest.fn(),
  };
  const matcher: jest.Mocked<Pick<BankSyncMatchService, "match">> = {
    match: jest.fn(),
  };
  const connectionRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
  };
  const accountRepo = {
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [BankSyncConnection, connectionRepo],
    [BankSyncAccount, accountRepo],
  ]);

  const CREDS = { applicationId: "app-1", privateKeyPem: "PEM" };

  let service: BankSyncConnectionsService;

  /** The UPDATE/DELETE tuple the postgres driver answers with. */
  const tuple = (rows: unknown[]) => [rows, rows.length];

  const statements = (needle: string) =>
    manager.query.mock.calls.filter((call) => String(call[0]).includes(needle));

  /**
   * The statement that records a failed authorization. It fails only a
   * `pending` (first-time) connection and leaves every other status alone.
   */
  const failureStatements = () => statements("last_error = $3");
  const expectFailsOnlyPending = (sql: unknown) => {
    expect(String(sql)).toMatch(
      /status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END/,
    );
    // Never an unconditional status write.
    expect(String(sql)).not.toMatch(/status = 'failed'/);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    credentials.resolveCredentials.mockResolvedValue(CREDS);
    credentials.redirectUrl.mockReturnValue(
      "https://money.example.com/settings/bank-sync/callback",
    );
    provider.listInstitutions.mockResolvedValue([institution()]);
    provider.startAuthorization.mockResolvedValue({
      url: "https://bank.example/auth",
    });
    manager.query.mockResolvedValue([]);
    matcher.match.mockResolvedValue({ linked: [], suggestions: [] });
    accountRepo.find.mockResolvedValue([]);
    accountRepo.create.mockImplementation((row: unknown) => row);
    accountRepo.save.mockImplementation(async (row: unknown) => row);
    connectionRepo.save.mockImplementation(async (row: unknown) => row);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BankSyncConnectionsService,
        { provide: DataSource, useValue: dataSource },
        { provide: BankSyncCredentialsService, useValue: credentials },
        { provide: BankSyncProviderRegistry, useValue: registry },
        { provide: BankSyncMatchService, useValue: matcher },
      ],
    }).compile();
    service = module.get(BankSyncConnectionsService);
  });

  describe("matchAccounts (POST /connections/:id/match)", () => {
    it("matches with a provider read allowed, passing the person at the keyboard, and answers the refreshed connection", async () => {
      const psu = { ipAddress: "203.0.113.4", userAgent: "UA" };
      matcher.match.mockResolvedValue({
        linked: [{ bankAccountId: BANK_ACCOUNT_ID, accountId: "acc-1" }],
        suggestions: [],
      });
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      accountRepo.find.mockResolvedValue([bankAccountRow()]);

      const answer = await service.matchAccounts(USER_ID, CONNECTION_ID, psu);

      expect(matcher.match).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, {
        fetchMissing: true,
        psu,
      });
      expect(answer.linked).toHaveLength(1);
      expect(answer.connection.id).toBe(CONNECTION_ID);
      expect(answer.connection.accounts).toHaveLength(1);
    });

    it("does not hide a failure of the match: the user asked for it", async () => {
      matcher.match.mockRejectedValue(new NotFoundException("gone"));
      await expect(
        service.matchAccounts(USER_ID, CONNECTION_ID, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("listInstitutions", () => {
    it("lists the provider's banks with the consent length in days", async () => {
      provider.listInstitutions.mockResolvedValue([
        institution({ maximumConsentValiditySeconds: 90 * SECONDS_PER_DAY }),
        institution({ name: "No Limit", maximumConsentValiditySeconds: null }),
        institution({ name: "Hours", maximumConsentValiditySeconds: 3600 }),
      ]);

      const result = await service.listInstitutions(USER_ID, "pl");

      expect(provider.listInstitutions).toHaveBeenCalledWith(CREDS, "PL");
      expect(result.map((i) => i.maximumConsentValidityDays)).toEqual([
        90,
        null,
        1,
      ]);
    });

    it.each(["", "POL", "1A", "P"])(
      "refuses the country %p",
      async (country) => {
        await expect(
          service.listInstitutions(USER_ID, country),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(provider.listInstitutions).not.toHaveBeenCalled();
      },
    );

    it("maps an unreachable provider to a 503, never an empty list", async () => {
      provider.listInstitutions.mockRejectedValue(
        new BankSyncProviderError("unavailable", "down"),
      );
      await expect(
        service.listInstitutions(USER_ID, "PL"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe("start", () => {
    const dto = {
      institutionName: "Test Bank",
      country: "PL",
      psuType: "personal" as const,
    };

    beforeEach(() => {
      manager.query.mockResolvedValue([{ id: CONNECTION_ID }]);
    });

    it("stores only the state's hash, then asks the provider after the commit", async () => {
      const order: string[] = [];
      dataSource.transaction.mockImplementationOnce(
        async (fn: (m: unknown) => Promise<unknown>) => {
          const result = await fn(manager);
          order.push("commit");
          return result;
        },
      );
      provider.startAuthorization.mockImplementation(async () => {
        order.push("provider");
        return { url: "https://bank.example/auth" };
      });

      const result = await service.start(USER_ID, dto);

      expect(order).toEqual(["commit", "provider"]);
      expect(result).toEqual({
        connectionId: CONNECTION_ID,
        authorizationUrl: "https://bank.example/auth",
      });
      const input = provider.startAuthorization.mock.calls[0][1];
      const insert = statements("INSERT INTO bank_sync_connections")[0];
      const params = insert[1] as string[];
      // The stored value is the hash of the state the provider was given, and
      // the state itself is nowhere in the statement.
      expect(params[5]).toBe(sha256(input.state));
      expect(params).not.toContain(input.state);
      expect(String(insert[0])).not.toContain(input.state);
      expect(String(insert[0])).toContain("'pending'");
      expect(input).toMatchObject({
        institutionName: "Test Bank",
        country: "PL",
        psuType: "personal",
        redirectUrl: "https://money.example.com/settings/bank-sync/callback",
      });
    });

    it("asks for the institution's maximum consent when it is under 180 days", async () => {
      const before = Date.now();
      await service.start(USER_ID, dto);
      const { validUntil } = provider.startAuthorization.mock.calls[0][1];
      const days = (validUntil.getTime() - before) / (SECONDS_PER_DAY * 1000);
      expect(days).toBeGreaterThan(89.99);
      expect(days).toBeLessThan(90.01);
    });

    it("caps a longer maximum at 180 days", async () => {
      provider.listInstitutions.mockResolvedValue([
        institution({ maximumConsentValiditySeconds: 400 * SECONDS_PER_DAY }),
      ]);
      const before = Date.now();
      await service.start(USER_ID, dto);
      const { validUntil } = provider.startAuthorization.mock.calls[0][1];
      const days = (validUntil.getTime() - before) / (SECONDS_PER_DAY * 1000);
      expect(days).toBeGreaterThan(179.99);
      expect(days).toBeLessThan(180.01);
    });

    it("asks for 180 days when the bank states no maximum", async () => {
      provider.listInstitutions.mockResolvedValue([
        institution({ maximumConsentValiditySeconds: null }),
      ]);
      const before = Date.now();
      await service.start(USER_ID, dto);
      const { validUntil } = provider.startAuthorization.mock.calls[0][1];
      expect(
        Math.round((validUntil.getTime() - before) / (SECONDS_PER_DAY * 1000)),
      ).toBe(180);
    });

    it("refuses an institution the provider does not list, writing nothing", async () => {
      await expect(
        service.start(USER_ID, { ...dto, institutionName: "Nope Bank" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.query).not.toHaveBeenCalled();
      expect(provider.startAuthorization).not.toHaveBeenCalled();
    });

    it("refuses a kind of access the bank does not offer", async () => {
      provider.listInstitutions.mockResolvedValue([
        institution({ psuTypes: ["personal"] }),
      ]);
      await expect(
        service.start(USER_ID, { ...dto, psuType: "business" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("compares the kind of access case-insensitively", async () => {
      provider.listInstitutions.mockResolvedValue([
        institution({ psuTypes: ["Personal", " BUSINESS "] }),
      ]);
      await expect(
        service.start(USER_ID, { ...dto, psuType: "personal" }),
      ).resolves.toMatchObject({ connectionId: CONNECTION_ID });
      await expect(
        service.start(USER_ID, { ...dto, psuType: "business" }),
      ).resolves.toMatchObject({ connectionId: CONNECTION_ID });
    });

    it("allows any kind of access when the bank lists none", async () => {
      provider.listInstitutions.mockResolvedValue([
        institution({ psuTypes: [] }),
      ]);
      await expect(
        service.start(USER_ID, { ...dto, psuType: "business" }),
      ).resolves.toMatchObject({ connectionId: CONNECTION_ID });
    });

    it("marks the row failed with a bounded message when the provider refuses, and maps the error", async () => {
      provider.startAuthorization.mockRejectedValue(
        new BankSyncProviderError("unavailable", "gateway down", 502),
      );

      await expect(service.start(USER_ID, dto)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      const failed = failureStatements()[0];
      expect(failed[1]).toEqual([
        CONNECTION_ID,
        USER_ID,
        "gateway down",
        sha256(provider.startAuthorization.mock.calls[0][1].state),
      ]);
      expectFailsOnlyPending(failed[0]);
    });

    it("still raises the provider's error when recording the failure fails too", async () => {
      provider.startAuthorization.mockRejectedValue(
        new BankSyncProviderError("unavailable", "down"),
      );
      const logged = jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);
      manager.query
        .mockResolvedValueOnce([{ id: CONNECTION_ID }])
        .mockRejectedValueOnce(new Error("db gone"));
      await expect(service.start(USER_ID, dto)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(logged).toHaveBeenCalledTimes(1);
    });
  });

  describe("reauthorize", () => {
    it("is 404 for a connection that is not the caller's", async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.reauthorize(OTHER_USER_ID, CONNECTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(connectionRepo.findOne).toHaveBeenCalledWith({
        where: { id: CONNECTION_ID, userId: OTHER_USER_ID },
      });
      expect(provider.startAuthorization).not.toHaveBeenCalled();
    });

    it("issues a new state on the same row and keeps its accounts", async () => {
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      manager.query.mockResolvedValue(tuple([{ id: CONNECTION_ID }]));

      const result = await service.reauthorize(USER_ID, CONNECTION_ID);

      expect(result.connectionId).toBe(CONNECTION_ID);
      const update = statements("SET auth_state_hash = $3")[0];
      // A renewal writes the new state and its start time and nothing else: the
      // status of a working connection is not its business.
      expect(String(update[0])).toContain(
        "auth_started_at = CURRENT_TIMESTAMP",
      );
      expect(String(update[0])).not.toMatch(/status/);
      expect(String(update[0])).not.toMatch(/last_error/);
      expect(String(update[0])).not.toContain("DELETE");
      const input = provider.startAuthorization.mock.calls[0][1];
      expect(update[1]).toEqual([CONNECTION_ID, USER_ID, sha256(input.state)]);
      expect(input.psuType).toBe("personal");
    });

    it("is 404 when the row vanished before the update", async () => {
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      manager.query.mockResolvedValue(tuple([]));
      await expect(
        service.reauthorize(USER_ID, CONNECTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(provider.startAuthorization).not.toHaveBeenCalled();
    });

    it("records the failure without touching the status of a working connection when the provider refuses", async () => {
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      manager.query.mockResolvedValue(tuple([{ id: CONNECTION_ID }]));
      provider.startAuthorization.mockRejectedValue(
        new BankSyncProviderError("bad_request", "bad redirect", 422),
      );
      await expect(
        service.reauthorize(USER_ID, CONNECTION_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(failureStatements()).toHaveLength(1);
      expectFailsOnlyPending(failureStatements()[0][0]);
    });
  });

  describe("completeCallback", () => {
    const STATE = "s".repeat(43);
    // A session with no account is refused (see below), so the default has one.
    const session = (
      accounts: BankAccountDescriptor[] = [descriptor()],
    ): Awaited<ReturnType<typeof provider.completeAuthorization>> => ({
      sessionId: "session-9",
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
      accounts,
    });
    const descriptor = (
      over: Partial<BankAccountDescriptor> = {},
    ): BankAccountDescriptor => ({
      externalAccountId: "ext-new",
      identificationHash: "hash-1",
      displayName: "Main",
      identifierMasked: "**** 1234",
      accountIdentifier: null,
      cashAccountType: null,
      currencyCode: "PLN",
      ...over,
    });

    /** The claim answers with the row; everything else with nothing. */
    function claimWins(provider_: string = "enable_banking") {
      manager.query.mockImplementation(async (sql: string) =>
        String(sql).includes("SET auth_state_hash = NULL")
          ? tuple([{ id: CONNECTION_ID, provider: provider_ }])
          : [],
      );
    }
    const claimStatement = () => statements("SET auth_state_hash = NULL")[0];

    it("claims by (user, hash of the state, not older than the TTL), whatever the status", async () => {
      claimWins();
      provider.completeAuthorization.mockResolvedValue(session());
      const pending = connectionRow({ status: "pending" });
      connectionRepo.findOne.mockResolvedValue(pending);

      await service.completeCallback(USER_ID, { state: STATE, code: "code-1" });

      const [sql, params] = claimStatement();
      expect(String(sql)).toContain("user_id = $1");
      expect(String(sql)).toContain("auth_state_hash = $2");
      // A renewal claims an `active` connection: the status is no condition.
      expect(String(sql)).not.toMatch(/status/);
      expect(String(sql)).toContain("auth_started_at >");
      expect(params).toEqual([
        USER_ID,
        sha256(STATE),
        String(AUTH_STATE_TTL_MS),
      ]);
      // The state itself is never in the statement or its parameters.
      expect(params).not.toContain(STATE);
    });

    it("refuses with the same 400 when nothing is claimed: replayed, expired or another user's state", async () => {
      manager.query.mockResolvedValue(tuple([]));
      const error = await service
        .completeCallback(OTHER_USER_ID, { state: STATE, code: "code-1" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(
        /invalid|expired|already used/i,
      );
      expect(claimStatement()[1]).toEqual([
        OTHER_USER_ID,
        sha256(STATE),
        String(AUTH_STATE_TTL_MS),
      ]);
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
      expect(credentials.resolveCredentials).not.toHaveBeenCalled();
    });

    it("does not spend the state on a callback that says nothing", async () => {
      await expect(
        service.completeCallback(USER_ID, { state: STATE }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.completeCallback(USER_ID, {
          state: STATE,
          code: "  ",
          error: " ",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("records the bank's refusal in the claiming transaction and returns the connection", async () => {
      claimWins();
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "failed", lastError: "User cancelled" }),
      );
      accountRepo.find.mockResolvedValue([bankAccountRow()]);

      const { connection: view } = await service.completeCallback(USER_ID, {
        state: STATE,
        error: "access_denied",
        errorDescription: "User cancelled",
      });

      const failed = failureStatements()[0];
      expect(failed[1]).toEqual([CONNECTION_ID, USER_ID, "User cancelled"]);
      expectFailsOnlyPending(failed[0]);
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
      expect(view.status).toBe("failed");
      expect(view.lastError).toBe("User cancelled");
    });

    it("bounds the bank's description to 500 characters and falls back to the code", async () => {
      claimWins();
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      await service.completeCallback(USER_ID, {
        state: STATE,
        error: "access_denied",
        errorDescription: "d".repeat(900),
      });
      expect((failureStatements()[0][1] as string[])[2]).toHaveLength(500);

      manager.query.mockClear();
      claimWins();
      await service.completeCallback(USER_ID, {
        state: STATE,
        error: "access_denied",
      });
      expect((failureStatements()[0][1] as string[])[2]).toBe("access_denied");
    });

    it("exchanges the code outside the claiming transaction, then activates", async () => {
      claimWins();
      const order: string[] = [];
      dataSource.transaction.mockImplementation(
        async (fn: (m: unknown) => Promise<unknown>) => {
          order.push("tx-start");
          const result = await fn(manager);
          order.push("tx-end");
          return result;
        },
      );
      provider.completeAuthorization.mockImplementation(async () => {
        order.push("provider");
        return session([descriptor()]);
      });
      const pending = connectionRow({ status: "pending" });
      connectionRepo.findOne.mockResolvedValue(pending);

      const { connection: view } = await service.completeCallback(USER_ID, {
        state: STATE,
        code: "code-1",
      });

      // Claim tx, then the provider with no transaction open, then the second tx.
      expect(order.slice(0, 3)).toEqual(["tx-start", "tx-end", "provider"]);
      expect(provider.completeAuthorization).toHaveBeenCalledWith(
        CREDS,
        "code-1",
      );
      expect(pending).toMatchObject({
        status: "active",
        externalSessionId: "session-9",
        lastError: null,
      });
      expect(pending.validUntil).toEqual(new Date("2026-12-01T00:00:00.000Z"));
      expect(view.status).toBe("active");
      // The response has no session id.
      expect(JSON.stringify(view)).not.toContain("session-9");
    });

    it("stores the bank account's identifier and type on insert, and keeps known ones a session omits", async () => {
      claimWins();
      provider.completeAuthorization.mockResolvedValue(
        session([
          descriptor({
            identificationHash: null,
            accountIdentifier: "PL61109010140000071219812874",
            cashAccountType: "CARD",
          }),
        ]),
      );
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "pending" }),
      );
      await service.completeCallback(USER_ID, { state: STATE, code: "c" });
      expect(accountRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountIdentifier: "PL61109010140000071219812874",
          cashAccountType: "CARD",
        }),
      );

      // A re-authorization that omits them keeps what was learned before.
      const existing = bankAccountRow({
        externalAccountId: "ext-new",
        identificationHash: "hash-1",
        accountIdentifier: "XX1",
        cashAccountType: "CACC",
      });
      accountRepo.find.mockResolvedValue([existing]);
      provider.completeAuthorization.mockResolvedValue(session([descriptor()]));
      claimWins();
      await service.completeCallback(USER_ID, { state: STATE, code: "c" });
      expect(existing).toMatchObject({
        accountIdentifier: "XX1",
        cashAccountType: "CACC",
      });

      // ... and takes the new ones when it has them.
      provider.completeAuthorization.mockResolvedValue(
        session([
          descriptor({ accountIdentifier: "XX2", cashAccountType: "SVGS" }),
        ]),
      );
      claimWins();
      await service.completeCallback(USER_ID, { state: STATE, code: "c" });
      expect(existing).toMatchObject({
        accountIdentifier: "XX2",
        cashAccountType: "SVGS",
      });
    });

    describe("matching after the activation commits (spec section 5a)", () => {
      beforeEach(() => {
        claimWins();
        provider.completeAuthorization.mockResolvedValue(session());
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ status: "pending" }),
        );
      });

      it("matches without asking the provider, after the second transaction, and answers what was linked", async () => {
        const order: string[] = [];
        dataSource.transaction.mockImplementation(
          async (fn: (m: unknown) => Promise<unknown>) => {
            order.push("tx");
            return fn(manager);
          },
        );
        matcher.match.mockImplementation(async () => {
          order.push("match");
          return {
            linked: [{ bankAccountId: BANK_ACCOUNT_ID, accountId: "acc-1" }],
            suggestions: [
              { bankAccountId: "bank-2", accountIds: ["acc-2", "acc-3"] },
            ],
          };
        });
        accountRepo.find.mockResolvedValue([bankAccountRow()]);

        const answer = await service.completeCallback(USER_ID, {
          state: STATE,
          code: "c",
        });

        expect(matcher.match).toHaveBeenCalledWith(USER_ID, CONNECTION_ID, {
          fetchMissing: false,
          psu: null,
        });
        // claim tx, activation tx, then the match, then the refreshed view.
        expect(order.slice(0, 3)).toEqual(["tx", "tx", "match"]);
        expect(answer.linked).toEqual([
          { bankAccountId: BANK_ACCOUNT_ID, accountId: "acc-1" },
        ]);
        expect(answer.suggestions).toEqual([
          { bankAccountId: "bank-2", accountIds: ["acc-2", "acc-3"] },
        ]);
        expect(answer.connection.id).toBe(CONNECTION_ID);
        expect(JSON.stringify(answer)).not.toContain("session-9");
      });

      it("answers nothing linked when nothing matched", async () => {
        const answer = await service.completeCallback(USER_ID, {
          state: STATE,
          code: "c",
        });
        expect(answer.linked).toEqual([]);
        expect(answer.suggestions).toEqual([]);
        expect(answer.connection.status).toBe("active");
      });

      it("keeps the activated connection when matching fails, logging it", async () => {
        const warn = jest
          .spyOn(service["logger"], "warn")
          .mockImplementation(() => undefined);
        matcher.match.mockRejectedValue(new Error("db down"));
        const answer = await service.completeCallback(USER_ID, {
          state: STATE,
          code: "c",
        });
        expect(answer.connection.status).toBe("active");
        expect(answer.linked).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
      });

      it("does not match a callback the bank refused", async () => {
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ status: "failed", lastError: "No" }),
        );
        const answer = await service.completeCallback(USER_ID, {
          state: STATE,
          error: "access_denied",
        });
        expect(matcher.match).not.toHaveBeenCalled();
        expect(answer).toMatchObject({ linked: [], suggestions: [] });
        expect(answer.connection.status).toBe("failed");
      });
    });

    it("inserts a new bank account unmapped", async () => {
      claimWins();
      provider.completeAuthorization.mockResolvedValue(
        session([descriptor({ identificationHash: null })]),
      );
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "pending" }),
      );

      await service.completeCallback(USER_ID, { state: STATE, code: "c" });

      expect(accountRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          connectionId: CONNECTION_ID,
          externalAccountId: "ext-new",
          accountId: null,
          syncFromDate: null,
        }),
      );
    });

    it("matches an existing bank account by identification hash, keeping its mapping", async () => {
      claimWins();
      const existing = bankAccountRow({
        externalAccountId: "ext-old",
        identificationHash: "hash-1",
        accountId: "a0a0a0a0-0000-4000-8000-000000000009",
        syncFromDate: "2026-01-01",
        displayName: "Old name",
      });
      accountRepo.find.mockResolvedValue([existing]);
      provider.completeAuthorization.mockResolvedValue(
        session([descriptor({ externalAccountId: "ext-new" })]),
      );
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "pending" }),
      );

      await service.completeCallback(USER_ID, { state: STATE, code: "c" });

      expect(accountRepo.create).not.toHaveBeenCalled();
      expect(existing).toMatchObject({
        externalAccountId: "ext-new",
        displayName: "Main",
        accountId: "a0a0a0a0-0000-4000-8000-000000000009",
        syncFromDate: "2026-01-01",
      });
    });

    it("falls back to the provider's account id when there is no hash, and keeps known values a session omits", async () => {
      claimWins();
      const existing = bankAccountRow({
        externalAccountId: "ext-1",
        identificationHash: null,
        currencyCode: "PLN",
        identifierMasked: "**** 1234",
      });
      accountRepo.find.mockResolvedValue([existing]);
      provider.completeAuthorization.mockResolvedValue(
        session([
          descriptor({
            externalAccountId: "ext-1",
            identificationHash: null,
            currencyCode: null,
            identifierMasked: null,
            displayName: null,
          }),
        ]),
      );
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "pending" }),
      );

      await service.completeCallback(USER_ID, { state: STATE, code: "c" });

      expect(accountRepo.create).not.toHaveBeenCalled();
      expect(existing).toMatchObject({
        currencyCode: "PLN",
        identifierMasked: "**** 1234",
        displayName: "Main account",
      });
    });

    it("adds each account of a session once, and one existing row matches one descriptor", async () => {
      claimWins();
      const existing = bankAccountRow({ identificationHash: "hash-1" });
      accountRepo.find.mockResolvedValue([existing]);
      provider.completeAuthorization.mockResolvedValue(
        session([
          descriptor({
            externalAccountId: "ext-a",
            identificationHash: "hash-1",
          }),
          descriptor({
            externalAccountId: "ext-a",
            identificationHash: "hash-1",
          }),
          descriptor({
            externalAccountId: "ext-b",
            identificationHash: "hash-1",
          }),
        ]),
      );
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "pending" }),
      );

      await service.completeCallback(USER_ID, { state: STATE, code: "c" });

      // ext-a took the existing row; the duplicate was skipped; ext-b, whose
      // hash the row already answered for, is a new unmapped account.
      expect(existing.externalAccountId).toBe("ext-a");
      expect(accountRepo.create).toHaveBeenCalledTimes(1);
      expect(accountRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ externalAccountId: "ext-b" }),
      );
    });

    it("marks the connection failed and maps the error when the code exchange fails", async () => {
      claimWins();
      provider.completeAuthorization.mockRejectedValue(
        new BankSyncProviderError("bad_request", "code already used", 422),
      );
      await expect(
        service.completeCallback(USER_ID, { state: STATE, code: "c" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const failed = failureStatements().find((call) =>
        String(call[0]).includes("IS NOT DISTINCT FROM"),
      )!;
      expect(failed[1]).toEqual([
        CONNECTION_ID,
        USER_ID,
        "code already used",
        null,
      ]);
      expectFailsOnlyPending(failed[0]);
    });

    it("ends a session that lists no account and fails with the no-accounts advice", async () => {
      // A production application in restricted mode is answered with an empty
      // list for an account that was not linked to it (Enable Banking FAQ).
      claimWins();
      provider.completeAuthorization.mockResolvedValue(session([]));
      const error = await service
        .completeCallback(USER_ID, { state: STATE, code: "c" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(
        /Activate by linking accounts/,
      );
      expect(provider.revokeSession).toHaveBeenCalledWith(CREDS, "session-9");
      // Nothing was activated, and the row records why.
      expect(connectionRepo.save).not.toHaveBeenCalled();
      expect(accountRepo.save).not.toHaveBeenCalled();
      const failed = failureStatements().find((call) =>
        String(call[0]).includes("IS NOT DISTINCT FROM"),
      )!;
      expect(failed[1]).toEqual([
        CONNECTION_ID,
        USER_ID,
        "The provider returned a session with no accounts.",
        null,
      ]);
      expectFailsOnlyPending(failed[0]);
    });

    it("marks it failed when the credentials cannot be resolved", async () => {
      claimWins();
      credentials.resolveCredentials.mockRejectedValue(
        new BadRequestException("no credentials"),
      );
      await expect(
        service.completeCallback(USER_ID, { state: STATE, code: "c" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        failureStatements().filter((call) =>
          String(call[0]).includes("IS NOT DISTINCT FROM"),
        ),
      ).toHaveLength(1);
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
    });

    it("revokes the session and marks the row failed when activation is refused", async () => {
      claimWins();
      provider.completeAuthorization.mockResolvedValue(session([descriptor()]));
      // A newer authorization owns the row now: its state is set again.
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "pending", authStateHash: "newer-hash" }),
      );

      await expect(
        service.completeCallback(USER_ID, { state: STATE, code: "c" }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(provider.revokeSession).toHaveBeenCalledWith(CREDS, "session-9");
      expect(connectionRepo.save).not.toHaveBeenCalled();
    });

    describe("a renewal on a connection that already has a session", () => {
      it("activates a connection that is not pending, replacing its session", async () => {
        claimWins();
        provider.completeAuthorization.mockResolvedValue(session());
        const working = connectionRow({
          status: "active",
          externalSessionId: "session-1",
        });
        connectionRepo.findOne.mockResolvedValue(working);

        const { connection: view } = await service.completeCallback(USER_ID, {
          state: STATE,
          code: "c",
        });

        expect(working).toMatchObject({
          status: "active",
          externalSessionId: "session-9",
        });
        expect(view.status).toBe("active");
      });

      it("activates an expired connection", async () => {
        claimWins();
        provider.completeAuthorization.mockResolvedValue(session());
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ status: "expired", externalSessionId: "session-1" }),
        );
        const { connection: view } = await service.completeCallback(USER_ID, {
          state: STATE,
          code: "c",
        });
        expect(view.status).toBe("active");
      });

      it("revokes the previous session after the commit, outside any transaction", async () => {
        claimWins();
        const order: string[] = [];
        dataSource.transaction.mockImplementation(
          async (fn: (m: unknown) => Promise<unknown>) => {
            order.push("tx-start");
            const result = await fn(manager);
            order.push("tx-end");
            return result;
          },
        );
        provider.completeAuthorization.mockResolvedValue(session());
        provider.revokeSession.mockImplementation(async () => {
          order.push("revoke");
        });
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ status: "active", externalSessionId: "session-1" }),
        );

        await service.completeCallback(USER_ID, { state: STATE, code: "c" });

        expect(provider.revokeSession).toHaveBeenCalledTimes(1);
        expect(provider.revokeSession).toHaveBeenCalledWith(CREDS, "session-1");
        expect(order.slice(-2)).toEqual(["tx-end", "revoke"]);
      });

      it("does not revoke when there was no previous session, or it is the same one", async () => {
        claimWins();
        provider.completeAuthorization.mockResolvedValue(session());
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ status: "pending", externalSessionId: null }),
        );
        await service.completeCallback(USER_ID, { state: STATE, code: "c" });

        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ status: "active", externalSessionId: "session-9" }),
        );
        await service.completeCallback(USER_ID, { state: STATE, code: "c" });

        expect(provider.revokeSession).not.toHaveBeenCalled();
      });

      it("still succeeds, logging safely, when revoking the previous session fails", async () => {
        claimWins();
        provider.completeAuthorization.mockResolvedValue(session());
        provider.revokeSession.mockRejectedValue(
          new BankSyncProviderError("unavailable", "down"),
        );
        const warn = jest
          .spyOn(service["logger"], "warn")
          .mockImplementation(() => undefined);
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({ status: "active", externalSessionId: "session-1" }),
        );

        const { connection: view } = await service.completeCallback(USER_ID, {
          state: STATE,
          code: "c",
        });

        expect(view.status).toBe("active");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).not.toContain("PEM");
      });

      it("does not revoke the previous session when activation is refused", async () => {
        claimWins();
        provider.completeAuthorization.mockResolvedValue(session());
        connectionRepo.findOne.mockResolvedValue(
          connectionRow({
            status: "active",
            externalSessionId: "session-1",
            authStateHash: "newer-hash",
          }),
        );
        await expect(
          service.completeCallback(USER_ID, { state: STATE, code: "c" }),
        ).rejects.toBeInstanceOf(ConflictException);
        // Only the new, unusable session is dropped; the working one stays.
        expect(provider.revokeSession).toHaveBeenCalledTimes(1);
        expect(provider.revokeSession).toHaveBeenCalledWith(CREDS, "session-9");
      });
    });

    it("refuses activation when the connection was deleted meanwhile", async () => {
      claimWins();
      provider.completeAuthorization.mockResolvedValue(session());
      connectionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.completeCallback(USER_ID, { state: STATE, code: "c" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(provider.revokeSession).toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns each connection with only its own bank accounts, and no session id", async () => {
      const other = connectionRow({
        id: "c0c0c0c0-0000-4000-8000-000000000002",
        externalSessionId: "session-2",
      });
      connectionRepo.find.mockResolvedValue([connectionRow(), other]);
      accountRepo.find.mockResolvedValue([
        bankAccountRow({ bankBalance: 1234.5 }),
        bankAccountRow({
          id: "b0b0b0b0-0000-4000-8000-000000000002",
          connectionId: other.id,
        }),
      ]);

      const views = await service.list(USER_ID);

      expect(views.map((v) => v.accounts.map((a) => a.id))).toEqual([
        [BANK_ACCOUNT_ID],
        ["b0b0b0b0-0000-4000-8000-000000000002"],
      ]);
      expect(views[0].accounts[0].bankBalance).toBe("1234.5000");
      expect(views[1].accounts[0].bankBalance).toBeNull();
      const serialized = JSON.stringify(views);
      expect(serialized).not.toMatch(
        /session-1|session-2|externalSessionId|authStateHash/,
      );
    });

    it("is empty without reading accounts when there are no connections", async () => {
      connectionRepo.find.mockResolvedValue([]);
      await expect(service.list(USER_ID)).resolves.toEqual([]);
      expect(accountRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("updateConnection", () => {
    it("sets autoSync and returns the connection", async () => {
      manager.query.mockResolvedValue(tuple([{ id: CONNECTION_ID }]));
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ autoSync: false }),
      );
      const view = await service.updateConnection(USER_ID, CONNECTION_ID, {
        autoSync: false,
      });
      expect(manager.query.mock.calls[0][1]).toEqual([
        CONNECTION_ID,
        USER_ID,
        false,
        null,
        null,
      ]);
      expect(view.autoSync).toBe(false);
    });

    it("sets only the operation-type tagging when only that is sent, and returns it", async () => {
      manager.query.mockResolvedValue(tuple([{ id: CONNECTION_ID }]));
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ tagOperationType: false }),
      );
      const view = await service.updateConnection(USER_ID, CONNECTION_ID, {
        tagOperationType: false,
      });
      expect(String(manager.query.mock.calls[0][0])).toContain(
        "tag_operation_type = COALESCE($5, tag_operation_type)",
      );
      expect(manager.query.mock.calls[0][1]).toEqual([
        CONNECTION_ID,
        USER_ID,
        null,
        null,
        false,
      ]);
      expect(view.tagOperationType).toBe(false);
    });

    it("can switch the tagging back on: false is a value, not an absent field", async () => {
      manager.query.mockResolvedValue(tuple([{ id: CONNECTION_ID }]));
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      await service.updateConnection(USER_ID, CONNECTION_ID, {
        tagOperationType: true,
      });
      expect(manager.query.mock.calls[0][1]).toEqual([
        CONNECTION_ID,
        USER_ID,
        null,
        null,
        true,
      ]);
    });

    it("returns the tagging setting in every connection view", async () => {
      connectionRepo.find.mockResolvedValue([connectionRow()]);
      accountRepo.find.mockResolvedValue([]);
      const [view] = await service.list(USER_ID);
      expect(view.tagOperationType).toBe(true);
    });

    it("sets only the success mode when only that is sent, and returns it", async () => {
      manager.query.mockResolvedValue(tuple([{ id: CONNECTION_ID }]));
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ notifySuccess: "never" }),
      );
      const view = await service.updateConnection(USER_ID, CONNECTION_ID, {
        notifySuccess: "never",
      });
      // COALESCE over the stored value: an omitted field passes NULL and keeps
      // what the row holds, so one setting never resets the other.
      expect(String(manager.query.mock.calls[0][0])).toContain(
        "auto_sync = COALESCE($3, auto_sync)",
      );
      expect(manager.query.mock.calls[0][1]).toEqual([
        CONNECTION_ID,
        USER_ID,
        null,
        "never",
        null,
      ]);
      expect(view.notifySuccess).toBe("never");
    });

    it("is 404 for a connection that is not the caller's", async () => {
      manager.query.mockResolvedValue(tuple([]));
      await expect(
        service.updateConnection(OTHER_USER_ID, CONNECTION_ID, {
          autoSync: true,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses a patch that changes nothing, before any write", async () => {
      await expect(
        service.updateConnection(USER_ID, CONNECTION_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("asks the provider to end the session, then deletes the row", async () => {
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      await service.disconnect(USER_ID, CONNECTION_ID);
      expect(provider.revokeSession).toHaveBeenCalledWith(CREDS, "session-1");
      expect(connectionRepo.delete).toHaveBeenCalledWith({
        id: CONNECTION_ID,
        userId: USER_ID,
      });
    });

    it("deletes the row even when the provider refuses, and logs the failure", async () => {
      connectionRepo.findOne.mockResolvedValue(connectionRow());
      provider.revokeSession.mockRejectedValue(
        new BankSyncProviderError("unavailable", "down"),
      );
      const warn = jest
        .spyOn(service["logger"], "warn")
        .mockImplementation(() => undefined);

      await service.disconnect(USER_ID, CONNECTION_ID);

      expect(connectionRepo.delete).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("skips the provider for a connection that never had a session", async () => {
      connectionRepo.findOne.mockResolvedValue(
        connectionRow({ status: "pending", externalSessionId: null }),
      );
      await service.disconnect(USER_ID, CONNECTION_ID);
      expect(provider.revokeSession).not.toHaveBeenCalled();
      expect(connectionRepo.delete).toHaveBeenCalled();
    });

    it("is 404 for a connection that is not the caller's, deleting nothing", async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.disconnect(OTHER_USER_ID, CONNECTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(connectionRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe("getView and listAccounts", () => {
    it("is 404 for a connection that is not the caller's", async () => {
      connectionRepo.findOne.mockResolvedValue(null);
      await expect(
        service.getView(OTHER_USER_ID, CONNECTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("lists the bank accounts of one connection as views", async () => {
      accountRepo.find.mockResolvedValue([bankAccountRow()]);
      const accounts = await service.listAccounts(USER_ID, CONNECTION_ID);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe(BANK_ACCOUNT_ID);
    });
  });
});
