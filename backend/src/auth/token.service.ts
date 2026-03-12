import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan, DataSource } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import * as crypto from "crypto";

import { User } from "../users/entities/user.entity";
import { RefreshToken } from "./entities/refresh-token.entity";
import { hashToken } from "./crypto.util";

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly ACCESS_TOKEN_EXPIRY = "15m";
  private readonly REFRESH_TOKEN_EXPIRY_MS = 1 * 24 * 60 * 60 * 1000; // 1 day
  private readonly REMEMBER_ME_EXPIRY_MS: number;

  constructor(
    @InjectRepository(RefreshToken)
    private refreshTokensRepository: Repository<RefreshToken>,
    private jwtService: JwtService,
    private dataSource: DataSource,
    private configService: ConfigService,
  ) {
    const rememberMeDays = parseInt(
      this.configService.get<string>("REMEMBER_ME_DAYS", "30"),
      10,
    );
    this.REMEMBER_ME_EXPIRY_MS =
      (rememberMeDays > 0 ? rememberMeDays : 30) * 24 * 60 * 60 * 1000;
  }

  getRefreshExpiryMs(rememberMe?: boolean): number {
    return rememberMe
      ? this.REMEMBER_ME_EXPIRY_MS
      : this.REFRESH_TOKEN_EXPIRY_MS;
  }

  async generateTokenPair(
    user: User,
    rememberMe?: boolean,
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
    const tokenHash = hashToken(rawRefreshToken);
    const familyId = crypto.randomUUID();
    const expiryMs = this.getRefreshExpiryMs(rememberMe);

    const refreshTokenEntity = this.refreshTokensRepository.create({
      userId: user.id,
      tokenHash,
      familyId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + expiryMs),
      replacedByHash: null,
    });
    await this.refreshTokensRepository.save(refreshTokenEntity);

    return { accessToken, refreshToken: rawRefreshToken };
  }

  async refreshTokens(
    rawRefreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const tokenHash = hashToken(rawRefreshToken);

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
      const newTokenHash = hashToken(newRawRefreshToken);

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

      return {
        accessToken,
        refreshToken: newRawRefreshToken,
        userId: user.id,
      };
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
    const tokenHash = hashToken(rawRefreshToken);
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
}
