import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner, In } from "typeorm";
import { Tag } from "./entities/tag.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import { CreateTagDto } from "./dto/create-tag.dto";
import { UpdateTagDto } from "./dto/update-tag.dto";
import { ActionHistoryService } from "../action-history/action-history.service";

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(
    @InjectRepository(Tag)
    private tagsRepository: Repository<Tag>,
    @InjectRepository(TransactionTag)
    private transactionTagsRepository: Repository<TransactionTag>,
    @InjectRepository(TransactionSplitTag)
    private transactionSplitTagsRepository: Repository<TransactionSplitTag>,
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async findAll(userId: string): Promise<Tag[]> {
    return this.tagsRepository.find({
      where: { userId },
      order: { name: "ASC" },
    });
  }

  async findOne(userId: string, id: string): Promise<Tag> {
    const tag = await this.tagsRepository.findOne({
      where: { id, userId },
    });
    if (!tag) {
      throw new NotFoundException(`Tag with ID ${id} not found`);
    }
    return tag;
  }

  async create(userId: string, dto: CreateTagDto): Promise<Tag> {
    const existing = await this.tagsRepository
      .createQueryBuilder("tag")
      .where("tag.userId = :userId", { userId })
      .andWhere("LOWER(tag.name) = LOWER(:name)", { name: dto.name })
      .getOne();

    if (existing) {
      throw new ConflictException(`A tag named "${dto.name}" already exists`);
    }

    const tag = this.tagsRepository.create({
      ...dto,
      color: dto.color || null,
      icon: dto.icon || null,
      userId,
    });
    const saved = await this.tagsRepository.save(tag);
    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: saved.id,
      action: "create",
      afterData: {
        id: saved.id,
        name: saved.name,
        color: saved.color,
        icon: saved.icon,
      },
      description: `Created tag "${saved.name}"`,
    });
    return saved;
  }

  async update(userId: string, id: string, dto: UpdateTagDto): Promise<Tag> {
    const tag = await this.findOne(userId, id);
    const beforeData = { name: tag.name, color: tag.color, icon: tag.icon };

    if (dto.name && dto.name.toLowerCase() !== tag.name.toLowerCase()) {
      const existing = await this.tagsRepository
        .createQueryBuilder("tag")
        .where("tag.userId = :userId", { userId })
        .andWhere("LOWER(tag.name) = LOWER(:name)", { name: dto.name })
        .andWhere("tag.id != :id", { id })
        .getOne();

      if (existing) {
        throw new ConflictException(`A tag named "${dto.name}" already exists`);
      }
    }

    Object.assign(tag, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.color !== undefined && { color: dto.color || null }),
      ...(dto.icon !== undefined && { icon: dto.icon || null }),
    });

    const saved = await this.tagsRepository.save(tag);
    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { name: saved.name, color: saved.color, icon: saved.icon },
      description: `Updated tag "${saved.name}"`,
    });
    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const tag = await this.findOne(userId, id);
    const beforeData = {
      id: tag.id,
      name: tag.name,
      color: tag.color,
      icon: tag.icon,
    };
    await this.tagsRepository.remove(tag);
    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: id,
      action: "delete",
      beforeData,
      description: `Deleted tag "${beforeData.name}"`,
    });
  }

  async getTransactionCount(userId: string, id: string): Promise<number> {
    await this.findOne(userId, id);
    return this.transactionTagsRepository.count({
      where: { tagId: id },
    });
  }

  async getAllTransactionCounts(
    userId: string,
  ): Promise<Record<string, number>> {
    const rows: Array<{ tag_id: string; count: string }> =
      await this.transactionTagsRepository
        .createQueryBuilder("tt")
        .select("tt.tag_id", "tag_id")
        .addSelect("COUNT(*)", "count")
        .innerJoin(Tag, "t", "t.id = tt.tag_id AND t.user_id = :userId", {
          userId,
        })
        .groupBy("tt.tag_id")
        .getRawMany();

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.tag_id] = Number(row.count);
    }
    return counts;
  }

  async setTransactionTags(
    transactionId: string,
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    const manager = queryRunner ? queryRunner.manager : this.dataSource.manager;

    // Validate all tags belong to this user
    if (tagIds.length > 0) {
      const tags = await manager.find(Tag, {
        where: { id: In(tagIds), userId },
      });
      if (tags.length !== tagIds.length) {
        throw new NotFoundException("One or more tags not found");
      }
    }

    // Delete existing and insert new
    await manager.delete(TransactionTag, { transactionId });

    if (tagIds.length > 0) {
      const newTags = tagIds.map((tagId) =>
        manager.create(TransactionTag, { transactionId, tagId }),
      );
      await manager.save(TransactionTag, newTags);
    }
  }

  async setSplitTags(
    transactionSplitId: string,
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    const manager = queryRunner ? queryRunner.manager : this.dataSource.manager;

    if (tagIds.length > 0) {
      const tags = await manager.find(Tag, {
        where: { id: In(tagIds), userId },
      });
      if (tags.length !== tagIds.length) {
        throw new NotFoundException("One or more tags not found");
      }
    }

    await manager.delete(TransactionSplitTag, { transactionSplitId });

    if (tagIds.length > 0) {
      const newTags = tagIds.map((tagId) =>
        manager.create(TransactionSplitTag, { transactionSplitId, tagId }),
      );
      await manager.save(TransactionSplitTag, newTags);
    }
  }
}
