import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DeepPartial, DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";

import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { RefreshToken } from "./entities/refresh-token.entity";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { derivePurposeKey, hashToken } from "./crypto.util";
import { PasswordBreachService } from "./password-breach.service";
import { EmailService } from "../notifications/email.service";
import {
  accountLockedTemplate,
  oidcLinkTemplate,
} from "../notifications/email-templates";
import { TokenService } from "./token.service";
import { TwoFactorService } from "./two-factor.service";
import { AuthEmailService } from "./auth-email.service";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private jwtSecret: string;
  /** Derived key for CSRF HMAC -- cryptographically isolated from the JWT signing key */
  private csrfKey: string;
  private readonly MAX_FAILED_ATTEMPTS = 5;
  private readonly BASE_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes

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
    private tokenService: TokenService,
    private twoFactorService: TwoFactorService,
    private authEmailService: AuthEmailService,
  ) {
    this.jwtSecret = this.configService.get<string>("JWT_SECRET")!;
    this.csrfKey = derivePurposeKey(this.jwtSecret, "csrf-token");
  }

  /** Get the derived CSRF key for use by the controller */
  getCsrfKey(): string {
    return this.csrfKey;
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

    const { accessToken, refreshToken } =
      await this.tokenService.generateTokenPair(user);

    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  }

  async login(
    loginDto: LoginDto,
    trustedDeviceToken?: string,
    userAgent?: string,
  ) {
    const { email: rawEmail, password, rememberMe } = loginDto;
    const email = rawEmail.toLowerCase().trim();

    const user = await this.usersRepository.findOne({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      this.logger.warn("Login failed: no matching account");
      throw new UnauthorizedException("Invalid credentials");
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      this.logger.warn(`Login failed: account locked for user ${user.id}`);
      throw new ForbiddenException(
        "Account is temporarily locked due to too many failed login attempts. Please try again later.",
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      this.logger.warn(`Login failed: invalid password for user ${user.id}`);
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
          `Account locked for user ${user.id} after ${newAttempts} failed attempts`,
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
      this.logger.warn(`Login failed: account deactivated for user ${user.id}`);
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
        const isTrusted = await this.twoFactorService.validateTrustedDevice(
          user.id,
          trustedDeviceToken,
          userAgent,
        );
        if (isTrusted) {
          user.lastLogin = new Date();
          await this.usersRepository.save(user);
          const { accessToken, refreshToken } =
            await this.tokenService.generateTokenPair(user, rememberMe);
          this.logger.log(
            `Login successful (trusted device) for user ${user.id}`,
          );
          return {
            user: this.sanitizeUser(user),
            accessToken,
            refreshToken,
            rememberMe,
          };
        }
      }

      // Return a temporary token for 2FA verification
      // Encode rememberMe in the temp token so it survives the 2FA step
      const tempToken = this.jwtService.sign(
        { sub: user.id, type: "2fa_pending", rememberMe: !!rememberMe },
        { expiresIn: "5m" },
      );
      this.logger.log(`Login requires 2FA for user ${user.id}`);
      return { requires2FA: true, tempToken };
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

    const { accessToken, refreshToken } =
      await this.tokenService.generateTokenPair(user, rememberMe);

    this.logger.log(`Login successful for user ${user.id}`);
    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
      rememberMe,
    };
  }

  async findOrCreateOidcUser(
    userInfo: Record<string, unknown>,
    registrationEnabled = true,
  ): Promise<{ user: User; linkPending?: boolean }> {
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
      // M6: If the existing account has a password (local account), require confirmation
      if (trustedEmail) {
        const existingUser = await this.usersRepository.findOne({
          where: { email: trustedEmail },
        });

        if (existingUser) {
          if (existingUser.passwordHash) {
            // SECURITY: Local account requires user confirmation before linking.
            const linkToken = await this.initiateOidcLink(existingUser, sub);
            this.logger.warn(
              `OIDC link pending confirmation for user ${existingUser.id}`,
            );
            await this.sendOidcLinkEmail(existingUser, linkToken);
            return { user: existingUser, linkPending: true };
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
          if (err.code === "23505" && trustedEmail) {
            const existingUser = await this.usersRepository.findOne({
              where: { email: trustedEmail },
            });
            if (existingUser) {
              if (existingUser.passwordHash) {
                // SECURITY: Local account requires confirmation
                const linkToken = await this.initiateOidcLink(
                  existingUser,
                  sub,
                );
                this.logger.warn(
                  `OIDC link pending confirmation (catch path) for user ${existingUser.id}`,
                );
                await this.sendOidcLinkEmail(existingUser, linkToken);
                return { user: existingUser, linkPending: true };
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

    return { user };
  }

  async validateOidcUser(profile: any): Promise<any> {
    const result = await this.findOrCreateOidcUser(profile);
    return this.sanitizeUser(result.user);
  }

  async getUserById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  // M6: OIDC account linking with confirmation

  async initiateOidcLink(
    existingUser: User,
    oidcSubject: string,
  ): Promise<string> {
    const linkToken = crypto.randomBytes(32).toString("hex");
    existingUser.oidcLinkToken = hashToken(linkToken);
    existingUser.oidcLinkExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    existingUser.oidcLinkPending = true;
    existingUser.pendingOidcSubject = oidcSubject;
    await this.usersRepository.save(existingUser);
    return linkToken;
  }

  private async sendOidcLinkEmail(
    user: User,
    linkToken: string,
  ): Promise<void> {
    if (!user.email) return;
    try {
      const frontendUrl =
        this.configService.get<string>("PUBLIC_APP_URL") ||
        "http://localhost:3000";
      const confirmUrl = `${frontendUrl}/api/v1/auth/oidc/confirm-link?token=${linkToken}`;
      const html = oidcLinkTemplate(user.firstName || "", confirmUrl);
      await this.emailService.sendMail(
        user.email,
        "Monize: Confirm SSO Account Link",
        html,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send OIDC link confirmation email: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async confirmOidcLink(token: string): Promise<User> {
    const hashedToken = hashToken(token);

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

  // --- Delegated methods (preserve public API for controller/strategies) ---

  async generateTokenPair(user: User, rememberMe?: boolean) {
    return this.tokenService.generateTokenPair(user, rememberMe);
  }

  async refreshTokens(rawRefreshToken: string) {
    return this.tokenService.refreshTokens(rawRefreshToken);
  }

  async revokeRefreshToken(rawRefreshToken: string) {
    return this.tokenService.revokeRefreshToken(rawRefreshToken);
  }

  async revokeAllUserRefreshTokens(userId: string) {
    return this.tokenService.revokeAllUserRefreshTokens(userId);
  }

  async verify2FA(
    tempToken: string,
    code: string,
    rememberDevice = false,
    userAgent?: string,
    ipAddress?: string,
  ) {
    return this.twoFactorService.verify2FA(
      tempToken,
      code,
      rememberDevice,
      userAgent,
      ipAddress,
    );
  }

  async setup2FA(userId: string) {
    return this.twoFactorService.setup2FA(userId);
  }

  async confirmSetup2FA(userId: string, code: string) {
    return this.twoFactorService.confirmSetup2FA(userId, code);
  }

  async disable2FA(userId: string, code: string) {
    return this.twoFactorService.disable2FA(userId, code);
  }

  async generateBackupCodes(userId: string, code: string) {
    return this.twoFactorService.generateBackupCodes(userId, code);
  }

  async getTrustedDevices(userId: string) {
    return this.twoFactorService.getTrustedDevices(userId);
  }

  async revokeTrustedDevice(userId: string, deviceId: string) {
    return this.twoFactorService.revokeTrustedDevice(userId, deviceId);
  }

  async revokeAllTrustedDevices(userId: string) {
    return this.twoFactorService.revokeAllTrustedDevices(userId);
  }

  async findTrustedDeviceByToken(userId: string, deviceToken: string) {
    return this.twoFactorService.findTrustedDeviceByToken(userId, deviceToken);
  }

  async createTrustedDevice(
    userId: string,
    userAgent: string,
    ipAddress?: string,
  ) {
    return this.twoFactorService.createTrustedDevice(
      userId,
      userAgent,
      ipAddress,
    );
  }

  async validateTrustedDevice(
    userId: string,
    deviceToken: string,
    userAgent?: string,
  ) {
    return this.twoFactorService.validateTrustedDevice(
      userId,
      deviceToken,
      userAgent,
    );
  }

  async migrateLegacyTotpSecrets() {
    return this.twoFactorService.migrateLegacyTotpSecrets();
  }

  async purgeExpiredRefreshTokens() {
    return this.tokenService.purgeExpiredRefreshTokens();
  }

  async generateResetToken(email: string) {
    return this.authEmailService.generateResetToken(email);
  }

  async resetPassword(token: string, newPassword: string) {
    return this.authEmailService.resetPassword(token, newPassword);
  }

  checkForgotPasswordEmailLimit(email: string) {
    return this.authEmailService.checkForgotPasswordEmailLimit(email);
  }
}
