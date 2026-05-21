import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { UpsertSettingsDto } from "./dto/upsert-settings.dto";
import { UpsertContactDto } from "./dto/upsert-contact.dto";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { EmailService } from "../notifications/email.service";
import { User } from "../users/entities/user.entity";

export interface ContactView {
  id: string;
  firstName: string;
  email: string;
  createdAt: Date;
}

export interface SettingsView {
  emailConfigured: boolean;
  enabled: boolean;
  grantAfterDays: number;
  reminderAfterDays: number;
  message: string | null;
  lastReminderSentAt: Date | null;
  grantedAt: Date | null;
  lastActivityAt: Date | null;
  contacts: ContactView[];
}

@Injectable()
export class EmergencyAccessService {
  private readonly logger = new Logger(EmergencyAccessService.name);

  constructor(
    @InjectRepository(EmergencyAccessSettings)
    private readonly settingsRepo: Repository<EmergencyAccessSettings>,
    @InjectRepository(EmergencyAccessContact)
    private readonly contactsRepo: Repository<EmergencyAccessContact>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly encryption: AiEncryptionService,
    private readonly emailService: EmailService,
    private readonly dataSource: DataSource,
  ) {}

  private toContactView(c: EmergencyAccessContact): ContactView {
    return {
      id: c.id,
      firstName: c.firstName,
      email: c.email,
      createdAt: c.createdAt,
    };
  }

  private decryptMessage(ciphertext: string | null): string | null {
    if (!ciphertext) return null;
    if (!this.encryption.isConfigured()) {
      this.logger.warn(
        "Encryption key not configured; emergency access message cannot be decrypted",
      );
      return null;
    }
    try {
      return this.encryption.decrypt(ciphertext);
    } catch (error) {
      this.logger.error(
        "Failed to decrypt emergency access message",
        error instanceof Error ? error.stack : error,
      );
      return null;
    }
  }

  async getView(userId: string): Promise<SettingsView> {
    const [settings, contacts, user] = await Promise.all([
      this.settingsRepo.findOne({ where: { ownerUserId: userId } }),
      this.contactsRepo.find({
        where: { ownerUserId: userId },
        order: { createdAt: "ASC" },
      }),
      this.usersRepo.findOne({ where: { id: userId } }),
    ]);

    const emailConfigured = this.emailService.getStatus().configured;

    return {
      emailConfigured,
      enabled: settings?.enabled ?? false,
      grantAfterDays: settings?.grantAfterDays ?? 14,
      reminderAfterDays: settings?.reminderAfterDays ?? 7,
      message: this.decryptMessage(settings?.messageCiphertext ?? null),
      lastReminderSentAt: settings?.lastReminderSentAt ?? null,
      grantedAt: settings?.grantedAt ?? null,
      lastActivityAt: user?.lastActivityAt ?? user?.lastLogin ?? null,
      contacts: contacts.map((c) => this.toContactView(c)),
    };
  }

  async upsertSettings(
    userId: string,
    dto: UpsertSettingsDto,
  ): Promise<SettingsView> {
    if (!this.emailService.getStatus().configured) {
      throw new ServiceUnavailableException(
        "Email is not configured. Emergency access cannot be enabled until SMTP is set up.",
      );
    }
    if (dto.enabled && dto.message && !this.encryption.isConfigured()) {
      throw new ServiceUnavailableException(
        "Encryption key is not configured. The free-form message cannot be stored securely until AI_ENCRYPTION_KEY is set.",
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      let row = await queryRunner.manager.findOne(EmergencyAccessSettings, {
        where: { ownerUserId: userId },
      });
      if (!row) {
        row = queryRunner.manager.create(EmergencyAccessSettings, {
          ownerUserId: userId,
        });
      }

      const wasEnabled = row.enabled;
      row.enabled = dto.enabled;
      row.grantAfterDays = dto.grantAfterDays;
      row.reminderAfterDays = dto.reminderAfterDays;

      const trimmed = dto.message?.trim();
      if (!trimmed) {
        row.messageCiphertext = null;
      } else {
        row.messageCiphertext = this.encryption.encrypt(trimmed);
      }

      // If the owner is (re-)enabling, reset the grant marker and the
      // last-reminder gate so the cron starts fresh.
      if (!wasEnabled && dto.enabled) {
        row.grantedAt = null;
        row.lastReminderSentAt = null;
      }
      // If the owner explicitly disables, also clear the grant marker so
      // a subsequent re-enable starts fresh.
      if (wasEnabled && !dto.enabled) {
        row.grantedAt = null;
        row.lastReminderSentAt = null;
        // Void any outstanding magic links -- the owner has revoked the feature.
        await queryRunner.manager
          .createQueryBuilder()
          .update(EmergencyAccessContact)
          .set({
            claimTokenHash: null,
            claimTokenExpiresAt: null,
            claimTokenUsedAt: () => "CURRENT_TIMESTAMP",
            claimVoidedReason: "owner_revoked",
          })
          .where("owner_user_id = :userId", { userId })
          .andWhere("claim_token_hash IS NOT NULL")
          .andWhere("claim_token_used_at IS NULL")
          .execute();
      }

      await queryRunner.manager.save(row);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return this.getView(userId);
  }

  async addContact(
    userId: string,
    dto: UpsertContactDto,
  ): Promise<ContactView> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const existing = await this.contactsRepo
      .createQueryBuilder("c")
      .where("c.owner_user_id = :userId", { userId })
      .andWhere("lower(c.email) = :email", { email: normalizedEmail })
      .getOne();
    if (existing) {
      throw new ConflictException(
        "An emergency contact with this email already exists.",
      );
    }
    const contact = this.contactsRepo.create({
      ownerUserId: userId,
      firstName: dto.firstName.trim(),
      email: dto.email.trim(),
    });
    await this.contactsRepo.save(contact);
    return this.toContactView(contact);
  }

  async updateContact(
    userId: string,
    contactId: string,
    dto: UpsertContactDto,
  ): Promise<ContactView> {
    const contact = await this.contactsRepo.findOne({
      where: { id: contactId, ownerUserId: userId },
    });
    if (!contact) {
      throw new NotFoundException("Contact not found");
    }
    const normalizedEmail = dto.email.trim().toLowerCase();
    if (normalizedEmail !== contact.email.toLowerCase()) {
      const dup = await this.contactsRepo
        .createQueryBuilder("c")
        .where("c.owner_user_id = :userId", { userId })
        .andWhere("lower(c.email) = :email", { email: normalizedEmail })
        .andWhere("c.id <> :id", { id: contactId })
        .getOne();
      if (dup) {
        throw new ConflictException(
          "An emergency contact with this email already exists.",
        );
      }
    }
    contact.firstName = dto.firstName.trim();
    contact.email = dto.email.trim();
    // Editing email invalidates any in-flight magic link.
    contact.claimTokenHash = null;
    contact.claimTokenExpiresAt = null;
    await this.contactsRepo.save(contact);
    return this.toContactView(contact);
  }

  async removeContact(userId: string, contactId: string): Promise<void> {
    const result = await this.contactsRepo.delete({
      id: contactId,
      ownerUserId: userId,
    });
    if (!result.affected) {
      throw new NotFoundException("Contact not found");
    }
  }

  async resetGrantedState(userId: string): Promise<SettingsView> {
    const settings = await this.settingsRepo.findOne({
      where: { ownerUserId: userId },
    });
    if (!settings) {
      throw new NotFoundException("Emergency access not configured");
    }
    settings.grantedAt = null;
    settings.lastReminderSentAt = null;
    await this.settingsRepo.save(settings);
    await this.contactsRepo
      .createQueryBuilder()
      .update(EmergencyAccessContact)
      .set({
        claimTokenHash: null,
        claimTokenExpiresAt: null,
        claimTokenUsedAt: () => "CURRENT_TIMESTAMP",
        claimVoidedReason: "owner_revoked",
      })
      .where("owner_user_id = :userId", { userId })
      .andWhere("claim_token_hash IS NOT NULL")
      .andWhere("claim_token_used_at IS NULL")
      .execute();
    return this.getView(userId);
  }
}
