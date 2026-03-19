import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import { User } from "./entities/user.entity";
import { UserPreference } from "./entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { UpdatePreferencesDto } from "./dto/update-preferences.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { DeleteDataDto } from "./dto/delete-data.dto";
import { PasswordBreachService } from "../auth/password-breach.service";

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    @InjectRepository(RefreshToken)
    private refreshTokensRepository: Repository<RefreshToken>,
    @InjectRepository(PersonalAccessToken)
    private patRepository: Repository<PersonalAccessToken>,
    private dataSource: DataSource,
    private passwordBreachService: PasswordBreachService,
  ) {}

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    // SECURITY: Require password confirmation when changing email to prevent
    // account takeover via compromised session
    if (dto.email && dto.email !== user.email) {
      if (!dto.currentPassword) {
        throw new BadRequestException(
          "Current password is required to change email address",
        );
      }
      if (!user.passwordHash) {
        throw new BadRequestException(
          "Cannot change email for accounts without a local password",
        );
      }
      const isPasswordValid = await bcrypt.compare(
        dto.currentPassword,
        user.passwordHash,
      );
      if (!isPasswordValid) {
        throw new BadRequestException("Current password is incorrect");
      }
      const existingUser = await this.usersRepository.findOne({
        where: { email: dto.email },
      });
      if (existingUser) {
        throw new ConflictException("Email already in use");
      }
      user.email = dto.email;
    }

    if (dto.firstName !== undefined) {
      user.firstName = dto.firstName;
    }
    if (dto.lastName !== undefined) {
      user.lastName = dto.lastName;
    }

    const saved = await this.usersRepository.save(user);
    const {
      passwordHash,
      resetToken,
      resetTokenExpiry,
      twoFactorSecret,
      ...rest
    } = saved;
    return { ...rest, hasPassword: !!passwordHash };
  }

  async getPreferences(userId: string): Promise<UserPreference> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    // Create default preferences if they don't exist
    // Default to 'browser' for locale-dependent settings
    if (!preferences) {
      // Use direct instantiation to ensure primary key is set
      preferences = new UserPreference();
      preferences.userId = userId;
      preferences.defaultCurrency = "USD";
      preferences.dateFormat = "browser";
      preferences.numberFormat = "browser";
      preferences.theme = "system";
      preferences.timezone = "browser";
      preferences.notificationEmail = true;
      preferences.notificationBrowser = true;
      preferences.twoFactorEnabled = false;
      preferences.gettingStartedDismissed = false;
      preferences.favouriteReportIds = [];
      await this.preferencesRepository.save(preferences);
    }

    return preferences;
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<UserPreference> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      // Create with defaults first
      preferences = await this.getPreferences(userId);
    }

    // Update only provided fields
    if (dto.defaultCurrency !== undefined) {
      preferences.defaultCurrency = dto.defaultCurrency;
    }
    if (dto.dateFormat !== undefined) {
      preferences.dateFormat = dto.dateFormat;
    }
    if (dto.numberFormat !== undefined) {
      preferences.numberFormat = dto.numberFormat;
    }
    if (dto.theme !== undefined) {
      preferences.theme = dto.theme;
    }
    if (dto.timezone !== undefined) {
      preferences.timezone = dto.timezone;
    }
    if (dto.notificationEmail !== undefined) {
      preferences.notificationEmail = dto.notificationEmail;
    }
    if (dto.notificationBrowser !== undefined) {
      preferences.notificationBrowser = dto.notificationBrowser;
    }
    if (dto.gettingStartedDismissed !== undefined) {
      preferences.gettingStartedDismissed = dto.gettingStartedDismissed;
    }
    if (dto.weekStartsOn !== undefined) {
      preferences.weekStartsOn = dto.weekStartsOn;
    }
    if (dto.budgetDigestEnabled !== undefined) {
      preferences.budgetDigestEnabled = dto.budgetDigestEnabled;
    }
    if (dto.budgetDigestDay !== undefined) {
      preferences.budgetDigestDay = dto.budgetDigestDay;
    }
    if (dto.favouriteReportIds !== undefined) {
      preferences.favouriteReportIds = dto.favouriteReportIds;
    }
    if (dto.showCreatedAt !== undefined) {
      preferences.showCreatedAt = dto.showCreatedAt;
    }

    return this.preferencesRepository.save(preferences);
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (!user.passwordHash) {
      throw new BadRequestException("No password set for this account");
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new BadRequestException("Current password is incorrect");
    }

    // Check for breached password
    const isBreached = await this.passwordBreachService.isBreached(
      dto.newPassword,
    );
    if (isBreached) {
      throw new BadRequestException(
        "This password has been found in a data breach. Please choose a different password.",
      );
    }

    // Hash and save new password
    const saltRounds = 12;
    user.passwordHash = await bcrypt.hash(dto.newPassword, saltRounds);
    user.mustChangePassword = false;
    await this.usersRepository.save(user);

    // SECURITY: Revoke all refresh tokens to force re-login on all devices
    await this.refreshTokensRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    // SECURITY: Revoke all PATs — credential change invalidates API access
    await this.patRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
  }

  async deleteAccount(
    userId: string,
    dto?: { password?: string; oidcIdToken?: string },
  ): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    // SECURITY: Re-authenticate before account deletion
    if (user.authProvider === "oidc") {
      if (!dto?.oidcIdToken) {
        throw new UnauthorizedException(
          "OIDC re-authentication is required to confirm account deletion",
        );
      }
    } else if (user.passwordHash) {
      if (!dto?.password) {
        throw new UnauthorizedException(
          "Password is required to confirm account deletion",
        );
      }
      const isValid = await bcrypt.compare(dto.password, user.passwordHash);
      if (!isValid) {
        throw new UnauthorizedException("Invalid password");
      }
    }

    // SECURITY: Prevent the last admin from self-deleting, which would leave
    // the system with no administrator
    if (user.role === "admin") {
      const adminCount = await this.usersRepository.count({
        where: { role: "admin" },
      });
      if (adminCount <= 1) {
        throw new ForbiddenException(
          "Cannot delete the last admin account. Promote another user first.",
        );
      }
    }

    // Delete preferences first (due to FK constraint)
    await this.preferencesRepository.delete({ userId });

    // Revoke all refresh tokens and PATs before deletion
    await this.refreshTokensRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
    await this.patRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    // Delete the user
    await this.usersRepository.remove(user);
  }

  async deleteData(
    userId: string,
    dto: DeleteDataDto,
  ): Promise<{ deleted: Record<string, number> }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }

    // SECURITY: Re-authenticate before destructive operation
    if (user.authProvider === "oidc") {
      if (!dto.oidcIdToken) {
        throw new UnauthorizedException(
          "OIDC re-authentication is required to confirm data deletion",
        );
      }
    } else if (user.passwordHash) {
      if (!dto.password) {
        throw new UnauthorizedException(
          "Password is required to confirm data deletion",
        );
      }
      const isValid = await bcrypt.compare(dto.password, user.passwordHash);
      if (!isValid) {
        throw new UnauthorizedException("Invalid password");
      }
      // The frontend obtains a fresh OIDC token via the re-auth flow.
      // The presence of a valid JWT session + the OIDC token confirms identity.
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const deleted: Record<string, number> = {};

    try {
      // Always deleted: financial transaction data, investments, summaries, budgets

      // Investment data (FK-safe order)
      let result = await queryRunner.query(
        "DELETE FROM investment_transactions WHERE user_id = $1",
        [userId],
      );
      deleted.investmentTransactions = result[1] ?? 0;

      result = await queryRunner.query(
        `DELETE FROM holdings WHERE account_id IN
         (SELECT id FROM accounts WHERE user_id = $1)`,
        [userId],
      );
      deleted.holdings = result[1] ?? 0;

      result = await queryRunner.query(
        `DELETE FROM security_prices WHERE security_id IN
         (SELECT id FROM securities WHERE user_id = $1)`,
        [userId],
      );
      deleted.securityPrices = result[1] ?? 0;

      result = await queryRunner.query(
        "DELETE FROM securities WHERE user_id = $1",
        [userId],
      );
      deleted.securities = result[1] ?? 0;

      // Budget data
      result = await queryRunner.query(
        `DELETE FROM budget_alerts WHERE user_id = $1`,
        [userId],
      );
      deleted.budgetAlerts = result[1] ?? 0;

      result = await queryRunner.query(
        `DELETE FROM budget_period_categories WHERE budget_period_id IN
         (SELECT bp.id FROM budget_periods bp
          JOIN budgets b ON bp.budget_id = b.id
          WHERE b.user_id = $1)`,
        [userId],
      );
      deleted.budgetPeriodCategories = result[1] ?? 0;

      result = await queryRunner.query(
        `DELETE FROM budget_periods WHERE budget_id IN
         (SELECT id FROM budgets WHERE user_id = $1)`,
        [userId],
      );
      deleted.budgetPeriods = result[1] ?? 0;

      result = await queryRunner.query(
        `DELETE FROM budget_categories WHERE budget_id IN
         (SELECT id FROM budgets WHERE user_id = $1)`,
        [userId],
      );
      deleted.budgetCategories = result[1] ?? 0;

      result = await queryRunner.query(
        "DELETE FROM budgets WHERE user_id = $1",
        [userId],
      );
      deleted.budgets = result[1] ?? 0;

      // Transaction tags
      result = await queryRunner.query(
        `DELETE FROM transaction_split_tags WHERE transaction_split_id IN
         (SELECT ts.id FROM transaction_splits ts
          JOIN transactions t ON ts.transaction_id = t.id
          WHERE t.user_id = $1)`,
        [userId],
      );

      result = await queryRunner.query(
        `DELETE FROM transaction_tags WHERE transaction_id IN
         (SELECT id FROM transactions WHERE user_id = $1)`,
        [userId],
      );

      // Transaction splits
      result = await queryRunner.query(
        `DELETE FROM transaction_splits WHERE transaction_id IN
         (SELECT id FROM transactions WHERE user_id = $1)`,
        [userId],
      );
      deleted.transactionSplits = result[1] ?? 0;

      // Transactions
      result = await queryRunner.query(
        "DELETE FROM transactions WHERE user_id = $1",
        [userId],
      );
      deleted.transactions = result[1] ?? 0;

      // Tags (now that transaction_tags are gone)
      result = await queryRunner.query("DELETE FROM tags WHERE user_id = $1", [
        userId,
      ]);
      deleted.tags = result[1] ?? 0;

      // Scheduled transactions
      result = await queryRunner.query(
        `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
        [userId],
      );

      result = await queryRunner.query(
        `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN
         (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
        [userId],
      );

      result = await queryRunner.query(
        "DELETE FROM scheduled_transactions WHERE user_id = $1",
        [userId],
      );
      deleted.scheduledTransactions = result[1] ?? 0;

      // Monthly account balances
      result = await queryRunner.query(
        "DELETE FROM monthly_account_balances WHERE user_id = $1",
        [userId],
      );
      deleted.monthlyBalances = result[1] ?? 0;

      // Custom reports
      result = await queryRunner.query(
        "DELETE FROM custom_reports WHERE user_id = $1",
        [userId],
      );
      deleted.customReports = result[1] ?? 0;

      // Import column mappings
      result = await queryRunner.query(
        "DELETE FROM import_column_mappings WHERE user_id = $1",
        [userId],
      );
      deleted.importMappings = result[1] ?? 0;

      // AI data
      result = await queryRunner.query(
        "DELETE FROM ai_insights WHERE user_id = $1",
        [userId],
      );
      deleted.aiInsights = result[1] ?? 0;

      result = await queryRunner.query(
        "DELETE FROM ai_usage_logs WHERE user_id = $1",
        [userId],
      );

      // Optional: delete payees (before accounts, since payee default_category_id
      // references categories, and accounts may reference payee-related data)
      if (dto.deletePayees) {
        result = await queryRunner.query(
          "DELETE FROM payee_aliases WHERE user_id = $1",
          [userId],
        );
        result = await queryRunner.query(
          "DELETE FROM payees WHERE user_id = $1",
          [userId],
        );
        deleted.payees = result[1] ?? 0;
      }

      // Optional: delete accounts (must come after transactions)
      if (dto.deleteAccounts) {
        result = await queryRunner.query(
          "DELETE FROM accounts WHERE user_id = $1",
          [userId],
        );
        deleted.accounts = result[1] ?? 0;
      } else {
        // Reset account balances to opening balance when transactions are deleted
        await queryRunner.query(
          "UPDATE accounts SET current_balance = opening_balance WHERE user_id = $1",
          [userId],
        );
      }

      // Optional: delete categories (must come after transactions and budgets)
      if (dto.deleteCategories) {
        // Clear payee default_category_id references first
        await queryRunner.query(
          `UPDATE payees SET default_category_id = NULL WHERE user_id = $1`,
          [userId],
        );
        // Clear account category references
        await queryRunner.query(
          `UPDATE accounts SET principal_category_id = NULL,
           interest_category_id = NULL, asset_category_id = NULL
           WHERE user_id = $1`,
          [userId],
        );
        result = await queryRunner.query(
          "DELETE FROM categories WHERE user_id = $1",
          [userId],
        );
        deleted.categories = result[1] ?? 0;
      }

      // Optional: delete exchange rates
      if (dto.deleteExchangeRates) {
        result = await queryRunner.query(
          "DELETE FROM user_currency_preferences WHERE user_id = $1",
          [userId],
        );
        deleted.exchangeRates = result[1] ?? 0;
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `User ${userId} deleted data: ${JSON.stringify(deleted)}`,
      );

      return { deleted };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
