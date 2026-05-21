import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { User } from "../users/entities/user.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { PasswordBreachService } from "../auth/password-breach.service";

const MIN_BACKUP_PASSWORD_LENGTH = 12;

/**
 * Manages the per-user opt-in to encrypted backups and the stored copy of
 * their backup password that the auto-backup cron needs.
 *
 * Storage shape: `users.backup_password_enc` holds the password ciphertext
 * encrypted with AI_ENCRYPTION_KEY. For local-auth users that's the same
 * string as their login password (re-stored on every password change); for
 * OIDC users it's a dedicated value they set in Security.
 */
@Injectable()
export class BackupEncryptionService {
  private readonly logger = new Logger(BackupEncryptionService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly aiEncryption: AiEncryptionService,
    private readonly passwordBreach: PasswordBreachService,
  ) {}

  async getStatus(
    userId: string,
  ): Promise<{ enabled: boolean; needsBackupPassword: boolean }> {
    const user = await this.requireUser(userId);
    return {
      enabled: user.backupEncryptionEnabled,
      // OIDC users need to set a backup password before they can enable.
      needsBackupPassword:
        user.authProvider === "oidc" && !user.backupPasswordEnc,
    };
  }

  /**
   * Local-auth users: confirm with current login password, then store it
   * (encrypted with master key) so the cron can use it.
   */
  async enableForLocalUser(userId: string, password: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (user.authProvider !== "local" || !user.passwordHash) {
      throw new BadRequestException(
        "Local password authentication is required",
      );
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException("Invalid password");
    }
    if (!this.aiEncryption.isConfigured()) {
      throw new BadRequestException(
        "Server is not configured for encryption (AI_ENCRYPTION_KEY missing)",
      );
    }
    user.backupPasswordEnc = this.aiEncryption.encrypt(password);
    user.backupEncryptionEnabled = true;
    await this.usersRepository.save(user);
  }

  /**
   * OIDC users: set/update a dedicated backup password. Validates strength
   * and breach status, stores it encrypted with the master key, and turns
   * encryption on.
   */
  async setBackupPasswordForOidcUser(
    userId: string,
    newBackupPassword: string,
  ): Promise<void> {
    const user = await this.requireUser(userId);
    if (user.authProvider !== "oidc") {
      throw new BadRequestException(
        "Backup password is only configurable for OIDC users; local users use their login password",
      );
    }
    await this.validatePasswordStrength(newBackupPassword);
    if (!this.aiEncryption.isConfigured()) {
      throw new BadRequestException(
        "Server is not configured for encryption (AI_ENCRYPTION_KEY missing)",
      );
    }
    user.backupPasswordEnc = this.aiEncryption.encrypt(newBackupPassword);
    user.backupEncryptionEnabled = true;
    await this.usersRepository.save(user);
  }

  async disable(userId: string): Promise<void> {
    const user = await this.requireUser(userId);
    user.backupEncryptionEnabled = false;
    user.backupPasswordEnc = null;
    await this.usersRepository.save(user);
  }

  /**
   * Called from the change-password flow so the stored copy keeps pace with
   * the user's current login password. If encryption isn't enabled this is
   * a no-op. Best-effort: failures are logged but don't block password
   * change (we'd rather have a working password than a perfectly-synced
   * backup config).
   */
  async syncOnPasswordChange(
    userId: string,
    newPassword: string,
  ): Promise<void> {
    try {
      const user = await this.usersRepository.findOne({
        where: { id: userId },
      });
      if (!user || !user.backupEncryptionEnabled) return;
      if (user.authProvider !== "local") return;
      if (!this.aiEncryption.isConfigured()) return;
      user.backupPasswordEnc = this.aiEncryption.encrypt(newPassword);
      await this.usersRepository.save(user);
    } catch (err) {
      this.logger.error(
        `Failed to sync stored backup password for user ${userId}: ${err.message}`,
      );
    }
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  private async validatePasswordStrength(password: string): Promise<void> {
    if (!password || password.length < MIN_BACKUP_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `Backup password must be at least ${MIN_BACKUP_PASSWORD_LENGTH} characters`,
      );
    }
    const breached = await this.passwordBreach.isBreached(password);
    if (breached) {
      throw new BadRequestException(
        "This password has been found in a data breach. Please choose a different password.",
      );
    }
  }
}
