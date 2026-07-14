import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, QueryRunner, In } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { SplitKind } from "./entities/split-kind.enum";
import { Category } from "../categories/entities/category.entity";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { AccountsService } from "../accounts/accounts.service";
import { AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture } from "../common/date-utils";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  computeInvestmentCashImpact,
  isInvestmentActionAllowedInSplit,
} from "../securities/cash-impact.util";
import { NetWorthService } from "../net-worth/net-worth.service";
import { roundMoney, sumMoney } from "../common/round.util";
import { validateSplitAmountSum } from "../common/split-amount.util";
import { tr } from "../i18n/translate";

function inferSplitKind(split: CreateTransactionSplitDto): SplitKind {
  if (split.splitKind) return split.splitKind;
  if (split.investment) return SplitKind.INVESTMENT;
  if (split.transferAccountId) return SplitKind.TRANSFER;
  return SplitKind.CATEGORY;
}

@Injectable()
export class TransactionSplitService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => InvestmentTransactionsService))
    private investmentTransactionsService: InvestmentTransactionsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private dataSource: DataSource,
  ) {}

  private async validateCategoryOwnership(
    userId: string,
    categoryId: string,
  ): Promise<void> {
    const category = await this.categoriesRepository.findOne({
      where: { id: categoryId, userId },
    });
    if (!category) {
      throw new NotFoundException(
        tr("errors.transactions.categoryNotFound", "Category not found"),
      );
    }
  }

  validateSplits(
    splits: CreateTransactionSplitDto[],
    transactionAmount: number,
  ): void {
    validateSplitAmountSum(splits, transactionAmount, {
      allowSinglePassthrough: true,
      isPassthrough: (s) => {
        const split = s as CreateTransactionSplitDto;
        return Boolean(split.transferAccountId || split.investment);
      },
    });

    for (const split of splits) {
      const kind = inferSplitKind(split);
      if (kind !== SplitKind.INVESTMENT) continue;

      const inv = split.investment;
      if (!inv) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresPayload",
            "Investment split requires an investment payload",
          ),
        );
      }
      if (!isInvestmentActionAllowedInSplit(inv.action)) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentActionNotAllowedInSplit",
            `Investment action ${inv.action} is not allowed inside a split transaction`,
            { action: inv.action },
          ),
        );
      }
      if (split.categoryId || split.transferAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitCannotSetCategoryOrTransfer",
            "Investment splits cannot also set categoryId or transferAccountId",
          ),
        );
      }

      const cashImpactInSecurity = computeInvestmentCashImpact(
        inv.action,
        Number(inv.quantity ?? 0),
        Number(inv.price ?? 0),
        Number(inv.commission ?? 0),
      );
      const exchangeRate =
        inv.exchangeRate !== undefined && inv.exchangeRate !== null
          ? Number(inv.exchangeRate)
          : 1;
      const expectedAmount = cashImpactInSecurity * exchangeRate;

      const expectedRounded = roundMoney(expectedAmount);
      const actualRounded = roundMoney(Number(split.amount));

      if (expectedRounded !== actualRounded) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitAmountMismatch",
            `Investment split amount (${split.amount}) does not match the cash impact ` +
              `of ${inv.action} ${inv.quantity ?? 0} @ ${inv.price ?? 0} ` +
              `(expected ${expectedAmount.toFixed(4)})`,
            {
              amount: split.amount,
              action: inv.action,
              quantity: inv.quantity ?? 0,
              price: inv.price ?? 0,
              expected: expectedAmount.toFixed(4),
            },
          ),
        );
      }
    }
  }

  async createSplits(
    transactionId: string,
    splits: CreateTransactionSplitDto[],
    userId?: string,
    sourceAccountId?: string,
    transactionDate?: Date,
    parentPayeeName?: string | null,
    externalQueryRunner?: QueryRunner,
    parentPayeeId?: string | null,
  ): Promise<TransactionSplit[]> {
    const ownTransaction = !externalQueryRunner;
    const queryRunner =
      externalQueryRunner ?? this.dataSource.createQueryRunner();

    if (ownTransaction) {
      await queryRunner.connect();
      await queryRunner.startTransaction();
    }

    try {
      const savedSplits = await this.createSplitsInternal(
        queryRunner,
        transactionId,
        splits,
        userId,
        sourceAccountId,
        transactionDate,
        parentPayeeName,
        parentPayeeId,
      );

      if (ownTransaction) {
        await queryRunner.commitTransaction();
      }

      return savedSplits;
    } catch (error) {
      if (ownTransaction) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      if (ownTransaction) {
        await queryRunner.release();
      }
    }
  }

  private async createSplitsInternal(
    queryRunner: QueryRunner,
    transactionId: string,
    splits: CreateTransactionSplitDto[],
    userId?: string,
    sourceAccountId?: string,
    transactionDate?: Date,
    parentPayeeName?: string | null,
    parentPayeeId?: string | null,
  ): Promise<TransactionSplit[]> {
    if (userId) {
      const categoryIds = [
        ...new Set(
          splits.map((s) => s.categoryId).filter((id): id is string => !!id),
        ),
      ];
      if (categoryIds.length > 0) {
        const found = await queryRunner.manager.find(Category, {
          where: { id: In(categoryIds), userId },
          select: ["id"],
        });
        const foundIds = new Set(found.map((c) => c.id));
        const invalid = categoryIds.filter((id) => !foundIds.has(id));
        if (invalid.length > 0) {
          throw new NotFoundException(
            tr(
              "errors.transactions.categoriesNotFound",
              `Categories not found: ${invalid.join(", ")}`,
              { ids: invalid.join(", ") },
            ),
          );
        }
      }
    }

    const hasInvestment = splits.some(
      (s) => inferSplitKind(s) === SplitKind.INVESTMENT,
    );
    let brokerageAccountId: string | null = null;
    let parentDateStr = "";

    if (hasInvestment) {
      if (!userId || !sourceAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresSourceAccount",
            "Investment splits require a known source account",
          ),
        );
      }
      const sourceAccount = await this.accountsService.findOne(
        userId,
        sourceAccountId,
      );
      if (sourceAccount.accountSubType !== AccountSubType.INVESTMENT_CASH) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresInvestmentCashAccount",
            "Investment splits require the parent transaction to be on an INVESTMENT_CASH account",
          ),
        );
      }
      if (!sourceAccount.linkedAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentCashAccountNotLinked",
            "Source INVESTMENT_CASH account is not linked to a brokerage account",
          ),
        );
      }
      brokerageAccountId = sourceAccount.linkedAccountId;
      parentDateStr = transactionDate
        ? transactionDate.toISOString().substring(0, 10)
        : "";
    }

    // Saved rows are placed back at their original input position so callers
    // that pair splits[i] with the result (e.g. split-level tag assignment) stay
    // aligned regardless of the batched/looped save ordering below.
    const savedSplits: TransactionSplit[] = new Array(splits.length);

    // Plain category splits (and transfers without userId/sourceAccountId
    // context, e.g. import flows) are batch-saved together. Each bucket keeps
    // the split's original index.
    const regularSplits: { split: CreateTransactionSplitDto; index: number }[] =
      [];
    const transferSplits: {
      split: CreateTransactionSplitDto;
      index: number;
    }[] = [];
    const investmentSplits: {
      split: CreateTransactionSplitDto;
      index: number;
    }[] = [];
    splits.forEach((split, index) => {
      const k = inferSplitKind(split);
      if (k === SplitKind.INVESTMENT) {
        investmentSplits.push({ split, index });
      } else if (
        k === SplitKind.TRANSFER &&
        split.transferAccountId &&
        userId &&
        sourceAccountId
      ) {
        transferSplits.push({ split, index });
      } else {
        regularSplits.push({ split, index });
      }
    });

    if (regularSplits.length > 0) {
      const regularEntities = regularSplits.map(({ split }) => {
        const kind = split.transferAccountId
          ? SplitKind.TRANSFER
          : SplitKind.CATEGORY;
        return queryRunner.manager.create(TransactionSplit, {
          transactionId,
          kind,
          categoryId: split.categoryId || null,
          transferAccountId: split.transferAccountId || null,
          amount: split.amount,
          memo: split.memo || null,
        });
      });
      const batchSaved = await queryRunner.manager.save(regularEntities);
      batchSaved.forEach((saved, j) => {
        savedSplits[regularSplits[j].index] = saved;
      });
    }

    for (const { split, index } of transferSplits) {
      const splitEntity = queryRunner.manager.create(TransactionSplit, {
        transactionId,
        kind: SplitKind.TRANSFER,
        categoryId: null,
        transferAccountId: split.transferAccountId,
        amount: split.amount,
        memo: split.memo || null,
      });

      const savedSplit = await queryRunner.manager.save(splitEntity);

      const targetAccount = await this.accountsService.findOne(
        userId!,
        split.transferAccountId!,
      );
      const sourceAccount = await this.accountsService.findOne(
        userId!,
        sourceAccountId!,
      );

      // Persist the transfer counterpart's date as a plain yyyy-MM-dd string,
      // not the Date object. The Date arrives as UTC midnight
      // (new Date("2024-01-05")), so saving it directly lets node-postgres
      // serialize it in the server's local time and Postgres truncates it to
      // the previous calendar day west of UTC -- shifting every split transfer
      // (e.g. loan payments) a day earlier than its parent. The ISO date part
      // recovers the intended day and matches the parent transaction.
      const dateStr = transactionDate
        ? transactionDate.toISOString().substring(0, 10)
        : "";

      const linkedTransaction = queryRunner.manager.create(Transaction, {
        userId,
        accountId: split.transferAccountId,
        transactionDate: (dateStr || null) as any,
        amount: -split.amount,
        currencyCode: targetAccount.currencyCode,
        exchangeRate: 1,
        description: split.memo || null,
        isTransfer: true,
        payeeId: parentPayeeId || null,
        payeeName: parentPayeeName || `Transfer from ${sourceAccount.name}`,
      });

      const savedLinkedTransaction =
        await queryRunner.manager.save(linkedTransaction);

      await queryRunner.manager.update(TransactionSplit, savedSplit.id, {
        linkedTransactionId: savedLinkedTransaction.id,
      });

      await queryRunner.manager.update(Transaction, savedLinkedTransaction.id, {
        linkedTransactionId: transactionId,
      });

      if (dateStr && isTransactionInFuture(dateStr)) {
        await this.accountsService.recalculateCurrentBalance(
          split.transferAccountId!,
          queryRunner,
        );
      } else {
        await this.accountsService.updateBalance(
          split.transferAccountId!,
          -split.amount,
          queryRunner,
        );
      }

      savedSplit.linkedTransactionId = savedLinkedTransaction.id;
      savedSplits[index] = savedSplit;
    }

    for (const { split, index } of investmentSplits) {
      const splitEntity = queryRunner.manager.create(TransactionSplit, {
        transactionId,
        kind: SplitKind.INVESTMENT,
        categoryId: null,
        transferAccountId: null,
        amount: split.amount,
        memo: split.memo || null,
      });
      const savedSplit = await queryRunner.manager.save(splitEntity);

      await this.investmentTransactionsService.createEmbeddedForSplit(
        queryRunner,
        userId!,
        parentDateStr,
        savedSplit.id,
        brokerageAccountId!,
        sourceAccountId!,
        split.investment!,
      );

      savedSplits[index] = savedSplit;
    }

    if (hasInvestment && userId && brokerageAccountId) {
      this.netWorthService.triggerDebouncedRecalc(brokerageAccountId, userId);
    }

    return savedSplits;
  }

  async deleteSplitSideEffects(
    transactionId: string,
    userId: string,
    externalQueryRunner?: QueryRunner,
  ): Promise<void> {
    const repo = externalQueryRunner
      ? externalQueryRunner.manager.getRepository(TransactionSplit)
      : this.splitsRepository;
    const txRepo = externalQueryRunner
      ? externalQueryRunner.manager.getRepository(Transaction)
      : this.transactionsRepository;

    const splits = await repo.find({
      where: { transactionId },
      relations: ["linkedTransaction", "investmentTransaction"],
    });

    // Reverse investment splits' holdings effects before the split rows are deleted.
    if (externalQueryRunner) {
      for (const s of splits) {
        if (s.kind === SplitKind.INVESTMENT && s.investmentTransaction) {
          await this.investmentTransactionsService.reverseAndRemoveEmbedded(
            externalQueryRunner,
            userId,
            s.investmentTransaction,
          );
        }
      }
    }

    const linkedTxIds = splits
      .filter((s) => s.linkedTransactionId && s.transferAccountId)
      .map((s) => s.linkedTransactionId!);

    if (linkedTxIds.length === 0) return;

    const linkedTransactions = await txRepo.find({
      where: { id: In(linkedTxIds) },
    });

    for (const linkedTx of linkedTransactions) {
      const linkedIsFuture = isTransactionInFuture(linkedTx.transactionDate);
      const linkedAccId = linkedTx.accountId;
      if (!linkedIsFuture) {
        await this.accountsService.updateBalance(
          linkedAccId,
          -Number(linkedTx.amount),
          externalQueryRunner,
        );
      }
      await txRepo.remove(linkedTx);
      if (linkedIsFuture) {
        await this.accountsService.recalculateCurrentBalance(
          linkedAccId,
          externalQueryRunner,
        );
      }
    }
  }

  /**
   * @deprecated use deleteSplitSideEffects
   * Kept as a thin wrapper for callers that don't have a userId in scope and
   * only need transfer-side cleanup.
   */
  async deleteTransferSplitLinkedTransactions(
    transactionId: string,
    externalQueryRunner?: QueryRunner,
  ): Promise<void> {
    const repo = externalQueryRunner
      ? externalQueryRunner.manager.getRepository(TransactionSplit)
      : this.splitsRepository;
    const txRepo = externalQueryRunner
      ? externalQueryRunner.manager.getRepository(Transaction)
      : this.transactionsRepository;

    const transferSplits = await repo.find({
      where: { transactionId },
      relations: ["linkedTransaction"],
    });

    const linkedTxIds = transferSplits
      .filter((s) => s.linkedTransactionId && s.transferAccountId)
      .map((s) => s.linkedTransactionId!);

    if (linkedTxIds.length === 0) return;

    const linkedTransactions = await txRepo.find({
      where: { id: In(linkedTxIds) },
    });

    for (const linkedTx of linkedTransactions) {
      const linkedIsFuture = isTransactionInFuture(linkedTx.transactionDate);
      const linkedAccId = linkedTx.accountId;
      if (!linkedIsFuture) {
        await this.accountsService.updateBalance(
          linkedAccId,
          -Number(linkedTx.amount),
          externalQueryRunner,
        );
      }
      await txRepo.remove(linkedTx);
      if (linkedIsFuture) {
        await this.accountsService.recalculateCurrentBalance(
          linkedAccId,
          externalQueryRunner,
        );
      }
    }
  }

  /**
   * Find the split that owns a given transfer counterpart (the leg living in the
   * target account), or null if the transaction is not a split-transfer leg.
   * Used to mirror edits made on the counterpart back onto its split.
   */
  async getTransferSplitByLinkedTransaction(
    linkedTransactionId: string,
  ): Promise<TransactionSplit | null> {
    return this.splitsRepository.findOne({
      where: { linkedTransactionId },
    });
  }

  async getSplits(transactionId: string): Promise<TransactionSplit[]> {
    return this.splitsRepository.find({
      where: { transactionId },
      relations: ["category", "transferAccount", "investmentTransaction"],
      order: { createdAt: "ASC" },
    });
  }

  async updateSplits(
    transaction: Transaction,
    splits: CreateTransactionSplitDto[],
    userId: string,
  ): Promise<TransactionSplit[]> {
    this.validateSplits(splits, transaction.amount);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.deleteSplitSideEffects(transaction.id, userId, queryRunner);

      await queryRunner.manager.delete(TransactionSplit, {
        transactionId: transaction.id,
      });

      const newSplits = await this.createSplits(
        transaction.id,
        splits,
        userId,
        transaction.accountId,
        new Date(transaction.transactionDate),
        transaction.payeeName,
        queryRunner,
        transaction.payeeId,
      );

      await queryRunner.manager.update(Transaction, transaction.id, {
        isSplit: true,
        categoryId: null,
      });

      await queryRunner.commitTransaction();
      return newSplits;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async addSplit(
    transaction: Transaction,
    splitDto: CreateTransactionSplitDto,
    userId: string,
  ): Promise<TransactionSplit> {
    if (splitDto.investment) {
      throw new BadRequestException(
        tr(
          "errors.transactions.investmentSplitNoIncremental",
          "Investment splits cannot be added incrementally; replace the full split set instead.",
        ),
      );
    }
    if (splitDto.categoryId) {
      await this.validateCategoryOwnership(userId, splitDto.categoryId);
    }

    const existingSplits = await this.getSplits(transaction.id);
    const existingTotal = sumMoney(existingSplits.map((s) => Number(s.amount)));
    const newTotal = sumMoney([existingTotal, Number(splitDto.amount)]);
    const transactionAmount = roundMoney(Number(transaction.amount));

    if (Math.abs(newTotal) > Math.abs(transactionAmount)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.splitExceedsTransactionAmount",
          `Adding this split would exceed the transaction amount. ` +
            `Current total: ${existingTotal}, New split: ${splitDto.amount}, ` +
            `Transaction amount: ${transaction.amount}`,
          {
            existingTotal,
            newSplit: splitDto.amount,
            transactionAmount: transaction.amount,
          },
        ),
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedSplitId: string;

    try {
      const splitKind = splitDto.transferAccountId
        ? SplitKind.TRANSFER
        : SplitKind.CATEGORY;
      const split = queryRunner.manager.create(TransactionSplit, {
        transactionId: transaction.id,
        kind: splitKind,
        categoryId: splitDto.categoryId || null,
        transferAccountId: splitDto.transferAccountId || null,
        amount: splitDto.amount,
        memo: splitDto.memo || null,
      });

      const savedSplit = await queryRunner.manager.save(split);
      savedSplitId = savedSplit.id;

      if (splitDto.transferAccountId) {
        const targetAccount = await this.accountsService.findOne(
          userId,
          splitDto.transferAccountId,
        );
        const sourceAccount = await this.accountsService.findOne(
          userId,
          transaction.accountId,
        );

        const linkedTransaction = queryRunner.manager.create(Transaction, {
          userId,
          accountId: splitDto.transferAccountId,
          transactionDate: transaction.transactionDate,
          amount: -splitDto.amount,
          currencyCode: targetAccount.currencyCode,
          exchangeRate: 1,
          description: splitDto.memo || null,
          isTransfer: true,
          payeeId: transaction.payeeId || null,
          payeeName:
            transaction.payeeName || `Transfer from ${sourceAccount.name}`,
        });

        const savedLinkedTransaction =
          await queryRunner.manager.save(linkedTransaction);

        await queryRunner.manager.update(TransactionSplit, savedSplit.id, {
          linkedTransactionId: savedLinkedTransaction.id,
        });

        if (isTransactionInFuture(transaction.transactionDate)) {
          await this.accountsService.recalculateCurrentBalance(
            splitDto.transferAccountId,
            queryRunner,
          );
        } else {
          await this.accountsService.updateBalance(
            splitDto.transferAccountId,
            -splitDto.amount,
            queryRunner,
          );
        }
      }

      const totalSplits = existingSplits.length + 1;
      if (totalSplits >= 2 && !transaction.isSplit) {
        await queryRunner.manager.update(Transaction, transaction.id, {
          isSplit: true,
          categoryId: null,
        });
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    const splitWithRelations = await this.splitsRepository.findOne({
      where: { id: savedSplitId },
      relations: ["category", "transferAccount"],
    });

    if (!splitWithRelations) {
      throw new NotFoundException(
        tr(
          "errors.transactions.splitNotFoundById",
          `Split with ID ${savedSplitId} not found`,
          { id: savedSplitId },
        ),
      );
    }

    return splitWithRelations;
  }

  async removeSplit(
    transaction: Transaction,
    splitId: string,
    userId: string,
  ): Promise<void> {
    const split = await this.splitsRepository.findOne({
      where: { id: splitId, transactionId: transaction.id },
      relations: ["investmentTransaction"],
    });

    if (!split) {
      throw new NotFoundException(
        tr(
          "errors.transactions.splitNotFoundById",
          `Split with ID ${splitId} not found`,
          { id: splitId },
        ),
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (split.kind === SplitKind.INVESTMENT && split.investmentTransaction) {
        await this.investmentTransactionsService.reverseAndRemoveEmbedded(
          queryRunner,
          userId,
          split.investmentTransaction,
        );
      } else if (split.linkedTransactionId && split.transferAccountId) {
        const linkedTx = await queryRunner.manager.findOne(Transaction, {
          where: { id: split.linkedTransactionId },
        });

        if (linkedTx) {
          const linkedIsFuture = isTransactionInFuture(
            linkedTx.transactionDate,
          );
          const linkedAccId = linkedTx.accountId;
          if (!linkedIsFuture) {
            await this.accountsService.updateBalance(
              linkedAccId,
              -Number(linkedTx.amount),
              queryRunner,
            );
          }
          await queryRunner.manager.remove(linkedTx);
          if (linkedIsFuture) {
            await this.accountsService.recalculateCurrentBalance(
              linkedAccId,
              queryRunner,
            );
          }
        }
      }

      await queryRunner.manager.remove(split);

      const remainingSplits = await queryRunner.manager.find(TransactionSplit, {
        where: { transactionId: transaction.id },
        relations: ["category", "transferAccount", "investmentTransaction"],
        order: { createdAt: "ASC" },
      });

      if (remainingSplits.length < 2) {
        if (remainingSplits.length === 1) {
          const lastSplit = remainingSplits[0];

          // Don't auto-collapse if the last remaining split is investment-kind
          // — that representation only makes sense as part of a split parent.
          if (lastSplit.kind === SplitKind.INVESTMENT) {
            await queryRunner.commitTransaction();
            return;
          }

          if (lastSplit.linkedTransactionId && lastSplit.transferAccountId) {
            const linkedTx = await queryRunner.manager.findOne(Transaction, {
              where: { id: lastSplit.linkedTransactionId },
            });

            if (linkedTx) {
              const lastLinkedIsFuture = isTransactionInFuture(
                linkedTx.transactionDate,
              );
              const lastLinkedAccId = linkedTx.accountId;
              if (!lastLinkedIsFuture) {
                await this.accountsService.updateBalance(
                  lastLinkedAccId,
                  -Number(linkedTx.amount),
                  queryRunner,
                );
              }
              await queryRunner.manager.remove(linkedTx);
              if (lastLinkedIsFuture) {
                await this.accountsService.recalculateCurrentBalance(
                  lastLinkedAccId,
                  queryRunner,
                );
              }
            }
          }

          await queryRunner.manager.update(Transaction, transaction.id, {
            isSplit: false,
            categoryId: lastSplit.categoryId,
          });
          await queryRunner.manager.remove(lastSplit);
        } else {
          await queryRunner.manager.update(Transaction, transaction.id, {
            isSplit: false,
          });
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
