import {
  Injectable,
  BadRequestException,
  Logger,
  OnModuleDestroy,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";

import { User } from "../users/entities/user.entity";
import { hashToken } from "./crypto.util";
import { PasswordBreachService } from "./password-breach.service";
import { TokenService } from "./token.service";

@Injectable()
export class AuthEmailService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthEmailService.name);

  // M7: Per-email rate limiting for forgot-password
  private readonly forgotPasswordAttempts = new Map<
    string,
    { count: number; windowStart: number }
  >();
  private readonly FORGOT_PASSWORD_EMAIL_LIMIT = 3;
  private readonly FORGOT_PASSWORD_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private passwordBreachService: PasswordBreachService,
    private tokenService: TokenService,
  ) {
    // Periodically prune expired entries to prevent unbounded memory growth.
    // unref() ensures the timer does not prevent Node.js process shutdown.
    this.cleanupInterval = setInterval(
      () => this.cleanupExpiredAttempts(),
      this.FORGOT_PASSWORD_EMAIL_WINDOW_MS,
    );
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  onModuleDestroy() {
    clearInterval(this.cleanupInterval);
  }

  private cleanupExpiredAttempts(): void {
    const now = Date.now();
    for (const [email, record] of this.forgotPasswordAttempts) {
      if (now - record.windowStart > this.FORGOT_PASSWORD_EMAIL_WINDOW_MS) {
        this.forgotPasswordAttempts.delete(email);
      }
    }
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

    // SECURITY: Store hashed token
    user.resetToken = hashToken(rawResetToken);
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
    const hashedToken = hashToken(token);

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    // M11: Atomic UPDATE...WHERE to prevent TOCTOU race condition.
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
      await this.tokenService.revokeAllUserRefreshTokens(userId);
    }
  }

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
}
