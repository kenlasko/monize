import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { SingleUseTokenService } from "../../auth/single-use-token.service";
import { withScopedDb } from "../../common/db/scoped-db";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { tr } from "../../i18n/translate";
import { EmailReceiptMailbox } from "../entities/email-receipt-mailbox.entity";
import type { EmailReceiptMailboxView } from "../mailbox/email-receipt-mailbox.view";
import { EmailReceiptMailboxService } from "../mailbox/email-receipt-mailbox.service";
import type {
  CompleteEmailReceiptOAuthDto,
  StartEmailReceiptOAuthDto,
} from "./dto/email-receipt-oauth.dto";
import { loginNameFromIdToken } from "./id-token-email";
import {
  EmailReceiptOAuthConfig,
  type EmailReceiptOAuthProviders,
} from "./oauth-config.service";
import { OAuthTokenError } from "./oauth-errors";
import {
  newOAuthState,
  OAUTH_STATE_PURPOSE,
  OAUTH_STATE_TTL_MS,
  openOAuthState,
  OAuthStateError,
  sealOAuthState,
} from "./oauth-state";
import { OAuthTokenClient } from "./oauth-token.client";

const DEFAULT_FOLDER = "INBOX";

/**
 * Connecting the receipts mailbox with OAuth2 (Google, Microsoft 365), and
 * disconnecting it (design section 3a, INV-RECEIPT-007).
 *
 * `start` answers with the provider's authorization URL. The provider redirects
 * the browser to the frontend's callback page, which posts what it read to
 * `complete`; the server keeps nothing in between, because the `state` it
 * handed out is a sealed envelope (`oauth-state.ts`) of the user, the provider,
 * the PKCE verifier and an expiry. `complete` opens it, checks it is the
 * caller's, claims its nonce once, exchanges the code, and only then writes.
 * The order matters: another user's attempt (a state is bound to the user who
 * started it) is refused BEFORE the nonce is claimed, so it cannot spend a flow
 * that is not theirs.
 *
 * The refresh token is encrypted with `EncryptionService` before it reaches the
 * database and is never returned (INV-RECEIPT-005). The token exchange is a
 * network call and runs outside any transaction; the write is one
 * `withScopedDb` transaction that locks the mailbox row, so a concurrent save or
 * connect cannot interleave with it.
 */
@Injectable()
export class EmailReceiptOAuthService {
  private readonly logger = new Logger(EmailReceiptOAuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly config: EmailReceiptOAuthConfig,
    private readonly tokens: OAuthTokenClient,
    private readonly singleUseTokens: SingleUseTokenService,
    private readonly mailbox: EmailReceiptMailboxService,
  ) {}

  /** Which providers this deployment offers, and the redirect URI registered with them. */
  providers(): EmailReceiptOAuthProviders {
    return this.config.providers();
  }

  /** The authorization URL to send the browser to. 400 for a provider that is not configured. */
  start(
    userId: string,
    dto: StartEmailReceiptOAuthDto,
  ): { authorizationUrl: string } {
    this.requireEncryption();
    const client = this.config.client(dto.provider);
    const spec = this.config.spec(dto.provider);
    if (!client || !spec) throw providerNotConfigured();

    const { payload, challenge } = newOAuthState(userId, dto.provider);
    const url = new URL(spec.authorizeUrl);
    const params = url.searchParams;
    params.set("client_id", client.clientId);
    params.set("redirect_uri", this.config.redirectUri());
    params.set("response_type", "code");
    params.set("scope", spec.scopes.join(" "));
    params.set("state", sealOAuthState(this.encryption, payload));
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
    for (const [key, value] of Object.entries(spec.authorizeParams)) {
      params.set(key, value);
    }
    return { authorizationUrl: url.toString() };
  }

  /**
   * Finish the flow the caller started: create the mailbox (INBOX, enabled, AI
   * off, auto-apply off) or switch the existing one to OAuth2, keeping its
   * folder and switches and clearing its password. The cursor is reset when the
   * account behind the mailbox changed (another address or provider): it names
   * messages of the old one. Every refusal is a 400 and nothing is written.
   */
  async complete(
    userId: string,
    dto: CompleteEmailReceiptOAuthDto,
  ): Promise<EmailReceiptMailboxView> {
    this.requireEncryption();
    const state = await this.claimState(userId, dto.state);
    const client = this.config.client(state.provider);
    const spec = this.config.spec(state.provider);
    if (!client || !spec) throw providerNotConfigured();

    let grant;
    try {
      grant = await this.tokens.exchangeCode(
        state.provider,
        dto.code,
        state.verifier,
        this.config.redirectUri(),
      );
    } catch (error) {
      if (!(error instanceof OAuthTokenError)) throw error;
      // The message is the code and status only, never a token or the body.
      this.logger.warn(
        `Email receipts OAuth code exchange failed user=${userId} provider=${state.provider} (${error.message})`,
      );
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.oauthExchangeFailed",
          "The provider did not accept the sign-in, so the mailbox was not connected. Try connecting again.",
        ),
      );
    }

    const username = grant.idToken ? loginNameFromIdToken(grant.idToken) : null;
    if (username === null) {
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.oauthNoEmail",
          "The provider did not return an email address for this account, so the mailbox cannot be connected.",
        ),
      );
    }
    if (grant.refreshToken === null) {
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.oauthNoRefreshToken",
          "The provider did not grant lasting access. Remove this app's access in your account's security settings and connect again.",
        ),
      );
    }
    const refreshTokenEnc = this.encryption.encrypt(grant.refreshToken);

    await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptMailbox);
      const existing = await repo.findOne({
        where: { userId },
        lock: { mode: "pessimistic_write" },
      });
      const target = {
        host: spec.imap.host,
        port: spec.imap.port,
        security: spec.imap.security,
        username,
        authMethod: "oauth2" as const,
        oauthProvider: state.provider,
        oauthRefreshTokenEnc: refreshTokenEnc,
        passwordEnc: null,
      };
      if (!existing) {
        await repo.save(
          repo.create({
            userId,
            ...target,
            folder: DEFAULT_FOLDER,
            enabled: true,
            aiMode: "off",
            autoApply: false,
          }),
        );
        return;
      }
      const accountChanged =
        existing.username !== username ||
        existing.host !== spec.imap.host ||
        existing.port !== spec.imap.port;
      await repo.update(
        { id: existing.id, userId },
        {
          ...target,
          // An error about the old connection says nothing about this one.
          lastError: null,
          lastErrorAt: null,
          // The cursor names messages of the mailbox it was read from.
          ...(accountChanged ? { uidValidity: null, lastUid: null } : {}),
        },
      );
    });
    const view = await this.mailbox.getView(userId);
    if (!view) throw mailboxNotFound();
    return view;
  }

  /**
   * Disconnect: delete the stored refresh token and switch the poll off. The
   * mailbox row, its settings and its stored emails stay. The grant itself is
   * the provider's: the user revokes it there (the settings screen links to it).
   * A user with no mailbox gets a 404; a password mailbox has nothing to
   * disconnect, a 400.
   */
  async disconnect(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptMailbox);
      const existing = await repo.findOne({
        where: { userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!existing) throw mailboxNotFound();
      if (existing.authMethod !== "oauth2") {
        throw new BadRequestException(
          tr(
            "errors.emailReceipts.notOAuthMailbox",
            "This mailbox does not sign in with Google or Microsoft.",
          ),
        );
      }
      await repo.update(
        { id: existing.id, userId },
        {
          oauthRefreshTokenEnc: null,
          enabled: false,
          lastError: null,
          lastErrorAt: null,
        },
      );
    });
  }

  /**
   * Open the state, check it is the caller's, and spend its nonce. A bad,
   * altered, expired, foreign or already used state is the same 400, so nothing
   * tells a probing caller which of them it was.
   */
  private async claimState(userId: string, sealed: string) {
    let state;
    try {
      state = openOAuthState(this.encryption, sealed);
    } catch (error) {
      if (error instanceof OAuthStateError) throw invalidState();
      throw error;
    }
    if (state.userId !== userId) throw invalidState();
    const won = await this.singleUseTokens.claim(
      OAUTH_STATE_PURPOSE,
      state.nonce,
      OAUTH_STATE_TTL_MS,
    );
    if (!won) throw invalidState();
    return state;
  }

  private requireEncryption(): void {
    if (!this.encryption.isConfigured()) {
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.oauthNeedsEncryption",
          "This server has no encryption key configured, so a mailbox sign-in cannot be stored.",
        ),
      );
    }
  }
}

function invalidState(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.emailReceipts.oauthStateInvalid",
      "This sign-in link is not valid any more. Start connecting the mailbox again.",
    ),
  );
}

function providerNotConfigured(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.emailReceipts.oauthProviderNotConfigured",
      "Sign-in with this provider is not set up on this server.",
    ),
  );
}

function mailboxNotFound(): NotFoundException {
  return new NotFoundException(
    tr(
      "errors.emailReceipts.mailboxNotFound",
      "No mailbox is set up for this account.",
    ),
  );
}
