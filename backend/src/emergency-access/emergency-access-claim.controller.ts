import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
  Res,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import * as bcrypt from "bcryptjs";
import { Response } from "express";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { hashToken } from "../auth/crypto.util";
import { TokenService } from "../auth/token.service";
import { PasswordBreachService } from "../auth/password-breach.service";
import { AuthService } from "../auth/auth.service";
import {
  revokeOAuthGrantsAfterCommit,
  revokeStandingCredentials,
} from "../auth/credential-revocation";
import { EncryptionService } from "../common/encryption/encryption.service";
import { generateCsrfToken, getCsrfCookieOptions } from "../common/csrf.util";
import { withSystemContext } from "../common/db/with-context";
import { decryptMessage } from "./decrypt-message.util";
import { ClaimCompleteDto, ClaimPreviewDto } from "./dto/claim.dto";

/**
 * True while the owner has NOT returned, with the same meaning as
 * `revokeReturnedOwners` in the monitor: the owner is active, has a last-seen
 * time (`last_activity_at`, else `last_login`), and was seen fewer than
 * `grant_after_days` whole days ago. The daily cron alone voids a returned
 * owner's link; this makes the claim refuse in the hours before it runs.
 */
const OWNER_NOT_RETURNED_SQL = `NOT EXISTS (
            SELECT 1
              FROM users u
              JOIN emergency_access_settings s ON s.owner_user_id = u.id
             WHERE u.id = emergency_access_contacts.owner_user_id
               AND s.enabled = true
               AND s.granted_at IS NOT NULL
               AND u.is_active = true
               AND COALESCE(u.last_activity_at, u.last_login) IS NOT NULL
               AND FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(u.last_activity_at, u.last_login))) / 86400) < s.grant_after_days
          )`;

@ApiTags("Emergency Access")
@Controller("emergency-access/claim")
export class EmergencyAccessClaimController {
  private readonly logger = new Logger(EmergencyAccessClaimController.name);
  private readonly useSecureCookies: boolean;

  constructor(
    private readonly dataSource: DataSource,
    private readonly tokenService: TokenService,
    private readonly authService: AuthService,
    private readonly passwordBreachService: PasswordBreachService,
    private readonly encryption: EncryptionService,
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {
    const disableHttpsHeaders =
      this.configService
        .get<string>("DISABLE_HTTPS_HEADERS", "false")
        .toLowerCase() === "true";
    this.useSecureCookies =
      this.configService.get<string>("NODE_ENV") === "production" &&
      !disableHttpsHeaders;
  }

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  private async findValidContact(
    rawToken: string,
  ): Promise<EmergencyAccessContact> {
    const tokenHash = hashToken(rawToken);
    const contact = await this.scoped(EmergencyAccessContact, (repo) =>
      repo.findOne({
        where: { claimTokenHash: tokenHash },
      }),
    );
    // A returned owner reads as an invalid link: same refusal, nothing to enumerate.
    const ownerAway = contact
      ? await withScopedDb(this.dataSource, (manager) =>
          manager.query(
            `SELECT id FROM emergency_access_contacts
              WHERE id = $1 AND ${OWNER_NOT_RETURNED_SQL}`,
            [contact.id],
          ),
        )
      : [];
    if (
      !contact ||
      returnedRows<{ id: string }>(ownerAway).length === 0 ||
      !contact.claimTokenExpiresAt ||
      contact.claimTokenUsedAt ||
      contact.claimTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new NotFoundException(
        tr(
          "errors.emergencyAccess.invalidClaimLink",
          "This emergency access link is invalid, expired, or has already been used.",
        ),
      );
    }
    return contact;
  }

  @Post("preview")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary: "Validate the magic link and return the contact's first name",
  })
  async preview(@Body() dto: ClaimPreviewDto) {
    // RLS (task C4): the claimant is the grantee (or a bare token), not the
    // owner, so the contact lookup by token hash is owner-keyed but runs with
    // the wrong identity. Run under a system context. Inert at RLS_MODE=off --
    // only seeds AsyncLocalStorage.
    return withSystemContext(() => this.previewWithinContext(dto));
  }

  private async previewWithinContext(dto: ClaimPreviewDto) {
    const contact = await this.findValidContact(dto.token);
    // The token alone proves nothing about who holds it, so the owner's name and
    // decrypted message are returned by `complete` only; this audit line is the
    // trace a leaked link leaves before any takeover (#2173, #2180).
    this.logger.log(
      `Emergency access claim link previewed for contact ${contact.id} of user ${contact.ownerUserId}`,
    );
    return {
      contactFirstName: contact.firstName,
      expiresAt: contact.claimTokenExpiresAt,
    };
  }

  @Post("complete")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary:
      "Consume the magic link, replace the owner's password, and sign in",
  })
  async complete(@Body() dto: ClaimCompleteDto, @Res() res: Response) {
    // RLS (task C4): the claim rewrites the OWNER's credentials across users,
    // user_preferences, trusted_devices, the emergency-access tables and
    // refresh_tokens while the requester is the grantee/bare token -- run the
    // whole flow under a system context.
    return withSystemContext(() => this.completeWithinContext(dto, res));
  }

  private async completeWithinContext(dto: ClaimCompleteDto, res: Response) {
    // Validate the magic link before doing any expensive work. Otherwise an
    // unauthenticated caller could force a breach lookup and a bcrypt hash
    // (cost 12) on every request with a bogus token. This is a cheap rejection
    // only -- the transaction below *consumes* the token conditionally, which is
    // what actually makes it single-use.
    await this.findValidContact(dto.token);

    const isBreached = await this.passwordBreachService.isBreached(
      dto.newPassword,
    );
    if (isBreached) {
      throw new BadRequestException(
        tr(
          "errors.emergencyAccess.passwordBreached",
          "This password has been found in a data breach. Please choose a different password.",
        ),
      );
    }

    const tokenHash = hashToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    const { ownerId, messageCiphertext } = await withScopedDb(
      this.dataSource,
      async (manager) => {
        // CONSUME THE TOKEN FIRST, in one conditional statement, before touching a
        // single credential.
        //
        // The previous shape was a `findOne` followed by an ordinary entity save,
        // under a comment claiming it revalidated "under lock" -- there was no
        // lock and no predicate. Two requests could both read the unused token,
        // both replace the owner's password with a different value, and both mark
        // it used: an account-takeover race where an attacker holding the link
        // competes with the intended contact instead of merely arriving second
        // (audit P4-007, DOC-04-04).
        //
        // `claim_token_used_at IS NULL` and the expiry are predicates of the
        // UPDATE, so PostgreSQL re-evaluates them after the row lock. Exactly one
        // statement gets a row back; every other caller sees zero and is refused
        // before anything is written.
        //
        // `claim_voided_reason = NULL` is belt-and-braces, not a guard: every path
        // that writes a reason stamps `claim_token_used_at` alongside it, so the
        // WHERE above already excludes every row where it could be non-NULL.
        const consumed: unknown = await manager.query(
          `UPDATE emergency_access_contacts
            SET claim_token_used_at = CURRENT_TIMESTAMP,
                claim_token_hash = NULL,
                claim_token_ciphertext = NULL,
                claim_voided_reason = NULL
          WHERE claim_token_hash = $1
            AND claim_token_used_at IS NULL
            AND claim_token_expires_at IS NOT NULL
            AND claim_token_expires_at >= CURRENT_TIMESTAMP
            AND ${OWNER_NOT_RETURNED_SQL}
          RETURNING id, owner_user_id`,
          [tokenHash],
        );
        const claimed = returnedRows<{ id: string; owner_user_id: string }>(
          consumed,
        );
        if (claimed.length === 0) {
          throw new NotFoundException(
            tr(
              "errors.emergencyAccess.invalidClaimLink",
              "This emergency access link is invalid, expired, or has already been used.",
            ),
          );
        }
        const contactId = claimed[0].id;
        const ownerId = claimed[0].owner_user_id;

        const owner = await manager.findOne(User, {
          where: { id: ownerId },
        });
        if (!owner) {
          throw new NotFoundException(
            tr(
              "errors.emergencyAccess.ownerAccountGone",
              "Owner account no longer exists.",
            ),
          );
        }

        // Replace credentials so the contact can sign in.
        await manager
          .createQueryBuilder()
          .update(User)
          .set({
            passwordHash,
            mustChangePassword: false,
            twoFactorSecret: null,
            pendingTwoFactorSecret: null,
            backupCodes: null,
            authProvider: "local",
            lastLogin: new Date(),
            lastActivityAt: new Date(),
            failedLoginAttempts: 0,
            lockedUntil: null,
            resetToken: null,
            resetTokenExpiry: null,
          })
          .where("id = :id", { id: ownerId })
          .execute();

        // 2FA on the preferences side.
        await manager
          .createQueryBuilder()
          .update(UserPreference)
          .set({ twoFactorEnabled: false })
          .where("user_id = :id", { id: ownerId })
          .execute();

        // Trusted devices and personal access tokens belonged to the previous
        // holder: a claim that left a PAT live would share the account with
        // whoever the owner handed one to (`credential-revocation.ts`).
        await revokeStandingCredentials(manager, ownerId);

        // The claiming token was already consumed above; void the siblings
        // (single-claim wins).
        await manager
          .createQueryBuilder()
          .update(EmergencyAccessContact)
          .set({
            claimTokenHash: null,
            claimTokenExpiresAt: null,
            claimTokenUsedAt: () => "CURRENT_TIMESTAMP",
            claimVoidedReason: "claimed_by_other",
            // The credential goes with the hash that made it usable: worthless
            // without one, but still a recoverable secret under the application
            // key, and nothing will ever want it again (DR-RRV4-03).
            claimTokenCiphertext: null,
          })
          .where("owner_user_id = :id", { id: ownerId })
          .andWhere("id <> :contactId", { contactId })
          .andWhere("claim_token_hash IS NOT NULL")
          .andWhere("claim_token_used_at IS NULL")
          .execute();

        // Read inside the claim transaction, so nothing that can fail sits
        // between the commit and the new session; decrypted after the commit.
        const settings = await manager
          .getRepository(EmergencyAccessSettings)
          .findOne({ where: { ownerUserId: ownerId } });

        // Disable the emergency access feature on the now-claimed account so
        // the cron does not re-fire if the new holder ever lapses.
        await manager
          .createQueryBuilder()
          .update(EmergencyAccessSettings)
          .set({ enabled: false, grantedAt: new Date() })
          .where("owner_user_id = :id", { id: ownerId })
          .execute();

        return {
          ownerId,
          messageCiphertext: settings?.messageCiphertext ?? null,
        };
      },
    );

    // Revoke every existing refresh token *after* the transaction, and the reason
    // is not the one that used to be written here ("it writes via its own repo" --
    // `TokenService.revokeAllUserRefreshTokens` is `withScopedDb` and would join an
    // ambient transaction happily). It is that the method deliberately runs up to
    // ten passes, each in its own transaction, converging against sessions being
    // rotated concurrently; nesting it would collapse those passes into one and
    // destroy the convergence.
    //
    // That leaves a real seam: the password is already replaced and committed, so a
    // failure here means the takeover happened while the previous holder's sessions
    // are still live. The claimant sees a 500 and can retry the login, but nothing
    // retries the revocation -- so it is logged at `error` with the account id,
    // which is what makes it alertable rather than a line in a stack trace.
    try {
      await this.tokenService.revokeAllUserRefreshTokens(ownerId);
    } catch (error) {
      this.logger.error(
        `Emergency-access takeover of account ${ownerId} committed, but revoking ` +
          `the previous holder's refresh tokens failed; their sessions may still be ` +
          `active and need revoking by hand`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
    // And the OAuth grants the previous holder's MCP clients were given.
    await revokeOAuthGrantsAfterCommit(this.moduleRef, ownerId, this.logger);

    const freshOwner = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: ownerId } }),
    );
    if (!freshOwner) {
      throw new NotFoundException(
        tr(
          "errors.emergencyAccess.ownerAccountGone",
          "Owner account no longer exists.",
        ),
      );
    }

    const message = decryptMessage(
      this.encryption,
      this.logger,
      messageCiphertext,
    );

    const { accessToken, refreshToken } =
      await this.tokenService.generateTokenPair(freshOwner, false);

    res.cookie("auth_token", accessToken, {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "lax" as const,
      maxAge: 15 * 60 * 1000,
      path: "/",
    });
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "strict" as const,
      maxAge: this.tokenService.getRefreshExpiryMs(false),
      path: "/",
    });
    res.cookie(
      "csrf_token",
      generateCsrfToken(freshOwner.id, this.authService.getCsrfKey()),
      getCsrfCookieOptions(this.useSecureCookies),
    );

    this.logger.log(`Emergency access claim completed for user ${ownerId}`);

    res.json({
      ok: true,
      ownerFirstName: freshOwner.firstName,
      ownerLastName: freshOwner.lastName,
      message,
    });
  }
}
