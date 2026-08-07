import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  DataSource,
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import * as bcrypt from "bcryptjs";
import { tr } from "../i18n/translate";
import { User } from "./entities/user.entity";
import { UserPreference } from "./entities/user-preference.entity";
import { lockAdminsForUpdate, wouldRemoveLastAdmin } from "./last-admin.util";
import {
  ensureUserPreferencesRow,
  type UserPreferencePatch,
} from "./user-preference-writer";
import { TrustedDevice } from "./entities/trusted-device.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdatePreferencesDto } from "./dto/update-preferences.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { DeleteDataDto } from "./dto/delete-data.dto";
import { PasswordBreachService } from "../auth/password-breach.service";
import { ModuleRef } from "@nestjs/core";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { CurrenciesService } from "../currencies/currencies.service";
import { BackupEncryptionService } from "../backup/backup-encryption.service";
import { DemoModeService } from "../common/demo-mode.service";
import {
  OidcReauthService,
  type OidcReauthPurpose,
} from "../auth/oidc/oidc-reauth.service";
import { toUserProfile } from "./user-profile";
import { UserMaintenanceService } from "../common/jobs/user-maintenance.service";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private dataSource: DataSource,
    private passwordBreachService: PasswordBreachService,
    private moduleRef: ModuleRef,
    private demoModeService: DemoModeService,
    private oidcReauth: OidcReauthService,
    private maintenance: UserMaintenanceService,
  ) {}

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had. Multi-statement units use
   * an explicit `withScopedDb` block so their statements share one transaction.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  async findById(id: string): Promise<User | null> {
    return this.scoped(User, (repo) => repo.findOne({ where: { id } }));
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.scoped(User, (repo) => repo.findOne({ where: { email } }));
  }

  async findAll(): Promise<User[]> {
    return this.scoped(User, (repo) => repo.find());
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new NotFoundException(
        tr("errors.users.userNotFound", "User not found"),
      );
    }

    // SECURITY: Require password confirmation when changing email to prevent
    // account takeover via compromised session
    if (dto.email && dto.email !== user.email) {
      if (!dto.currentPassword) {
        throw new BadRequestException(
          tr(
            "errors.users.emailChangePasswordRequired",
            "Current password is required to change email address",
          ),
        );
      }
      if (!user.passwordHash) {
        throw new BadRequestException(
          tr(
            "errors.users.emailChangeNoLocalPassword",
            "Cannot change email for accounts without a local password",
          ),
        );
      }
      const isPasswordValid = await bcrypt.compare(
        dto.currentPassword,
        user.passwordHash,
      );
      if (!isPasswordValid) {
        throw new BadRequestException(
          tr(
            "errors.users.currentPasswordIncorrect",
            "Current password is incorrect",
          ),
        );
      }
      const existingUser = await this.scoped(User, (repo) =>
        repo.findOne({
          where: { email: dto.email },
        }),
      );
      if (existingUser) {
        throw new ConflictException(
          tr("errors.users.emailInUse", "Email already in use"),
        );
      }
      user.email = dto.email;
    }

    if (dto.firstName !== undefined) {
      user.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined) {
      user.lastName = dto.lastName;
    }

    const saved = await this.scoped(User, (repo) => repo.save(user));
    return toUserProfile(saved);
  }

  async getPreferences(userId: string): Promise<UserPreference> {
    // Materialize the row if it does not exist, then read it back. `language` is
    // seeded from the request locale (browser-detected on first visit, forwarded
    // by the proxy) so a row first materialized here captures the user's UI
    // language rather than defaulting everyone to English.
    //
    // Insert-if-absent rather than read-then-insert: the first page load fires
    // several requests at once, and two of them both finding no row used to mean
    // one got a unique violation on a plain read. Both statements are in one
    // transaction so the value returned is the value that is there.
    return withScopedDb(this.dataSource, async (manager) => {
      await ensureUserPreferencesRow(manager, userId);
      const preferences = await manager
        .getRepository(UserPreference)
        .findOne({ where: { userId } });
      // The insert above guarantees the row; the non-null assertion records that
      // rather than inventing a fallback that could mask a real absence.
      return preferences!;
    });
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<UserPreference> {
    // Build a patch of exactly the fields the request supplied, and write only
    // those. The previous shape mutated a loaded entity and `repo.save`d it,
    // which writes back every column that differs from what the entity holds --
    // including columns another request changed in between. `tour_progress`,
    // `last_seen_version` and `dismissed_update_version` are all written by
    // other endpoints on the same row, so saving a Settings form could quietly
    // undo a tour the user had just dismissed in another tab.
    const patch: UserPreferencePatch = {};

    if (dto.defaultCurrency !== undefined) {
      patch.defaultCurrency = dto.defaultCurrency;
    }
    if (dto.dateFormat !== undefined) {
      patch.dateFormat = dto.dateFormat;
    }
    if (dto.numberFormat !== undefined) {
      patch.numberFormat = dto.numberFormat;
    }
    if (dto.theme !== undefined) {
      patch.theme = dto.theme;
    }
    if (dto.colorTheme !== undefined) {
      patch.colorTheme = dto.colorTheme;
    }
    if (dto.timezone !== undefined) {
      patch.timezone = dto.timezone;
    }
    if (dto.notificationEmail !== undefined) {
      patch.notificationEmail = dto.notificationEmail;
    }
    if (dto.notificationBrowser !== undefined) {
      patch.notificationBrowser = dto.notificationBrowser;
    }
    if (dto.gettingStartedDismissed !== undefined) {
      patch.gettingStartedDismissed = dto.gettingStartedDismissed;
    }
    if (dto.aiBubbleEnabled !== undefined) {
      patch.aiBubbleEnabled = dto.aiBubbleEnabled;
    }
    if (dto.showWhatsNew !== undefined) {
      patch.showWhatsNew = dto.showWhatsNew;
    }
    if (dto.weekStartsOn !== undefined) {
      patch.weekStartsOn = dto.weekStartsOn;
    }
    if (dto.budgetDigestEnabled !== undefined) {
      patch.budgetDigestEnabled = dto.budgetDigestEnabled;
    }
    if (dto.budgetDigestDay !== undefined) {
      patch.budgetDigestDay = dto.budgetDigestDay;
    }
    if (dto.favouriteReportIds !== undefined) {
      patch.favouriteReportIds = dto.favouriteReportIds;
    }
    if (dto.dashboardWidgets !== undefined) {
      patch.dashboardWidgets = dto.dashboardWidgets;
    }
    if (dto.dashboardWidgetConfig !== undefined) {
      // A free-form JSONB map: `QueryDeepPartialEntity` treats a bare
      // `Record<string, unknown>` as a possible nested-entity patch, so say
      // plainly that this value is the column's whole contents.
      patch.dashboardWidgetConfig =
        dto.dashboardWidgetConfig as UserPreference["dashboardWidgetConfig"];
    }
    if (dto.showCreatedAt !== undefined) {
      patch.showCreatedAt = dto.showCreatedAt;
    }
    if (dto.timeFormat !== undefined) {
      patch.timeFormat = dto.timeFormat;
    }
    if (dto.preferredExchanges !== undefined) {
      patch.preferredExchanges = dto.preferredExchanges;
    }
    if (dto.defaultQuoteProvider !== undefined) {
      patch.defaultQuoteProvider = dto.defaultQuoteProvider;
    }
    if (dto.recentTransactionsLimit !== undefined) {
      patch.recentTransactionsLimit = dto.recentTransactionsLimit;
    }
    // In demo mode the account is shared across all visitors, so the UI
    // language must not be persisted to it -- otherwise one visitor's choice
    // would follow the next person until the nightly reset. The locale cookie
    // (set client-side) still applies the language for the current visit.
    if (dto.language !== undefined && !this.demoModeService.isDemo) {
      patch.language = dto.language;
    }

    // One transaction: materialize the row if absent, capture the currency the
    // refresh decision below compares against, apply the patch, read the result
    // back. The old code did each of those in its own autocommit transaction,
    // so the value it reported was not necessarily the value it wrote.
    const { saved, previousDefaultCurrency } = await withScopedDb(
      this.dataSource,
      async (manager) => {
        await ensureUserPreferencesRow(manager, userId);
        const repo = manager.getRepository(UserPreference);
        const before = await repo.findOne({ where: { userId } });
        // Copy the value out now, not after the write: reading it from `before`
        // later would depend on that object not having been touched by the
        // update in between.
        const previousDefaultCurrency = before?.defaultCurrency;
        if (Object.keys(patch).length > 0) {
          await repo
            .createQueryBuilder()
            .update()
            .set(patch)
            .where("user_id = :userId", { userId })
            .execute();
        }
        const after = await repo.findOne({ where: { userId } });
        return { saved: after!, previousDefaultCurrency };
      },
    );

    // Fetch fresh exchange rates whenever the user picks a new default
    // currency so multi-currency totals (Net Worth card, account group totals)
    // can convert immediately instead of waiting for the next daily cron.
    // Resolved lazily via ModuleRef to avoid a UsersModule -> CurrenciesModule
    // import that would create a circular dependency through Notifications.
    if (
      dto.defaultCurrency !== undefined &&
      dto.defaultCurrency !== previousDefaultCurrency
    ) {
      // Currencies are created on demand rather than seeded up front, so make
      // sure the newly chosen default currency exists (with a proper symbol)
      // before anything tries to display or convert it.
      try {
        const currenciesService = this.moduleRef.get(CurrenciesService, {
          strict: false,
        });
        await currenciesService.ensureSystemCurrency(dto.defaultCurrency);
      } catch (err) {
        this.logger.warn(
          `Could not ensure default currency ${dto.defaultCurrency} exists: ${err.message}`,
        );
      }
      try {
        const exchangeRateService = this.moduleRef.get(ExchangeRateService, {
          strict: false,
        });
        exchangeRateService.refreshAllRates().catch((err) => {
          this.logger.warn(
            `Background exchange rate refresh after default-currency change failed: ${err.message}`,
          );
        });
      } catch (err) {
        this.logger.warn(
          `Could not resolve ExchangeRateService for background refresh: ${err.message}`,
        );
      }
    }

    return saved;
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new NotFoundException(
        tr("errors.users.userNotFound", "User not found"),
      );
    }

    if (!user.passwordHash) {
      throw new BadRequestException(
        tr("errors.users.noPasswordSet", "No password set for this account"),
      );
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new BadRequestException(
        tr(
          "errors.users.currentPasswordIncorrect",
          "Current password is incorrect",
        ),
      );
    }

    // Check for breached password
    const isBreached = await this.passwordBreachService.isBreached(
      dto.newPassword,
    );
    if (isBreached) {
      throw new BadRequestException(
        tr(
          "errors.users.passwordBreached",
          "This password has been found in a data breach. Please choose a different password.",
        ),
      );
    }

    // Hash and save new password
    const saltRounds = 12;
    user.passwordHash = await bcrypt.hash(dto.newPassword, saltRounds);
    user.mustChangePassword = false;
    await this.scoped(User, (repo) => repo.save(user));

    // Re-sync the encrypted-backup password so the auto-backup cron keeps
    // working with the new login password. Best-effort; failures here log
    // but don't fail the password change.
    try {
      const backupEncryption = this.moduleRef.get(BackupEncryptionService, {
        strict: false,
      });
      await backupEncryption.rememberLoginPassword(userId, dto.newPassword);
    } catch (err) {
      this.logger.warn(
        `Could not sync backup password after change: ${err.message}`,
      );
    }

    // SECURITY: Revoke all refresh tokens to force re-login on all devices
    await this.scoped(RefreshToken, (repo) =>
      repo.update({ userId, isRevoked: false }, { isRevoked: true }),
    );

    // SECURITY: Revoke all PATs — credential change invalidates API access
    await this.scoped(PersonalAccessToken, (repo) =>
      repo.update({ userId, isRevoked: false }, { isRevoked: true }),
    );

    // SECURITY: Revoke trusted devices so a stolen trusted-device cookie
    // cannot bypass 2FA after the user rotates their password.
    await this.scoped(TrustedDevice, (repo) => repo.delete({ userId }));
  }

  /**
   * Second proof of identity for a destructive action.
   *
   * One method for both providers, because the three branches used to disagree
   * about what counts as proof and the weakest one decided:
   *
   * - OIDC accounts presented a client-supplied string, and any non-empty value
   *   was accepted -- the frontend literally sent `"oidc-session-confirmed"`.
   *   The second factor collapsed into possession of the session (P2-005). Now a
   *   signed, action-bound, one-time artifact minted by the OIDC callback after a
   *   `prompt=login` round trip.
   * - Local accounts with a password: unchanged, bcrypt comparison.
   * - Local accounts with NO password (admin-provisioned, reset not yet
   *   completed) fell off the end of the `else if` and were required to prove
   *   nothing at all. That branch now refuses, which is what the step-up service
   *   has always done for the same state.
   */
  private async reauthenticate(
    user: User,
    purpose: OidcReauthPurpose,
    dto: { password?: string; oidcIdToken?: string } | undefined,
  ): Promise<void> {
    if (user.authProvider === "oidc") {
      this.oidcReauth.consume(user.id, purpose, dto?.oidcIdToken);
      return;
    }
    if (!user.passwordHash) {
      throw new UnauthorizedException(
        tr(
          "errors.users.reauthUnavailable",
          "Finish setting up your account password before using this action.",
        ),
      );
    }
    if (!dto?.password) {
      throw new UnauthorizedException(
        tr(
          "errors.users.passwordRequiredForDelete",
          "Password is required to confirm this action",
        ),
      );
    }
    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException(
        tr("errors.users.invalidPassword", "Invalid password"),
      );
    }
  }

  async deleteAccount(
    userId: string,
    dto?: { password?: string; oidcIdToken?: string },
  ): Promise<{ downgraded: boolean }> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new NotFoundException(
        tr("errors.users.userNotFound", "User not found"),
      );
    }

    // SECURITY: Re-authenticate before account deletion.
    await this.reauthenticate(user, "delete-account", dto);

    // SECURITY: Prevent the last admin from self-deleting, which would leave
    // the system with no administrator.
    //
    // Pre-flight only, so an obviously refused deletion does not first revoke
    // the caller's own sessions. The authoritative check is under the admin lock
    // in the transaction that removes the row -- two admins self-deleting at the
    // same instant each counted two here and each proceeded, and the instance
    // ended up with none.
    if (user.role === "admin") {
      const adminCount = await this.scoped(User, (repo) =>
        repo.count({
          where: { role: "admin" },
        }),
      );
      if (adminCount <= 1) {
        throw new ForbiddenException(
          tr(
            "errors.users.deleteLastAdmin",
            "Cannot delete the last admin account. Promote another user first.",
          ),
        );
      }
    }

    // Revoke all refresh tokens and PATs (forces re-login either way).
    await this.scoped(RefreshToken, (repo) =>
      repo.update({ userId, isRevoked: false }, { isRevoked: true }),
    );
    await this.scoped(PersonalAccessToken, (repo) =>
      repo.update({ userId, isRevoked: false }, { isRevoked: true }),
    );

    // A full account that is also a delegate of someone else is demoted to
    // a pure delegate instead of being removed: their own data goes, but
    // their login and the delegate access others granted them stay, so
    // they can keep acting as a delegate.
    if (await this.isActingDelegate(userId)) {
      await this.purgeForDowngrade(userId);
      return { downgraded: true };
    }

    // Clear the rows that point at the user before removing it. Databases
    // predating migration 108 can carry TypeORM-generated foreign keys with no
    // ON DELETE CASCADE, which abort the delete outright; the sessions, tokens
    // and preferences are worthless once the account is gone either way.
    // Delegate sessions acting *as* this user go too -- the owner they point
    // at is about to disappear.
    await withScopedDb(this.dataSource, async (manager) => {
      // The authoritative last-admin check, in the transaction that removes the
      // row and while the lock over the admin set is still held.
      if (
        user.role === "admin" &&
        wouldRemoveLastAdmin(await lockAdminsForUpdate(manager), userId)
      ) {
        throw new ForbiddenException(
          tr(
            "errors.users.deleteLastAdmin",
            "Cannot delete the last admin account. Promote another user first.",
          ),
        );
      }

      const refreshTokens = manager.getRepository(RefreshToken);
      await refreshTokens.delete({ userId });
      await refreshTokens.delete({ actingAsUserId: userId });
      await manager.getRepository(PersonalAccessToken).delete({ userId });
      await manager.getRepository(UserPreference).delete({ userId });
      await manager.getRepository(User).remove(user);
    });
    return { downgraded: false };
  }

  /**
   * `reauthPurpose` names the action the caller's re-authentication artifact must
   * have been minted for. It defaults to the Settings "delete my data" flow; the
   * .mny import's wipe-first mode passes its own, so an artifact obtained for one
   * cannot silently drive the other -- they present different confirmations to
   * the user and one of them is followed by an import.
   *
   * @param initiator who asked. `"user-request"` is the self-service flow and
   *   must not overlap another operation replacing this account's data, so it
   *   takes the maintenance lease. `"mny-import"` is the importer's "start
   *   fresh" wipe, which already holds the user's single import slot -- taking
   *   the lease there would have it refuse itself, and consulting it would
   *   refuse on the importer's own in-flight job (audit DR-04-02).
   */
  async deleteData(
    userId: string,
    dto: DeleteDataDto,
    reauthPurpose: OidcReauthPurpose = "delete-data",
    initiator: "user-request" | "mny-import" = "user-request",
  ): Promise<{ deleted: Record<string, number> }> {
    if (initiator === "user-request") {
      return this.maintenance.withMaintenanceLease(
        userId,
        "delete my data",
        () => this.deleteDataWithinLease(userId, dto, reauthPurpose),
      );
    }
    return this.deleteDataWithinLease(userId, dto, reauthPurpose);
  }

  private async deleteDataWithinLease(
    userId: string,
    dto: DeleteDataDto,
    reauthPurpose: OidcReauthPurpose,
  ): Promise<{ deleted: Record<string, number> }> {
    const user = await this.scoped(User, (repo) =>
      repo.findOne({ where: { id: userId } }),
    );
    if (!user) {
      throw new NotFoundException(
        tr("errors.users.userNotFound", "User not found"),
      );
    }

    // SECURITY: Re-authenticate before destructive operation.
    await this.reauthenticate(user, reauthPurpose, dto);

    const deleted = await withScopedDb(this.dataSource, (manager) =>
      this.runOwnedDataDeletes(userId, dto, manager),
    );
    this.logger.log(`User ${userId} deleted data: ${JSON.stringify(deleted)}`);
    return { deleted };
  }

  /**
   * Deletes all data owned by a user -- the same set the self-service
   * "delete my data" flow removes. Runs inside the caller's transaction.
   * `opts` mirror DeleteDataDto's optional toggles.
   */
  private async runOwnedDataDeletes(
    userId: string,
    opts: {
      deletePayees?: boolean;
      deleteAccounts?: boolean;
      deleteCategories?: boolean;
      deleteExchangeRates?: boolean;
    },
    manager: EntityManager,
  ): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};

    // Always deleted: financial transaction data, investments, summaries, budgets

    // Investment data (FK-safe order)
    let result = await manager.query(
      "DELETE FROM investment_transactions WHERE user_id = $1",
      [userId],
    );
    deleted.investmentTransactions = result[1] ?? 0;

    result = await manager.query(
      `DELETE FROM holdings WHERE account_id IN
         (SELECT id FROM accounts WHERE user_id = $1)`,
      [userId],
    );
    deleted.holdings = result[1] ?? 0;

    result = await manager.query(
      `DELETE FROM security_prices WHERE security_id IN
         (SELECT id FROM securities WHERE user_id = $1)`,
      [userId],
    );
    deleted.securityPrices = result[1] ?? 0;

    // Scheduled transactions (before securities: they reference investment_security_id)
    result = await manager.query(
      `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );

    result = await manager.query(
      `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
      [userId],
    );

    result = await manager.query(
      "DELETE FROM scheduled_transactions WHERE user_id = $1",
      [userId],
    );
    deleted.scheduledTransactions = result[1] ?? 0;

    result = await manager.query("DELETE FROM securities WHERE user_id = $1", [
      userId,
    ]);
    deleted.securities = result[1] ?? 0;

    // Budget data
    result = await manager.query(
      `DELETE FROM budget_alerts WHERE user_id = $1`,
      [userId],
    );
    deleted.budgetAlerts = result[1] ?? 0;

    result = await manager.query(
      `DELETE FROM budget_period_categories WHERE budget_period_id IN
         (SELECT bp.id FROM budget_periods bp
          JOIN budgets b ON bp.budget_id = b.id
          WHERE b.user_id = $1)`,
      [userId],
    );
    deleted.budgetPeriodCategories = result[1] ?? 0;

    result = await manager.query(
      `DELETE FROM budget_periods WHERE budget_id IN
         (SELECT id FROM budgets WHERE user_id = $1)`,
      [userId],
    );
    deleted.budgetPeriods = result[1] ?? 0;

    result = await manager.query(
      `DELETE FROM budget_categories WHERE budget_id IN
         (SELECT id FROM budgets WHERE user_id = $1)`,
      [userId],
    );
    deleted.budgetCategories = result[1] ?? 0;

    result = await manager.query("DELETE FROM budgets WHERE user_id = $1", [
      userId,
    ]);
    deleted.budgets = result[1] ?? 0;

    // Transaction tags
    result = await manager.query(
      `DELETE FROM transaction_split_tags WHERE transaction_split_id IN
         (SELECT ts.id FROM transaction_splits ts
          JOIN transactions t ON ts.transaction_id = t.id
          WHERE t.user_id = $1)`,
      [userId],
    );

    result = await manager.query(
      `DELETE FROM transaction_tags WHERE transaction_id IN
         (SELECT id FROM transactions WHERE user_id = $1)`,
      [userId],
    );

    // Transaction splits
    result = await manager.query(
      `DELETE FROM transaction_splits WHERE transaction_id IN
         (SELECT id FROM transactions WHERE user_id = $1)`,
      [userId],
    );
    deleted.transactionSplits = result[1] ?? 0;

    // Transactions
    result = await manager.query(
      "DELETE FROM transactions WHERE user_id = $1",
      [userId],
    );
    deleted.transactions = result[1] ?? 0;

    // Tags (now that transaction_tags are gone)
    result = await manager.query("DELETE FROM tags WHERE user_id = $1", [
      userId,
    ]);
    deleted.tags = result[1] ?? 0;

    // Monthly account balances
    result = await manager.query(
      "DELETE FROM monthly_account_balances WHERE user_id = $1",
      [userId],
    );
    deleted.monthlyBalances = result[1] ?? 0;

    // Custom reports
    result = await manager.query(
      "DELETE FROM custom_reports WHERE user_id = $1",
      [userId],
    );
    deleted.customReports = result[1] ?? 0;

    // Import column mappings
    result = await manager.query(
      "DELETE FROM import_column_mappings WHERE user_id = $1",
      [userId],
    );
    deleted.importMappings = result[1] ?? 0;

    // AI data
    result = await manager.query("DELETE FROM ai_insights WHERE user_id = $1", [
      userId,
    ]);
    deleted.aiInsights = result[1] ?? 0;

    result = await manager.query(
      "DELETE FROM ai_usage_logs WHERE user_id = $1",
      [userId],
    );

    // Optional: delete payees (before accounts, since payee default_category_id
    // references categories, and accounts may reference payee-related data)
    if (opts.deletePayees) {
      result = await manager.query(
        "DELETE FROM payee_aliases WHERE user_id = $1",
        [userId],
      );
      result = await manager.query("DELETE FROM payees WHERE user_id = $1", [
        userId,
      ]);
      deleted.payees = result[1] ?? 0;
    }

    // Optional: delete accounts (must come after transactions)
    if (opts.deleteAccounts) {
      result = await manager.query("DELETE FROM accounts WHERE user_id = $1", [
        userId,
      ]);
      deleted.accounts = result[1] ?? 0;
    } else {
      // Reset account balances to opening balance when transactions are deleted
      await manager.query(
        "UPDATE accounts SET current_balance = opening_balance WHERE user_id = $1",
        [userId],
      );
    }

    // Optional: delete categories (must come after transactions and budgets)
    if (opts.deleteCategories) {
      // Clear payee default_category_id references first
      await manager.query(
        `UPDATE payees SET default_category_id = NULL WHERE user_id = $1`,
        [userId],
      );
      // Clear account category references
      await manager.query(
        `UPDATE accounts SET principal_category_id = NULL,
           interest_category_id = NULL, asset_category_id = NULL
           WHERE user_id = $1`,
        [userId],
      );
      result = await manager.query(
        "DELETE FROM categories WHERE user_id = $1",
        [userId],
      );
      deleted.categories = result[1] ?? 0;
    }

    // Optional: delete exchange rates
    if (opts.deleteExchangeRates) {
      result = await manager.query(
        "DELETE FROM user_currency_preferences WHERE user_id = $1",
        [userId],
      );
      deleted.exchangeRates = result[1] ?? 0;
    }

    // Clear action history (undo/redo) -- references deleted entities
    result = await manager.query(
      "DELETE FROM action_history WHERE user_id = $1",
      [userId],
    );
    deleted.actionHistory = result[1] ?? 0;

    return deleted;
  }

  /** True if the user is a delegate of someone else (has incoming access). */
  async isActingDelegate(userId: string): Promise<boolean> {
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.query(
        "SELECT 1 FROM account_delegates WHERE delegate_user_id = $1 LIMIT 1",
        [userId],
      ),
    );
    return rows.length > 0;
  }

  /**
   * Wipes everything the user owns but keeps their login and the delegate
   * access others granted them -- demoting a full account to a pure
   * delegate. Delegations the user owned are removed (their accounts are
   * gone); the rows where they are the delegate are left untouched, and
   * is_delegate_only is flipped back to true so the row is hidden from
   * admin User Management and no "self" context is offered.
   */
  async purgeForDowngrade(userId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (manager) => {
      await this.runOwnedDataDeletes(
        userId,
        {
          deletePayees: true,
          deleteAccounts: true,
          deleteCategories: true,
          deleteExchangeRates: true,
        },
        manager,
      );
      await manager.query(
        "DELETE FROM account_delegates WHERE owner_user_id = $1",
        [userId],
      );
      await manager.query(
        "UPDATE users SET is_delegate_only = true WHERE id = $1",
        [userId],
      );
    });
  }
}
