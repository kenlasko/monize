import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { decimalPlacesOf } from "../common/amount-precision.util";
import { tr } from "../i18n/translate";
import { Budget } from "./entities/budget.entity";
import {
  BudgetBucket,
  BudgetBucketTargetType,
} from "./entities/budget-bucket.entity";
import { CreateBudgetBucketDto } from "./dto/create-budget-bucket.dto";
import { UpdateBudgetBucketDto } from "./dto/update-budget-bucket.dto";

/** Decision 10 of docs/future-plans/bucket-budget.md. */
export const MAX_BUCKETS_PER_BUDGET = 12;
const MAX_NAME_LENGTH = 50;
const MAX_PERCENT = 100;
const PERCENT_PLACES = 2;

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

      const name = this.checkedName(dto.name, existing, null);
      const carryOver = dto.carryOver ?? false;
      this.checkTarget(dto.targetType, dto.targetValue);
      const carryCap = this.checkedCarryCap(carryOver, dto.carryCap ?? null);

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
        bucket.name = this.checkedName(dto.name, all, bucket.id);
      }
      if (dto.targetType !== undefined) bucket.targetType = dto.targetType;
      if (dto.targetValue !== undefined) bucket.targetValue = dto.targetValue;
      if (dto.targetType !== undefined || dto.targetValue !== undefined) {
        this.checkTarget(bucket.targetType, bucket.targetValue);
      }

      if (dto.carryOver !== undefined) bucket.carryOver = dto.carryOver;
      if (dto.carryCap !== undefined) {
        bucket.carryCap = this.checkedCarryCap(bucket.carryOver, dto.carryCap);
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

  private checkedName(
    raw: string,
    siblings: BudgetBucket[],
    selfId: string | null,
  ): string {
    const name = raw.trim();
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      throw new BadRequestException(
        tr(
          "errors.budgets.bucketNameInvalid",
          `A bucket name must be 1 to ${MAX_NAME_LENGTH} characters`,
          { max: MAX_NAME_LENGTH },
        ),
      );
    }
    const key = name.toLowerCase();
    if (
      siblings.some(
        (b) => b.id !== selfId && b.name.trim().toLowerCase() === key,
      )
    ) {
      throw new BadRequestException(
        tr(
          "errors.budgets.bucketNameDuplicate",
          "This budget already has a bucket with that name",
        ),
      );
    }
    return name;
  }

  private checkTarget(type: BudgetBucketTargetType, value: number): void {
    if (!(value > 0)) {
      throw new BadRequestException(
        tr(
          "errors.budgets.bucketTargetInvalid",
          "A bucket target must be greater than zero",
        ),
      );
    }
    if (
      type === BudgetBucketTargetType.PERCENT &&
      (value > MAX_PERCENT || decimalPlacesOf(value) > PERCENT_PLACES)
    ) {
      throw new BadRequestException(
        tr(
          "errors.budgets.bucketPercentInvalid",
          "A percent target must be greater than 0 and at most 100, with at most two decimals",
        ),
      );
    }
  }

  private checkedCarryCap(
    carryOver: boolean,
    carryCap: number | null,
  ): number | null {
    if (carryCap === null) return null;
    if (!carryOver) {
      throw new BadRequestException(
        tr(
          "errors.budgets.bucketCarryCapNeedsCarryOver",
          "A carry cap needs carry-over turned on",
        ),
      );
    }
    return carryCap;
  }
}
