import { guardAccruedTagDeletion } from "../accruals/accrual-tag-guard";
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager, QueryRunner, In } from "typeorm";
import { Tag } from "./entities/tag.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import { CreateTagDto } from "./dto/create-tag.dto";
import { UpdateTagDto } from "./dto/update-tag.dto";
import { ActionHistoryService } from "../action-history/action-history.service";
import { withScopedDb } from "../common/db/scoped-db";
import { LEDGER_EXCLUDES_VOID } from "../common/ledger-balance.sql";
import { todayYMD } from "../common/date-utils";

/** Upper bounds for one additive/removal call (design 6.2). */
export const MAX_TAGS_PER_CALL = 100;
export const MAX_TRANSACTIONS_PER_CALL = 1000;

/**
 * Rows per INSERT in addTransactionTags. A link binds two parameters and one
 * PostgreSQL statement takes at most 65535, so the 1000 x 100 upper bound
 * (200000 parameters) is written in batches, all on the caller's transaction.
 */
export const TAG_LINK_INSERT_BATCH = 5000;

/** One tag's use on non-void transactions: latest date (YYYY-MM-DD) and number of uses. */
export interface TagUsage {
  lastUsed: string;
  count: number;
}

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async findAll(userId: string): Promise<Tag[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(Tag).find({
        where: { userId },
        order: { name: "ASC" },
      }),
    );
  }

  async findOne(userId: string, id: string): Promise<Tag> {
    const tag = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Tag).findOne({
        where: { id, userId },
      }),
    );
    if (!tag) {
      throw new NotFoundException(
        tr("errors.tags.notFound", `Tag with ID ${id} not found`, { id }),
      );
    }
    return tag;
  }

  private async findConflictingName(
    m: EntityManager,
    userId: string,
    name: string,
    excludeId?: string,
  ): Promise<Tag | null> {
    const qb = m
      .getRepository(Tag)
      .createQueryBuilder("tag")
      .where("tag.userId = :userId", { userId })
      .andWhere("LOWER(tag.name) = LOWER(:name)", { name });
    if (excludeId) {
      qb.andWhere("tag.id != :id", { id: excludeId });
    }
    return qb.getOne();
  }

  async create(userId: string, dto: CreateTagDto): Promise<Tag> {
    const saved = await withScopedDb(this.dataSource, async (m) => {
      const existing = await this.findConflictingName(m, userId, dto.name);
      if (existing) {
        throw new ConflictException(
          tr(
            "errors.tags.nameConflict",
            `A tag named "${dto.name}" already exists`,
            { name: dto.name },
          ),
        );
      }

      const repo = m.getRepository(Tag);
      const tag = repo.create({
        ...dto,
        color: dto.color || null,
        icon: dto.icon || null,
        userId,
      });
      return repo.save(tag);
    });

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
      descriptionKey: "createdTag",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  async update(userId: string, id: string, dto: UpdateTagDto): Promise<Tag> {
    const tag = await this.findOne(userId, id);
    const beforeData = { name: tag.name, color: tag.color, icon: tag.icon };

    const saved = await withScopedDb(this.dataSource, async (m) => {
      if (dto.name && dto.name.toLowerCase() !== tag.name.toLowerCase()) {
        const existing = await this.findConflictingName(
          m,
          userId,
          dto.name,
          id,
        );
        if (existing) {
          throw new ConflictException(
            tr(
              "errors.tags.nameConflict",
              `A tag named "${dto.name}" already exists`,
              { name: dto.name },
            ),
          );
        }
      }

      Object.assign(tag, {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.color !== undefined && { color: dto.color || null }),
        ...(dto.icon !== undefined && { icon: dto.icon || null }),
      });

      return m.getRepository(Tag).save(tag);
    });

    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { name: saved.name, color: saved.color, icon: saved.icon },
      description: `Updated tag "${saved.name}"`,
      descriptionKey: "updatedTag",
      descriptionParams: { name: saved.name },
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
    await withScopedDb(this.dataSource, async (m) => {
      await guardAccruedTagDeletion(m, userId, id);
      await m.getRepository(Tag).remove(tag);
    });
    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: id,
      action: "delete",
      beforeData,
      description: `Deleted tag "${beforeData.name}"`,
      descriptionKey: "deletedTag",
      descriptionParams: { name: beforeData.name },
    });
  }

  async getTransactionCount(userId: string, id: string): Promise<number> {
    await this.findOne(userId, id);
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionTag).count({
        where: { tagId: id },
      }),
    );
  }

  async getAllTransactionCounts(
    userId: string,
  ): Promise<Record<string, number>> {
    const rows: Array<{ tag_id: string; count: string }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m
          .getRepository(TransactionTag)
          .createQueryBuilder("tt")
          .select("tt.tag_id", "tag_id")
          .addSelect("COUNT(*)", "count")
          .innerJoin(Tag, "t", "t.id = tt.tag_id AND t.user_id = :userId", {
            userId,
          })
          .groupBy("tt.tag_id")
          .getRawMany(),
    );

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.tag_id] = Number(row.count);
    }
    return counts;
  }

  /**
   * How each of the user's tags has been used, for ordering the pickers that
   * apply tags to a transaction: the latest date of a non-void transaction
   * carrying it (on the transaction or on one of its splits) and how many
   * times it was applied. A tag never used, or used only on void rows, is
   * absent.
   *
   * - A row dated after today does not count until its date arrives, so a
   *   mistyped year cannot hold a tag at the top of the picker.
   * - One use is one movement: tagging a transfer writes a link on both legs,
   *   and a split transfer tags the split and its counterpart, so the legs
   *   collapse to one `use_id` (the smaller leg id, or the split's id).
   * - `accountScope` is an acting delegate's READ-granted accounts
   *   (`delegateReadableAccountScope`); `undefined` means every account, and
   *   an empty scope reports nothing.
   */
  async getUsage(
    userId: string,
    accountScope?: readonly string[],
  ): Promise<Record<string, TagUsage>> {
    if (accountScope !== undefined && accountScope.length === 0) return {};
    const params: unknown[] = [userId, todayYMD()];
    let scopeClause = "";
    if (accountScope !== undefined) {
      params.push([...accountScope]);
      scopeClause = "AND t.account_id = ANY($3::uuid[])";
    }
    // The owner filter sits inside each branch so the scan starts from the
    // user's tags (idx_transaction_tags_tag / idx_transaction_split_tags_tag)
    // rather than from every user's links.
    const rowFilter = `${LEDGER_EXCLUDES_VOID}
                  AND t.transaction_date <= $2::date
                  ${scopeClause}`;
    const rows: Array<{ tag_id: string; last_used: string; count: string }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT u.tag_id,
                  TO_CHAR(MAX(u.transaction_date), 'YYYY-MM-DD') AS last_used,
                  COUNT(DISTINCT u.use_id) AS count
             FROM (
               SELECT tt.tag_id, t.transaction_date,
                      COALESCE(
                        cs.id,
                        LEAST(t.id, COALESCE(t.linked_transaction_id, t.id))
                      ) AS use_id
                 FROM transaction_tags tt
                 JOIN tags g ON g.id = tt.tag_id AND g.user_id = $1
                 JOIN transactions t ON t.id = tt.transaction_id
                 LEFT JOIN transaction_splits cs
                        ON cs.linked_transaction_id = t.id
                WHERE ${rowFilter}
               UNION ALL
               SELECT st.tag_id, t.transaction_date, s.id AS use_id
                 FROM transaction_split_tags st
                 JOIN tags g ON g.id = st.tag_id AND g.user_id = $1
                 JOIN transaction_splits s ON s.id = st.transaction_split_id
                 JOIN transactions t ON t.id = s.transaction_id
                WHERE ${rowFilter}
             ) u
            GROUP BY u.tag_id`,
          params,
        ),
      );

    const usage: Record<string, TagUsage> = {};
    for (const row of rows) {
      usage[row.tag_id] = { lastUsed: row.last_used, count: Number(row.count) };
    }
    return usage;
  }

  /**
   * Run `fn` against the caller's QueryRunner transaction when one is passed
   * (the transactions module's flows still manage their own QueryRunner until
   * task R2), otherwise inside a `withScopedDb` of our own.
   */
  private withTagManager<T>(
    queryRunner: QueryRunner | undefined,
    fn: (m: EntityManager) => Promise<T>,
  ): Promise<T> {
    return queryRunner
      ? fn(queryRunner.manager)
      : withScopedDb(this.dataSource, fn);
  }

  async setTransactionTags(
    transactionId: string,
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    return this.withTagManager(queryRunner, async (manager) => {
      // Validate all tags belong to this user
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
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
    });
  }

  /**
   * Set the same tag set on many transactions at once. Validates the tag set a
   * single time, then replaces tags with one bulk DELETE and one multi-row
   * INSERT instead of running validate + delete + insert per transaction (which
   * is ~3N queries for N transactions in a bulk update).
   */
  async setTransactionTagsBulk(
    transactionIds: string[],
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    if (transactionIds.length === 0) {
      return;
    }
    return this.withTagManager(queryRunner, async (manager) => {
      // Validate the tag set once for all transactions
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      // Replace existing tags for every target transaction in one statement
      await manager.delete(TransactionTag, {
        transactionId: In(transactionIds),
      });

      if (tagIds.length > 0) {
        const newTags = transactionIds.flatMap((transactionId) =>
          tagIds.map((tagId) =>
            manager.create(TransactionTag, { transactionId, tagId }),
          ),
        );
        await manager.save(TransactionTag, newTags);
      }
    });
  }

  /**
   * Validate and dedupe the inputs of addTransactionTags /
   * removeTransactionTags: bounds first (no query), then tag ownership and
   * transaction ownership on the caller's manager, before any write. Returns
   * null when there is nothing to do.
   */
  private async prepareTransactionTagChange(
    m: EntityManager,
    userId: string,
    transactionIds: readonly string[],
    tagIds: readonly string[],
  ): Promise<{ txIds: string[]; tIds: string[] } | null> {
    const txIds = [...new Set(transactionIds)];
    const tIds = [...new Set(tagIds)];
    if (txIds.length === 0 || tIds.length === 0) {
      return null;
    }
    if (tIds.length > MAX_TAGS_PER_CALL) {
      throw new BadRequestException(
        tr(
          "errors.tags.tooManyTags",
          `At most ${MAX_TAGS_PER_CALL} tags can be changed in one call`,
          { max: MAX_TAGS_PER_CALL },
        ),
      );
    }
    if (txIds.length > MAX_TRANSACTIONS_PER_CALL) {
      throw new BadRequestException(
        tr(
          "errors.tags.tooManyTransactions",
          `At most ${MAX_TRANSACTIONS_PER_CALL} transactions can be changed in one call`,
          { max: MAX_TRANSACTIONS_PER_CALL },
        ),
      );
    }

    // Same ownership check as setTransactionTags / setTransactionTagsBulk.
    const tags = await m.find(Tag, { where: { id: In(tIds), userId } });
    if (tags.length !== tIds.length) {
      throw new NotFoundException(
        tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
      );
    }

    // The existing methods rely on RLS alone for the transaction side; the
    // additive path checks it explicitly so a foreign id is refused, not
    // silently skipped or written.
    const ownedTransactions = await m.count(Transaction, {
      where: { id: In(txIds), userId },
    });
    if (ownedTransactions !== txIds.length) {
      throw new NotFoundException(
        tr(
          "errors.tags.oneOrMoreTransactionsNotFound",
          "One or more transactions not found",
        ),
      );
    }
    return { txIds, tIds };
  }

  /**
   * Add tags to many transactions without touching the tags they already
   * carry. Runs on the caller's EntityManager (its withScopedDb transaction).
   * Idempotent: (transaction_id, tag_id) is the primary key and the insert is
   * ON CONFLICT DO NOTHING, so a repeat leaves one link.
   */
  async addTransactionTags(
    m: EntityManager,
    userId: string,
    transactionIds: readonly string[],
    tagIds: readonly string[],
  ): Promise<void> {
    const plan = await this.prepareTransactionTagChange(
      m,
      userId,
      transactionIds,
      tagIds,
    );
    if (!plan) {
      return;
    }
    const rows = plan.txIds.flatMap((transactionId) =>
      plan.tIds.map((tagId) => ({ transactionId, tagId })),
    );
    for (let i = 0; i < rows.length; i += TAG_LINK_INSERT_BATCH) {
      await m
        .createQueryBuilder()
        .insert()
        .into(TransactionTag)
        .values(rows.slice(i, i + TAG_LINK_INSERT_BATCH))
        .orIgnore()
        .execute();
    }
  }

  /**
   * The user's tags whose names equal `names` case-insensitively, on the
   * caller's manager (read only). A name the user has no tag for is absent from
   * the result. Used to preview which tag names a proposal would create.
   */
  async findByNames(
    m: EntityManager,
    userId: string,
    names: readonly string[],
  ): Promise<Tag[]> {
    const lowered = [...new Set(names.map((n) => n.trim().toLowerCase()))];
    if (lowered.length === 0) return [];
    return m
      .getRepository(Tag)
      .createQueryBuilder("tag")
      .where("tag.userId = :userId", { userId })
      .andWhere("LOWER(tag.name) IN (:...lowered)", { lowered })
      .getMany();
  }

  /**
   * Find the user's tag for each name (case-insensitively) or create it, on the
   * caller's manager, and return them in the order of `names`, each once. The
   * insert is guarded by `WHERE NOT EXISTS` and by `ON CONFLICT DO NOTHING` against
   * the unique index `idx_tags_user_name`, so two writers racing for one name leave
   * one tag and neither fails; the select that follows reads what is there. The tag is
   * written in the caller's transaction, so a rollback drops a tag it created.
   * Blank names are skipped; at most `MAX_TAGS_PER_CALL` are taken.
   */
  async findOrCreateByNames(
    m: EntityManager,
    userId: string,
    names: readonly string[],
  ): Promise<Tag[]> {
    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const name = raw.trim();
      const key = name.toLowerCase();
      if (name === "" || seen.has(key)) continue;
      seen.add(key);
      wanted.push(name);
      if (wanted.length >= MAX_TAGS_PER_CALL) break;
    }
    for (const name of wanted) {
      // The WHERE NOT EXISTS makes the common case a no-op; the unique index
      // `idx_tags_user_name` (user_id, LOWER(name)) is the backstop for two
      // writers racing for one name, and a target-less ON CONFLICT DO NOTHING
      // turns that loss into "the other one's tag", which the select below reads.
      await m.query(
        `INSERT INTO tags (user_id, name)
         SELECT $1::uuid, $2::varchar
          WHERE NOT EXISTS (
                  SELECT 1 FROM tags
                   WHERE user_id = $1::uuid AND LOWER(name) = LOWER($2::varchar))
         ON CONFLICT DO NOTHING`,
        [userId, name],
      );
    }
    const found = await this.findByNames(m, userId, wanted);
    const byKey = new Map(found.map((tag) => [tag.name.toLowerCase(), tag]));
    return wanted.flatMap((name) => {
      const tag = byKey.get(name.toLowerCase());
      return tag ? [tag] : [];
    });
  }

  /** Remove exactly the named (transaction, tag) links; other tags stay. */
  async removeTransactionTags(
    m: EntityManager,
    userId: string,
    transactionIds: readonly string[],
    tagIds: readonly string[],
  ): Promise<void> {
    const plan = await this.prepareTransactionTagChange(
      m,
      userId,
      transactionIds,
      tagIds,
    );
    if (!plan) {
      return;
    }
    await m.delete(TransactionTag, {
      transactionId: In(plan.txIds),
      tagId: In(plan.tIds),
    });
  }

  /**
   * Set the same tag set on many transaction splits at once. Bulk counterpart
   * of setSplitTags, mirroring setTransactionTagsBulk: one validation pass,
   * one bulk DELETE, one multi-row INSERT.
   */
  async setSplitTagsBulk(
    transactionSplitIds: string[],
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    if (transactionSplitIds.length === 0) {
      return;
    }
    return this.withTagManager(queryRunner, async (manager) => {
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      await manager.delete(TransactionSplitTag, {
        transactionSplitId: In(transactionSplitIds),
      });

      if (tagIds.length > 0) {
        const newTags = transactionSplitIds.flatMap((transactionSplitId) =>
          tagIds.map((tagId) =>
            manager.create(TransactionSplitTag, { transactionSplitId, tagId }),
          ),
        );
        await manager.save(TransactionSplitTag, newTags);
      }
    });
  }

  async setSplitTags(
    transactionSplitId: string,
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    return this.withTagManager(queryRunner, async (manager) => {
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      await manager.delete(TransactionSplitTag, { transactionSplitId });

      if (tagIds.length > 0) {
        const newTags = tagIds.map((tagId) =>
          manager.create(TransactionSplitTag, { transactionSplitId, tagId }),
        );
        await manager.save(TransactionSplitTag, newTags);
      }
    });
  }
}
