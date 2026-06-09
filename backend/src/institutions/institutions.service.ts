import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { tr } from "../i18n/translate";
import { Institution } from "./entities/institution.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { CreateInstitutionDto } from "./dto/create-institution.dto";
import { UpdateInstitutionDto } from "./dto/update-institution.dto";
import {
  InstitutionLogoService,
  FetchedLogo,
} from "./institution-logo.service";
import { ActionHistoryService } from "../action-history/action-history.service";

/**
 * Client-facing institution shape. The cached favicon bytes
 * (logoData/logoContentType) are deliberately omitted -- they are served only
 * through GET /institutions/:id/logo.
 */
export interface InstitutionView {
  id: string;
  userId: string;
  name: string;
  website: string;
  country: string | null;
  hasLogo: boolean;
  logoFetchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  accountCount: number;
}

@Injectable()
export class InstitutionsService {
  private readonly logger = new Logger(InstitutionsService.name);

  constructor(
    @InjectRepository(Institution)
    private institutionsRepository: Repository<Institution>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    private dataSource: DataSource,
    private logoService: InstitutionLogoService,
    private actionHistoryService: ActionHistoryService,
  ) {}

  /**
   * Normalise a user-entered website to an absolute https URL so it works both
   * as a stored link and as input to the favicon resolver.
   */
  private normalizeWebsite(website: string): string {
    const trimmed = website.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return `https://${trimmed}`;
    }
    return trimmed;
  }

  private toView(
    institution: Institution,
    accountCount: number,
  ): InstitutionView {
    return {
      id: institution.id,
      userId: institution.userId,
      name: institution.name,
      website: institution.website,
      country: institution.country,
      hasLogo: institution.hasLogo,
      logoFetchedAt: institution.logoFetchedAt,
      createdAt: institution.createdAt,
      updatedAt: institution.updatedAt,
      accountCount,
    };
  }

  private applyLogo(institution: Institution, logo: FetchedLogo | null): void {
    if (logo) {
      institution.logoData = logo.data;
      institution.logoContentType = logo.contentType;
      institution.hasLogo = true;
      institution.logoFetchedAt = new Date();
    } else {
      institution.logoData = null;
      institution.logoContentType = null;
      institution.hasLogo = false;
      institution.logoFetchedAt = new Date();
    }
  }

  private async countAccounts(
    userId: string,
    institutionId: string,
  ): Promise<number> {
    return this.accountsRepository.count({
      where: { userId, institutionId },
    });
  }

  async create(
    userId: string,
    dto: CreateInstitutionDto,
  ): Promise<InstitutionView> {
    const existing = await this.institutionsRepository.findOne({
      where: { userId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException(
        tr(
          "errors.institutions.nameConflict",
          `Institution with name "${dto.name}" already exists`,
          { name: dto.name },
        ),
      );
    }

    const website = this.normalizeWebsite(dto.website);
    const institution = this.institutionsRepository.create({
      userId,
      name: dto.name,
      website,
      country: dto.country ? dto.country.toUpperCase() : null,
    });

    // Best-effort: never fail creation because the favicon could not be fetched.
    const logo = await this.logoService.fetchFavicon(website);
    this.applyLogo(institution, logo);

    const saved = await this.institutionsRepository.save(institution);

    this.actionHistoryService.record(userId, {
      entityType: "institution",
      entityId: saved.id,
      action: "create",
      afterData: {
        id: saved.id,
        name: saved.name,
        website: saved.website,
        country: saved.country,
      },
      description: `Created institution "${saved.name}"`,
    });

    return this.toView(saved, 0);
  }

  async findAll(userId: string): Promise<InstitutionView[]> {
    const institutions = await this.institutionsRepository.find({
      where: { userId },
      order: { name: "ASC" },
    });

    if (institutions.length === 0) {
      return [];
    }

    const counts = await this.accountsRepository
      .createQueryBuilder("account")
      .select("account.institution_id", "institution_id")
      .addSelect("COUNT(*)", "count")
      .where("account.user_id = :userId", { userId })
      .andWhere("account.institution_id IS NOT NULL")
      .groupBy("account.institution_id")
      .getRawMany<{ institution_id: string; count: string }>();

    const countMap = new Map<string, number>();
    for (const row of counts) {
      countMap.set(row.institution_id, parseInt(row.count, 10) || 0);
    }

    return institutions.map((institution) =>
      this.toView(institution, countMap.get(institution.id) ?? 0),
    );
  }

  /**
   * Load the institution entity (without the cached logo bytes), scoped to the
   * owner. Throws NotFound if it does not exist or belongs to another user.
   */
  private async getOwnedEntity(
    userId: string,
    id: string,
  ): Promise<Institution> {
    const institution = await this.institutionsRepository.findOne({
      where: { id, userId },
    });
    if (!institution) {
      throw new NotFoundException(
        tr(
          "errors.institutions.notFound",
          `Institution with ID ${id} not found`,
          { id },
        ),
      );
    }
    return institution;
  }

  async findOne(userId: string, id: string): Promise<InstitutionView> {
    const institution = await this.getOwnedEntity(userId, id);
    const accountCount = await this.countAccounts(userId, id);
    return this.toView(institution, accountCount);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateInstitutionDto,
  ): Promise<InstitutionView> {
    const institution = await this.getOwnedEntity(userId, id);

    if (dto.name !== undefined && dto.name !== institution.name) {
      const existing = await this.institutionsRepository.findOne({
        where: { userId, name: dto.name },
      });
      if (existing && existing.id !== id) {
        throw new ConflictException(
          tr(
            "errors.institutions.nameConflict",
            `Institution with name "${dto.name}" already exists`,
            { name: dto.name },
          ),
        );
      }
      institution.name = dto.name;
    }

    if (dto.country !== undefined) {
      institution.country = dto.country ? dto.country.toUpperCase() : null;
    }

    // Re-resolve the favicon whenever the website changes.
    if (dto.website !== undefined) {
      const website = this.normalizeWebsite(dto.website);
      if (website !== institution.website) {
        institution.website = website;
        const logo = await this.logoService.fetchFavicon(website);
        this.applyLogo(institution, logo);
      }
    }

    const saved = await this.institutionsRepository.save(institution);

    this.actionHistoryService.record(userId, {
      entityType: "institution",
      entityId: saved.id,
      action: "update",
      afterData: {
        id: saved.id,
        name: saved.name,
        website: saved.website,
        country: saved.country,
      },
      description: `Updated institution "${saved.name}"`,
    });

    const accountCount = await this.countAccounts(userId, id);
    return this.toView(saved, accountCount);
  }

  async remove(userId: string, id: string): Promise<void> {
    const institution = await this.getOwnedEntity(userId, id);
    await this.institutionsRepository.remove(institution);

    this.actionHistoryService.record(userId, {
      entityType: "institution",
      entityId: id,
      action: "delete",
      beforeData: {
        id,
        name: institution.name,
        website: institution.website,
        country: institution.country,
      },
      description: `Deleted institution "${institution.name}"`,
    });
  }

  /**
   * Re-fetch the favicon for the institution's current website.
   */
  async refreshLogo(userId: string, id: string): Promise<InstitutionView> {
    const institution = await this.getOwnedEntity(userId, id);
    const logo = await this.logoService.fetchFavicon(institution.website);
    this.applyLogo(institution, logo);
    const saved = await this.institutionsRepository.save(institution);
    const accountCount = await this.countAccounts(userId, id);
    return this.toView(saved, accountCount);
  }

  /**
   * Load the cached favicon bytes for streaming. Throws NotFound when the
   * institution is missing or has no cached logo.
   */
  async getLogo(userId: string, id: string): Promise<FetchedLogo> {
    const institution = await this.institutionsRepository
      .createQueryBuilder("institution")
      .addSelect(["institution.logoData", "institution.logoContentType"])
      .where("institution.id = :id", { id })
      .andWhere("institution.user_id = :userId", { userId })
      .getOne();

    if (!institution) {
      throw new NotFoundException(
        tr(
          "errors.institutions.notFound",
          `Institution with ID ${id} not found`,
          { id },
        ),
      );
    }

    if (!institution.hasLogo || !institution.logoData) {
      throw new NotFoundException(
        tr(
          "errors.institutions.logoNotFound",
          "No logo available for this institution",
        ),
      );
    }

    return {
      data: institution.logoData,
      contentType: institution.logoContentType || "image/png",
    };
  }

  /**
   * List the accounts assigned to an institution.
   */
  async getAccounts(userId: string, id: string): Promise<Account[]> {
    await this.getOwnedEntity(userId, id);
    return this.accountsRepository.find({
      where: { userId, institutionId: id },
      order: { name: "ASC" },
    });
  }

  /**
   * Set an account's institution and keep a linked investment pair (cash <->
   * brokerage) in sync, atomically. The two halves represent one real-world
   * account, so the institution always applies to both.
   *
   * @param expectedInstitutionId when provided (unassign), only clears accounts
   *        currently pointing at this institution.
   */
  private async setAccountInstitution(
    userId: string,
    accountId: string,
    institutionId: string | null,
    expectedInstitutionId?: string,
  ): Promise<Account> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const account = await queryRunner.manager.findOne(Account, {
        where: { id: accountId, userId },
      });
      if (!account) {
        throw new NotFoundException(
          tr(
            "errors.institutions.accountNotFound",
            `Account with ID ${accountId} not found`,
            { id: accountId },
          ),
        );
      }

      // Unassign is a no-op unless the account points at this institution.
      if (
        expectedInstitutionId !== undefined &&
        account.institutionId !== expectedInstitutionId
      ) {
        await queryRunner.commitTransaction();
        return account;
      }

      account.institutionId = institutionId;
      await queryRunner.manager.save(account);

      // Mirror the change onto the linked investment partner.
      if (
        account.linkedAccountId &&
        account.accountType === AccountType.INVESTMENT
      ) {
        const partner = await queryRunner.manager.findOne(Account, {
          where: { id: account.linkedAccountId, userId },
        });
        if (partner && partner.institutionId !== institutionId) {
          partner.institutionId = institutionId;
          await queryRunner.manager.save(partner);
        }
      }

      await queryRunner.commitTransaction();
      return account;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Assign an account (and its linked investment partner) to this institution.
   */
  async assignAccount(
    userId: string,
    id: string,
    accountId: string,
  ): Promise<Account> {
    await this.getOwnedEntity(userId, id);
    return this.setAccountInstitution(userId, accountId, id);
  }

  /**
   * Remove an account (and its linked investment partner) from this institution.
   */
  async unassignAccount(
    userId: string,
    id: string,
    accountId: string,
  ): Promise<Account> {
    await this.getOwnedEntity(userId, id);
    return this.setAccountInstitution(userId, accountId, null, id);
  }
}
