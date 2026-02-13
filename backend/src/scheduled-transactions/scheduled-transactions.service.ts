import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThanOrEqual } from "typeorm";
import { Cron } from "@nestjs/schedule";
import {
  ScheduledTransaction,
  FrequencyType,
} from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { CreateScheduledTransactionDto } from "./dto/create-scheduled-transaction.dto";
import { UpdateScheduledTransactionDto } from "./dto/update-scheduled-transaction.dto";
import { CreateScheduledTransactionSplitDto } from "./dto/create-scheduled-transaction-split.dto";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "./dto/scheduled-transaction-override.dto";
import { PostScheduledTransactionDto } from "./dto/post-scheduled-transaction.dto";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";

@Injectable()
export class ScheduledTransactionsService {
  private readonly logger = new Logger(ScheduledTransactionsService.name);

  constructor(
    @InjectRepository(ScheduledTransaction)
    private scheduledTransactionsRepository: Repository<ScheduledTransaction>,
    @InjectRepository(ScheduledTransactionSplit)
    private splitsRepository: Repository<ScheduledTransactionSplit>,
    @InjectRepository(ScheduledTransactionOverride)
    private overridesRepository: Repository<ScheduledTransactionOverride>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    private transactionsService: TransactionsService,
    private overrideService: ScheduledTransactionOverrideService,
    private loanService: ScheduledTransactionLoanService,
  ) {}

  @Cron("5 * * * *")
  async processAutoPostTransactions(): Promise<void> {
    this.logger.log("Starting auto-post processing for scheduled transactions");

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const dueTransactions = await this.scheduledTransactionsRepository.find({
        where: {
          isActive: true,
          autoPost: true,
          nextDueDate: LessThanOrEqual(today),
        },
        relations: [
          "account",
          "payee",
          "category",
          "transferAccount",
          "splits",
          "splits.category",
          "splits.transferAccount",
        ],
        order: { nextDueDate: "ASC" },
      });

      if (dueTransactions.length === 0) {
        this.logger.log("No auto-post transactions due");
        return;
      }

      this.logger.log(
        `Found ${dueTransactions.length} auto-post transaction(s) to process`,
      );

      let successCount = 0;
      let errorCount = 0;

      for (const scheduled of dueTransactions) {
        try {
          await this.post(scheduled.userId, scheduled.id);
          successCount++;
          this.logger.log(
            `Auto-posted: "${scheduled.name}" (ID: ${scheduled.id})`,
          );
        } catch (error) {
          errorCount++;
          this.logger.error(
            `Failed to auto-post "${scheduled.name}" (ID: ${scheduled.id}): ${error.message}`,
            error.stack,
          );
        }
      }

      this.logger.log(
        `Auto-post processing complete: ${successCount} succeeded, ${errorCount} failed`,
      );
    } catch (error) {
      this.logger.error("Auto-post processing failed", error.stack);
    }
  }

  async create(
    userId: string,
    createDto: CreateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    await this.accountsService.findOne(userId, createDto.accountId);

    if (createDto.isTransfer && createDto.transferAccountId) {
      await this.accountsService.findOne(userId, createDto.transferAccountId);
      if (createDto.transferAccountId === createDto.accountId) {
        throw new BadRequestException(
          "Source and destination accounts must be different",
        );
      }
    }

    const { splits, isTransfer, transferAccountId, ...transactionData } =
      createDto;
    const hasSplits = splits && splits.length > 0;

    if (hasSplits && !isTransfer) {
      this.validateSplits(splits, createDto.amount);
    }

    const scheduledTransaction = this.scheduledTransactionsRepository.create({
      ...transactionData,
      userId,
      startDate: transactionData.startDate || transactionData.nextDueDate,
      totalOccurrences: transactionData.occurrencesRemaining,
      categoryId: hasSplits || isTransfer ? null : transactionData.categoryId,
      isSplit: hasSplits && !isTransfer,
      isTransfer: isTransfer || false,
      transferAccountId: isTransfer ? transferAccountId : null,
    });

    const saved =
      await this.scheduledTransactionsRepository.save(scheduledTransaction);

    if (hasSplits && !isTransfer) {
      await this.createSplits(saved.id, splits);
    }

    return this.findOne(userId, saved.id);
  }

  private validateSplits(
    splits: CreateScheduledTransactionSplitDto[],
    transactionAmount: number,
  ): void {
    const isTransfer = splits.length === 1 && splits[0].transferAccountId;

    if (splits.length < 2 && !isTransfer) {
      throw new BadRequestException(
        "Split transactions must have at least 2 splits",
      );
    }

    const splitsSum = splits.reduce(
      (sum, split) => sum + Number(split.amount),
      0,
    );
    const roundedSum = Math.round(splitsSum * 10000) / 10000;
    const roundedAmount = Math.round(Number(transactionAmount) * 10000) / 10000;

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

  private async createSplits(
    scheduledTransactionId: string,
    splits: CreateScheduledTransactionSplitDto[],
  ): Promise<ScheduledTransactionSplit[]> {
    const splitEntities = splits.map((split) =>
      this.splitsRepository.create({
        scheduledTransactionId,
        categoryId: split.categoryId || null,
        transferAccountId: split.transferAccountId || null,
        amount: split.amount,
        memo: split.memo || null,
      }),
    );

    return this.splitsRepository.save(splitEntities);
  }

  async findAll(userId: string): Promise<
    (ScheduledTransaction & {
      overrideCount?: number;
      nextOverride?: ScheduledTransactionOverride | null;
    })[]
  > {
    const transactions = await this.scheduledTransactionsRepository
      .createQueryBuilder("st")
      .leftJoinAndSelect("st.account", "account")
      .leftJoinAndSelect("st.payee", "payee")
      .leftJoinAndSelect("st.category", "category")
      .leftJoinAndSelect("st.transferAccount", "transferAccount")
      .leftJoinAndSelect("st.splits", "splits")
      .leftJoinAndSelect("splits.category", "splitCategory")
      .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
      .where("st.userId = :userId", { userId })
      .orderBy("st.nextDueDate", "ASC")
      .getMany();

    if (transactions.length === 0) {
      return [];
    }

    const txDueDates = new Map<string, string>();
    const txIds = transactions.map((t) => {
      const d =
        t.nextDueDate instanceof Date
          ? t.nextDueDate.toISOString().split("T")[0]
          : String(t.nextDueDate).split("T")[0];
      txDueDates.set(t.id, d);
      return t.id;
    });

    const nextOverridesQuery = this.overridesRepository
      .createQueryBuilder("override")
      .leftJoinAndSelect("override.category", "category");

    const orConditions: string[] = [];
    const params: Record<string, string> = {};
    txIds.forEach((id, i) => {
      orConditions.push(
        `(override.scheduledTransactionId = :id${i} AND override.originalDate = :date${i})`,
      );
      params[`id${i}`] = id;
      params[`date${i}`] = txDueDates.get(id)!;
    });
    nextOverridesQuery.where(orConditions.join(" OR "), params);

    const allNextOverrides = await nextOverridesQuery.getMany();
    const nextOverrideMap = new Map<string, ScheduledTransactionOverride>();
    for (const o of allNextOverrides) {
      nextOverrideMap.set(o.scheduledTransactionId, o);
    }

    const futureOverrideCounts = await this.overridesRepository.query(
      `SELECT o.scheduled_transaction_id as "stId", COUNT(*) as cnt
         FROM scheduled_transaction_overrides o
         WHERE o.scheduled_transaction_id = ANY($1)
           AND EXISTS (
             SELECT 1 FROM (VALUES ${txIds.map((_, i) => `($${i * 2 + 2}::uuid, $${i * 2 + 3}::date)`).join(", ")}) AS v(id, due_date)
             WHERE v.id = o.scheduled_transaction_id AND o.original_date >= v.due_date
           )
         GROUP BY o.scheduled_transaction_id`,
      [txIds, ...txIds.flatMap((id) => [id, txDueDates.get(id)!])],
    );

    const countMap = new Map<string, number>();
    for (const row of futureOverrideCounts) {
      countMap.set(row.stId, parseInt(row.cnt, 10));
    }

    return transactions.map((transaction) => ({
      ...transaction,
      overrideCount: countMap.get(transaction.id) || 0,
      nextOverride: nextOverrideMap.get(transaction.id) || null,
    }));
  }

  async findOne(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await this.scheduledTransactionsRepository.findOne({
      where: { id },
      relations: [
        "account",
        "payee",
        "category",
        "transferAccount",
        "splits",
        "splits.category",
        "splits.transferAccount",
      ],
    });

    if (!scheduled) {
      throw new NotFoundException(
        `Scheduled transaction with ID ${id} not found`,
      );
    }

    if (scheduled.userId !== userId) {
      throw new ForbiddenException(
        "You do not have access to this scheduled transaction",
      );
    }

    return scheduled;
  }

  async findDue(userId: string): Promise<ScheduledTransaction[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.scheduledTransactionsRepository.find({
      where: {
        userId,
        isActive: true,
        nextDueDate: LessThanOrEqual(today),
      },
      relations: [
        "account",
        "payee",
        "category",
        "transferAccount",
        "splits",
        "splits.category",
        "splits.transferAccount",
      ],
      order: { nextDueDate: "ASC" },
    });
  }

  async findUpcoming(
    userId: string,
    days: number = 30,
  ): Promise<ScheduledTransaction[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);

    return this.scheduledTransactionsRepository
      .createQueryBuilder("st")
      .leftJoinAndSelect("st.account", "account")
      .leftJoinAndSelect("st.payee", "payee")
      .leftJoinAndSelect("st.category", "category")
      .leftJoinAndSelect("st.transferAccount", "transferAccount")
      .leftJoinAndSelect("st.splits", "splits")
      .leftJoinAndSelect("splits.category", "splitCategory")
      .leftJoinAndSelect("splits.transferAccount", "splitTransferAccount")
      .where("st.userId = :userId", { userId })
      .andWhere("st.isActive = :isActive", { isActive: true })
      .andWhere("st.nextDueDate <= :futureDate", { futureDate })
      .orderBy("st.nextDueDate", "ASC")
      .getMany();
  }

  async update(
    userId: string,
    id: string,
    updateDto: UpdateScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    if (updateDto.accountId && updateDto.accountId !== scheduled.accountId) {
      await this.accountsService.findOne(userId, updateDto.accountId);
    }

    if (updateDto.isTransfer && updateDto.transferAccountId) {
      await this.accountsService.findOne(userId, updateDto.transferAccountId);
      const accountId = updateDto.accountId || scheduled.accountId;
      if (updateDto.transferAccountId === accountId) {
        throw new BadRequestException(
          "Source and destination accounts must be different",
        );
      }
    }

    const { splits, isTransfer, transferAccountId, ...updateData } = updateDto;

    if (splits !== undefined) {
      if (Array.isArray(splits) && splits.length > 0) {
        const amount = updateData.amount ?? scheduled.amount;
        this.validateSplits(splits, amount);

        await this.splitsRepository.delete({ scheduledTransactionId: id });
        await this.createSplits(id, splits);

        await this.scheduledTransactionsRepository.update(id, {
          isSplit: true,
          categoryId: null,
        });
      } else if (Array.isArray(splits) && splits.length === 0) {
        await this.splitsRepository.delete({ scheduledTransactionId: id });
        await this.scheduledTransactionsRepository.update(id, {
          isSplit: false,
        });
      }
    }

    const fieldsToUpdate: Record<string, any> = {};

    if (updateData.accountId !== undefined)
      fieldsToUpdate.accountId = updateData.accountId;
    if (updateData.name !== undefined) fieldsToUpdate.name = updateData.name;
    if (updateData.payeeId !== undefined)
      fieldsToUpdate.payeeId = updateData.payeeId || null;
    if (updateData.payeeName !== undefined)
      fieldsToUpdate.payeeName = updateData.payeeName || null;
    if (updateData.categoryId !== undefined)
      fieldsToUpdate.categoryId = updateData.categoryId || null;
    if (updateData.amount !== undefined)
      fieldsToUpdate.amount = updateData.amount;
    if (updateData.currencyCode !== undefined)
      fieldsToUpdate.currencyCode = updateData.currencyCode;
    if (updateData.description !== undefined)
      fieldsToUpdate.description = updateData.description || null;
    if (updateData.frequency !== undefined)
      fieldsToUpdate.frequency = updateData.frequency;
    if (updateData.nextDueDate !== undefined)
      fieldsToUpdate.nextDueDate = updateData.nextDueDate;
    if (updateData.startDate !== undefined)
      fieldsToUpdate.startDate = updateData.startDate;
    if (updateData.endDate !== undefined)
      fieldsToUpdate.endDate = updateData.endDate || null;
    if (updateData.occurrencesRemaining !== undefined)
      fieldsToUpdate.occurrencesRemaining =
        updateData.occurrencesRemaining ?? null;
    if (updateData.isActive !== undefined)
      fieldsToUpdate.isActive = updateData.isActive;
    if (updateData.autoPost !== undefined)
      fieldsToUpdate.autoPost = updateData.autoPost;
    if (updateData.reminderDaysBefore !== undefined)
      fieldsToUpdate.reminderDaysBefore = updateData.reminderDaysBefore;

    if (isTransfer !== undefined) {
      fieldsToUpdate.isTransfer = isTransfer;
      if (isTransfer) {
        fieldsToUpdate.isSplit = false;
        fieldsToUpdate.categoryId = null;
        await this.splitsRepository.delete({ scheduledTransactionId: id });
      }
    }
    if (transferAccountId !== undefined) {
      fieldsToUpdate.transferAccountId = transferAccountId || null;
    }

    if (Object.keys(fieldsToUpdate).length > 0) {
      await this.scheduledTransactionsRepository.update(id, fieldsToUpdate);
    }

    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const scheduled = await this.findOne(userId, id);
    await this.scheduledTransactionsRepository.remove(scheduled);
  }

  async skip(userId: string, id: string): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    const nextDueDateStr =
      scheduled.nextDueDate instanceof Date
        ? scheduled.nextDueDate.toISOString().split("T")[0]
        : String(scheduled.nextDueDate).split("T")[0];

    await this.overridesRepository.delete({
      scheduledTransactionId: id,
      overrideDate: nextDueDateStr,
    });

    const nextDate = this.calculateNextDueDate(
      new Date(scheduled.nextDueDate),
      scheduled.frequency,
    );

    const updateFields: Record<string, any> = {
      nextDueDate: nextDate,
    };

    if (
      scheduled.occurrencesRemaining !== null &&
      scheduled.occurrencesRemaining > 0
    ) {
      const newRemaining = scheduled.occurrencesRemaining - 1;
      updateFields.occurrencesRemaining = newRemaining;
      if (newRemaining === 0) {
        updateFields.isActive = false;
      }
    }

    if (scheduled.endDate && nextDate > new Date(scheduled.endDate)) {
      updateFields.isActive = false;
    }

    await this.scheduledTransactionsRepository.update(id, updateFields);
    return this.findOne(userId, id);
  }

  async post(
    userId: string,
    id: string,
    postDto?: PostScheduledTransactionDto,
  ): Promise<ScheduledTransaction> {
    const scheduled = await this.findOne(userId, id);

    const nextDueDateStr =
      scheduled.nextDueDate instanceof Date
        ? scheduled.nextDueDate.toISOString().split("T")[0]
        : String(scheduled.nextDueDate).split("T")[0];

    const postDate = postDto?.transactionDate || nextDueDateStr;

    const storedOverride = await this.overridesRepository
      .createQueryBuilder("override")
      .where("override.scheduledTransactionId = :id", { id })
      .andWhere("override.overrideDate = :postDate", { postDate })
      .getOne();

    const hasInlineAmount =
      postDto?.amount !== undefined && postDto?.amount !== null;
    const hasInlineCategoryId = postDto?.categoryId !== undefined;
    const hasInlineDescription = postDto?.description !== undefined;
    const hasInlineIsSplit =
      postDto?.isSplit !== undefined && postDto?.isSplit !== null;
    const hasInlineSplits = postDto?.splits && postDto.splits.length > 0;

    const finalAmount = hasInlineAmount
      ? Number(postDto.amount)
      : storedOverride?.amount !== null && storedOverride?.amount !== undefined
        ? Number(storedOverride.amount)
        : Number(scheduled.amount);

    const finalDescription = hasInlineDescription
      ? postDto.description
      : storedOverride?.description !== null &&
          storedOverride?.description !== undefined
        ? storedOverride.description
        : scheduled.description || undefined;

    const transactionPayload: any = {
      accountId: scheduled.accountId,
      transactionDate: postDate,
      payeeId: scheduled.payeeId || undefined,
      payeeName: scheduled.payeeName || undefined,
      amount: finalAmount,
      currencyCode: scheduled.currencyCode,
      description: finalDescription,
      isCleared: false,
    };

    const useSplits = hasInlineIsSplit
      ? postDto.isSplit
      : storedOverride?.isSplit !== null &&
          storedOverride?.isSplit !== undefined
        ? storedOverride.isSplit
        : scheduled.isSplit;

    if (useSplits) {
      if (hasInlineSplits && postDto?.splits) {
        transactionPayload.splits = postDto.splits.map((split) => ({
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      } else if (storedOverride?.splits && storedOverride.splits.length > 0) {
        transactionPayload.splits = storedOverride.splits.map((split: any) => ({
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      } else if (scheduled.splits && scheduled.splits.length > 0) {
        transactionPayload.splits = scheduled.splits.map((split) => ({
          categoryId: split.categoryId || undefined,
          transferAccountId: split.transferAccountId || undefined,
          amount: Number(split.amount),
          memo: split.memo || undefined,
        }));
      }
    } else {
      const finalCategoryId = hasInlineCategoryId
        ? postDto.categoryId
        : storedOverride?.categoryId !== null &&
            storedOverride?.categoryId !== undefined
          ? storedOverride.categoryId
          : scheduled.categoryId || undefined;
      transactionPayload.categoryId = finalCategoryId || undefined;
    }

    if (scheduled.isTransfer && scheduled.transferAccountId) {
      await this.transactionsService.createTransfer(userId, {
        fromAccountId: scheduled.accountId,
        toAccountId: scheduled.transferAccountId,
        amount: Math.abs(finalAmount),
        transactionDate: postDate,
        fromCurrencyCode: scheduled.currencyCode,
        description: finalDescription || undefined,
      });
    } else {
      await this.transactionsService.create(userId, transactionPayload);
    }

    if (storedOverride) {
      await this.overridesRepository.remove(storedOverride);
    }

    const newNextDueDate =
      scheduled.frequency === "ONCE"
        ? null
        : this.calculateNextDueDate(
            new Date(scheduled.nextDueDate),
            scheduled.frequency,
          );

    if (newNextDueDate) {
      const newNextDueDateStr = newNextDueDate.toISOString().split("T")[0];
      await this.overridesRepository
        .createQueryBuilder()
        .delete()
        .where("scheduledTransactionId = :id", { id })
        .andWhere("overrideDate < :newNextDueDate", {
          newNextDueDate: newNextDueDateStr,
        })
        .execute();
    }

    const updateFields: Record<string, any> = {
      lastPostedDate: new Date(),
    };

    if (scheduled.frequency === "ONCE") {
      updateFields.isActive = false;
    } else {
      const nextDate = this.calculateNextDueDate(
        new Date(scheduled.nextDueDate),
        scheduled.frequency,
      );
      updateFields.nextDueDate = nextDate;

      if (
        scheduled.occurrencesRemaining !== null &&
        scheduled.occurrencesRemaining > 0
      ) {
        const newRemaining = scheduled.occurrencesRemaining - 1;
        updateFields.occurrencesRemaining = newRemaining;
        if (newRemaining === 0) {
          updateFields.isActive = false;
        }
      }

      if (scheduled.endDate && nextDate > new Date(scheduled.endDate)) {
        updateFields.isActive = false;
      }
    }

    await this.scheduledTransactionsRepository.update(id, updateFields);

    if (scheduled.splits && scheduled.splits.length > 0) {
      const loanAccountId = await this.loanService.findLoanAccountFromSplits(
        scheduled.splits,
      );
      if (loanAccountId) {
        await this.loanService.recalculateLoanPaymentSplits(id, loanAccountId);
      }
    }

    return this.findOne(userId, id);
  }

  private calculateNextDueDate(
    currentDate: Date,
    frequency: FrequencyType,
  ): Date {
    const date = new Date(currentDate);

    switch (frequency) {
      case "DAILY":
        date.setDate(date.getDate() + 1);
        break;
      case "WEEKLY":
        date.setDate(date.getDate() + 7);
        break;
      case "BIWEEKLY":
        date.setDate(date.getDate() + 14);
        break;
      case "SEMIMONTHLY":
        if (date.getDate() <= 15) {
          date.setMonth(date.getMonth() + 1, 0);
        } else {
          date.setMonth(date.getMonth() + 1, 15);
        }
        break;
      case "MONTHLY":
        date.setMonth(date.getMonth() + 1);
        break;
      case "QUARTERLY":
        date.setMonth(date.getMonth() + 3);
        break;
      case "YEARLY":
        date.setFullYear(date.getFullYear() + 1);
        break;
      case "ONCE":
      default:
        break;
    }

    return date;
  }

  // Delegated override methods

  async createOverride(
    userId: string,
    scheduledTransactionId: string,
    createDto: CreateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.createOverride(
      scheduledTransactionId,
      createDto,
    );
  }

  async findOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<ScheduledTransactionOverride[]> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverrides(scheduledTransactionId);
  }

  async findOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<ScheduledTransactionOverride> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverride(
      scheduledTransactionId,
      overrideId,
    );
  }

  async findOverrideByDate(
    userId: string,
    scheduledTransactionId: string,
    date: string,
  ): Promise<ScheduledTransactionOverride | null> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.findOverrideByDate(
      scheduledTransactionId,
      date,
    );
  }

  async updateOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
    updateDto: UpdateScheduledTransactionOverrideDto,
  ): Promise<ScheduledTransactionOverride> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.updateOverride(
      scheduledTransactionId,
      overrideId,
      updateDto,
    );
  }

  async removeOverride(
    userId: string,
    scheduledTransactionId: string,
    overrideId: string,
  ): Promise<void> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.removeOverride(
      scheduledTransactionId,
      overrideId,
    );
  }

  async removeAllOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<number> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.removeAllOverrides(scheduledTransactionId);
  }

  async hasOverrides(
    userId: string,
    scheduledTransactionId: string,
  ): Promise<{ hasOverrides: boolean; count: number }> {
    await this.findOne(userId, scheduledTransactionId);
    return this.overrideService.hasOverrides(scheduledTransactionId);
  }

  async recalculateLoanPaymentSplits(
    scheduledTransactionId: string,
    loanAccountId: string,
  ): Promise<void> {
    return this.loanService.recalculateLoanPaymentSplits(
      scheduledTransactionId,
      loanAccountId,
    );
  }
}
