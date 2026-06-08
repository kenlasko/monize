import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, IsNull } from "typeorm";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { I18nService } from "nestjs-i18n";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { EmailService } from "../notifications/email.service";
import {
  emergencyAccessGrantTemplate,
  emergencyAccessGrantRevokedTemplate,
  emergencyAccessReminderTemplate,
} from "../notifications/email-templates";
import { emailTranslator } from "../i18n/email-translator";
import { DEFAULT_LOCALE } from "../i18n/config";
import { hashToken } from "../auth/crypto.util";
import { User } from "../users/entities/user.entity";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CLAIM_TOKEN_BYTES = 32;
const CLAIM_TOKEN_TTL_DAYS = 30;

@Injectable()
export class EmergencyAccessMonitorService {
  private readonly logger = new Logger(EmergencyAccessMonitorService.name);

  constructor(
    @InjectRepository(EmergencyAccessSettings)
    private readonly settingsRepo: Repository<EmergencyAccessSettings>,
    @InjectRepository(EmergencyAccessContact)
    private readonly contactsRepo: Repository<EmergencyAccessContact>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly emailService: EmailService,
    private readonly encryption: AiEncryptionService,
    private readonly configService: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async runDailyCheck(): Promise<void> {
    if (!this.emailService.getStatus().configured) {
      this.logger.debug(
        "SMTP not configured, skipping emergency access checks",
      );
      return;
    }

    const enabled = await this.settingsRepo.find({ where: { enabled: true } });
    if (enabled.length === 0) {
      this.logger.debug("No users with emergency access enabled");
      return;
    }

    this.logger.log(
      `Running emergency access check for ${enabled.length} user(s)`,
    );

    const appUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );

    let grants = 0;
    let reminders = 0;
    let skipped = 0;

    for (const settings of enabled) {
      try {
        const handled = await this.processOne(settings, appUrl);
        if (handled === "granted") grants += 1;
        else if (handled === "reminded") reminders += 1;
        else skipped += 1;
      } catch (error) {
        this.logger.error(
          `Emergency access processing failed for user ${settings.ownerUserId}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    this.logger.log(
      `Emergency access check complete: ${grants} granted, ${reminders} reminded, ${skipped} skipped`,
    );
  }

  private async processOne(
    settings: EmergencyAccessSettings,
    appUrl: string,
  ): Promise<"granted" | "reminded" | "skipped"> {
    const owner = await this.usersRepo.findOne({
      where: { id: settings.ownerUserId },
    });
    if (!owner || !owner.isActive || !owner.email) return "skipped";
    // Prefer last_activity_at (touched by every authenticated request); fall
    // back to last_login for users who have not done anything since the
    // backfill migration.
    const lastSeen = owner.lastActivityAt ?? owner.lastLogin;
    if (!lastSeen) return "skipped";

    const now = Date.now();
    const daysSinceLogin = Math.floor((now - lastSeen.getTime()) / MS_PER_DAY);

    // Step 0: the owner is active again after a grant fired. Revoke the
    // outstanding (unclaimed) magic links, re-arm monitoring, and tell the
    // owner. Without this, a contact could take over a fully-active account
    // for the entire 30-day link lifetime after the owner returned.
    if (
      settings.grantedAt !== null &&
      daysSinceLogin < settings.grantAfterDays
    ) {
      await this.revokeAfterReturn(settings, owner, appUrl);
      return "skipped";
    }

    // Step 1: grant cascade (only if not already granted)
    if (
      settings.grantedAt === null &&
      daysSinceLogin >= settings.grantAfterDays
    ) {
      const contacts = await this.contactsRepo.find({
        where: { ownerUserId: settings.ownerUserId },
      });
      if (contacts.length === 0) return "skipped";

      const decryptedMessage = settings.messageCiphertext
        ? this.tryDecrypt(settings.messageCiphertext)
        : null;
      const ownerFullName =
        [owner.firstName, owner.lastName].filter(Boolean).join(" ") ||
        owner.email;
      const expiresAt = new Date(now + CLAIM_TOKEN_TTL_DAYS * MS_PER_DAY);

      let delivered = 0;
      for (const contact of contacts) {
        try {
          const rawToken = crypto
            .randomBytes(CLAIM_TOKEN_BYTES)
            .toString("hex");
          contact.claimTokenHash = hashToken(rawToken);
          contact.claimTokenExpiresAt = expiresAt;
          contact.claimTokenUsedAt = null;
          contact.claimVoidedReason = null;
          await this.contactsRepo.save(contact);

          const claimUrl = `${appUrl}/emergency-access/claim?token=${rawToken}`;
          const lang = DEFAULT_LOCALE;
          const t = emailTranslator(this.i18n, lang);
          const html = emergencyAccessGrantTemplate(
            {
              contactFirstName: contact.firstName,
              ownerFullName,
              message: decryptedMessage,
              claimUrl,
              expiresAt,
            },
            t,
          );
          await this.emailService.sendMail(
            contact.email,
            t(
              "emails.emergencyAccessGrant.subject",
              `You have been granted emergency access to ${ownerFullName}'s Monize account`,
              { owner: ownerFullName },
            ),
            html,
          );
          delivered += 1;
        } catch (error) {
          this.logger.error(
            `Failed to issue emergency access grant for contact ${contact.id}`,
            error instanceof Error ? error.stack : error,
          );
        }
      }

      // Only commit the grant if at least one contact actually received a
      // link. Otherwise leave grantedAt null so the next run retries -- a
      // transient SMTP failure must not permanently disable the safeguard.
      if (delivered === 0) {
        this.logger.error(
          `Emergency access grant for user ${settings.ownerUserId} delivered no contact emails; leaving grant un-set for retry`,
        );
        return "skipped";
      }

      settings.grantedAt = new Date(now);
      await this.settingsRepo.save(settings);
      return "granted";
    }

    // Step 2: reminder cascade (only if not already granted, at most once per day)
    if (
      settings.grantedAt === null &&
      daysSinceLogin >= settings.reminderAfterDays
    ) {
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      if (
        settings.lastReminderSentAt &&
        settings.lastReminderSentAt >= todayMidnight
      ) {
        return "skipped";
      }

      const contacts = await this.contactsRepo.find({
        where: {
          ownerUserId: settings.ownerUserId,
          claimTokenUsedAt: IsNull(),
        },
      });
      const daysUntilGrant = Math.max(
        0,
        settings.grantAfterDays - daysSinceLogin,
      );
      const reminderLang = DEFAULT_LOCALE;
      const reminderT = emailTranslator(this.i18n, reminderLang);
      const html = emergencyAccessReminderTemplate(
        {
          ownerFirstName: owner.firstName || "",
          daysSinceLogin,
          daysUntilGrant,
          contacts: contacts.map((c) => ({
            firstName: c.firstName,
            email: c.email,
          })),
          appUrl,
        },
        reminderT,
      );
      await this.emailService.sendMail(
        owner.email,
        reminderT(
          "emails.emergencyAccessReminder.subject",
          `Monize: your account has been inactive for ${daysSinceLogin} day${daysSinceLogin === 1 ? "" : "s"}`,
          { daysSinceLogin },
        ),
        html,
      );
      settings.lastReminderSentAt = new Date(now);
      await this.settingsRepo.save(settings);
      return "reminded";
    }

    return "skipped";
  }

  /**
   * The owner signed back in after a grant had fired. Void every outstanding
   * (unclaimed) magic link, clear the grant marker so monitoring re-arms, and
   * notify the owner that access had been granted in their absence.
   */
  private async revokeAfterReturn(
    settings: EmergencyAccessSettings,
    owner: User,
    appUrl: string,
  ): Promise<void> {
    const result = await this.contactsRepo
      .createQueryBuilder()
      .update(EmergencyAccessContact)
      .set({
        claimTokenHash: null,
        claimTokenExpiresAt: null,
        claimTokenUsedAt: () => "CURRENT_TIMESTAMP",
        claimVoidedReason: "owner_returned",
      })
      .where("owner_user_id = :userId", { userId: settings.ownerUserId })
      .andWhere("claim_token_hash IS NOT NULL")
      .andWhere("claim_token_used_at IS NULL")
      .execute();

    settings.grantedAt = null;
    settings.lastReminderSentAt = null;
    await this.settingsRepo.save(settings);

    this.logger.warn(
      `Owner ${settings.ownerUserId} active again after a grant; voided ${
        result.affected ?? 0
      } outstanding emergency-access link(s) and re-armed monitoring`,
    );

    if (!owner.email) return;
    try {
      const revokedLang = DEFAULT_LOCALE;
      const revokedT = emailTranslator(this.i18n, revokedLang);
      const html = emergencyAccessGrantRevokedTemplate(
        {
          ownerFirstName: owner.firstName || "",
          appUrl,
        },
        revokedT,
      );
      await this.emailService.sendMail(
        owner.email,
        revokedT(
          "emails.emergencyAccessGrantRevoked.subject",
          "Monize: emergency access was granted while you were away",
        ),
        html,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send emergency-access revocation notice to owner ${settings.ownerUserId}`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  private tryDecrypt(ciphertext: string): string | null {
    if (!this.encryption.isConfigured()) return null;
    try {
      return this.encryption.decrypt(ciphertext);
    } catch (error) {
      this.logger.error(
        "Failed to decrypt emergency access message for grant email",
        error instanceof Error ? error.stack : error,
      );
      return null;
    }
  }
}
