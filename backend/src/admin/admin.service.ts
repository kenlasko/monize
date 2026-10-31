import {
  assertSharedOwnershipTransferred,
  eraseSharedUser,
} from "../shared-expenses/shared-erasure";
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  localAuthEnabled,
  oidcPasswordLoginAllowed,
} from "../auth/oidc/oidc-password-login";
import { DataSource, EntityManager, FindOptionsWhere } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import { I18nService } from "nestjs-i18n";
import { tr } from "../i18n/translate";
import { emailTranslator } from "../i18n/email-translator";
import { resolveUserEmailLocale } from "../i18n/resolve-user-email-locale";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { patchUserPreferences } from "../users/user-preference-writer";
import { generateReadablePassword } from "./utils/password-generator";
import { hashToken } from "../auth/crypto.util";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import {
  revokeRefreshSessionsAfterCommit,
  revokeStandingCredentials,
} from "../auth/credential-revocation";
import { UsersService } from "../users/users.service";
import {
  lockAdminsForUpdate,
  wouldRemoveLastAdmin,
} from "../users/last-admin.util";
import { EmailService } from "../notifications/email.service";
import { accountInviteTemplate } from "../notifications/email-templates";
import { CreateUserDto } from "./dto/create-user.dto";
import { toUserProfile, UserProfile } from "../users/user-profile";
import {
  AttachmentsService,
  AttachmentStorageUsage,
} from "../attachments/attachments.service";
import {
  AutoBackupService,
  StoredBackupUsage,
} from "../backup/auto-backup.service";
import { CLEARED_BACKUP_KEY } from "../backup/backup-encryption.service";

/**
 * Who the admin screens manage: everybody except the owner-managed delegate
 * identities -- users that exist solely because an account owner added them via
 * Shared Access, and are managed from that owner's page instead.
 *
 * One constant rather than the clause spelled out per query, because the user
 * list and the storage figures beside it have to enumerate the same people: a
 * user in one and not the other would render as an account storing nothing.
 */
const MANAGED_USERS: FindOptionsWhere<User> = { isDelegateOnly: false };

/** The order both managed-user listings use, oldest account first. */
const MANAGED_USERS_ORDER = { createdAt: "ASC" } as const;

/**
 * What one user occupies on this deployment's storage, as the admin user list
 * shows it.
 *
 * Two independent figures, kept apart on purpose: attachments are counted from
 * metadata rows and are always known, while the backups are counted by
 * enumerating whatever store this deployment writes to and can therefore be
 * unknown. Summing them into one number would have to answer for a component
 * that may be missing, so no such total is offered.
 */
export interface AdminUserStorageUsage {
  readonly userId: string;
  readonly backups: StoredBackupUsage;
  readonly attachments: AttachmentStorageUsage;
}

/**
 * The admin create-user response: the complete profile plus the fields only
 * this flow produces. Named so removing a required admin field from the
 * allowlist fails to compile here, at the response construction site, rather
 * than surfacing as a missing property in the admin UI.
 */
type CreatedAdminUserProfile = UserProfile & {
  temporaryPassword: string | undefined;
  invited: boolean;
  upgraded: boolean;
};

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly BCRYPT_ROUNDS = 12;

  constructor(
    private oauthProviderService: OAuthProviderService,
    private usersService: UsersService,
    private dataSource: DataSource,
    private configService: ConfigService,
    private emailService: EmailService,
    private readonly i18n: I18nService,
    private readonly attachmentsService: AttachmentsService,
    private readonly autoBackupService: AutoBackupService,
  ) {}

  async findAllUsers(): Promise<UserProfile[]> {
    return withSystemContext(() => this.findAllUsersWithinContext());
  }

  private async findAllUsersWithinContext(): Promise<UserProfile[]> {
    // Hide owner-managed delegate identities -- users that exist solely
    // because an account owner added them via Shared Access. Those rows
    // are managed from the owner's Shared Access page. The is_delegate_only
    // column is set when createDelegate provisions a new user and cleared
    // when the user upgrades into a full account via the /register claim
    // path, so a self-registered user who happens to also be a delegate
    // still shows up here.
    const users = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(User).find({
        where: MANAGED_USERS,
        order: MANAGED_USERS_ORDER,
      }),
    );
    return users.map((user) => toUserProfile(user));
  }

  /**
   * What each managed user occupies on this deployment's storage: their
   * automatic backups and their attachments.
   *
   * Its own endpoint rather than extra fields on the user list, because the two
   * cost very different things to answer. The list is one query; this
   * enumerates the backup store once per user, which on an object store is a
   * round trip each -- folding it in would make opening User Management wait on
   * S3, and a store that has gone slow would look like a broken page rather
   * than like two columns that have not filled in yet.
   */
  async getUserStorageUsage(): Promise<AdminUserStorageUsage[]> {
    return withSystemContext(() => this.getUserStorageUsageWithinContext());
  }

  private async getUserStorageUsageWithinContext(): Promise<
    AdminUserStorageUsage[]
  > {
    const users = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(User).find({
        where: MANAGED_USERS,
        order: MANAGED_USERS_ORDER,
        select: { id: true },
      }),
    );

    // One grouped aggregate for every user's attachments, against the metadata
    // rows that record each file's size -- so the figure is the same whichever
    // provider holds the bytes (database, local or S3) and no object store is
    // enumerated for it at all.
    const attachmentsByUser =
      await this.attachmentsService.summarizeUsageByUser();

    // The backups, by contrast, are only knowable by asking the store, and the
    // store keeps one namespace per user. Sequentially: on the `s3` target each
    // call is a ListObjectsV2, and fanning an unbounded user list out in
    // parallel would put the whole deployment's users on the wire at once for a
    // page that is not latency-critical.
    const usage: AdminUserStorageUsage[] = [];
    for (const user of users) {
      usage.push({
        userId: user.id,
        backups: await this.autoBackupService.summarizeStoredBackups(user.id),
        // A user with no attachments has no aggregate row; zero is the honest
        // figure for an account that stores nothing, and is not a stand-in for
        // an answer nobody could obtain.
        attachments: attachmentsByUser.get(user.id) ?? { files: 0, bytes: 0 },
      });
    }
    return usage;
  }

  async createUser(dto: CreateUserDto): Promise<CreatedAdminUserProfile> {
    return withSystemContext(() => this.createUserWithinContext(dto));
  }

  private async createUserWithinContext(
    dto: CreateUserDto,
  ): Promise<CreatedAdminUserProfile> {
    const email = dto.email.toLowerCase().trim();
    const role = dto.role === "admin" ? "admin" : "user";

    if (dto.password && dto.sendInvite) {
      throw new BadRequestException(
        tr(
          "errors.admin.passwordOrInviteNotBoth",
          "Provide either a password or an email invite, not both.",
        ),
      );
    }
    if (dto.sendInvite && !this.emailService.getStatus().configured) {
      throw new BadRequestException(
        tr(
          "errors.admin.smtpNotConfigured",
          "SMTP is not configured. Set a password for the user instead.",
        ),
      );
    }

    let temporaryPassword: string | undefined;
    let inviteToken: string | undefined;

    const { saved, upgraded } = await withScopedDb(
      this.dataSource,
      async (manager) => {
        const existing = await manager.findOne(User, { where: { email } });

        let user: User;
        let upgraded = false;

        if (existing) {
          // Only an owner-managed "pure delegate" row (created via Shared
          // Access, owns no data of its own) may be turned into a full
          // account here. Any other existing row belongs to a real account
          // and rotating its credentials would be account takeover. The
          // is_delegate_only flag is the canonical signal for this state --
          // it is set when a delegate is provisioned and cleared the moment
          // the user upgrades into a full account.
          const claimable =
            existing.isDelegateOnly === true &&
            existing.authProvider === "local";
          if (!claimable) {
            throw new ConflictException(
              tr(
                "errors.admin.emailAlreadyExists",
                "A user with this email address already exists.",
              ),
            );
          }
          user = existing;
          upgraded = true;
          if (dto.firstName !== undefined) {
            user.firstName = dto.firstName ?? null;
          }
          if (dto.lastName !== undefined) {
            user.lastName = dto.lastName ?? null;
          }
          user.role = role;
          // Promote out of the owner-managed delegate state: the row becomes
          // a standalone account (visible in User Management, gets its own
          // "self" context) while keeping every delegation others granted it.
          user.isDelegateOnly = false;
          // Admin-created accounts are trusted (the admin vouches for the
          // email, and any invite link is delivered to it), so they bypass the
          // self-service email-verification gate.
          user.emailVerified = true;
        } else {
          user = manager.create(User, {
            email,
            firstName: dto.firstName ?? null,
            lastName: dto.lastName ?? null,
            authProvider: "local",
            role,
            isDelegateOnly: false,
            // Admin-created accounts bypass the email-verification gate.
            emailVerified: true,
          });
        }

        if (dto.sendInvite) {
          const rawToken = crypto.randomBytes(32).toString("hex");
          user.resetToken = hashToken(rawToken);
          user.resetTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
          // The invitee sets their own password via the reset link.
          user.mustChangePassword = false;
          inviteToken = rawToken;
        } else if (dto.password) {
          user.passwordHash = await bcrypt.hash(
            dto.password,
            this.BCRYPT_ROUNDS,
          );
          user.mustChangePassword = false;
          user.resetToken = null;
          user.resetTokenExpiry = null;
          user.failedLoginAttempts = 0;
          user.lockedUntil = null;
        } else {
          temporaryPassword = generateReadablePassword();
          user.passwordHash = await bcrypt.hash(
            temporaryPassword,
            this.BCRYPT_ROUNDS,
          );
          user.mustChangePassword = true;
          user.resetToken = null;
          user.resetTokenExpiry = null;
          user.failedLoginAttempts = 0;
          user.lockedUntil = null;
        }

        const saved = await manager.save(user);
        return { saved, upgraded };
      },
    );

    if (inviteToken) {
      const frontendUrl = this.configService.get<string>(
        "PUBLIC_APP_URL",
        "http://localhost:3000",
      );
      const inviteUrl = `${frontendUrl}/reset-password?token=${inviteToken}`;
      const lang = await withScopedDb(this.dataSource, (manager) =>
        resolveUserEmailLocale(manager.getRepository(UserPreference), saved.id),
      );
      const t = emailTranslator(this.i18n, lang);
      this.emailService
        .sendMail(
          email,
          t("emails.accountInvite.subject", "Your Monize account is ready"),
          accountInviteTemplate(dto.firstName || "", inviteUrl, t),
        )
        .catch((err) =>
          this.logger.warn(
            `Failed to send account invite email: ${
              err instanceof Error ? err.message : err
            }`,
          ),
        );
    }

    return {
      ...toUserProfile(saved),
      temporaryPassword,
      invited: !!inviteToken,
      upgraded,
    };
  }

  async updateUserRole(
    adminId: string,
    targetUserId: string,
    role: string,
  ): Promise<UserProfile> {
    return withSystemContext(() =>
      this.updateUserRoleWithinContext(adminId, targetUserId, role),
    );
  }

  private async updateUserRoleWithinContext(
    adminId: string,
    targetUserId: string,
    role: string,
  ): Promise<UserProfile> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        tr(
          "errors.admin.cannotChangeOwnRole",
          "You cannot change your own role",
        ),
      );
    }

    // One transaction, and the admin set locked inside it: the last-admin check
    // and the demotion are a read-modify-write over the same set of rows. A
    // count would let two concurrent demotions of two *different* admins both
    // see two and both proceed, leaving nobody able to administer the instance
    // -- one transaction is not enough on its own, because neither sees the
    // other's uncommitted change.
    const saved = await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);

      // Locked before the target is read, so this read also reflects a
      // concurrent role change that has since committed.
      const adminIds = await lockAdminsForUpdate(manager);

      const targetUser = await repo.findOne({
        where: { id: targetUserId },
      });
      if (!targetUser) {
        throw new NotFoundException(
          tr("errors.admin.userNotFound", "User not found"),
        );
      }

      // Prevent removing the last admin
      if (
        targetUser.role === "admin" &&
        role === "user" &&
        wouldRemoveLastAdmin(adminIds, targetUserId)
      ) {
        throw new BadRequestException(
          tr(
            "errors.admin.removeLastAdmin",
            "Cannot remove the last admin. Promote another user first.",
          ),
        );
      }

      targetUser.role = role;
      return repo.save(targetUser);
    });
    return toUserProfile(saved);
  }

  async updateUserStatus(
    adminId: string,
    targetUserId: string,
    isActive: boolean,
  ): Promise<UserProfile> {
    return withSystemContext(() =>
      this.updateUserStatusWithinContext(adminId, targetUserId, isActive),
    );
  }

  private async updateUserStatusWithinContext(
    adminId: string,
    targetUserId: string,
    isActive: boolean,
  ): Promise<UserProfile> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        tr(
          "errors.admin.cannotDisableOwnAccount",
          "You cannot disable your own account",
        ),
      );
    }

    const saved = await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      const targetUser = await repo.findOne({
        where: { id: targetUserId },
      });
      if (!targetUser) {
        throw new NotFoundException(
          tr("errors.admin.userNotFound", "User not found"),
        );
      }

      targetUser.isActive = isActive;
      const updated = await repo.save(targetUser);
      // A disable and the end of its standing credentials are one commit.
      if (!isActive) {
        await this.revokeStandingAccess(manager, targetUserId);
      }
      return updated;
    });

    // SECURITY: Revoke all refresh tokens, PATs, and OIDC artifacts when
    // deactivating a user to immediately invalidate every authenticated
    // surface — web sessions (refresh tokens), CLI/API access (PATs), and
    // MCP/OAuth clients (access + refresh tokens, authorization codes,
    // grants, sessions). Without the OIDC sweep, an MCP client could keep
    // calling tools for up to the access-token TTL even after deactivation.
    if (!isActive) {
      await this.endSessionsAfterCommit(targetUserId);
    }

    return toUserProfile(saved);
  }

  async deleteUser(
    adminId: string,
    targetUserId: string,
  ): Promise<{ downgraded: boolean }> {
    return withSystemContext(() =>
      this.deleteUserWithinContext(adminId, targetUserId),
    );
  }

  private async deleteUserWithinContext(
    adminId: string,
    targetUserId: string,
  ): Promise<{ downgraded: boolean }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        tr(
          "errors.admin.cannotDeleteOwnAccount",
          "You cannot delete your own account",
        ),
      );
    }

    // Pre-flight, so an obviously refused delete does not first revoke the
    // target's sessions. The authoritative check is in the delete transaction
    // below, under the admin lock -- a guard that commits before the delete
    // starts holds nothing by the time the row is removed.
    const targetUser = await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      const found = await repo.findOne({
        where: { id: targetUserId },
      });
      if (!found) {
        throw new NotFoundException(
          tr("errors.admin.userNotFound", "User not found"),
        );
      }

      if (
        found.role === "admin" &&
        wouldRemoveLastAdmin(await lockAdminsForUpdate(manager), targetUserId)
      ) {
        throw new BadRequestException(
          tr(
            "errors.admin.deleteLastAdmin",
            "Cannot delete the last admin account.",
          ),
        );
      }
      await assertSharedOwnershipTransferred(manager, targetUserId);
      return found;
    });

    // Revoke sessions/PATs and sweep OIDC artifacts (forces re-login and
    // avoids orphan oauth_payloads rows) -- needed whether the account is
    // fully removed or demoted to a delegate.
    await this.revokeSessionsAndTokens(targetUserId);

    // A full account that is also a delegate of someone else is demoted to
    // a pure delegate instead of being removed: their own data goes, but
    // their login and the delegate access others granted them stay.
    if (await this.usersService.isActingDelegate(targetUserId)) {
      await this.usersService.purgeForDowngrade(targetUserId);
      return { downgraded: true };
    }

    // Clear the rows that point at the user before removing it. Databases
    // predating migration 108 can carry TypeORM-generated foreign keys with no
    // ON DELETE CASCADE, which abort the delete outright; the sessions, tokens
    // and preferences are worthless once the account is gone either way.
    // Delegate sessions acting *as* this user go too -- the owner they point
    // at is about to disappear.
    // One transaction: a partially cleared account would leave live sessions
    // pointing at a user row that is about to disappear.
    await withScopedDb(this.dataSource, async (manager) => {
      // The authoritative last-admin check: taken here, in the transaction that
      // actually removes the row, so the lock is still held when it commits.
      if (
        targetUser.role === "admin" &&
        wouldRemoveLastAdmin(await lockAdminsForUpdate(manager), targetUserId)
      ) {
        throw new BadRequestException(
          tr(
            "errors.admin.deleteLastAdmin",
            "Cannot delete the last admin account.",
          ),
        );
      }

      await eraseSharedUser(manager, targetUserId);
      const refreshTokens = manager.getRepository(RefreshToken);
      await refreshTokens.delete({ userId: targetUserId });
      await refreshTokens.delete({ actingAsUserId: targetUserId });
      await manager
        .getRepository(PersonalAccessToken)
        .delete({ userId: targetUserId });
      await manager
        .getRepository(UserPreference)
        .delete({ userId: targetUserId });
      await manager.getRepository(User).remove(targetUser);
    });
    return { downgraded: false };
  }

  async resetUserPassword(
    adminId: string,
    targetUserId: string,
  ): Promise<{ temporaryPassword: string }> {
    return withSystemContext(() =>
      this.resetUserPasswordWithinContext(adminId, targetUserId),
    );
  }

  private async resetUserPasswordWithinContext(
    adminId: string,
    targetUserId: string,
  ): Promise<{ temporaryPassword: string }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        tr(
          "errors.admin.cannotResetOwnPassword",
          "You cannot reset your own password through the admin panel",
        ),
      );
    }

    const targetUser = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(User).findOne({
        where: { id: targetUserId },
      }),
    );
    if (!targetUser) {
      throw new NotFoundException(
        tr("errors.admin.userNotFound", "User not found"),
      );
    }

    if (
      targetUser.authProvider === "oidc" &&
      !localAuthEnabled(this.configService)
    ) {
      throw new BadRequestException(
        tr(
          "errors.admin.localAuthDisabled",
          "Password sign-in is turned off on this server",
        ),
      );
    }

    if (
      targetUser.authProvider === "oidc" &&
      !oidcPasswordLoginAllowed(this.configService)
    ) {
      throw new BadRequestException(
        tr(
          "errors.admin.ssoPasswordLoginDisabled",
          "Password sign-in is turned off for SSO accounts. Use Unlink SSO instead.",
        ),
      );
    }

    if (!targetUser.passwordHash) {
      throw new BadRequestException(
        tr(
          "errors.admin.noLocalPassword",
          "Cannot reset password for accounts without a local password",
        ),
      );
    }

    const { temporaryPassword, passwordHash } =
      await this.generateTemporaryPassword();
    this.applyTemporaryPassword(targetUser, passwordHash);
    // The new password, its PATs and its trusted devices are one commit: a
    // reset whose revocation fails leaves the old password in place rather than
    // a new password with the old credentials still live (INV-AUTH-005).
    await withScopedDb(this.dataSource, async (manager) => {
      await manager.getRepository(User).save(targetUser);
      await this.revokeStandingAccess(manager, targetUserId);
    });

    // SECURITY: then every refresh session and OIDC artifact, so the forced
    // password change applies everywhere — web, CLI/API, and MCP.
    await this.endSessionsAfterCommit(targetUserId);

    return { temporaryPassword };
  }

  /** A fresh readable password and its hash; hashed outside any transaction. */
  private async generateTemporaryPassword(): Promise<{
    temporaryPassword: string;
    passwordHash: string;
  }> {
    const temporaryPassword = generateReadablePassword();
    const saltRounds = 12;
    return {
      temporaryPassword,
      passwordHash: await bcrypt.hash(temporaryPassword, saltRounds),
    };
  }

  /** Give `user` the hashed temporary password, forced change, and no reset token or lockout. */
  private applyTemporaryPassword(user: User, passwordHash: string): void {
    user.passwordHash = passwordHash;
    user.mustChangePassword = true;
    user.resetToken = null;
    user.resetTokenExpiry = null;
    // An admin reset is a recovery action: the temporary password must work.
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }

  /**
   * Convert an SSO account back to a local one with a temporary password, so
   * the person can sign in while the IdP is down or SSO is not wanted for them.
   * TOTP fields stay as they are (`resetUserTwoFactor` is the recovery for a
   * lost device). A backup key an SSO account holds may sit under a dedicated
   * backup password (no login-password ref), which a local account does not
   * use, so the key is cleared here; the next password login wraps a new one
   * under the new password.
   */
  async unlinkUserSso(
    adminId: string,
    targetUserId: string,
  ): Promise<{ temporaryPassword: string }> {
    return withSystemContext(() =>
      this.unlinkUserSsoWithinContext(adminId, targetUserId),
    );
  }

  private async unlinkUserSsoWithinContext(
    adminId: string,
    targetUserId: string,
  ): Promise<{ temporaryPassword: string }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        tr(
          "errors.admin.cannotUnlinkOwnSso",
          "You cannot unlink your own SSO account through the admin panel",
        ),
      );
    }

    if (!localAuthEnabled(this.configService)) {
      throw new BadRequestException(
        tr(
          "errors.admin.localAuthDisabled",
          "Password sign-in is turned off on this server",
        ),
      );
    }

    // Hash before the transaction: bcrypt must not hold the row lock.
    const { temporaryPassword, passwordHash } =
      await this.generateTemporaryPassword();
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(User);
      const targetUser = await repo.findOne({
        where: { id: targetUserId },
        lock: { mode: "pessimistic_write" },
      });
      if (!targetUser) {
        throw new NotFoundException(
          tr("errors.admin.userNotFound", "User not found"),
        );
      }
      if (targetUser.authProvider !== "oidc") {
        throw new BadRequestException(
          tr(
            "errors.admin.notSsoAccount",
            "This account is not an SSO account",
          ),
        );
      }
      if (!targetUser.email) {
        throw new BadRequestException(
          tr(
            "errors.admin.unlinkSsoNeedsEmail",
            "This account has no email address, so it cannot sign in with a password",
          ),
        );
      }
      targetUser.authProvider = "local";
      targetUser.oidcSubject = null;
      targetUser.pendingOidcSubject = null;
      targetUser.oidcLinkPending = false;
      targetUser.oidcLinkToken = null;
      targetUser.oidcLinkExpiresAt = null;
      this.applyTemporaryPassword(targetUser, passwordHash);
      if (targetUser.backupKeyWrap) {
        Object.assign(targetUser, CLEARED_BACKUP_KEY);
      }
      await repo.save(targetUser);
      await this.revokeStandingAccess(manager, targetUserId);
    });
    await this.endSessionsAfterCommit(targetUserId);

    return { temporaryPassword };
  }

  /**
   * Switch off a user's two-factor authentication so they can sign in with
   * their password and enroll again.
   *
   * The recovery for a user who lost their authenticator and their backup
   * codes, and for everyone enrolled before a `JWT_SECRET` change: the TOTP
   * secret is encrypted under a key derived from it, so after a change it can
   * no longer be decrypted and authenticator codes stop working. That is why
   * this never decrypts anything -- it clears the columns, whatever they hold.
   *
   * One transaction: the TOTP secret, the staged setup secret and the backup
   * codes are cleared, the preference flag is switched off, trusted devices
   * (which skip the second factor) are deleted and the user's refresh tokens
   * are revoked, so a reset cannot commit half done or leave a session that was
   * established under the old enrollment. Under FORCE_2FA the user is sent to
   * set 2FA up again at their next sign-in (`ProtectedRoute`).
   *
   * Refused for the caller themself, like the other credential actions here: a
   * stolen admin session must not be able to strip its own second factor
   * without the code `disable2FA` asks for. Refused with a 400, rather than
   * reported as a success, for a user with no 2FA state at all, so the admin
   * learns they picked the wrong account.
   */
  async resetUserTwoFactor(
    adminId: string,
    targetUserId: string,
  ): Promise<{ reset: true }> {
    return withSystemContext(() =>
      this.resetUserTwoFactorWithinContext(adminId, targetUserId),
    );
  }

  private async resetUserTwoFactorWithinContext(
    adminId: string,
    targetUserId: string,
  ): Promise<{ reset: true }> {
    if (adminId === targetUserId) {
      throw new ForbiddenException(
        tr(
          "errors.admin.cannotResetOwnTwoFactor",
          "You cannot reset your own two-factor authentication through the admin panel",
        ),
      );
    }

    await withScopedDb(this.dataSource, async (manager) => {
      const users = manager.getRepository(User);
      // Locked, so the "has 2FA" check and the clearing below see one state
      // even against a concurrent enrollment by the user.
      const targetUser = await users.findOne({
        where: { id: targetUserId },
        lock: { mode: "pessimistic_write" },
      });
      if (!targetUser) {
        throw new NotFoundException(
          tr("errors.admin.userNotFound", "User not found"),
        );
      }
      const preferences = await manager
        .getRepository(UserPreference)
        .findOne({ where: { userId: targetUserId } });
      const hasTwoFactor =
        targetUser.twoFactorSecret !== null ||
        targetUser.pendingTwoFactorSecret !== null ||
        targetUser.backupCodes !== null ||
        preferences?.twoFactorEnabled === true;
      if (!hasTwoFactor) {
        throw new BadRequestException(
          tr(
            "errors.admin.twoFactorNotEnabled",
            "This user does not have two-factor authentication set up.",
          ),
        );
      }

      await users.update(
        { id: targetUserId },
        {
          twoFactorSecret: null,
          pendingTwoFactorSecret: null,
          backupCodes: null,
        },
      );
      await patchUserPreferences(manager, targetUserId, {
        twoFactorEnabled: false,
      });
      await manager.getRepository(TrustedDevice).delete({
        userId: targetUserId,
      });
      await manager
        .getRepository(RefreshToken)
        .update(
          { userId: targetUserId, isRevoked: false },
          { isRevoked: true },
        );
    });

    this.logger.log(
      `Administrator ${adminId} reset two-factor authentication for user ${targetUserId}`,
    );
    return { reset: true };
  }

  /**
   * Revoking every authenticated surface for a user -- web sessions (refresh
   * tokens), CLI/API access (PATs), trusted devices and MCP/OAuth clients -- is
   * two halves, and this is the one that commits with the caller's write:
   * a first-pass refresh revoke, PATs and trusted devices. The blanket refresh
   * UPDATE misses a successor a concurrent rotation inserts after its snapshot,
   * so `endSessionsAfterCommit` must follow the commit.
   */
  private async revokeStandingAccess(
    manager: EntityManager,
    targetUserId: string,
  ): Promise<void> {
    await manager
      .getRepository(RefreshToken)
      .update({ userId: targetUserId, isRevoked: false }, { isRevoked: true });
    await revokeStandingCredentials(manager, targetUserId);
  }

  /** The half that runs after the commit: converging refresh revoke, OAuth. */
  private async endSessionsAfterCommit(targetUserId: string): Promise<void> {
    await revokeRefreshSessionsAfterCommit(
      this.dataSource,
      targetUserId,
      this.logger,
    );
    await this.oauthProviderService.revokeAllForUser(targetUserId);
  }

  /** Both halves, for a path with no credential write of its own (delete). */
  private async revokeSessionsAndTokens(targetUserId: string): Promise<void> {
    await withScopedDb(this.dataSource, (manager: EntityManager) =>
      this.revokeStandingAccess(manager, targetUserId),
    );
    await this.endSessionsAfterCommit(targetUserId);
  }
}
