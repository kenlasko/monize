import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan, DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import * as otplib from "otplib";
import * as QRCode from "qrcode";
import { UAParser } from "ua-parser-js";

import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { encrypt, decrypt, derivePurposeKey, hashToken } from "./crypto.util";
import { TokenService } from "./token.service";

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);
  private readonly jwtSecret: string;
  private readonly totpEncryptionKey: string;
  private readonly TRUSTED_DEVICE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  private readonly MAX_2FA_ATTEMPTS = 3;
  private readonly MAX_USER_2FA_ATTEMPTS = 10;
  private readonly BASE_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes
  private readonly BACKUP_CODE_COUNT = 12;
  private readonly twoFactorAttempts = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  private readonly user2FAAttempts = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  /**
   * Track recently used TOTP codes per user to prevent replay within the
   * code's validity window. Keys are "userId:code", values are expiry timestamps.
   * TOTP codes are valid for ~30s but we track for 90s to cover clock skew.
   */
  private readonly usedTotpCodes = new Map<string, number>();
  private readonly TOTP_CODE_REUSE_WINDOW_MS = 90 * 1000;

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    @InjectRepository(TrustedDevice)
    private trustedDevicesRepository: Repository<TrustedDevice>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private dataSource: DataSource,
    private tokenService: TokenService,
  ) {
    this.jwtSecret = this.configService.get<string>("JWT_SECRET")!;
    this.totpEncryptionKey = derivePurposeKey(
      this.jwtSecret,
      "totp-encryption",
    );
  }

  /**
   * Decrypt a TOTP secret, transparently migrating from the old key (raw jwtSecret)
   * to the new purpose-derived key.
   */
  decryptTotpSecret(ciphertext: string): {
    secret: string;
    needsReEncrypt: boolean;
  } {
    try {
      return {
        secret: decrypt(ciphertext, this.totpEncryptionKey),
        needsReEncrypt: false,
      };
    } catch {
      const secret = decrypt(ciphertext, this.jwtSecret);
      return { secret, needsReEncrypt: true };
    }
  }

  reEncryptTotpSecret(plainSecret: string): string {
    return encrypt(plainSecret, this.totpEncryptionKey);
  }

  async verify2FA(
    tempToken: string,
    code: string,
    rememberDevice = false,
    userAgent?: string,
    ipAddress?: string,
  ) {
    // M4: Check per-token attempt tracking before processing
    this.cleanupExpired2FAAttempts();
    const attemptRecord = this.twoFactorAttempts.get(tempToken);
    if (attemptRecord && attemptRecord.count >= this.MAX_2FA_ATTEMPTS) {
      throw new UnauthorizedException(
        "Too many verification attempts. Please log in again.",
      );
    }

    let payload: any;
    try {
      payload = this.jwtService.verify(tempToken);
    } catch {
      this.logger.warn("2FA verification failed: invalid or expired token");
      throw new UnauthorizedException("Invalid or expired verification token");
    }

    if (payload.type !== "2fa_pending") {
      this.logger.warn(
        `2FA verification failed: invalid token type for user ${payload.sub}`,
      );
      throw new UnauthorizedException("Invalid token type");
    }

    // Per-user rate limiting: prevents brute-force multiplication via multiple tempTokens
    const userAttemptRecord = this.user2FAAttempts.get(payload.sub);
    if (
      userAttemptRecord &&
      userAttemptRecord.count >= this.MAX_USER_2FA_ATTEMPTS
    ) {
      this.logger.warn(
        `2FA verification blocked: too many attempts for user ${payload.sub}`,
      );
      throw new UnauthorizedException(
        "Too many verification attempts. Your account has been temporarily locked.",
      );
    }

    const user = await this.usersRepository.findOne({
      where: { id: payload.sub },
    });

    if (!user || !user.twoFactorSecret) {
      this.logger.warn(
        `2FA verification failed: invalid state for user ${payload.sub}`,
      );
      throw new UnauthorizedException("Invalid verification state");
    }

    const { secret, needsReEncrypt } = this.decryptTotpSecret(
      user.twoFactorSecret,
    );

    // L5: Try TOTP for 6-digit codes, backup codes for XXXX-XXXX format
    let isValid = false;
    let isTotpCode = false;
    if (/^\d{6}$/.test(code)) {
      isTotpCode = true;
      // SECURITY: Reject previously used TOTP codes to prevent replay attacks.
      const codeKey = `${user.id}:${code}`;
      this.cleanupExpiredTotpCodes();
      if (this.usedTotpCodes.has(codeKey)) {
        isValid = false;
      } else {
        isValid = otplib.verifySync({ token: code, secret }).valid;
      }
    } else if (user.backupCodes) {
      isValid = await this.verifyBackupCode(user, code);
    }

    if (!isValid) {
      // Track failed attempt per-token
      const existing = this.twoFactorAttempts.get(tempToken);
      const newCount = (existing?.count ?? 0) + 1;
      this.twoFactorAttempts.set(tempToken, {
        count: newCount,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      // Track failed attempt per-user
      const existingUser = this.user2FAAttempts.get(payload.sub);
      const newUserCount = (existingUser?.count ?? 0) + 1;
      this.user2FAAttempts.set(payload.sub, {
        count: newUserCount,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      // Lock account after exceeding per-user threshold
      if (newUserCount >= this.MAX_USER_2FA_ATTEMPTS) {
        await this.usersRepository
          .createQueryBuilder()
          .update(User)
          .set({ lockedUntil: new Date(Date.now() + this.BASE_LOCKOUT_MS) })
          .where("id = :id", { id: user.id })
          .execute();
        this.logger.warn(
          `Account locked after ${newUserCount} failed 2FA attempts for user ${user.id}`,
        );
      }

      this.logger.warn(
        `2FA verification failed: invalid code for user ${user.id}`,
      );
      throw new UnauthorizedException("Invalid verification code");
    }

    // M4: Clear attempt tracking on success
    this.twoFactorAttempts.delete(tempToken);
    this.user2FAAttempts.delete(payload.sub);

    // Mark TOTP code as used to prevent replay
    if (isTotpCode) {
      const codeKey = `${user.id}:${code}`;
      this.usedTotpCodes.set(
        codeKey,
        Date.now() + this.TOTP_CODE_REUSE_WINDOW_MS,
      );
    }

    // Re-encrypt with purpose-derived key if still using old key material
    if (needsReEncrypt) {
      user.twoFactorSecret = this.reEncryptTotpSecret(secret);
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);
    this.logger.log(`2FA verification successful for user ${user.id}`);

    const rememberMe = payload.rememberMe === true;
    const { accessToken, refreshToken } =
      await this.tokenService.generateTokenPair(user, rememberMe);

    let trustedDeviceToken: string | undefined;
    if (rememberDevice) {
      trustedDeviceToken = await this.createTrustedDevice(
        user.id,
        userAgent || "Unknown Device",
        ipAddress,
      );
    }

    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
      trustedDeviceToken,
      rememberMe,
    };
  }

  private cleanupExpired2FAAttempts(): void {
    const now = Date.now();
    for (const [key, value] of this.twoFactorAttempts.entries()) {
      if (value.expiresAt <= now) {
        this.twoFactorAttempts.delete(key);
      }
    }
    for (const [key, value] of this.user2FAAttempts.entries()) {
      if (value.expiresAt <= now) {
        this.user2FAAttempts.delete(key);
      }
    }
  }

  private cleanupExpiredTotpCodes(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.usedTotpCodes.entries()) {
      if (expiresAt <= now) {
        this.usedTotpCodes.delete(key);
      }
    }
  }

  async setup2FA(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (user.authProvider === "oidc") {
      throw new BadRequestException(
        "Two-factor authentication is not available for SSO accounts",
      );
    }

    const secret = otplib.generateSecret();
    const otpauthUrl = otplib.generateURI({
      secret,
      issuer: "Monize",
      label: user.email || userId,
    });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    // H5: Store in pending field, only commit after confirmation
    user.pendingTwoFactorSecret = encrypt(secret, this.totpEncryptionKey);
    await this.usersRepository.save(user);

    return { secret, qrCodeDataUrl, otpauthUrl };
  }

  async confirmSetup2FA(userId: string, code: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user || !user.pendingTwoFactorSecret) {
      throw new BadRequestException("2FA setup not initiated");
    }

    const secret = decrypt(user.pendingTwoFactorSecret, this.totpEncryptionKey);
    const isValid = otplib.verifySync({ token: code, secret }).valid;

    if (!isValid) {
      throw new BadRequestException("Invalid verification code");
    }

    // H5: Promote pending secret to active secret on successful confirmation
    user.twoFactorSecret = user.pendingTwoFactorSecret;
    user.pendingTwoFactorSecret = null;
    await this.usersRepository.save(user);

    // Enable 2FA in preferences
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      preferences = this.preferencesRepository.create({ userId });
    }

    preferences.twoFactorEnabled = true;
    await this.preferencesRepository.save(preferences);

    return { message: "Two-factor authentication enabled successfully" };
  }

  async disable2FA(userId: string, code: string) {
    const force2fa =
      this.configService.get<string>("FORCE_2FA", "false").toLowerCase() ===
      "true";
    if (force2fa) {
      throw new ForbiddenException(
        "Two-factor authentication is required by the administrator",
      );
    }

    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user || !user.twoFactorSecret) {
      throw new BadRequestException("2FA is not enabled");
    }

    const { secret } = this.decryptTotpSecret(user.twoFactorSecret);
    const isValid = otplib.verifySync({ token: code, secret }).valid;

    if (!isValid) {
      throw new BadRequestException("Invalid verification code");
    }

    // Clear secret and disable
    user.twoFactorSecret = null;
    await this.usersRepository.save(user);

    const preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (preferences) {
      preferences.twoFactorEnabled = false;
      await this.preferencesRepository.save(preferences);
    }

    // Revoke all trusted devices
    await this.trustedDevicesRepository.delete({ userId });

    return { message: "Two-factor authentication disabled successfully" };
  }

  // L5: Backup code methods

  async generateBackupCodes(userId: string, code: string): Promise<string[]> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    if (!user.twoFactorSecret) {
      throw new BadRequestException("2FA is not enabled");
    }

    const { secret } = this.decryptTotpSecret(user.twoFactorSecret);
    const isValid = otplib.verifySync({ token: code, secret }).valid;

    if (!isValid) {
      throw new BadRequestException("Invalid verification code");
    }

    const codes: string[] = [];
    for (let i = 0; i < this.BACKUP_CODE_COUNT; i++) {
      const raw = crypto.randomBytes(4).toString("hex");
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`); // XXXX-XXXX hex codes
    }

    // Store hashed codes as JSON array
    const hashedCodes = await Promise.all(
      codes.map((code) => bcrypt.hash(code, 10)),
    );
    user.backupCodes = JSON.stringify(hashedCodes);
    await this.usersRepository.save(user);

    return codes;
  }

  private async verifyBackupCode(user: User, code: string): Promise<boolean> {
    if (!user.backupCodes) return false;

    // Pre-check: find matching code index before acquiring lock
    const hashedCodes: string[] = JSON.parse(user.backupCodes);
    let matchIndex = -1;
    for (let i = 0; i < hashedCodes.length; i++) {
      const isMatch = await bcrypt.compare(code, hashedCodes[i]);
      if (isMatch) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) return false;

    // Atomic removal: use QueryRunner with pessimistic lock to prevent
    // concurrent backup code reuse (TOCTOU race condition)
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const lockedUser = await queryRunner.manager.findOne(User, {
        where: { id: user.id },
        lock: { mode: "pessimistic_write" },
      });

      if (!lockedUser?.backupCodes) {
        await queryRunner.rollbackTransaction();
        return false;
      }

      const currentCodes: string[] = JSON.parse(lockedUser.backupCodes);

      // Re-verify against the locked row to prevent replay
      let verifiedIndex = -1;
      for (let i = 0; i < currentCodes.length; i++) {
        const isMatch = await bcrypt.compare(code, currentCodes[i]);
        if (isMatch) {
          verifiedIndex = i;
          break;
        }
      }

      if (verifiedIndex === -1) {
        // Code already consumed by a concurrent request
        await queryRunner.rollbackTransaction();
        return false;
      }

      const updatedCodes = [
        ...currentCodes.slice(0, verifiedIndex),
        ...currentCodes.slice(verifiedIndex + 1),
      ];

      await queryRunner.manager
        .createQueryBuilder()
        .update(User)
        .set({
          backupCodes:
            updatedCodes.length > 0 ? JSON.stringify(updatedCodes) : null,
        })
        .where("id = :id", { id: user.id })
        .execute();

      await queryRunner.commitTransaction();

      // Keep in-memory entity consistent
      user.backupCodes =
        updatedCodes.length > 0 ? JSON.stringify(updatedCodes) : null;

      return true;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // Migrate all TOTP secrets to use purpose-derived encryption key

  async migrateLegacyTotpSecrets(): Promise<number> {
    const users = await this.usersRepository
      .createQueryBuilder("user")
      .where("user.twoFactorSecret IS NOT NULL")
      .getMany();

    let migratedCount = 0;
    for (const user of users) {
      if (!user.twoFactorSecret) continue;
      const { secret, needsReEncrypt } = this.decryptTotpSecret(
        user.twoFactorSecret,
      );
      if (needsReEncrypt) {
        user.twoFactorSecret = this.reEncryptTotpSecret(secret);
        await this.usersRepository.save(user);
        migratedCount++;
      }
    }

    if (migratedCount > 0) {
      this.logger.log(
        `Migrated ${migratedCount} TOTP secrets to purpose-derived key`,
      );
    }
    return migratedCount;
  }

  // Trusted device methods

  /**
   * Create a stable fingerprint from the user-agent that survives browser updates.
   */
  private hashUserAgent(userAgent: string): string {
    if (!userAgent) return hashToken("unknown");
    const parser = new UAParser(userAgent);
    const browser = parser.getBrowser();
    const os = parser.getOS();
    const stableFingerprint = `${browser.name || "unknown"}:${os.name || "unknown"}`;
    return hashToken(stableFingerprint);
  }

  private parseDeviceName(userAgent: string): string {
    if (!userAgent || userAgent === "Unknown Device") {
      return "Unknown Device";
    }
    const parser = new UAParser(userAgent);
    const browser = parser.getBrowser();
    const os = parser.getOS();
    const parts: string[] = [];
    if (browser.name) parts.push(browser.name);
    if (os.name) {
      let osStr = os.name;
      if (os.version) osStr += " " + os.version;
      parts.push("on " + osStr);
    }
    return parts.length > 0 ? parts.join(" ") : "Unknown Device";
  }

  async createTrustedDevice(
    userId: string,
    userAgent: string,
    ipAddress?: string,
  ): Promise<string> {
    const deviceToken = crypto.randomBytes(64).toString("hex");
    const tokenHash = hashToken(deviceToken);
    const deviceName = this.parseDeviceName(userAgent);
    const expiresAt = new Date(Date.now() + this.TRUSTED_DEVICE_EXPIRY_MS);

    const trustedDevice = this.trustedDevicesRepository.create({
      userId,
      tokenHash,
      deviceName,
      ipAddress: ipAddress || null,
      userAgentHash: this.hashUserAgent(userAgent),
      lastUsedAt: new Date(),
      expiresAt,
    });

    await this.trustedDevicesRepository.save(trustedDevice);
    return deviceToken;
  }

  async validateTrustedDevice(
    userId: string,
    deviceToken: string,
    userAgent?: string,
  ): Promise<boolean> {
    const tokenHash = hashToken(deviceToken);

    const device = await this.trustedDevicesRepository.findOne({
      where: { userId, tokenHash },
    });

    if (!device) return false;

    if (device.expiresAt < new Date()) {
      await this.trustedDevicesRepository.remove(device);
      return false;
    }

    // SECURITY: Verify user-agent fingerprint matches to limit stolen token reuse.
    if (device.userAgentHash && userAgent) {
      const expected = Buffer.from(device.userAgentHash, "utf8");
      const actual = Buffer.from(this.hashUserAgent(userAgent), "utf8");
      if (
        expected.length !== actual.length ||
        !crypto.timingSafeEqual(expected, actual)
      ) {
        this.logger.warn(
          `Trusted device token rejected: user-agent mismatch for user ${userId}`,
        );
        return false;
      }
    }

    device.lastUsedAt = new Date();
    await this.trustedDevicesRepository.save(device);
    return true;
  }

  async getTrustedDevices(userId: string): Promise<TrustedDevice[]> {
    await this.trustedDevicesRepository.delete({
      userId,
      expiresAt: LessThan(new Date()),
    });

    return this.trustedDevicesRepository.find({
      where: { userId },
      order: { lastUsedAt: "DESC" },
    });
  }

  async revokeTrustedDevice(userId: string, deviceId: string): Promise<void> {
    const device = await this.trustedDevicesRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException("Device not found");
    }

    await this.trustedDevicesRepository.remove(device);
  }

  async revokeAllTrustedDevices(userId: string): Promise<number> {
    const result = await this.trustedDevicesRepository.delete({ userId });
    return result.affected || 0;
  }

  async findTrustedDeviceByToken(
    userId: string,
    deviceToken: string,
  ): Promise<string | null> {
    const tokenHash = hashToken(deviceToken);
    const device = await this.trustedDevicesRepository.findOne({
      where: { userId, tokenHash },
    });
    return device?.id || null;
  }

  sanitizeUser(user: User) {
    const {
      passwordHash,
      resetToken,
      resetTokenExpiry,
      twoFactorSecret,
      pendingTwoFactorSecret,
      failedLoginAttempts,
      lockedUntil,
      backupCodes,
      oidcLinkPending,
      oidcLinkToken,
      oidcLinkExpiresAt,
      pendingOidcSubject,
      ...sanitized
    } = user;
    return { ...sanitized, hasPassword: !!passwordHash };
  }
}
