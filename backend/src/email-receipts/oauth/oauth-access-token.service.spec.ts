import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import {
  OAuthAccessTokenService,
  oauthReconnectRequired,
} from "./oauth-access-token.service";
import { OAuthReconnectRequiredError, OAuthTokenError } from "./oauth-errors";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const REFRESH = "refresh-token-SECRET";
const ROTATED = "rotated-refresh-SECRET";
const ACCESS = "access-token-SECRET";
const STORED = `enc(${REFRESH})`;

const encryption = {
  encrypt: jest.fn((s: string) => `enc(${s})`),
  decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")),
};

function setup() {
  const mailboxRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const { dataSource } = createScopedDbMocks([
    [EmailReceiptMailbox, mailboxRepo],
  ]);
  const tokens = { refresh: jest.fn() };
  const service = new OAuthAccessTokenService(
    dataSource as never,
    encryption as never,
    tokens as never,
  );
  const obtain = (over: { refreshTokenEnc?: string | null } = {}) =>
    service.obtain({
      userId: "user-1",
      mailboxId: "mb-1",
      provider: "google",
      refreshTokenEnc: STORED,
      ...over,
    });
  return { service, mailboxRepo, tokens, obtain };
}

beforeEach(() => jest.clearAllMocks());

describe("OAuthAccessTokenService.obtain", () => {
  it("trades the decrypted refresh token for an access token and stores nothing", async () => {
    const { tokens, obtain, mailboxRepo } = setup();
    tokens.refresh.mockResolvedValue({
      accessToken: ACCESS,
      refreshToken: null,
      idToken: null,
    });

    const access = await obtain();

    expect(tokens.refresh).toHaveBeenCalledWith("google", REFRESH);
    expect(access.accessToken).toBe(ACCESS);
    expect(access.secrets).toEqual([REFRESH, ACCESS]);
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("stores a rotated refresh token, encrypted, only while the stored one is still the one read", async () => {
    const { tokens, obtain, mailboxRepo } = setup();
    tokens.refresh.mockResolvedValue({
      accessToken: ACCESS,
      refreshToken: ROTATED,
      idToken: null,
    });

    const access = await obtain();

    expect(mailboxRepo.update).toHaveBeenCalledTimes(1);
    const [where, patch] = mailboxRepo.update.mock.calls[0];
    expect(where).toEqual({
      id: "mb-1",
      userId: "user-1",
      oauthRefreshTokenEnc: STORED,
    });
    expect(patch).toEqual({ oauthRefreshTokenEnc: `enc(${ROTATED})` });
    expect(JSON.stringify(patch)).not.toContain(`"${ROTATED}"`);
    expect(access.secrets).toEqual([REFRESH, ACCESS, ROTATED]);
  });

  it("does not rewrite the row when the provider returns the same refresh token", async () => {
    const { tokens, obtain, mailboxRepo } = setup();
    tokens.refresh.mockResolvedValue({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      idToken: null,
    });
    await obtain();
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("deletes the stored token on invalid_grant and says to connect again", async () => {
    const { tokens, obtain, mailboxRepo } = setup();
    tokens.refresh.mockRejectedValue(new OAuthTokenError("invalid_grant", 400));

    const failure = await obtain().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(OAuthReconnectRequiredError);
    expect((failure as Error).message).toMatch(/Connect the mailbox again/);
    const [where, patch] = mailboxRepo.update.mock.calls[0];
    expect(where).toEqual({
      id: "mb-1",
      userId: "user-1",
      oauthRefreshTokenEnc: STORED,
    });
    expect(patch).toEqual({ oauthRefreshTokenEnc: null });
  });

  it("keeps the token on a transient failure and lets the error through", async () => {
    const { tokens, obtain, mailboxRepo } = setup();
    const error = new OAuthTokenError("unavailable", 503);
    tokens.refresh.mockRejectedValue(error);

    await expect(obtain()).rejects.toBe(error);
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("keeps the token when the operator's client is wrong (invalid_client)", async () => {
    const { tokens, obtain, mailboxRepo } = setup();
    tokens.refresh.mockRejectedValue(
      new OAuthTokenError("invalid_client", 401),
    );
    await expect(obtain()).rejects.toBeInstanceOf(OAuthTokenError);
    expect(mailboxRepo.update).not.toHaveBeenCalled();
  });

  it("asks to reconnect, without a request, when no token is stored", async () => {
    const { tokens, obtain } = setup();
    await expect(obtain({ refreshTokenEnc: null })).rejects.toBeInstanceOf(
      OAuthReconnectRequiredError,
    );
    expect(tokens.refresh).not.toHaveBeenCalled();
  });

  it("asks to reconnect when the stored token cannot be decrypted, quoting nothing", async () => {
    const { tokens, obtain } = setup();
    encryption.decrypt.mockImplementationOnce(() => {
      throw new Error(`bad auth tag for ${STORED}`);
    });

    const failure = await obtain().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(OAuthReconnectRequiredError);
    expect((failure as Error).message).not.toContain("enc(");
    expect(tokens.refresh).not.toHaveBeenCalled();
  });

  it("makes the reconnect refusal a translated sentence", () => {
    expect(oauthReconnectRequired().message).toMatch(
      /revoked or has expired.*Connect the mailbox again/,
    );
  });
});
