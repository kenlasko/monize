import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import * as bcrypt from "bcryptjs";
import { Response } from "express";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { hashToken } from "../auth/crypto.util";
import { TokenService } from "../auth/token.service";
import { PasswordBreachService } from "../auth/password-breach.service";
import { AuthService } from "../auth/auth.service";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { generateCsrfToken, getCsrfCookieOptions } from "../common/csrf.util";
import { ClaimCompleteDto, ClaimPreviewDto } from "./dto/claim.dto";

@ApiTags("Emergency Access")
@Controller("emergency-access/claim")
export class EmergencyAccessClaimController {
  private readonly logger = new Logger(EmergencyAccessClaimController.name);
  private readonly useSecureCookies: boolean;

  constructor(
    @InjectRepository(EmergencyAccessContact)
    private readonly contactsRepo: Repository<EmergencyAccessContact>,
    @InjectRepository(EmergencyAccessSettings)
    private readonly settingsRepo: Repository<EmergencyAccessSettings>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly tokenService: TokenService,
    private readonly authService: AuthService,
    private readonly passwordBreachService: PasswordBreachService,
    private readonly encryption: AiEncryptionService,
    private readonly configService: ConfigService,
  ) {
    const disableHttpsHeaders =
      this.configService
        .get<string>("DISABLE_HTTPS_HEADERS", "false")
        .toLowerCase() === "true";
    this.useSecureCookies =
      this.configService.get<string>("NODE_ENV") === "production" &&
      !disableHttpsHeaders;
  }

  private async findValidContact(
    rawToken: string,
  ): Promise<EmergencyAccessContact> {
    const tokenHash = hashToken(rawToken);
    const contact = await this.contactsRepo.findOne({
      where: { claimTokenHash: tokenHash },
    });
    if (
      !contact ||
      !contact.claimTokenExpiresAt ||
      contact.claimTokenUsedAt ||
      contact.claimTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new NotFoundException(
        "This emergency access link is invalid, expired, or has already been used.",
      );
    }
    return contact;
  }

  @Post("preview")
  @AllowDelegate()
  @SkipCsrf()
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary: "Validate the magic link and return owner identity + message",
  })
  async preview(@Body() dto: ClaimPreviewDto) {
    const contact = await this.findValidContact(dto.token);
    const settings = await this.settingsRepo.findOne({
      where: { ownerUserId: contact.ownerUserId },
    });
    const owner = await this.usersRepo.findOne({
      where: { id: contact.ownerUserId },
    });
    if (!settings || !owner) {
      throw new NotFoundException("Owner account no longer exists.");
    }

    let message: string | null = null;
    if (settings.messageCiphertext && this.encryption.isConfigured()) {
      try {
        message = this.encryption.decrypt(settings.messageCiphertext);
      } catch (error) {
        this.logger.error(
          "Failed to decrypt emergency access message during preview",
          error instanceof Error ? error.stack : error,
        );
      }
    }

    return {
      ownerFirstName: owner.firstName,
      ownerLastName: owner.lastName,
      contactFirstName: contact.firstName,
      message,
      expiresAt: contact.claimTokenExpiresAt,
    };
  }

  @Post("complete")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({
    summary:
      "Consume the magic link, replace the owner's password, and sign in",
  })
  async complete(@Body() dto: ClaimCompleteDto, @Res() res: Response) {
    const isBreached = await this.passwordBreachService.isBreached(
      dto.newPassword,
    );
    if (isBreached) {
      throw new BadRequestException(
        "This password has been found in a data breach. Please choose a different password.",
      );
    }

    const tokenHash = hashToken(dto.token);
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let ownerId: string;
    try {
      const contact = await queryRunner.manager.findOne(
        EmergencyAccessContact,
        {
          where: { claimTokenHash: tokenHash },
        },
      );
      if (
        !contact ||
        !contact.claimTokenExpiresAt ||
        contact.claimTokenUsedAt ||
        contact.claimTokenExpiresAt.getTime() < Date.now()
      ) {
        throw new NotFoundException(
          "This emergency access link is invalid, expired, or has already been used.",
        );
      }
      ownerId = contact.ownerUserId;

      const owner = await queryRunner.manager.findOne(User, {
        where: { id: ownerId },
      });
      if (!owner) {
        throw new NotFoundException("Owner account no longer exists.");
      }

      // Replace credentials so the contact can sign in.
      await queryRunner.manager
        .createQueryBuilder()
        .update(User)
        .set({
          passwordHash,
          mustChangePassword: false,
          twoFactorSecret: null,
          pendingTwoFactorSecret: null,
          backupCodes: null,
          authProvider: "local",
          lastLogin: new Date(),
          lastActivityAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
          resetToken: null,
          resetTokenExpiry: null,
        })
        .where("id = :id", { id: ownerId })
        .execute();

      // 2FA on the preferences side.
      await queryRunner.manager
        .createQueryBuilder()
        .update(UserPreference)
        .set({ twoFactorEnabled: false })
        .where("user_id = :id", { id: ownerId })
        .execute();

      // Trusted devices belonged to the previous holder.
      await queryRunner.manager.delete(TrustedDevice, { userId: ownerId });

      // Consume the claiming token, void all sibling tokens (single-claim wins).
      contact.claimTokenUsedAt = new Date();
      contact.claimVoidedReason = null;
      contact.claimTokenHash = null;
      await queryRunner.manager.save(contact);

      await queryRunner.manager
        .createQueryBuilder()
        .update(EmergencyAccessContact)
        .set({
          claimTokenHash: null,
          claimTokenExpiresAt: null,
          claimTokenUsedAt: () => "CURRENT_TIMESTAMP",
          claimVoidedReason: "claimed_by_other",
        })
        .where("owner_user_id = :id", { id: ownerId })
        .andWhere("id <> :contactId", { contactId: contact.id })
        .andWhere("claim_token_hash IS NOT NULL")
        .andWhere("claim_token_used_at IS NULL")
        .execute();

      // Disable the emergency access feature on the now-claimed account so
      // the cron does not re-fire if the new holder ever lapses.
      await queryRunner.manager
        .createQueryBuilder()
        .update(EmergencyAccessSettings)
        .set({ enabled: false, grantedAt: new Date() })
        .where("owner_user_id = :id", { id: ownerId })
        .execute();

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    // Revoke every existing refresh token outside the transaction so it
    // uses the TokenService API (which writes via its own repo).
    await this.tokenService.revokeAllUserRefreshTokens(ownerId);

    const freshOwner = await this.usersRepo.findOne({ where: { id: ownerId } });
    if (!freshOwner) {
      throw new NotFoundException("Owner account no longer exists.");
    }

    const { accessToken, refreshToken } =
      await this.tokenService.generateTokenPair(freshOwner, false);

    res.cookie("auth_token", accessToken, {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "lax" as const,
      maxAge: 15 * 60 * 1000,
      path: "/",
    });
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "strict" as const,
      maxAge: this.tokenService.getRefreshExpiryMs(false),
      path: "/",
    });
    res.cookie(
      "csrf_token",
      generateCsrfToken(freshOwner.id, this.authService.getCsrfKey()),
      getCsrfCookieOptions(this.useSecureCookies),
    );

    this.logger.log(`Emergency access claim completed for user ${ownerId}`);

    res.json({ ok: true });
  }
}
