import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
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
import { encrypt, decrypt } from "./crypto.util";
import { UAParser } from "ua-parser-js";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private jwtSecret: string;
  private readonly ACCESS_TOKEN_EXPIRY = "15m";
  private readonly REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  ) {
    this.jwtSecret = this.configService.get<string>("JWT_SECRET")!;
  }

  async register(registerDto: RegisterDto) {
    const { email, password, firstName, lastName } = registerDto;

    // Check if user exists
    const existingUser = await this.usersRepository.findOne({
      where: { email },
    });

    if (existingUser) {
      // SECURITY: Generic message to prevent account enumeration
      throw new UnauthorizedException("Unable to complete registration");
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = this.usersRepository.create({
      email,
      passwordHash,
      firstName,
      lastName,
      authProvider: "local",
    });

    // First registered user automatically becomes admin
    const userCount = await this.usersRepository.count();
    if (userCount === 0) {
      user.role = "admin";
    }

    await this.usersRepository.save(user);

    const { accessToken, refreshToken } = await this.generateTokenPair(user);

    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  }

  async login(loginDto: LoginDto, trustedDeviceToken?: string) {
    const { email, password } = loginDto;

    const user = await this.usersRepository.findOne({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    if (!user.isActive) {
      throw new UnauthorizedException("Account is deactivated");
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
          return { user: this.sanitizeUser(user), accessToken, refreshToken };
        }
      }

      // Return a temporary token for 2FA verification
      const tempToken = this.jwtService.sign(
        { sub: user.id, type: "2fa_pending" },
        { expiresIn: "5m" },
      );
      return { requires2FA: true, tempToken };
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

    const { accessToken, refreshToken } = await this.generateTokenPair(user);

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
    let payload: any;
    try {
      payload = this.jwtService.verify(tempToken);
    } catch {
      throw new UnauthorizedException("Invalid or expired verification token");
    }

    if (payload.type !== "2fa_pending") {
      throw new UnauthorizedException("Invalid token type");
    }

    const user = await this.usersRepository.findOne({
      where: { id: payload.sub },
    });

    if (!user || !user.twoFactorSecret) {
      throw new UnauthorizedException("Invalid verification state");
    }

    const secret = decrypt(user.twoFactorSecret, this.jwtSecret);
    const isValid = otplib.verifySync({ token: code, secret }).valid;

    if (!isValid) {
      throw new UnauthorizedException("Invalid verification code");
    }

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

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

  async setup2FA(userId: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException("User not found");
    }

    const secret = otplib.generateSecret();
    const otpauthUrl = otplib.generateURI({
      secret,
      issuer: "Monize",
      label: user.email || userId,
    });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Store encrypted secret (pending confirmation)
    user.twoFactorSecret = encrypt(secret, this.jwtSecret);
    await this.usersRepository.save(user);

    return { secret, qrCodeDataUrl, otpauthUrl };
  }

  async confirmSetup2FA(userId: string, code: string) {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user || !user.twoFactorSecret) {
      throw new BadRequestException("2FA setup not initiated");
    }

    const secret = decrypt(user.twoFactorSecret, this.jwtSecret);
    const isValid = otplib.verifySync({ token: code, secret }).valid;

    if (!isValid) {
      throw new BadRequestException("Invalid verification code");
    }

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
      where: { email },
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
    const email = userInfo.email as string | undefined;
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
      if (trustedEmail) {
        const existingUser = await this.usersRepository.findOne({
          where: { email: trustedEmail },
        });

        if (existingUser) {
          // Link OIDC to existing local account
          existingUser.oidcSubject = sub;
          existingUser.authProvider = "oidc";
          await this.usersRepository.save(existingUser);
          user = existingUser;
        }
      }

      if (!user) {
        if (!registrationEnabled) {
          throw new ForbiddenException("New account registration is disabled.");
        }
        // Create new user (no existing account found)
        // Use trusted email if verified, otherwise store raw email but don't link accounts
        const userData: DeepPartial<User> = {
          email: trustedEmail ?? email ?? null,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          oidcSubject: sub,
          authProvider: "oidc",
        };

        // First registered user automatically becomes admin
        const userCount = await this.usersRepository.count();
        if (userCount === 0) {
          userData.role = "admin";
        }

        user = this.usersRepository.create(userData);

        try {
          await this.usersRepository.save(user);
        } catch (err: any) {
          // Handle duplicate email: link OIDC to the existing account
          // SECURITY: Only link accounts when the OIDC provider has verified the email
          if (err.code === "23505" && trustedEmail) {
            const existingUser = await this.usersRepository.findOne({
              where: { email: trustedEmail },
            });
            if (existingUser) {
              existingUser.oidcSubject = sub;
              existingUser.authProvider = "oidc";
              await this.usersRepository.save(existingUser);
              user = existingUser;
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

    // Update last login
    user.lastLogin = new Date();
    await this.usersRepository.save(user);

    return user;
  }

  async validateOidcUser(profile: any): Promise<any> {
    const user = await this.findOrCreateOidcUser(profile);
    return this.sanitizeUser(user);
  }

  generateToken(user: User): string {
    const payload = {
      sub: user.id,
      email: user.email,
      authProvider: user.authProvider,
      role: user.role,
    };
    return this.jwtService.sign(payload);
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
  ): Promise<{ accessToken: string; refreshToken: string }> {
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

      return { accessToken, refreshToken: newRawRefreshToken };
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
    const result = await this.refreshTokensRepository.delete({
      expiresAt: LessThan(new Date()),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(`Purged ${result.affected} expired refresh tokens`);
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
    // SECURITY: Hash the incoming token to compare against stored hash
    const hashedToken = this.hashToken(token);
    const user = await this.usersRepository.findOne({
      where: { resetToken: hashedToken },
    });

    if (!user || !user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
      throw new BadRequestException("Invalid or expired reset token");
    }

    const saltRounds = 10;
    user.passwordHash = await bcrypt.hash(newPassword, saltRounds);
    user.resetToken = null;
    user.resetTokenExpiry = null;
    await this.usersRepository.save(user);

    // Revoke all refresh tokens to force re-login on all devices
    await this.revokeAllUserRefreshTokens(user.id);
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
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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

  private sanitizeUser(user: User) {
    const {
      passwordHash,
      resetToken,
      resetTokenExpiry,
      twoFactorSecret,
      ...sanitized
    } = user;
    return { ...sanitized, hasPassword: !!passwordHash };
  }
}
