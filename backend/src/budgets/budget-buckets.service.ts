import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import { Budget } from "./entities/budget.entity";
import { BudgetBucket } from "./entities/budget-bucket.entity";
import {
  MAX_BUCKETS_PER_BUDGET,
  checkBucketTarget,
  checkedBucketCarryCap,
  checkedBucketName,
} from "./budget-bucket-rules.util";
import { CreateBudgetBucketDto } from "./dto/create-budget-bucket.dto";
import { UpdateBudgetBucketDto } from "./dto/update-budget-bucket.dto";

const byOrder = (a: BudgetBucket, b: BudgetBucket): number =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/**
 * CRUD for the buckets of a budget the caller owns (design section 6.4). Every
 * refusal is decided inside the write's own `withScopedDb` transaction, before
 * the write. The budget row is locked `FOR UPDATE` on create and update so two
 * concurrent writers cannot both pass the 12-bucket or the case-insensitive
 * name check. Bucket writes are not in the undo history (decision 13).
 */
@Injectable()
export class BudgetBucketsService {
  constructor(private dataSource: DataSource) {}

  async findAll(userId: string, budgetId: string): Promise<BudgetBucket[]> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.requireBudget(m, userId, budgetId, false);
      return this.listOf(m, budgetId);
    });
  }

  async create(
    userId: string,
    budgetId: string,
    dto: CreateBudgetBucketDto,
  ): Promise<BudgetBucket> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.requireBudget(m, userId, budgetId, true);
      const existing = await this.listOf(m, budgetId);

      if (existing.length >= MAX_BUCKETS_PER_BUDGET) {
        throw new BadRequestException(
          tr(
            "errors.budgets.bucketLimit",
            `A budget can have at most ${MAX_BUCKETS_PER_BUDGET} buckets`,
            { max: MAX_BUCKETS_PER_BUDGET },
          ),
        );
      }

      const name = checkedBucketName(dto.name, existing, null);
      const carryOver = dto.carryOver ?? false;
      checkBucketTarget(dto.targetType, dto.targetValue);
      const carryCap = checkedBucketCarryCap(carryOver, dto.carryCap ?? null);

      const repo = m.getRepository(BudgetBucket);
      return repo.save(
        repo.create({
          budgetId,
          name,
          targetType: dto.targetType,
          targetValue: dto.targetValue,
          carryOver,
          carryCap,
          sortOrder:
            dto.sortOrder ??
            existing.reduce((max, b) => Math.max(max, b.sortOrder), -1) + 1,
        }),
      );
    });
  }

  /**
   * A partial update, validated as the row it would become. Turning
   * `carryOver` off clears an existing `carryCap` (a cap on a bucket that does
   * not carry is meaningless); sending a non-null `carryCap` while the bucket
   * would not carry is refused.
   */
  async update(
    userId: string,
    budgetId: string,
    bucketId: string,
    dto: UpdateBudgetBucketDto,
  ): Promise<BudgetBucket> {
    return withScopedDb(this.dataSource, async (m) => {
      await this.requireBudget(m, userId, budgetId, true);
      const all = await this.listOf(m, budgetId);
      const bucket = all.find((b) => b.id === bucketId);
      if (!bucket) throw this.bucketNotFound(bucketId);

      if (dto.name !== undefined) {
        bucket.name = checkedBucketName(dto.name, all, bucket.id);
      }
      if (dto.targetType !== undefined) bucket.targetType = dto.targetType;
      if (dto.targetValue !== undefined) bucket.targetValue = dto.targetValue;
      if (dto.targetType !== undefined || dto.targetValue !== undefined) {
        checkBucketTarget(bucket.targetType, bucket.targetValue);
      }

      if (dto.carryOver !== undefined) bucket.carryOver = dto.carryOver;
      if (dto.carryCap !== undefined) {
        bucket.carryCap = checkedBucketCarryCap(bucket.carryOver, dto.carryCap);
      } else if (!bucket.carryOver) {
        bucket.carryCap = null;
      }
      if (dto.sortOrder !== undefined) bucket.sortOrder = dto.sortOrder;

      return m.getRepository(BudgetBucket).save(bucket);
    });
  }

  /** Lines in the bucket become unassigned (`ON DELETE SET NULL`, decision 11). */
  async remove(
    userId: string,
    budgetId: string,
    bucketId: string,
  ): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      await this.requireBudget(m, userId, budgetId, false);
      const repo = m.getRepository(BudgetBucket);
      const bucket = await repo.findOne({ where: { id: bucketId, budgetId } });
      if (!bucket) throw this.bucketNotFound(bucketId);
      await repo.remove(bucket);
    });
  }

  private async requireBudget(
    m: EntityManager,
    userId: string,
    budgetId: string,
    lock: boolean,
  ): Promise<Budget> {
    const budget = await m.getRepository(Budget).findOne({
      where: { id: budgetId, userId },
      ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
    });
    if (!budget) {
      throw new NotFoundException(
        tr("errors.budgets.notFound", `Budget with ID ${budgetId} not found`, {
          id: budgetId,
        }),
      );
    }
    return budget;
  }

  private async listOf(
    m: EntityManager,
    budgetId: string,
  ): Promise<BudgetBucket[]> {
    const rows = await m
      .getRepository(BudgetBucket)
      .find({ where: { budgetId }, order: { sortOrder: "ASC", name: "ASC" } });
    return [...rows].sort(byOrder);
  }

  private bucketNotFound(id: string): NotFoundException {
    return new NotFoundException(
      tr("errors.budgets.bucketNotFound", `Bucket with ID ${id} not found`, {
        id,
      }),
    );
  }
}
