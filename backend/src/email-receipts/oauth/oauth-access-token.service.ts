import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { tr } from "../../i18n/translate";
import {
  EmailReceiptMailbox,
  type EmailReceiptOAuthProvider,
} from "../entities/email-receipt-mailbox.entity";
import { OAuthReconnectRequiredError, OAuthTokenError } from "./oauth-errors";
import { OAuthTokenClient } from "./oauth-token.client";

/** What a connection needs from an OAuth mailbox, and what to redact from its failures. */
export interface OAuthAccess {
  readonly accessToken: string;
  /** Every token this call held, plaintext, for redacting a failure line. Never log or store. */
  readonly secrets: readonly string[];
}

/** The refusal that tells the user the mailbox has to be connected again. */
export function oauthReconnectRequired(): OAuthReconnectRequiredError {
  return new OAuthReconnectRequiredError(
    tr(
      "errors.emailReceipts.oauthReconnectRequired",
      "The mailbox's sign-in was revoked or has expired. Connect the mailbox again in the mailbox settings.",
    ),
  );
}

/**
 * An access token for one OAuth mailbox, obtained fresh for each connection
 * (design section 3a): no access token is ever stored, so a stored credential is
 * the refresh token alone, encrypted (INV-RECEIPT-005).
 *
 * The provider's answer is acted on in two ways, both by a conditional UPDATE
 * keyed on the ciphertext this call read, so a concurrent connect, reconnect or
 * disconnect is never overwritten by a stale one:
 * - a rotated refresh token (`refresh_token` in the response) replaces the stored
 *   one, before the access token is used, since some providers end the old one;
 * - `invalid_grant` (revoked, expired, password changed, consent withdrawn)
 *   deletes the stored refresh token, since it can never work again. The mailbox
 *   keeps its row and its settings, and with no token it is skipped by the poll
 *   (`listEnabledMailboxes`) until the user connects it again; the caller
 *   records the reason as `last_error`.
 * The network call happens outside any database transaction: `withScopedDb` is
 * entered only to write.
 */
@Injectable()
export class OAuthAccessTokenService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly encryption: EncryptionService,
    private readonly tokens: OAuthTokenClient,
  ) {}

  async obtain(input: {
    userId: string;
    mailboxId: string;
    provider: EmailReceiptOAuthProvider;
    refreshTokenEnc: string | null;
  }): Promise<OAuthAccess> {
    const { userId, mailboxId, provider, refreshTokenEnc } = input;
    if (refreshTokenEnc === null) throw oauthReconnectRequired();

    let refreshToken: string;
    try {
      refreshToken = this.encryption.decrypt(refreshTokenEnc);
    } catch {
      // A key that changed since the token was stored: nothing in the message.
      throw new OAuthReconnectRequiredError(
        tr(
          "errors.emailReceipts.oauthTokenUnreadable",
          "The stored sign-in cannot be read on this server. Connect the mailbox again in the mailbox settings.",
        ),
      );
    }

    let grant;
    try {
      grant = await this.tokens.refresh(provider, refreshToken);
    } catch (error) {
      if (error instanceof OAuthTokenError && error.code === "invalid_grant") {
        await this.replaceToken(userId, mailboxId, refreshTokenEnc, null);
        throw oauthReconnectRequired();
      }
      throw error;
    }

    const secrets = [refreshToken, grant.accessToken];
    if (grant.refreshToken !== null && grant.refreshToken !== refreshToken) {
      secrets.push(grant.refreshToken);
      await this.replaceToken(
        userId,
        mailboxId,
        refreshTokenEnc,
        this.encryption.encrypt(grant.refreshToken),
      );
    }
    return { accessToken: grant.accessToken, secrets };
  }

  /**
   * Replace (or, with null, delete) the stored refresh token, only while it is
   * still the ciphertext this call read. Zero rows is fine: someone else
   * changed it first and their value stands.
   */
  private async replaceToken(
    userId: string,
    mailboxId: string,
    expectedEnc: string,
    nextEnc: string | null,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      await m
        .getRepository(EmailReceiptMailbox)
        .update(
          { id: mailboxId, userId, oauthRefreshTokenEnc: expectedEnc },
          { oauthRefreshTokenEnc: nextEnc },
        );
    });
  }
}
