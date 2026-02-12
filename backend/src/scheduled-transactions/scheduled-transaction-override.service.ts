import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "./dto/scheduled-transaction-override.dto";

@Injectable()
export class ScheduledTransactionOverrideService {
  private readonly logger = new Logger(ScheduledTransactionOverrideService.name);

  constructor(
    @InjectRepository(ScheduledTransactionOverride)
    private overridesRepository: Repository<ScheduledTransactionOverride>,
  ) {}

  async createOverride(
    scheduledTransactionId: string,
    createDto: CreateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    const existing = await this.overridesRepository
      .createQueryBuilder("override")
      .where("override.scheduledTransactionId = :scheduledTransactionId", {
        scheduledTransactionId,
      })
      .andWhere("override.originalDate = :date", {
        date: createDto.originalDate,
      })
      .getOne();

    if (existing) {
      throw new BadRequestException(
        `An override already exists for the ${createDto.originalDate} occurrence. Use update instead.`,
      );
    }

    if (createDto.isSplit && createDto.splits && createDto.splits.length > 0) {
      if (createDto.amount === undefined || createDto.amount === null) {
        throw new BadRequestException(
          "Amount is required when creating split override",
        );
      }
      this.validateOverrideSplits(createDto.splits, createDto.amount);
    }

    const override = this.overridesRepository.create({
      scheduledTransactionId,
      originalDate: createDto.originalDate,
      overrideDate: createDto.overrideDate,
      amount: createDto.amount ?? null,
      categoryId: createDto.categoryId ?? null,
      description: createDto.description ?? null,
      isSplit: createDto.isSplit ?? null,
      splits:
        createDto.splits?.map((s) => ({
          categoryId: s.categoryId ?? null,
          amount: s.amount,
          memo: s.memo ?? null,
        })) ?? null,
    });

    return this.overridesRepository.save(override);
  }

  async findOverrides(
    scheduledTransactionId: string,
  ): Promise<ScheduledTransactionOverride[]> {
    return this.overridesRepository.find({
      where: { scheduledTransactionId },
      relations: ["category"],
      order: { overrideDate: "ASC" },
    });
  }

  async findOverride(
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> {
    const override = await this.overridesRepository.findOne({
      where: { id: overrideId, scheduledTransactionId },
      relations: ["category"],
    });

    if (!override) {
      throw new NotFoundException(`Override with ID ${overrideId} not found`);
    }

    return override;
  }

  async findOverrideByDate(
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> {
    const normalizedDate = date.split("T")[0];

    this.logger.debug(
      `findOverrideByDate: Looking for override with scheduledTransactionId=${scheduledTransactionId}, date=${normalizedDate}`,
    );

    const allOverrides = await this.overridesRepository.find({
      where: { scheduledTransactionId },
      relations: ["category"],
    });

    this.logger.debug(
      `findOverrideByDate: Found ${allOverrides.length} total overrides for transaction`,
    );

    const override = allOverrides.find((o) => {
      const originalDate = String(o.originalDate).split("T")[0];
      this.logger.debug(
        `findOverrideByDate: Comparing originalDate ${originalDate} with ${normalizedDate}`,
      );
      return originalDate === normalizedDate;
    });

    this.logger.debug(
      `findOverrideByDate: Result = ${override ? `found id=${override.id}` : "null"}`,
    );

    return override || null;
  }

  async updateOverride(
    scheduledTransactionId: string,
    overrideId: string,
    updateDto: UpdateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    const override = await this.findOverride(
      scheduledTransactionId,
      overrideId,
    );

    if (updateDto.isSplit && updateDto.splits && updateDto.splits.length > 0) {
      const amount = updateDto.amount ?? override.amount;
      if (amount === null) {
        throw new BadRequestException("Amount is required for split override");
      }
      this.validateOverrideSplits(updateDto.splits, amount);
    }

    if (updateDto.amount !== undefined) override.amount = updateDto.amount;
    if (updateDto.categoryId !== undefined)
      override.categoryId = updateDto.categoryId ?? null;
    if (updateDto.description !== undefined)
      override.description = updateDto.description;
    if (updateDto.isSplit !== undefined) override.isSplit = updateDto.isSplit;
    if (updateDto.splits !== undefined) {
      override.splits =
        updateDto.splits?.map((s) => ({
          categoryId: s.categoryId ?? null,
          amount: s.amount,
          memo: s.memo ?? null,
        })) ?? null;
    }

    return this.overridesRepository.save(override);
  }

  async removeOverride(
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<void> {
    const override = await this.findOverride(
      scheduledTransactionId,
      overrideId,
    );
    await this.overridesRepository.remove(override);
  }

  async removeAllOverrides(
    scheduledTransactionId: string,
  ): Promise<number> {
    const result = await this.overridesRepository.delete({
      scheduledTransactionId,
    });
    return result.affected || 0;
  }

  async hasOverrides(
    scheduledTransactionId: string,
  ): Promise<{ hasOverrides: boolean; count: number }> {
    const count = await this.overridesRepository.count({
      where: { scheduledTransactionId },
    });

    return { hasOverrides: count > 0, count };
  }

  private validateOverrideSplits(
    splits: {
      categoryId?: string | null;
      amount: number;
      memo?: string | null;
    }[],
    transactionAmount: number,
  ): void {
    if (splits.length < 2) {
      throw new BadRequestException(
        "Split overrides must have at least 2 splits",
      );
    }

    const splitsSum = splits.reduce(
      (sum, split) => sum + Number(split.amount),
      0,
    );
    const roundedSum = Math.round(splitsSum * 10000) / 10000;
    const roundedAmount =
      Math.round(Number(transactionAmount) * 10000) / 10000;

    if (roundedSum !== roundedAmount) {
      throw new BadRequestException(
        `Split amounts (${roundedSum}) must equal transaction amount (${roundedAmount})`,
      );
    }

    for (const split of splits) {
      if (split.amount === 0) {
        throw new BadRequestException("Split amounts cannot be zero");
      }
    }
  }
}
