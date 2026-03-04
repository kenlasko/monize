import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DeepPartial, LessThan, DataSource } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import * as otplib from "otplib";
import * as QRCode from "qrcode";

import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { RefreshToken } from "./entities/refresh-token.entity";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import {
  encrypt,
  decrypt,
  isLegacyEncryption,
  migrateFromLegacy,
} from "./crypto.util";
import { PasswordBreachService } from "./password-breach.service";
import { EmailService } from "../notifications/email.service";
import { accountLockedTemplate } from "../notifications/email-templates";
import { UAParser } from "ua-parser-js";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private jwtSecret: string;
  private readonly ACCESS_TOKEN_EXPIRY = "15m";
  private readonly REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly BASE_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes
  private readonly TRUSTED_DEVICE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  private readonly MAX_2FA_ATTEMPTS = 3;
  private readonly MAX_USER_2FA_ATTEMPTS = 10;
  private readonly BACKUP_CODE_COUNT = 12;
  private readonly twoFactorAttempts = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  private readonly user2FAAttempts = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  private readonly forgotPasswordAttempts = new Map<
    string,
    { count: number; windowStart: number }
  >();
  private readonly FORGOT_PASSWORD_EMAIL_LIMIT = 3;
  private readonly FORGOT_PASSWORD_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    @InjectRepository(UserPreference)
    private preferencesRepository: Repository<UserPreference>,
    @InjectRepository(TrustedDevice)
    private trustedDevicesRepository: Repository<TrustedDevice>,
    @InjectRepository(RefreshToken)
    private refreshTokensRepository: Repository<RefreshToken>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private dataSource: DataSource,
    private passwordBreachService: PasswordBreachService,
    private emailService: EmailService,
  ) {
    this.jwtSecret = this.configService.get<string>("JWT_SECRET")!;
  }

  async register(registerDto: RegisterDto) {
    const { email, password, firstName, lastName } = registerDto;

    // H7: Normalize email before lookups
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists
    const existingUser = await this.usersRepository.findOne({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      throw new ConflictException("Unable to complete registration");
    }

    // Check for breached password
    const isBreached = await this.passwordBreachService.isBreached(password);
    if (isBreached) {
      throw new BadRequestException(
        "This password has been found in a data breach. Please choose a different password.",
      );
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // C9: Use serializable transaction to prevent race condition on first-user admin
    const user = await this.dataSource.transaction(
      "SERIALIZABLE",
      async (manager) => {
        const userCount = await manager.count(User);
        const newUser = manager.create(User, {
          email: normalizedEmail,
          passwordHash,
          firstName,
          lastName,
          authProvider: "local",
          role: userCount === 0 ? "admin" : "user",
        });
        return manager.save(newUser);
      },
    );

    const { accessToken, refreshToken } = await this.generateTokenPair(user);

    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  }

  async login(loginDto: LoginDto, trustedDeviceToken?: string) {
    const { email: rawEmail, password } = loginDto;
    const email = rawEmail.toLowerCase().trim();

    const user = await this.usersRepository.findOne({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      this.logger.warn(`Login failed: invalid credentials for email ${email}`);
      throw new UnauthorizedException("Invalid credentials");
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      this.logger.warn(`Login failed: account locked for email ${email}`);
      throw new ForbiddenException(
        "Account is temporarily locked due to too many failed login attempts. Please try again later.",
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      this.logger.warn(`Login failed: invalid password for email ${email}`);
      // Atomically increment failed attempts
      const newAttempts = user.failedLoginAttempts + 1;
      const updateFields: Record<string, unknown> = {
        failedLoginAttempts: newAttempts,
      };
      if (newAttempts >= this.MAX_FAILED_ATTEMPTS) {
        const lockoutMultiplier = Math.pow(
          2,
          Math.floor(newAttempts / this.MAX_FAILED_ATTEMPTS) - 1,
        );
        const lockoutDuration = this.BASE_LOCKOUT_MS * lockoutMultiplier;
        updateFields.lockedUntil = new Date(Date.now() + lockoutDuration);
        this.logger.warn(
          `Account locked for email ${email} after ${newAttempts} failed attempts`,
        );
        // Fire-and-forget lockout email
        if (user.email) {
          this.emailService
            .sendMail(
              user.email,
              "Account Temporarily Locked",
              accountLockedTemplate(user.firstName || ""),
            )
            .catch((err) =>
              this.logger.warn(`Failed to send lockout email: ${err.message}`),
            );
        }
      }
      await this.usersRepository
        .createQueryBuilder()
        .update(User)
        .set(updateFields)
        .where("id = :id", { id: user.id })
        .execute();
      throw new UnauthorizedException("Invalid credentials");
    }

    if (!user.isActive) {
      this.logger.warn(`Login failed: account deactivated for email ${email}`);
      throw new UnauthorizedException("Account is deactivated");
    }

    // Reset failed attempts on successful login
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await this.usersRepository
        .createQueryBuilder()
        .update(User)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where("id = :id", { id: user.id })
        .execute();
    }

    // Check if 2FA is enabled
    const preferences = await this.preferencesRepository.findOne({
      where: { userId: user.id },
    });

    if (preferences?.twoFactorEnabled && user.twoFactorSecret) {
      // Check for trusted device
      if (trustedDeviceToken) {
        const isTrusted = await this.validateTrustedDevice(
          user.id,
          trustedDeviceToken,
        );
        if (isTrusted) {
          user.lastLogin = new Date();
          await this.usersRepository.save(user);
          const { accessToken, refreshToken } =
            await this.generateTokenPair(user);
          this.logger.log(
            `Login successful (trusted device) for email ${email}`,
          );
          return { user: this.sanitizeUser(user), accessToken, refreshToken };
        }
      }

      // Return a temporary token for 2FA verification
      const tempToken = this.jwtService.sign(
        { sub: user.id, type: "2fa_pending" },
        { expiresIn: "5m" },
      );
      this.logger.log(`Login requires 2FA for email ${email}`);
      return { requires2FA: true, tempToken };
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

    const { accessToken, refreshToken } = await this.generateTokenPair(user);

    this.logger.log(`Login successful for email ${email}`);
    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
    };
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

    const secret = decrypt(user.twoFactorSecret, this.jwtSecret);

    // L5: Try TOTP for 6-digit codes, backup codes for XXXX-XXXX format
    let isValid = false;
    if (/^\d{6}$/.test(code)) {
      isValid = otplib.verifySync({ token: code, secret }).valid;
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

    // M8: Migrate legacy TOTP encryption if needed
    if (isLegacyEncryption(user.twoFactorSecret)) {
      const migrated = migrateFromLegacy(user.twoFactorSecret, this.jwtSecret);
      if (migrated) {
        user.twoFactorSecret = migrated;
      }
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);
    this.logger.log(`2FA verification successful for user ${user.id}`);

    const { accessToken, refreshToken } = await this.generateTokenPair(user);

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
    user.pendingTwoFactorSecret = encrypt(secret, this.jwtSecret);
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

    const secret = decrypt(user.pendingTwoFactorSecret, this.jwtSecret);
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

    const secret = decrypt(user.twoFactorSecret, this.jwtSecret);
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

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.usersRepository.findOne({
      where: { email: email.toLowerCase().trim() },
    });

    if (user && user.passwordHash) {
      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
      if (isPasswordValid && user.isActive) {
        return this.sanitizeUser(user);
      }
    }
    return null;
  }

  async findOrCreateOidcUser(
    userInfo: Record<string, unknown>,
    registrationEnabled = true,
  ) {
    // Standard OIDC claims
    const sub = userInfo.sub as string;
    const rawEmail = userInfo.email as string | undefined;
    // H7: Normalize email before lookups
    const email = rawEmail?.toLowerCase().trim();
    // SECURITY: Only trust email if verified by the OIDC provider
    const emailVerified = userInfo.email_verified === true;
    const trustedEmail = emailVerified ? email : undefined;

    // Handle name claims - try specific claims first, fall back to 'name'
    const fullName = userInfo.name as string | undefined;
    const firstName =
      (userInfo.given_name as string) ||
      (userInfo.preferred_username as string) ||
      fullName?.split(" ")[0] ||
      undefined;
    const lastName =
      (userInfo.family_name as string) ||
      fullName?.split(" ").slice(1).join(" ") ||
      undefined;

    if (!sub) {
      throw new UnauthorizedException(
        "OIDC provider did not return a subject identifier",
      );
    }

    let user = await this.usersRepository.findOne({
      where: { oidcSubject: sub },
    });

    if (!user) {
      // SECURITY: Only link to existing account if email is verified by OIDC provider
      // This prevents account takeover via OIDC providers that don't verify emails
      // M6: If the existing account has a password (local account), require confirmation
      if (trustedEmail) {
        const existingUser = await this.usersRepository.findOne({
          where: { email: trustedEmail },
        });

        if (existingUser) {
          if (existingUser.passwordHash) {
            // M6: Local account requires user confirmation before linking
            await this.initiateOidcLink(existingUser, sub);
            this.logger.warn(
              `OIDC link pending confirmation for user ${existingUser.id}`,
            );
            // Return the existing user without completing the link
            user = existingUser;
          } else {
            // OIDC-only account -- safe to link directly
            existingUser.oidcSubject = sub;
            existingUser.authProvider = "oidc";
            await this.usersRepository.save(existingUser);
            user = existingUser;
          }
        }
      }

      if (!user) {
        if (!registrationEnabled) {
          throw new ForbiddenException("New account registration is disabled.");
        }
        // C9: Use serializable transaction for first-user admin race prevention
        try {
          user = await this.dataSource.transaction(
            "SERIALIZABLE",
            async (manager) => {
              const userCount = await manager.count(User);
              const userData: DeepPartial<User> = {
                email: trustedEmail ?? email ?? null,
                firstName: firstName ?? null,
                lastName: lastName ?? null,
                oidcSubject: sub,
                authProvider: "oidc",
                role: userCount === 0 ? "admin" : "user",
              };
              const newUser = manager.create(User, userData);
              return manager.save(newUser);
            },
          );
        } catch (err: any) {
          // Handle duplicate email: link OIDC to the existing account
          // SECURITY: Only link accounts when the OIDC provider has verified the email
          if (err.code === "23505" && trustedEmail) {
            const existingUser = await this.usersRepository.findOne({
              where: { email: trustedEmail },
            });
            if (existingUser) {
              if (existingUser.passwordHash) {
                // M6: Local account requires user confirmation before linking
                await this.initiateOidcLink(existingUser, sub);
                this.logger.warn(
                  `OIDC link pending confirmation (catch path) for user ${existingUser.id}`,
                );
                user = existingUser;
              } else {
                // OIDC-only account -- safe to link directly
                existingUser.oidcSubject = sub;
                existingUser.authProvider = "oidc";
                await this.usersRepository.save(existingUser);
                user = existingUser;
              }
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
    } else {
      // Update user info if it has changed (but don't overwrite with null)
      let needsUpdate = false;

      // Ensure authProvider reflects OIDC usage
      if (user.authProvider !== "oidc") {
        user.authProvider = "oidc";
        needsUpdate = true;
      }

      // SECURITY: Only update email if verified by OIDC provider
      if (trustedEmail && user.email !== trustedEmail) {
        user.email = trustedEmail;
        needsUpdate = true;
      }
      if (firstName && user.firstName !== firstName) {
        user.firstName = firstName;
        needsUpdate = true;
      }
      if (lastName && user.lastName !== lastName) {
        user.lastName = lastName;
        needsUpdate = true;
      }

      if (needsUpdate) {
        await this.usersRepository.save(user);
      }
    }

    // Strip any 2FA config from SSO users -- 2FA is managed by the identity provider
    if (
      user.twoFactorSecret ||
      user.pendingTwoFactorSecret ||
      user.backupCodes
    ) {
      user.twoFactorSecret = null;
      user.pendingTwoFactorSecret = null;
      user.backupCodes = null;
      this.logger.log(`Cleared 2FA config for SSO user ${user.id}`);

      const preferences = await this.preferencesRepository.findOne({
        where: { userId: user.id },
      });
      if (preferences && preferences.twoFactorEnabled) {
        preferences.twoFactorEnabled = false;
        await this.preferencesRepository.save(preferences);
      }

      await this.trustedDevicesRepository.delete({ userId: user.id });
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

    return user;
  }

  async validateOidcUser(profile: any): Promise<any> {
    const user = await this.findOrCreateOidcUser(profile);
    return this.sanitizeUser(user);
  }

  async generateTokenPair(
    user: User,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const payload = {
      sub: user.id,
      email: user.email,
      authProvider: user.authProvider,
      role: user.role,
    };
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.ACCESS_TOKEN_EXPIRY,
    });

    const rawRefreshToken = crypto.randomBytes(64).toString("hex");
    const tokenHash = this.hashToken(rawRefreshToken);
    const familyId = crypto.randomUUID();

    const refreshTokenEntity = this.refreshTokensRepository.create({
      userId: user.id,
      tokenHash,
      familyId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + this.REFRESH_TOKEN_EXPIRY_MS),
      replacedByHash: null,
    });
    await this.refreshTokensRepository.save(refreshTokenEntity);

    return { accessToken, refreshToken: rawRefreshToken };
  }

  async refreshTokens(
    rawRefreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const tokenHash = this.hashToken(rawRefreshToken);

    return this.dataSource.transaction(async (manager) => {
      // SECURITY: Pessimistic lock prevents race condition when two requests
      // try to rotate the same refresh token concurrently
      const existingToken = await manager.findOne(RefreshToken, {
        where: { tokenHash },
        lock: { mode: "pessimistic_write" },
      });

      if (!existingToken) {
        throw new UnauthorizedException("Invalid refresh token");
      }

      // Replay detection: if token is revoked, a previously-rotated token was reused
      if (existingToken.isRevoked) {
        await manager.update(
          RefreshToken,
          { familyId: existingToken.familyId },
          { isRevoked: true },
        );
        throw new UnauthorizedException("Refresh token reuse detected");
      }

      if (existingToken.expiresAt < new Date()) {
        existingToken.isRevoked = true;
        await manager.save(existingToken);
        throw new UnauthorizedException("Refresh token expired");
      }

      const user = await manager.findOne(User, {
        where: { id: existingToken.userId },
      });

      if (!user || !user.isActive) {
        await manager.update(
          RefreshToken,
          { familyId: existingToken.familyId },
          { isRevoked: true },
        );
        throw new UnauthorizedException("User not found or inactive");
      }

      // Rotate: generate new refresh token in the same family
      const newRawRefreshToken = crypto.randomBytes(64).toString("hex");
      const newTokenHash = this.hashToken(newRawRefreshToken);

      existingToken.isRevoked = true;
      existingToken.replacedByHash = newTokenHash;
      await manager.save(existingToken);

      const newRefreshTokenEntity = manager.create(RefreshToken, {
        userId: user.id,
        tokenHash: newTokenHash,
        familyId: existingToken.familyId,
        isRevoked: false,
        expiresAt: new Date(Date.now() + this.REFRESH_TOKEN_EXPIRY_MS),
        replacedByHash: null,
      });
      await manager.save(newRefreshTokenEntity);

      const payload = {
        sub: user.id,
        email: user.email,
        authProvider: user.authProvider,
        role: user.role,
      };
      const accessToken = this.jwtService.sign(payload, {
        expiresIn: this.ACCESS_TOKEN_EXPIRY,
      });

      return { accessToken, refreshToken: newRawRefreshToken, userId: user.id };
    });
  }

  async revokeTokenFamily(familyId: string): Promise<void> {
    await this.refreshTokensRepository.update(
      { familyId },
      { isRevoked: true },
    );
  }

  async revokeRefreshToken(rawRefreshToken: string): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = this.hashToken(rawRefreshToken);
    const token = await this.refreshTokensRepository.findOne({
      where: { tokenHash },
    });
    if (token) {
      await this.revokeTokenFamily(token.familyId);
    }
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await this.refreshTokensRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredRefreshTokens(): Promise<void> {
    const expiredResult = await this.refreshTokensRepository.delete({
      expiresAt: LessThan(new Date()),
    });

    const revokedResult = await this.refreshTokensRepository.delete({
      isRevoked: true,
    });

    const totalPurged =
      (expiredResult.affected || 0) + (revokedResult.affected || 0);
    if (totalPurged > 0) {
      this.logger.log(`Purged ${totalPurged} expired/revoked refresh tokens`);
    }
  }

  async getUserById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async generateResetToken(
    email: string,
  ): Promise<{ user: User; token: string } | null> {
    const user = await this.usersRepository.findOne({
      where: { email },
    });

    if (!user || !user.passwordHash) return null;

    const rawResetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // SECURITY: Store hashed token — matches pattern used for refresh tokens and trusted devices
    user.resetToken = this.hashToken(rawResetToken);
    user.resetTokenExpiry = resetTokenExpiry;
    await this.usersRepository.save(user);

    return { user, token: rawResetToken };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Check for breached password
    const isBreached = await this.passwordBreachService.isBreached(newPassword);
    if (isBreached) {
      throw new BadRequestException(
        "This password has been found in a data breach. Please choose a different password.",
      );
    }

    // SECURITY: Hash the incoming token to compare against stored hash
    const hashedToken = this.hashToken(token);

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    // M11: Atomic UPDATE...WHERE to prevent TOCTOU race condition.
    // Only one concurrent request can match the resetToken; the second will
    // find affected === 0 because the first already cleared it.
    const result = await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({
        passwordHash,
        resetToken: null,
        resetTokenExpiry: null,
      })
      .where("resetToken = :hashedToken", { hashedToken })
      .andWhere("resetTokenExpiry > :now", { now: new Date() })
      .returning("id")
      .execute();

    if (!result.affected || result.affected === 0) {
      throw new BadRequestException("Invalid or expired reset token");
    }

    // Revoke all refresh tokens to force re-login on all devices
    const userId = result.raw?.[0]?.id;
    if (userId) {
      await this.revokeAllUserRefreshTokens(userId);
    }
  }

  // Trusted device methods

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
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
    const tokenHash = this.hashToken(deviceToken);
    const deviceName = this.parseDeviceName(userAgent);
    const expiresAt = new Date(Date.now() + this.TRUSTED_DEVICE_EXPIRY_MS);

    const trustedDevice = this.trustedDevicesRepository.create({
      userId,
      tokenHash,
      deviceName,
      ipAddress: ipAddress || null,
      lastUsedAt: new Date(),
      expiresAt,
    });

    await this.trustedDevicesRepository.save(trustedDevice);
    return deviceToken;
  }

  async validateTrustedDevice(
    userId: string,
    deviceToken: string,
  ): Promise<boolean> {
    const tokenHash = this.hashToken(deviceToken);

    const device = await this.trustedDevicesRepository.findOne({
      where: { userId, tokenHash },
    });

    if (!device) return false;

    if (device.expiresAt < new Date()) {
      await this.trustedDevicesRepository.remove(device);
      return false;
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
    const tokenHash = this.hashToken(deviceToken);
    const device = await this.trustedDevicesRepository.findOne({
      where: { userId, tokenHash },
    });
    return device?.id || null;
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

    const secret = decrypt(user.twoFactorSecret, this.jwtSecret);
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

  // M7: Per-email rate limiting for forgot-password

  checkForgotPasswordEmailLimit(email: string): boolean {
    const normalizedEmail = email.toLowerCase().trim();
    const now = Date.now();
    const record = this.forgotPasswordAttempts.get(normalizedEmail);

    if (record) {
      if (now - record.windowStart > this.FORGOT_PASSWORD_EMAIL_WINDOW_MS) {
        // Window expired, reset
        this.forgotPasswordAttempts.set(normalizedEmail, {
          count: 1,
          windowStart: now,
        });
        return true;
      }
      if (record.count >= this.FORGOT_PASSWORD_EMAIL_LIMIT) {
        return false;
      }
      record.count += 1;
      return true;
    }

    this.forgotPasswordAttempts.set(normalizedEmail, {
      count: 1,
      windowStart: now,
    });
    return true;
  }

  // M6: OIDC account linking with confirmation

  async initiateOidcLink(
    existingUser: User,
    oidcSubject: string,
  ): Promise<string> {
    const linkToken = crypto.randomBytes(32).toString("hex");
    existingUser.oidcLinkToken = this.hashToken(linkToken);
    existingUser.oidcLinkExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    existingUser.oidcLinkPending = true;
    existingUser.pendingOidcSubject = oidcSubject;
    await this.usersRepository.save(existingUser);
    return linkToken;
  }

  async confirmOidcLink(token: string): Promise<User> {
    const hashedToken = this.hashToken(token);

    const user = await this.usersRepository.findOne({
      where: { oidcLinkToken: hashedToken, oidcLinkPending: true },
    });

    if (!user) {
      throw new BadRequestException("Invalid or expired link token");
    }

    if (user.oidcLinkExpiresAt && user.oidcLinkExpiresAt < new Date()) {
      // Clear expired linking data
      user.oidcLinkPending = false;
      user.oidcLinkToken = null;
      user.oidcLinkExpiresAt = null;
      user.pendingOidcSubject = null;
      await this.usersRepository.save(user);
      throw new BadRequestException("Link token has expired");
    }

    // Complete the link
    user.oidcSubject = user.pendingOidcSubject;
    user.authProvider = "oidc";
    user.oidcLinkPending = false;
    user.oidcLinkToken = null;
    user.oidcLinkExpiresAt = null;
    user.pendingOidcSubject = null;
    await this.usersRepository.save(user);

    return user;
  }

  // M8: Migrate all legacy TOTP secrets to new format

  async migrateLegacyTotpSecrets(): Promise<number> {
    const users = await this.usersRepository
      .createQueryBuilder("user")
      .where("user.twoFactorSecret IS NOT NULL")
      .getMany();

    let migratedCount = 0;
    for (const user of users) {
      if (user.twoFactorSecret && isLegacyEncryption(user.twoFactorSecret)) {
        const migrated = migrateFromLegacy(
          user.twoFactorSecret,
          this.jwtSecret,
        );
        if (migrated) {
          user.twoFactorSecret = migrated;
          await this.usersRepository.save(user);
          migratedCount++;
        }
      }
    }

    if (migratedCount > 0) {
      this.logger.log(
        `Migrated ${migratedCount} legacy TOTP secrets to new format`,
      );
    }
    return migratedCount;
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
