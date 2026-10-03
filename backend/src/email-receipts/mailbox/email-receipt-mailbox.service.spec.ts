import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import * as safeUrl from "../../ai/validators/safe-url.validator";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { User } from "../../users/entities/user.entity";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import type { ImapMailboxClient } from "../imap/imap-mailbox-client";
import { OAuthReconnectRequiredError } from "../oauth/oauth-errors";
import type { OAuthAccessTokenService } from "../oauth/oauth-access-token.service";
import { EmailReceiptMailboxService } from "./email-receipt-mailbox.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const PASSWORD = "app-password-123";

/** A stand-in for EncryptionService that is visibly not the identity function. */
const encryption = {
  isConfigured: jest.fn(() => true),
  encrypt: jest.fn((s: string) => `enc(${s.split("").reverse().join("")})`),
  decrypt: jest.fn((s: string) =>
    s
      .replace(/^enc\(|\)$/g, "")
      .split("")
      .reverse()
      .join(""),
  ),
};

function stored(over: Partial<EmailReceiptMailbox> = {}): EmailReceiptMailbox {
  return Object.assign(new EmailReceiptMailbox(), {
    id: "mb-1",
    userId: USER,
    host: "8.8.8.8",
    port: 993,
    security: "tls",
    username: "receipts@example.com",
    passwordEnc: encryption.encrypt(PASSWORD),
    authMethod: "password",
    oauthProvider: null,
    oauthRefreshTokenEnc: null,
    folder: "INBOX",
    enabled: true,
    aiMode: "off",
    autoApply: false,
    uidValidity: "77",
    lastUid: "40",
    lastPolledAt: new Date("2026-09-29T10:00:00Z"),
    lastSuccessAt: new Date("2026-09-29T10:00:00Z"),
    lastError: "old error",
    lastErrorAt: new Date("2026-09-28T10:00:00Z"),
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-29T10:00:00Z"),
    ...over,
  });
}

const REFRESH = "refresh-token-abc";
const ACCESS = "access-token-xyz";

function storedOAuth(
  over: Partial<EmailReceiptMailbox> = {},
): EmailReceiptMailbox {
  return stored({
    host: "imap.gmail.com",
    username: "receipts@gmail.example",
    authMethod: "oauth2",
    oauthProvider: "google",
    passwordEnc: null,
    oauthRefreshTokenEnc: encryption.encrypt(REFRESH),
    ...over,
  });
}

const dto = (over: Record<string, unknown> = {}) =>
  ({
    host: "8.8.8.8",
    port: 993,
    security: "tls",
    username: "receipts@example.com",
    enabled: true,
    aiMode: "off",
    autoApply: false,
    ...over,
  }) as never;

function setup() {
  const mailboxRepo = {
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    create: jest.fn((v: Partial<EmailReceiptMailbox>) =>
      Object.assign(new EmailReceiptMailbox(), v),
    ),
    save: jest.fn(async (v: EmailReceiptMailbox) =>
      Object.assign(v, {
        id: "mb-new",
        createdAt: new Date("2026-09-30T00:00:00Z"),
        updatedAt: new Date("2026-09-30T00:00:00Z"),
        lastPolledAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastErrorAt: null,
      }),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const userRepo = { findOne: jest.fn().mockResolvedValue({ role: "user" }) };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceiptMailbox, mailboxRepo],
    [User, userRepo],
  ]);
  manager.query.mockResolvedValue([]);
  const storedQuery = { result: null as EmailReceiptMailbox | null };
  mailboxRepo.createQueryBuilder.mockImplementation(() => {
    const qb = {
      addSelect: jest.fn(() => qb),
      where: jest.fn(() => qb),
      getOne: jest.fn(async () => storedQuery.result),
    };
    return qb;
  });
  const imap = {
    testConnection: jest.fn(),
    fetchSince: jest.fn(),
  } as jest.Mocked<ImapMailboxClient>;
  const oauthAccess = { obtain: jest.fn() };
  const service = new EmailReceiptMailboxService(
    dataSource as unknown as DataSource,
    encryption as never,
    imap,
    oauthAccess as unknown as OAuthAccessTokenService,
  );
  return {
    service,
    mailboxRepo,
    userRepo,
    manager,
    imap,
    storedQuery,
    oauthAccess,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  encryption.isConfigured.mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

describe("EmailReceiptMailboxService.getView", () => {
  it("is null when no mailbox is set up", async () => {
    const { service, storedQuery } = setup();
    storedQuery.result = null;
    await expect(service.getView(USER)).resolves.toBeNull();
  });

  it("never carries the password, and says one is stored", async () => {
    const { service, storedQuery } = setup();
    storedQuery.result = stored();

    const view = await service.getView(USER);

    expect(view).toMatchObject({
      id: "mb-1",
      host: "8.8.8.8",
      authMethod: "password",
      oauthProvider: null,
      passwordSet: true,
      oauthConnected: false,
      encryptionConfigured: true,
      lastError: "old error",
      lastPolledAt: "2026-09-29T10:00:00.000Z",
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("passwordEnc");
    expect(text).not.toContain("enc(");
    expect(view).not.toHaveProperty("uidValidity");
    expect(view).not.toHaveProperty("userId");
  });

  it("shows an OAuth2 mailbox as connected, without any token or a password", async () => {
    const { service, storedQuery } = setup();
    storedQuery.result = stored({
      authMethod: "oauth2",
      oauthProvider: "google",
      passwordEnc: null,
      oauthRefreshTokenEnc: encryption.encrypt("refresh-token-abc"),
    });

    const view = await service.getView(USER);

    expect(view).toMatchObject({
      authMethod: "oauth2",
      oauthProvider: "google",
      passwordSet: false,
      oauthConnected: true,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain("refresh-token-abc");
    expect(text).not.toContain("enc(");
    expect(text).not.toContain("oauthRefreshTokenEnc");
  });

  it("shows a disconnected OAuth2 mailbox as not connected", async () => {
    const { service, storedQuery } = setup();
    storedQuery.result = stored({
      authMethod: "oauth2",
      oauthProvider: "microsoft",
      passwordEnc: null,
      oauthRefreshTokenEnc: null,
    });
    await expect(service.getView(USER)).resolves.toMatchObject({
      oauthProvider: "microsoft",
      oauthConnected: false,
      passwordSet: false,
    });
  });

  it("reports whether this server can encrypt a password at all", async () => {
    const { service, storedQuery } = setup();
    storedQuery.result = stored();
    encryption.isConfigured.mockReturnValue(false);
    await expect(service.getView(USER)).resolves.toMatchObject({
      encryptionConfigured: false,
    });
  });
});

describe("EmailReceiptMailboxService.upsert", () => {
  it("creates a mailbox with the password encrypted, and requires one", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(null);

    const view = await service.upsert(USER, dto({ password: PASSWORD }));

    expect(mailboxRepo.save).toHaveBeenCalledTimes(1);
    const saved = mailboxRepo.save.mock.calls[0][0];
    expect(saved.passwordEnc).toBe(encryption.encrypt(PASSWORD));
    expect(saved.passwordEnc).not.toContain(PASSWORD);
    expect(saved.userId).toBe(USER);
    expect(saved.folder).toBe("INBOX");
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(view.passwordSet).toBe(true);
  });

  it("refuses a first save without a password, and writes nothing", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(null);

    await expect(service.upsert(USER, dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mailboxRepo.save).not.toHaveBeenCalled();
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("takes the row lock before deciding, so two saves cannot interleave", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());
    mailboxRepo.findOneByOrFail.mockResolvedValue(stored());

    await service.upsert(USER, dto());

    expect(mailboxRepo.findOne).toHaveBeenCalledWith({
      where: { userId: USER },
      lock: { mode: "pessimistic_write" },
    });
  });

  it("keeps the stored password when none is sent, and leaves the cursor alone for a setting change", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());
    mailboxRepo.findOneByOrFail.mockResolvedValue(stored());

    encryption.encrypt.mockClear();

    await service.upsert(USER, dto({ aiMode: "automatic", autoApply: true }));

    const [, patch] = mailboxRepo.update.mock.calls[0];
    expect(patch).not.toHaveProperty("passwordEnc");
    expect(patch).not.toHaveProperty("uidValidity");
    expect(patch).not.toHaveProperty("lastUid");
    expect(patch).not.toHaveProperty("lastError");
    expect(patch).toMatchObject({ aiMode: "automatic", autoApply: true });
    expect(encryption.encrypt).not.toHaveBeenCalled();
  });

  it("treats a blank password as 'keep'", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());
    mailboxRepo.findOneByOrFail.mockResolvedValue(stored());

    await service.upsert(USER, dto({ password: "" }));

    expect(mailboxRepo.update.mock.calls[0][1]).not.toHaveProperty(
      "passwordEnc",
    );
  });

  it("replaces the password when one is sent, clears the old error, and keeps the cursor", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());
    mailboxRepo.findOneByOrFail.mockResolvedValue(stored());

    await service.upsert(USER, dto({ password: "new-password" }));

    const [, patch] = mailboxRepo.update.mock.calls[0];
    expect(patch.passwordEnc).toBe(encryption.encrypt("new-password"));
    expect(patch).toMatchObject({ lastError: null, lastErrorAt: null });
    expect(patch).not.toHaveProperty("uidValidity");
  });

  it("starts the poll over when the folder changes", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());
    mailboxRepo.findOneByOrFail.mockResolvedValue(stored());

    await service.upsert(USER, dto({ folder: "Receipts" }));

    expect(mailboxRepo.update.mock.calls[0][1]).toMatchObject({
      folder: "Receipts",
      uidValidity: null,
      lastUid: null,
    });
  });

  it("switches an OAuth2 mailbox to password login and deletes the refresh token", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(storedOAuth());
    mailboxRepo.findOneByOrFail.mockResolvedValue(stored());

    await service.upsert(USER, dto({ password: PASSWORD }));

    const [, patch] = mailboxRepo.update.mock.calls[0];
    expect(patch).toMatchObject({
      authMethod: "password",
      oauthProvider: null,
      oauthRefreshTokenEnc: null,
      passwordEnc: encryption.encrypt(PASSWORD),
    });
  });

  it("requires a password to leave OAuth2, and writes nothing without one", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(storedOAuth());

    await expect(
      service.upsert(
        USER,
        dto({ host: "imap.gmail.com", username: "receipts@gmail.example" }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("starts the poll over when the host or user name changes, given the password again", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());
    mailboxRepo.findOneByOrFail.mockResolvedValue(stored());

    await service.upsert(USER, dto({ host: "9.9.9.9", password: PASSWORD }));
    await service.upsert(
      USER,
      dto({ username: "other@example.com", password: PASSWORD }),
    );

    for (const [, patch] of mailboxRepo.update.mock.calls) {
      expect(patch).toMatchObject({ uidValidity: null, lastUid: null });
    }
  });

  it("refuses a new host or user name without the password, so the stored one cannot be sent elsewhere", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());

    await expect(
      service.upsert(USER, dto({ host: "9.9.9.9" })),
    ).rejects.toThrow(/password again/);
    await expect(
      service.upsert(USER, dto({ username: "other@example.com" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("refuses a private host for a non-admin before anything is written", async () => {
    const { service, mailboxRepo } = setup();

    await expect(
      service.upsert(USER, dto({ host: "192.168.1.5", password: PASSWORD })),
    ).rejects.toThrow(/private or local network address/);

    expect(mailboxRepo.findOne).not.toHaveBeenCalled();
    expect(mailboxRepo.save).not.toHaveBeenCalled();
    expect(encryption.encrypt).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private address for a non-admin", async () => {
    const { service, mailboxRepo } = setup();
    jest.spyOn(safeUrl, "validateUrlIsSafe").mockResolvedValue(false);

    await expect(
      service.upsert(
        USER,
        dto({ host: "rebind.example.com", password: PASSWORD }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mailboxRepo.save).not.toHaveBeenCalled();
  });

  it("lets an admin save a private host", async () => {
    const { service, mailboxRepo, userRepo } = setup();
    userRepo.findOne.mockResolvedValue({ role: "admin" });
    mailboxRepo.findOne.mockResolvedValue(null);

    await service.upsert(
      USER,
      dto({ host: "192.168.1.5", password: PASSWORD }),
    );

    expect(mailboxRepo.save).toHaveBeenCalledTimes(1);
  });

  it("stores an IPv6 literal unbracketed and refuses one that is not an address", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(null);

    await service.upsert(
      USER,
      dto({ host: "[2001:4860:4860::8888]", password: PASSWORD }),
    );
    expect(mailboxRepo.save.mock.calls[0][0].host).toBe("2001:4860:4860::8888");

    await expect(
      service.upsert(USER, dto({ host: "dead:beef:zz", password: PASSWORD })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses to store a password when the server has no encryption key", async () => {
    const { service, mailboxRepo } = setup();
    encryption.isConfigured.mockReturnValue(false);

    await expect(
      service.upsert(USER, dto({ password: PASSWORD })),
    ).rejects.toThrow(/no encryption key/);
    expect(mailboxRepo.save).not.toHaveBeenCalled();
  });

  it("answers a second mailbox for one user as a conflict", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(null);
    mailboxRepo.save.mockRejectedValue(
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );

    await expect(
      service.upsert(USER, dto({ password: PASSWORD })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("lets any other failure through unchanged", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(null);
    mailboxRepo.save.mockRejectedValue(new Error("connection lost"));

    await expect(
      service.upsert(USER, dto({ password: PASSWORD })),
    ).rejects.toThrow("connection lost");
  });
});

describe("EmailReceiptMailboxService.updateSettings", () => {
  it("writes only the fields sent, under the row lock, for either login method", async () => {
    const { service, mailboxRepo, storedQuery } = setup();
    mailboxRepo.findOne.mockResolvedValue(storedOAuth());
    storedQuery.result = storedOAuth({ enabled: false, aiMode: "automatic" });

    const view = await service.updateSettings(USER, {
      enabled: false,
      aiMode: "automatic",
    } as never);

    expect(mailboxRepo.findOne).toHaveBeenCalledWith({
      where: { userId: USER },
      lock: { mode: "pessimistic_write" },
    });
    const [where, patch] = mailboxRepo.update.mock.calls[0];
    expect(where).toEqual({ id: "mb-1", userId: USER });
    expect(patch).toEqual({ enabled: false, aiMode: "automatic" });
    expect(view).toMatchObject({ authMethod: "oauth2", enabled: false });
  });

  it("resets the cursor and the old error when the folder changes, and only then", async () => {
    const { service, mailboxRepo, storedQuery } = setup();
    mailboxRepo.findOne.mockResolvedValue(stored());
    storedQuery.result = stored();

    await service.updateSettings(USER, { folder: "Receipts" } as never);
    await service.updateSettings(USER, { folder: "INBOX" } as never);

    expect(mailboxRepo.update.mock.calls[0][1]).toEqual({
      folder: "Receipts",
      uidValidity: null,
      lastUid: null,
      lastError: null,
      lastErrorAt: null,
    });
    expect(mailboxRepo.update.mock.calls[1][1]).toEqual({ folder: "INBOX" });
  });

  it("refuses an empty change with a 400 before touching the database", async () => {
    const { service, mailboxRepo } = setup();
    await expect(
      service.updateSettings(USER, {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.updateSettings(USER, { folder: "  " } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mailboxRepo.findOne).not.toHaveBeenCalled();
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("is a 404 for a user with no mailbox, and writes nothing", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(null);
    await expect(
      service.updateSettings(USER, { enabled: true } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptMailboxService.remove", () => {
  it("deletes the user's mailbox, then rejects the open requests raised for its emails", async () => {
    const { service, mailboxRepo, manager } = setup();
    mailboxRepo.delete.mockResolvedValue({ affected: 1 });

    await service.remove(USER);

    expect(mailboxRepo.delete).toHaveBeenCalledWith({ userId: USER });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE ai_review_requests\s+SET status = 'rejected'/);
    expect(sql).toMatch(/kind = 'email_receipt'/);
    expect(params).toEqual([USER]);
  });

  it("refuses a missing mailbox before writing anything else", async () => {
    const { service, mailboxRepo, manager } = setup();
    mailboxRepo.delete.mockResolvedValue({ affected: 0 });

    await expect(service.remove(USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptMailboxService.testConnection", () => {
  it("tests the stored settings with the decrypted stored password", async () => {
    const { service, imap, storedQuery } = setup();
    storedQuery.result = stored();
    imap.testConnection.mockResolvedValue({ messages: 12, uidValidity: "77" });

    const result = await service.testConnection(USER);

    expect(result).toEqual({ ok: true, messages: 12 });
    expect(imap.testConnection).toHaveBeenCalledWith({
      host: "8.8.8.8",
      port: 993,
      security: "tls",
      username: "receipts@example.com",
      auth: { kind: "password", password: PASSWORD },
      folder: "INBOX",
      allowPrivateHost: false,
    });
  });

  it("merges a draft over the stored mailbox, using the draft's password when sent", async () => {
    const { service, imap, storedQuery } = setup();
    storedQuery.result = stored();
    imap.testConnection.mockResolvedValue({ messages: 0, uidValidity: "1" });

    await service.testConnection(USER, {
      port: 143,
      security: "starttls",
      password: "typed-password",
    } as never);

    expect(imap.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "8.8.8.8",
        port: 143,
        security: "starttls",
        auth: { kind: "password", password: "typed-password" },
      }),
    );
  });

  it("refuses to send the stored password to a different host or user name", async () => {
    const { service, imap, storedQuery } = setup();
    storedQuery.result = stored();

    await expect(
      service.testConnection(USER, { host: "9.9.9.9" } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.testConnection(USER, { username: "x@example.com" } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(imap.testConnection).not.toHaveBeenCalled();
  });

  it("asks for the settings when nothing is stored and the draft is incomplete", async () => {
    const { service, imap } = setup();
    await expect(
      service.testConnection(USER, { host: "9.9.9.9" } as never),
    ).rejects.toThrow(/Enter the server/);
    await expect(service.testConnection(USER)).rejects.toThrow(
      /Enter the server/,
    );
    expect(imap.testConnection).not.toHaveBeenCalled();
  });

  it("asks for a password when a complete draft has none and nothing is stored", async () => {
    const { service, imap } = setup();
    await expect(
      service.testConnection(USER, {
        host: "9.9.9.9",
        port: 993,
        security: "tls",
        username: "u",
      } as never),
    ).rejects.toThrow(/Enter the mailbox password/);
    expect(imap.testConnection).not.toHaveBeenCalled();
  });

  it("refuses a private host for a non-admin as a 400, not a test result", async () => {
    const { service, imap } = setup();
    await expect(
      service.testConnection(USER, {
        host: "10.0.0.1",
        port: 993,
        security: "tls",
        username: "u",
        password: "p",
      } as never),
    ).rejects.toThrow(/private or local network address/);
    expect(imap.testConnection).not.toHaveBeenCalled();
  });

  it("passes an admin's private-host allowance down to the connection", async () => {
    const { service, imap, userRepo } = setup();
    userRepo.findOne.mockResolvedValue({ role: "admin" });
    imap.testConnection.mockResolvedValue({ messages: 1, uidValidity: "1" });

    await service.testConnection(USER, {
      host: "10.0.0.1",
      port: 993,
      security: "tls",
      username: "u",
      password: "p",
    } as never);

    expect(imap.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: "10.0.0.1", allowPrivateHost: true }),
    );
  });

  it("reports a failed connection without the password, however the error quotes it", async () => {
    const { service, imap, storedQuery } = setup();
    storedQuery.result = stored();
    imap.testConnection.mockRejectedValue(
      Object.assign(new Error(`LOGIN failed for ${PASSWORD}`), {
        authenticationFailed: true,
        responseText: `NO bad password ${PASSWORD}`,
      }),
    );

    const result = await service.testConnection(USER);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(result).toMatchObject({
      error: expect.stringContaining("Could not read the mailbox"),
    });
  });

  it("reports a stored password this server cannot decrypt, without the ciphertext", async () => {
    const { service, imap, storedQuery } = setup();
    storedQuery.result = stored();
    encryption.decrypt.mockImplementationOnce(() => {
      throw new Error("bad auth tag");
    });

    const result = await service.testConnection(USER);

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("enc(");
    expect(imap.testConnection).not.toHaveBeenCalled();
  });

  it("lets a refusal thrown by the client through as the error it is", async () => {
    const { service, imap, storedQuery } = setup();
    storedQuery.result = stored();
    imap.testConnection.mockRejectedValue(
      new BadRequestException("private host"),
    );

    await expect(service.testConnection(USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("EmailReceiptMailboxService OAuth2 mailbox", () => {
  const grant = {
    accessToken: ACCESS,
    secrets: [REFRESH, ACCESS],
  };

  it("tests with a fresh access token against the provider's host, not the stored one", async () => {
    const { service, imap, storedQuery, oauthAccess } = setup();
    storedQuery.result = storedOAuth({ host: "evil.example.com" });
    oauthAccess.obtain.mockResolvedValue(grant);
    imap.testConnection.mockResolvedValue({ messages: 3, uidValidity: "1" });

    const result = await service.testConnection(USER);

    expect(result).toEqual({ ok: true, messages: 3 });
    expect(oauthAccess.obtain).toHaveBeenCalledWith({
      userId: USER,
      mailboxId: "mb-1",
      provider: "google",
      refreshTokenEnc: encryption.encrypt(REFRESH),
    });
    expect(imap.testConnection).toHaveBeenCalledWith({
      host: "imap.gmail.com",
      port: 993,
      security: "tls",
      username: "receipts@gmail.example",
      auth: { kind: "oauth2", accessToken: ACCESS },
      folder: "INBOX",
      allowPrivateHost: false,
    });
  });

  it("reports a failed test without the tokens or the SASL strings built from them", async () => {
    const { service, imap, storedQuery, oauthAccess } = setup();
    storedQuery.result = storedOAuth();
    oauthAccess.obtain.mockResolvedValue(grant);
    const sasl = Buffer.from(
      `user=receipts@gmail.example\u0001auth=Bearer ${ACCESS}\u0001\u0001`,
    ).toString("base64");
    imap.testConnection.mockRejectedValue(
      Object.assign(new Error(`AUTHENTICATE ${sasl} ${ACCESS} ${REFRESH}`), {
        authenticationFailed: true,
        responseText: `NO ${ACCESS}`,
      }),
    );

    const result = await service.testConnection(USER);

    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    for (const secret of [ACCESS, REFRESH, sasl]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reports a revoked sign-in as a result that says to connect again", async () => {
    const { service, imap, storedQuery, oauthAccess } = setup();
    storedQuery.result = storedOAuth();
    oauthAccess.obtain.mockRejectedValue(
      new OAuthReconnectRequiredError("Connect the mailbox again."),
    );

    const result = await service.testConnection(USER);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Connect the mailbox again."),
    });
    expect(imap.testConnection).not.toHaveBeenCalled();
  });

  it("uses the typed password, not OAuth2, when a draft carries one", async () => {
    const { service, imap, storedQuery, oauthAccess } = setup();
    storedQuery.result = storedOAuth();
    imap.testConnection.mockResolvedValue({ messages: 0, uidValidity: "1" });

    await service.testConnection(USER, {
      host: "8.8.8.8",
      port: 993,
      security: "tls",
      username: "receipts@example.com",
      password: "typed-password",
    } as never);

    expect(oauthAccess.obtain).not.toHaveBeenCalled();
    expect(imap.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { kind: "password", password: "typed-password" },
      }),
    );
  });

  it("loads an access token for the poll, from the provider's host, public-only", async () => {
    const { service, storedQuery, oauthAccess } = setup();
    storedQuery.result = storedOAuth({
      oauthProvider: "microsoft",
      host: "evil.example.com",
    });
    oauthAccess.obtain.mockResolvedValue(grant);

    const loaded = await service.loadConnection(USER);

    expect(loaded?.connection).toEqual({
      host: "outlook.office365.com",
      port: 993,
      security: "tls",
      username: "receipts@gmail.example",
      auth: { kind: "oauth2", accessToken: ACCESS },
      folder: "INBOX",
      allowPrivateHost: false,
    });
    expect(loaded?.cursor).toEqual({ uidValidity: "77", lastUid: "40" });
    // Both tokens, and the base64 SASL strings a failure line could quote.
    expect(loaded?.secrets).toEqual(
      expect.arrayContaining([
        ACCESS,
        REFRESH,
        Buffer.from(
          `user=receipts@gmail.example\u0001auth=Bearer ${ACCESS}\u0001\u0001`,
        ).toString("base64"),
      ]),
    );
  });

  it("throws the reconnect refusal for a disconnected mailbox, for the poll to record", async () => {
    const { service, storedQuery, oauthAccess } = setup();
    storedQuery.result = storedOAuth({ oauthRefreshTokenEnc: null });
    oauthAccess.obtain.mockRejectedValue(
      new OAuthReconnectRequiredError("Connect the mailbox again."),
    );

    await expect(service.loadConnection(USER)).rejects.toBeInstanceOf(
      OAuthReconnectRequiredError,
    );
  });
});

describe("EmailReceiptMailboxService.loadConnection", () => {
  it("is null when no mailbox is set up", async () => {
    const { service } = setup();
    await expect(service.loadConnection(USER)).resolves.toBeNull();
  });

  it("decrypts the password for the poll and carries the cursor and the switches", async () => {
    const { service, storedQuery } = setup();
    storedQuery.result = stored({ aiMode: "automatic", autoApply: true });

    const loaded = await service.loadConnection(USER);

    expect(loaded).toMatchObject({
      mailboxId: "mb-1",
      connection: {
        host: "8.8.8.8",
        auth: { kind: "password", password: PASSWORD },
        allowPrivateHost: false,
      },
      cursor: { uidValidity: "77", lastUid: "40" },
      enabled: true,
      aiMode: "automatic",
      autoApply: true,
    });
    expect(loaded?.secrets).toContain(PASSWORD);
  });

  it("allows a private host for an admin's mailbox and for an allowlisted host", async () => {
    const { service, storedQuery, userRepo } = setup();
    storedQuery.result = stored({ host: "10.0.0.5" });
    userRepo.findOne.mockResolvedValue({ role: "admin" });
    await expect(service.loadConnection(USER)).resolves.toMatchObject({
      connection: { allowPrivateHost: true },
    });

    userRepo.findOne.mockResolvedValue({ role: "user" });
    const before = process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST;
    process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST = "10.0.0.5:993";
    try {
      await expect(service.loadConnection(USER)).resolves.toMatchObject({
        connection: { allowPrivateHost: true },
      });
    } finally {
      if (before === undefined)
        delete process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST;
      else process.env.EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST = before;
    }
    await expect(service.loadConnection(USER)).resolves.toMatchObject({
      connection: { allowPrivateHost: false },
    });
  });

  it("throws, without the ciphertext, for a password it cannot decrypt", async () => {
    const { service, storedQuery } = setup();
    storedQuery.result = stored();
    encryption.decrypt.mockImplementationOnce(() => {
      throw new Error(`bad auth tag for ${stored().passwordEnc}`);
    });

    await expect(service.loadConnection(USER)).rejects.toThrow(
      "The stored mailbox password cannot be decrypted",
    );
  });
});

describe("EmailReceiptMailboxService poll bookkeeping", () => {
  it("lists the enabled mailboxes for the poll's fan-out", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.find.mockResolvedValue([
      Object.assign(new EmailReceiptMailbox(), { id: "m1", userId: "u1" }),
    ]);

    await expect(service.listEnabledMailboxes()).resolves.toEqual([
      { id: "m1", userId: "u1" },
    ]);
    // An OAuth2 mailbox is polled only while it holds a refresh token.
    const where = mailboxRepo.find.mock.calls[0][0].where;
    expect(where).toHaveLength(2);
    expect(where[0]).toEqual({ enabled: true, authMethod: "password" });
    expect(where[1]).toMatchObject({ enabled: true, authMethod: "oauth2" });
    expect(where[1].oauthRefreshTokenEnc).toBeDefined();
  });

  it("advances the cursor in one conditional UPDATE keyed on the user, that never rewinds on one UIDVALIDITY", async () => {
    const { service, manager } = setup();

    await service.advanceCursor(USER, "mb-1", {
      uidValidity: "77",
      lastUid: "90",
    });

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE email_receipt_mailboxes/);
    expect(sql).toMatch(/GREATEST\(last_uid, \$4::bigint\)/);
    expect(sql).toMatch(/uid_validity IS NOT DISTINCT FROM \$3::bigint/);
    expect(sql).toMatch(/AND user_id = \$2/);
    expect(params).toEqual(["mb-1", USER, "77", "90"]);
  });

  it("stamps a successful poll and clears the last error", async () => {
    const { service, mailboxRepo } = setup();
    const at = new Date("2026-09-30T12:00:00Z");

    await service.recordPollSuccess(USER, "mb-1", at);

    expect(mailboxRepo.update).toHaveBeenCalledWith(
      { id: "mb-1", userId: USER },
      {
        lastPolledAt: at,
        lastSuccessAt: at,
        lastError: null,
        lastErrorAt: null,
      },
    );
  });

  it("stores a failed poll's reason cut to 300 characters and without the password", async () => {
    const { service, mailboxRepo } = setup();
    const at = new Date("2026-09-30T12:00:00Z");
    const error = new Error(`LOGIN ${PASSWORD} ${"x".repeat(1000)}`);

    const line = await service.recordPollFailure(
      USER,
      "mb-1",
      error,
      [PASSWORD],
      at,
    );

    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).not.toContain(PASSWORD);
    const [where, patch] = mailboxRepo.update.mock.calls[0];
    expect(where).toEqual({ id: "mb-1", userId: USER });
    expect(patch).toEqual({
      lastPolledAt: at,
      lastError: line,
      lastErrorAt: at,
    });
    expect(JSON.stringify(patch)).not.toContain(PASSWORD);
  });
});
