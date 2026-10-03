import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";

import { EncryptionService } from "@/common/encryption/encryption.service";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { EmailReceiptMailboxService } from "@/email-receipts/mailbox/email-receipt-mailbox.service";
import type { ImapMailboxClient } from "@/email-receipts/imap/imap-mailbox-client";
import { SingleUseTokenService } from "@/auth/single-use-token.service";
import { EmailReceiptOAuthService } from "@/email-receipts/oauth/email-receipt-oauth.service";
import { EmailReceiptOAuthConfig } from "@/email-receipts/oauth/oauth-config.service";
import { OAuthAccessTokenService } from "@/email-receipts/oauth/oauth-access-token.service";
import { OAuthTokenError } from "@/email-receipts/oauth/oauth-errors";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

/**
 * The mailbox settings against a real PostgreSQL enforcing RLS: what a mocked
 * repository cannot show. One mailbox per user, the password stored only as
 * ciphertext and absent from every view and every stored error, the cursor
 * reset and its never-rewind rule, and a delete that takes the stored emails
 * with it and closes the requests raised for them (INV-RECEIPT-005).
 */
describe("email receipt mailbox (integration)", () => {
  jest.setTimeout(180000);

  const PASSWORD = "correct-horse-battery-staple";
  let harness: EnforcedIntegrationHarness;
  let db: DataSource;
  let service: EmailReceiptMailboxService;
  let encryption: EncryptionService;
  let imap: jest.Mocked<ImapMailboxClient>;
  let oauth: EmailReceiptOAuthService;
  let tokens: { exchangeCode: jest.Mock; refresh: jest.Mock };
  let aliceId: string;
  let bobId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      host: "8.8.8.8",
      port: 993,
      security: "tls",
      username: "receipts@example.com",
      password: PASSWORD,
      enabled: true,
      aiMode: "off",
      autoApply: false,
      ...over,
    }) as never;

  const row = async (userId = aliceId) =>
    (
      await db.query(
        `SELECT * FROM email_receipt_mailboxes WHERE user_id = $1`,
        [userId],
      )
    )[0];

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    db = harness.owner;
    encryption = new EncryptionService(
      new ConfigService({ ENCRYPTION_KEY: "x".repeat(40) }),
    );
    imap = { testConnection: jest.fn(), fetchSince: jest.fn() };
    tokens = { exchangeCode: jest.fn(), refresh: jest.fn() };
    service = new EmailReceiptMailboxService(
      harness.app,
      encryption,
      imap,
      new OAuthAccessTokenService(harness.app, encryption, tokens as never),
    );
    oauth = new EmailReceiptOAuthService(
      harness.app,
      encryption,
      new EmailReceiptOAuthConfig(
        new ConfigService({
          PUBLIC_APP_URL: "https://monize.example.com",
          EMAIL_RECEIPTS_GOOGLE_CLIENT_ID: "google-client",
          EMAIL_RECEIPTS_GOOGLE_CLIENT_SECRET: "google-secret",
        }),
      ),
      tokens as never,
      new SingleUseTokenService(harness.app),
      service,
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanTables(db, [
      "ai_review_requests",
      "email_receipts",
      "email_receipt_mailboxes",
      "transactions",
      "accounts",
      "users",
    ]);
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
  });

  it("stores the password as ciphertext that decrypts, and returns it in no view", async () => {
    const view = await asAlice(() => service.upsert(aliceId, dto()));

    const stored = await row();
    expect(stored.password_enc).not.toContain(PASSWORD);
    expect(encryption.decrypt(stored.password_enc)).toBe(PASSWORD);
    expect(view).toMatchObject({ host: "8.8.8.8", passwordSet: true });
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(JSON.stringify(view)).not.toContain(stored.password_enc);
    const read = await asAlice(() => service.getView(aliceId));
    expect(JSON.stringify(read)).not.toContain(stored.password_enc);
  });

  it("keeps one mailbox per user: a second save replaces, and another user sees nothing", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    await asAlice(() => service.upsert(aliceId, dto({ aiMode: "automatic" })));

    expect(
      await db.query(`SELECT 1 FROM email_receipt_mailboxes`),
    ).toHaveLength(1);
    expect((await row()).ai_mode).toBe("automatic");
    expect(await asBob(() => service.getView(bobId))).toBeNull();
    await expect(asBob(() => service.remove(bobId))).rejects.toMatchObject({
      status: 404,
    });
    expect(await row()).toBeDefined();
  });

  it("keeps the stored password when none is sent, and replaces it when one is", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    const before = (await row()).password_enc;

    await asAlice(() =>
      service.upsert(aliceId, dto({ password: undefined, enabled: false })),
    );
    expect((await row()).password_enc).toBe(before);
    expect((await row()).enabled).toBe(false);

    await asAlice(() => service.upsert(aliceId, dto({ password: "new-one" })));
    expect(encryption.decrypt((await row()).password_enc)).toBe("new-one");
  });

  it("refuses a first save with no password, and a new host without one, changing nothing", async () => {
    await expect(
      asAlice(() => service.upsert(aliceId, dto({ password: undefined }))),
    ).rejects.toMatchObject({ status: 400 });
    expect(await row()).toBeUndefined();

    await asAlice(() => service.upsert(aliceId, dto()));
    const before = await row();
    await expect(
      asAlice(() =>
        service.upsert(aliceId, dto({ host: "9.9.9.9", password: undefined })),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await row()).toEqual(before);
  });

  it("refuses a private host for a user, and allows it for an admin", async () => {
    await expect(
      asAlice(() => service.upsert(aliceId, dto({ host: "192.168.1.5" }))),
    ).rejects.toThrow(/private or local network address/);
    expect(await row()).toBeUndefined();

    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [aliceId]);
    await asAlice(() => service.upsert(aliceId, dto({ host: "192.168.1.5" })));
    expect((await row()).host).toBe("192.168.1.5");

    const loaded = await asAlice(() => service.loadConnection(aliceId));
    expect(loaded?.connection.allowPrivateHost).toBe(true);
  });

  it("resets the cursor when the folder changes and keeps it for any other setting", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    const { id } = await row();
    await asAlice(() =>
      service.advanceCursor(aliceId, id, { uidValidity: "77", lastUid: "40" }),
    );

    await asAlice(() => service.upsert(aliceId, dto({ aiMode: "on_demand" })));
    expect(await row()).toMatchObject({ uid_validity: "77", last_uid: "40" });

    await asAlice(() => service.upsert(aliceId, dto({ folder: "Receipts" })));
    expect(await row()).toMatchObject({ uid_validity: null, last_uid: null });
  });

  it("advances the cursor, never rewinds it on one UIDVALIDITY, and replaces it on another", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    const { id } = await row();
    const cursor = async () => {
      const r = await row();
      return [r.uid_validity, r.last_uid];
    };

    await asAlice(() =>
      service.advanceCursor(aliceId, id, { uidValidity: "5", lastUid: "40" }),
    );
    expect(await cursor()).toEqual(["5", "40"]);
    await asAlice(() =>
      service.advanceCursor(aliceId, id, { uidValidity: "5", lastUid: "30" }),
    );
    expect(await cursor()).toEqual(["5", "40"]);
    await asAlice(() =>
      service.advanceCursor(aliceId, id, { uidValidity: "5", lastUid: null }),
    );
    expect(await cursor()).toEqual(["5", "40"]);
    await asAlice(() =>
      service.advanceCursor(aliceId, id, { uidValidity: "6", lastUid: "3" }),
    );
    expect(await cursor()).toEqual(["6", "3"]);
    await asAlice(() =>
      service.advanceCursor(aliceId, id, { uidValidity: "7", lastUid: null }),
    );
    expect(await cursor()).toEqual(["7", null]);
  });

  it("does not move another user's cursor", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    const { id } = await row();

    await asBob(() =>
      service.advanceCursor(bobId, id, { uidValidity: "9", lastUid: "9" }),
    );
    await asBob(() =>
      service.advanceCursor(aliceId, id, { uidValidity: "9", lastUid: "9" }),
    );

    expect(await row()).toMatchObject({ uid_validity: null, last_uid: null });
  });

  it("stores a failed poll's reason cut to 300 characters, without the password", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    const loaded = await asAlice(() => service.loadConnection(aliceId));
    expect(loaded?.connection.auth).toEqual({
      kind: "password",
      password: PASSWORD,
    });

    await asAlice(() =>
      service.recordPollFailure(
        aliceId,
        loaded!.mailboxId,
        Object.assign(new Error(`LOGIN ${PASSWORD} ${"z".repeat(900)}`), {
          authenticationFailed: true,
        }),
        loaded!.secrets,
      ),
    );

    const stored = await row();
    expect(stored.last_error.length).toBeLessThanOrEqual(300);
    expect(stored.last_error).not.toContain(PASSWORD);
    expect(stored.last_polled_at).not.toBeNull();
    const view = await asAlice(() => service.getView(aliceId));
    expect(view?.lastError).toBe(stored.last_error);

    await asAlice(() => service.recordPollSuccess(aliceId, loaded!.mailboxId));
    expect(await row()).toMatchObject({
      last_error: null,
      last_error_at: null,
    });
    expect((await row()).last_success_at).not.toBeNull();
  });

  it("tests a connection without echoing the password, and stores nothing", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    const before = await row();
    imap.testConnection.mockRejectedValue(
      new Error(`authentication failed for ${PASSWORD}`),
    );

    const result = await asAlice(() => service.testConnection(aliceId));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(imap.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { kind: "password", password: PASSWORD },
        host: "8.8.8.8",
      }),
    );
    expect(await row()).toEqual(before);
  });

  it("lists the enabled mailboxes of every user for the poll's fan-out", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    await asBob(() => service.upsert(bobId, dto({ enabled: false })));

    const listed = await withSystemContext(() =>
      service.listEnabledMailboxes(),
    );

    expect(listed.map((m) => m.userId)).toEqual([aliceId]);
  });

  it("deletes the mailbox with its stored emails and rejects the open requests raised for them", async () => {
    await asAlice(() => service.upsert(aliceId, dto()));
    const { id: mailboxId } = await row();
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    const [account] = await db.query(
      `INSERT INTO accounts (user_id, account_type, name, currency_code)
       VALUES ($1, 'CHEQUING', 'Checking', 'USD') RETURNING id`,
      [aliceId],
    );
    const [tx] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
       VALUES ($1, $2, '2026-03-10', -5, 'USD', 'UNRECONCILED') RETURNING id`,
      [aliceId, account.id],
    );
    const [receipt] = await db.query(
      `INSERT INTO email_receipts
         (user_id, mailbox_id, uid_validity, uid, from_address, from_domain, subject, received_at, body_text)
       VALUES ($1, $2, 1, 1, 'a@b', 'b', 's', now(), 't') RETURNING id`,
      [aliceId, mailboxId],
    );
    await db.query(
      `INSERT INTO ai_review_requests (user_id, transaction_id, kind, instruction, email_receipt_id)
       VALUES ($1, $2, 'email_receipt', 'x', $3)`,
      [aliceId, tx.id, receipt.id],
    );

    await asAlice(() => service.remove(aliceId));

    expect(await row()).toBeUndefined();
    expect(await db.query(`SELECT 1 FROM email_receipts`)).toEqual([]);
    const [request] = await db.query(
      `SELECT status, email_receipt_id FROM ai_review_requests`,
    );
    expect(request).toEqual({ status: "rejected", email_receipt_id: null });
  });
  describe("OAuth2 mailbox (design 3a, INV-RECEIPT-005, INV-RECEIPT-007)", () => {
    const REFRESH = "1//refresh-token-abc";
    const ACCESS = "ya29.access-token-abc";
    const idToken = (email: string) =>
      [
        Buffer.from("{}").toString("base64url"),
        Buffer.from(JSON.stringify({ email })).toString("base64url"),
        "sig",
      ].join(".");

    const stateFor = (userId: string) =>
      new URL(
        oauth.start(userId, { provider: "google" }).authorizationUrl,
      ).searchParams.get("state") as string;

    const connect = async (
      userId: string,
      as: <T>(fn: () => Promise<T>) => Promise<T>,
      email = "Receipts@Example.com",
    ) => {
      tokens.exchangeCode.mockResolvedValueOnce({
        accessToken: ACCESS,
        refreshToken: REFRESH,
        idToken: idToken(email),
      });
      return as(() =>
        oauth.complete(userId, { code: "code", state: stateFor(userId) }),
      );
    };

    it("creates an OAuth2 mailbox under RLS: ciphertext token, no password, no secret in the view", async () => {
      const view = await connect(aliceId, asAlice);

      const stored = await row();
      expect(stored).toMatchObject({
        host: "imap.gmail.com",
        port: 993,
        security: "tls",
        username: "receipts@example.com",
        auth_method: "oauth2",
        oauth_provider: "google",
        password_enc: null,
        folder: "INBOX",
        enabled: true,
        ai_mode: "off",
        auto_apply: false,
      });
      expect(stored.oauth_refresh_token_enc).not.toContain(REFRESH);
      expect(encryption.decrypt(stored.oauth_refresh_token_enc)).toBe(REFRESH);
      expect(view).toMatchObject({
        authMethod: "oauth2",
        oauthProvider: "google",
        oauthConnected: true,
        passwordSet: false,
      });
      const text = JSON.stringify(view);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(stored.oauth_refresh_token_enc);
      expect(await asBob(() => service.getView(bobId))).toBeNull();
    });

    it("spends the state once, and refuses it for another user, in the real single-use table", async () => {
      const state = stateFor(aliceId);
      tokens.exchangeCode.mockResolvedValue({
        accessToken: ACCESS,
        refreshToken: REFRESH,
        idToken: idToken("a@example.com"),
      });

      await expect(
        asBob(() => oauth.complete(bobId, { code: "code", state })),
      ).rejects.toMatchObject({ status: 400 });
      expect(await row(bobId)).toBeUndefined();

      await asAlice(() => oauth.complete(aliceId, { code: "code", state }));
      await expect(
        asAlice(() => oauth.complete(aliceId, { code: "code", state })),
      ).rejects.toMatchObject({ status: 400 });
      expect(tokens.exchangeCode).toHaveBeenCalledTimes(1);
    });

    it("switches a password mailbox to OAuth2, keeping its settings and clearing the password and the cursor", async () => {
      await asAlice(() =>
        service.upsert(
          aliceId,
          dto({ folder: "Receipts", aiMode: "on_demand", autoApply: true }),
        ),
      );
      const { id } = await row();
      await asAlice(() =>
        service.advanceCursor(aliceId, id, {
          uidValidity: "77",
          lastUid: "40",
        }),
      );

      await connect(aliceId, asAlice);

      expect(await row()).toMatchObject({
        id,
        auth_method: "oauth2",
        oauth_provider: "google",
        password_enc: null,
        folder: "Receipts",
        ai_mode: "on_demand",
        auto_apply: true,
        uid_validity: null,
        last_uid: null,
      });
    });

    it("switches back to password login, deleting the refresh token, and needs a password to do it", async () => {
      await connect(aliceId, asAlice);

      await expect(
        asAlice(() => service.upsert(aliceId, dto({ password: undefined }))),
      ).rejects.toMatchObject({ status: 400 });
      expect((await row()).auth_method).toBe("oauth2");

      await asAlice(() => service.upsert(aliceId, dto()));
      expect(await row()).toMatchObject({
        auth_method: "password",
        oauth_provider: null,
        oauth_refresh_token_enc: null,
      });
      expect(encryption.decrypt((await row()).password_enc)).toBe(PASSWORD);
    });

    it("loads a fresh access token from the provider's host and stores a rotated refresh token", async () => {
      await connect(aliceId, asAlice);
      tokens.refresh.mockResolvedValue({
        accessToken: ACCESS,
        refreshToken: "1//rotated",
        idToken: null,
      });

      const loaded = await asAlice(() => service.loadConnection(aliceId));

      expect(tokens.refresh).toHaveBeenCalledWith("google", REFRESH);
      expect(loaded?.connection).toMatchObject({
        host: "imap.gmail.com",
        auth: { kind: "oauth2", accessToken: ACCESS },
        allowPrivateHost: false,
      });
      expect(encryption.decrypt((await row()).oauth_refresh_token_enc)).toBe(
        "1//rotated",
      );
    });

    it("drops the refresh token on invalid_grant, records the reason, and leaves the poll's list", async () => {
      await connect(aliceId, asAlice);
      expect(
        (await withSystemContext(() => service.listEnabledMailboxes())).map(
          (m) => m.userId,
        ),
      ).toEqual([aliceId]);
      tokens.refresh.mockRejectedValue(
        new OAuthTokenError("invalid_grant", 400),
      );

      const failure = await asAlice(() =>
        service.loadConnection(aliceId),
      ).catch((e: unknown) => e);
      const { id: mailboxId } = await row();
      const line = await asAlice(() =>
        service.recordPollFailure(aliceId, mailboxId, failure, []),
      );

      expect(line).toMatch(/Connect the mailbox again/);
      expect(await row()).toMatchObject({
        oauth_refresh_token_enc: null,
        auth_method: "oauth2",
        enabled: true,
      });
      expect((await row()).last_error).toBe(line);
      expect(
        await withSystemContext(() => service.listEnabledMailboxes()),
      ).toEqual([]);
      const view = await asAlice(() => service.getView(aliceId));
      expect(view).toMatchObject({ oauthConnected: false, enabled: true });
    });

    it("disconnects: deletes the token and stops the poll, keeping the row and its receipts", async () => {
      await connect(aliceId, asAlice);
      const { id } = await row();
      await db.query(
        `INSERT INTO email_receipts
           (user_id, mailbox_id, uid_validity, uid, from_address, from_domain, subject, received_at, body_text)
         VALUES ($1, $2, 1, 1, 'a@b', 'b', 's', now(), 't')`,
        [aliceId, id],
      );

      await expect(asBob(() => oauth.disconnect(bobId))).rejects.toMatchObject({
        status: 404,
      });
      expect((await row()).oauth_refresh_token_enc).not.toBeNull();

      await asAlice(() => oauth.disconnect(aliceId));

      expect(await row()).toMatchObject({
        id,
        oauth_refresh_token_enc: null,
        enabled: false,
        auth_method: "oauth2",
      });
      expect(await db.query(`SELECT 1 FROM email_receipts`)).toHaveLength(1);
    });

    it("changes settings for either method, resetting the cursor on a folder change only", async () => {
      await connect(aliceId, asAlice);
      const { id } = await row();
      await asAlice(() =>
        service.advanceCursor(aliceId, id, { uidValidity: "5", lastUid: "9" }),
      );

      await asAlice(() =>
        service.updateSettings(aliceId, {
          enabled: false,
          aiMode: "automatic",
          autoApply: true,
        }),
      );
      expect(await row()).toMatchObject({
        enabled: false,
        ai_mode: "automatic",
        auto_apply: true,
        uid_validity: "5",
        last_uid: "9",
      });

      const view = await asAlice(() =>
        service.updateSettings(aliceId, { folder: "Receipts" }),
      );
      expect(await row()).toMatchObject({
        folder: "Receipts",
        uid_validity: null,
        last_uid: null,
      });
      expect(view).toMatchObject({ folder: "Receipts", oauthConnected: true });

      await expect(
        asBob(() => service.updateSettings(bobId, { enabled: true })),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        asAlice(() => service.updateSettings(aliceId, {})),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
