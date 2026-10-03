import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { createSingleUseTokenMock } from "../../test-helpers/single-use-token-testing";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import { EmailReceiptOAuthConfig } from "./oauth-config.service";
import { EmailReceiptOAuthService } from "./email-receipt-oauth.service";
import { OAuthTokenError } from "./oauth-errors";
import {
  newOAuthState,
  OAUTH_STATE_PURPOSE,
  OAUTH_STATE_TTL_MS,
  openOAuthState,
  pkceChallenge,
  sealOAuthState,
} from "./oauth-state";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const OTHER = "user-2";
const CODE = "auth-code-SECRET";
const REFRESH = "refresh-token-SECRET";
const ACCESS = "access-token-SECRET";
const REDIRECT =
  "https://monize.example.com/settings/email-receipts/oauth-callback";

const encryption = new EncryptionService(
  new ConfigService({ ENCRYPTION_KEY: "k".repeat(40) }),
);

const idToken = (claims: unknown) =>
  [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "sig",
  ].join(".");

const grant = (over: Record<string, unknown> = {}) => ({
  accessToken: ACCESS,
  refreshToken: REFRESH,
  idToken: idToken({ email: "Receipts@Example.com" }),
  ...over,
});

function existing(over: Partial<EmailReceiptMailbox> = {}) {
  return Object.assign(new EmailReceiptMailbox(), {
    id: "mb-1",
    userId: USER,
    host: "imap.example.com",
    port: 993,
    security: "tls",
    username: "old@example.com",
    authMethod: "password",
    passwordEnc: "enc",
    folder: "Receipts",
    enabled: false,
    aiMode: "on_demand",
    autoApply: true,
    uidValidity: "77",
    lastUid: "40",
    ...over,
  });
}

function setup(env: Record<string, string> | null = null) {
  const mailboxRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v: Partial<EmailReceiptMailbox>) =>
      Object.assign(new EmailReceiptMailbox(), v),
    ),
    save: jest.fn(async (v: EmailReceiptMailbox) => v),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const { dataSource } = createScopedDbMocks([
    [EmailReceiptMailbox, mailboxRepo],
  ]);
  const config = new EmailReceiptOAuthConfig(
    new ConfigService(
      env ?? {
        PUBLIC_APP_URL: "https://monize.example.com/",
        EMAIL_RECEIPTS_GOOGLE_CLIENT_ID: "google-client",
        EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET: "google-secret",
        EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID: "ms-client",
        EMAIL_RECEIPTS_MICROSOFT_CLIENT_SECRET: "ms-secret",
        EMAIL_RECEIPTS_MICROSOFT_TENANT: "organizations",
      },
    ),
  );
  const tokens = { exchangeCode: jest.fn(), refresh: jest.fn() };
  const singleUse = createSingleUseTokenMock();
  const mailbox = { getView: jest.fn().mockResolvedValue({ id: "mb-1" }) };
  const service = new EmailReceiptOAuthService(
    dataSource as never,
    encryption,
    config,
    tokens as never,
    singleUse as never,
    mailbox as never,
  );
  const startFlow = (
    userId = USER,
    provider: "google" | "microsoft" = "google",
  ) => {
    const { authorizationUrl } = service.start(userId, { provider });
    return new URL(authorizationUrl).searchParams.get("state") as string;
  };
  return { service, mailboxRepo, tokens, singleUse, mailbox, startFlow };
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe("EmailReceiptOAuthService.providers", () => {
  it("says which providers are configured and the redirect URI", () => {
    expect(setup().service.providers()).toEqual({
      google: true,
      microsoft: true,
      redirectUri: REDIRECT,
    });
    expect(setup({}).service.providers()).toMatchObject({
      google: false,
      microsoft: false,
    });
  });
});

describe("EmailReceiptOAuthService.start", () => {
  it("builds the Google authorization URL with PKCE and a sealed state", () => {
    const { service } = setup();
    const { authorizationUrl } = service.start(USER, { provider: "google" });

    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("google-client");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("https://mail.google.com/ openid email");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    // The challenge is the S256 of the verifier sealed in the state, and the
    // verifier itself is not in the URL.
    const opened = openOAuthState(encryption, p.get("state") as string);
    expect(opened).toMatchObject({ userId: USER, provider: "google" });
    expect(p.get("code_challenge")).toBe(pkceChallenge(opened.verifier));
    expect(authorizationUrl).not.toContain(opened.verifier);
    expect(authorizationUrl).not.toContain("google-secret");
  });

  it("builds the Microsoft URL for the configured tenant", () => {
    const { service } = setup();
    const { authorizationUrl } = service.start(USER, { provider: "microsoft" });
    const url = new URL(authorizationUrl);
    expect(url.pathname).toBe("/organizations/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toBe(
      "https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email",
    );
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(authorizationUrl).not.toContain("ms-secret");
  });

  it("refuses a provider that is not configured with a 400", () => {
    const { service } = setup({
      EMAIL_RECEIPTS_GOOGLE_CLIENT_ID: "only-an-id",
    });
    expect(() => service.start(USER, { provider: "google" })).toThrow(
      BadRequestException,
    );
    expect(() => service.start(USER, { provider: "microsoft" })).toThrow(
      BadRequestException,
    );
  });

  it("refuses when the server cannot encrypt, so no flow starts that could not finish", () => {
    const { service } = setup();
    jest.spyOn(encryption, "isConfigured").mockReturnValue(false);
    expect(() => service.start(USER, { provider: "google" })).toThrow(
      /no encryption key/,
    );
  });
});

describe("EmailReceiptOAuthService.complete (INV-RECEIPT-007)", () => {
  it("creates the mailbox with INBOX, enabled, AI off and auto-apply off", async () => {
    const { service, tokens, startFlow, mailboxRepo, mailbox } = setup();
    tokens.exchangeCode.mockResolvedValue(grant());

    const view = await service.complete(USER, {
      code: CODE,
      state: startFlow(),
    });

    expect(view).toEqual({ id: "mb-1" });
    expect(mailbox.getView).toHaveBeenCalledWith(USER);
    const saved = mailboxRepo.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      userId: USER,
      host: "imap.gmail.com",
      port: 993,
      security: "tls",
      username: "receipts@example.com",
      authMethod: "oauth2",
      oauthProvider: "google",
      passwordEnc: null,
      folder: "INBOX",
      enabled: true,
      aiMode: "off",
      autoApply: false,
    });
    expect(encryption.decrypt(saved.oauthRefreshTokenEnc as string)).toBe(
      REFRESH,
    );
    expect(saved.oauthRefreshTokenEnc as string).not.toContain(REFRESH);
  });

  it("exchanges the code with the state's own PKCE verifier and the redirect URI", async () => {
    const { service, tokens } = setup();
    tokens.exchangeCode.mockResolvedValue(grant());
    const { payload } = newOAuthState(USER, "microsoft");
    const state = sealOAuthState(encryption, payload);

    await service.complete(USER, { code: CODE, state });

    expect(tokens.exchangeCode).toHaveBeenCalledWith(
      "microsoft",
      CODE,
      payload.verifier,
      REDIRECT,
    );
  });

  it("switches an existing mailbox to OAuth2, keeping its folder and switches and clearing the password", async () => {
    const { service, tokens, startFlow, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(existing());
    tokens.exchangeCode.mockResolvedValue(grant());

    await service.complete(USER, { code: CODE, state: startFlow() });

    expect(mailboxRepo.findOne).toHaveBeenCalledWith({
      where: { userId: USER },
      lock: { mode: "pessimistic_write" },
    });
    expect(mailboxRepo.save).not.toHaveBeenCalled();
    const [where, patch] = mailboxRepo.update.mock.calls[0];
    expect(where).toEqual({ id: "mb-1", userId: USER });
    expect(patch).toMatchObject({
      host: "imap.gmail.com",
      username: "receipts@example.com",
      authMethod: "oauth2",
      oauthProvider: "google",
      passwordEnc: null,
      lastError: null,
      lastErrorAt: null,
    });
    for (const kept of ["folder", "enabled", "aiMode", "autoApply"]) {
      expect(patch).not.toHaveProperty(kept);
    }
  });

  it("resets the UID cursor when the account behind the mailbox changed", async () => {
    const { service, tokens, startFlow, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(existing());
    tokens.exchangeCode.mockResolvedValue(grant());

    await service.complete(USER, { code: CODE, state: startFlow() });

    expect(mailboxRepo.update.mock.calls[0][1]).toMatchObject({
      uidValidity: null,
      lastUid: null,
    });
  });

  it("keeps the cursor when the same account reconnects", async () => {
    const { service, tokens, startFlow, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(
      existing({
        host: "imap.gmail.com",
        username: "receipts@example.com",
        authMethod: "oauth2",
        oauthProvider: "google",
        passwordEnc: null,
      }),
    );
    tokens.exchangeCode.mockResolvedValue(grant());

    await service.complete(USER, { code: CODE, state: startFlow() });

    const patch = mailboxRepo.update.mock.calls[0][1];
    expect(patch).not.toHaveProperty("uidValidity");
    expect(patch).not.toHaveProperty("lastUid");
  });

  it("refuses garbage, a state sealed for nobody, and an expired one, writing nothing", async () => {
    const { service, tokens, mailboxRepo, singleUse } = setup();
    const { payload } = newOAuthState(
      USER,
      "google",
      Date.now() - 2 * OAUTH_STATE_TTL_MS,
    );
    const expired = sealOAuthState(encryption, payload);

    for (const state of ["garbage", "AAAA", expired]) {
      await expect(
        service.complete(USER, { code: CODE, state }),
      ).rejects.toThrow(/not valid any more/);
    }
    expect(singleUse.claim).not.toHaveBeenCalled();
    expect(tokens.exchangeCode).not.toHaveBeenCalled();
    expect(mailboxRepo.save).not.toHaveBeenCalled();
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("refuses another user's state with the same 400, and does not spend its nonce", async () => {
    const { service, tokens, startFlow, singleUse, mailboxRepo } = setup();
    const state = startFlow(OTHER);

    const failure = await service
      .complete(USER, { code: CODE, state })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as Error).message).toMatch(/not valid any more/);
    expect(singleUse.claim).not.toHaveBeenCalled();
    expect(tokens.exchangeCode).not.toHaveBeenCalled();
    expect(mailboxRepo.save).not.toHaveBeenCalled();

    // The owner can still finish their own flow.
    tokens.exchangeCode.mockResolvedValue(grant());
    await expect(
      service.complete(OTHER, { code: CODE, state }),
    ).resolves.toBeDefined();
  });

  it("claims the nonce once: a replay is a 400 and exchanges nothing", async () => {
    const { service, tokens, startFlow, singleUse } = setup();
    tokens.exchangeCode.mockResolvedValue(grant());
    const state = startFlow();

    await service.complete(USER, { code: CODE, state });
    await expect(service.complete(USER, { code: CODE, state })).rejects.toThrow(
      /not valid any more/,
    );

    expect(tokens.exchangeCode).toHaveBeenCalledTimes(1);
    expect(singleUse.claim).toHaveBeenCalledTimes(2);
    expect(singleUse.claim).toHaveBeenCalledWith(
      OAUTH_STATE_PURPOSE,
      expect.any(String),
      OAUTH_STATE_TTL_MS,
    );
    expect(OAUTH_STATE_PURPOSE).toBe("email-receipt-oauth");
  });

  it("answers a failed exchange with a translated 400 and logs no secret", async () => {
    const { service, tokens, startFlow, mailboxRepo } = setup();
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    tokens.exchangeCode.mockRejectedValue(new OAuthTokenError("rejected", 400));

    const failure = await service
      .complete(USER, { code: CODE, state: startFlow() })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as Error).message).toMatch(/did not accept the sign-in/);
    expect(mailboxRepo.save).not.toHaveBeenCalled();
    expect(mailboxRepo.update).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("rejected");
    for (const secret of [CODE, REFRESH, ACCESS]) {
      expect(logged).not.toContain(secret);
      expect((failure as Error).message).not.toContain(secret);
    }
  });

  it("lets an error that is not a token error through", async () => {
    const { service, tokens, startFlow } = setup();
    tokens.exchangeCode.mockRejectedValue(new RangeError("bug"));
    await expect(
      service.complete(USER, { code: CODE, state: startFlow() }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("refuses an account with no usable address, and one with no refresh token", async () => {
    const { service, tokens, startFlow, mailboxRepo } = setup();

    tokens.exchangeCode.mockResolvedValueOnce(grant({ idToken: null }));
    await expect(
      service.complete(USER, { code: CODE, state: startFlow() }),
    ).rejects.toThrow(/did not return an email address/);

    tokens.exchangeCode.mockResolvedValueOnce(
      grant({ idToken: idToken({ sub: "x" }) }),
    );
    await expect(
      service.complete(USER, { code: CODE, state: startFlow() }),
    ).rejects.toThrow(/did not return an email address/);

    tokens.exchangeCode.mockResolvedValueOnce(grant({ refreshToken: null }));
    await expect(
      service.complete(USER, { code: CODE, state: startFlow() }),
    ).rejects.toThrow(/did not grant lasting access/);

    expect(mailboxRepo.save).not.toHaveBeenCalled();
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("refuses when the operator removed the provider after the flow began", async () => {
    const first = setup();
    const state = first.startFlow();
    const second = setup({});
    await expect(
      second.service.complete(USER, { code: CODE, state }),
    ).rejects.toThrow(/not set up on this server/);
    expect(second.tokens.exchangeCode).not.toHaveBeenCalled();
  });
});

describe("EmailReceiptOAuthService.disconnect", () => {
  const oauthRow = () =>
    existing({
      authMethod: "oauth2",
      oauthProvider: "google",
      passwordEnc: null,
    });

  it("deletes the refresh token and switches the poll off, under the row lock", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValue(oauthRow());

    await service.disconnect(USER);

    expect(mailboxRepo.findOne).toHaveBeenCalledWith({
      where: { userId: USER },
      lock: { mode: "pessimistic_write" },
    });
    const [where, patch] = mailboxRepo.update.mock.calls[0];
    expect(where).toEqual({ id: "mb-1", userId: USER });
    expect(patch).toEqual({
      oauthRefreshTokenEnc: null,
      enabled: false,
      lastError: null,
      lastErrorAt: null,
    });
  });

  it("is a 404 without a mailbox and a 400 for a password mailbox, writing nothing", async () => {
    const { service, mailboxRepo } = setup();
    mailboxRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.disconnect(USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    mailboxRepo.findOne.mockResolvedValueOnce(existing());
    await expect(service.disconnect(USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });
});
