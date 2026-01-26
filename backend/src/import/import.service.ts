import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Transaction, TransactionStatus } from '../transactions/entities/transaction.entity';
import { TransactionSplit } from '../transactions/entities/transaction-split.entity';
import { Account } from '../accounts/entities/account.entity';
import { Category } from '../categories/entities/category.entity';
import { Payee } from '../payees/entities/payee.entity';
import {
  parseQif,
  validateQifContent,
  QifParseResult,
  QifTransaction,
} from './qif-parser';
import {
  ImportQifDto,
  ParsedQifResponseDto,
  ImportResultDto,
  CategoryMappingDto,
  AccountMappingDto,
} from './dto/import.dto';

@Injectable()
export class ImportService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(TransactionSplit)
    private splitsRepository: Repository<TransactionSplit>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
  ) {}

  async parseQifFile(userId: string, content: string): Promise<ParsedQifResponseDto> {
    const validation = validateQifContent(content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseQif(content);

    // Calculate date range
    let startDate = '';
    let endDate = '';
    if (result.transactions.length > 0) {
      const dates = result.transactions
        .map((t) => t.date)
        .filter((d) => d)
        .sort();
      startDate = dates[0] || '';
      endDate = dates[dates.length - 1] || '';
    }

    return {
      accountType: result.accountType,
      transactionCount: result.transactions.length,
      categories: result.categories,
      transferAccounts: result.transferAccounts,
      dateRange: {
        start: startDate,
        end: endDate,
      },
      detectedDateFormat: result.detectedDateFormat,
      sampleDates: result.sampleDates,
      openingBalance: result.openingBalance,
      openingBalanceDate: result.openingBalanceDate,
    };
  }

  async importQifFile(userId: string, dto: ImportQifDto): Promise<ImportResultDto> {
    const validation = validateQifContent(dto.content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    // Verify account belongs to user
    const account = await this.accountsRepository.findOne({
      where: { id: dto.accountId, userId },
    });
    if (!account) {
      throw new BadRequestException('Account not found');
    }

    const result = parseQif(dto.content, dto.dateFormat as any);

    // Build category mapping lookup
    const categoryMap = new Map<string, string | null>();
    const categoriesToCreate: CategoryMappingDto[] = [];

    for (const mapping of dto.categoryMappings) {
      if (mapping.categoryId) {
        categoryMap.set(mapping.originalName, mapping.categoryId);
      } else if (mapping.createNew) {
        categoriesToCreate.push(mapping);
      } else {
        categoryMap.set(mapping.originalName, null);
      }
    }

    // Build account mapping lookup
    const accountMap = new Map<string, string | null>();
    const accountsToCreate: AccountMappingDto[] = [];

    for (const mapping of dto.accountMappings) {
      if (mapping.accountId) {
        accountMap.set(mapping.originalName, mapping.accountId);
      } else if (mapping.createNew) {
        accountsToCreate.push(mapping);
      } else {
        accountMap.set(mapping.originalName, null);
      }
    }

    // Start transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const importResult: ImportResultDto = {
      imported: 0,
      skipped: 0,
      errors: 0,
      errorMessages: [],
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
    };

    try {
      // Create new categories
      for (const catMapping of categoriesToCreate) {
        const newCategory = queryRunner.manager.create(Category, {
          userId,
          name: catMapping.createNew,
          parentId: catMapping.parentCategoryId || null,
          isIncome: false,
        });
        const saved = await queryRunner.manager.save(newCategory);
        categoryMap.set(catMapping.originalName, saved.id);
        importResult.categoriesCreated++;
      }

      // Create new accounts
      for (const accMapping of accountsToCreate) {
        const newAccount = queryRunner.manager.create(Account, {
          userId,
          name: accMapping.createNew,
          accountType: (accMapping.accountType as any) || 'CHEQUING',
          currencyCode: account.currencyCode,
          openingBalance: 0,
          currentBalance: 0,
        });
        const saved = await queryRunner.manager.save(newAccount);
        accountMap.set(accMapping.originalName, saved.id);
        importResult.accountsCreated++;
      }

      // Apply opening balance if present
      if (result.openingBalance !== null) {
        await queryRunner.manager.update(Account, dto.accountId, {
          openingBalance: result.openingBalance,
          currentBalance: account.currentBalance + result.openingBalance - (account.openingBalance || 0),
        });
      }

      // Track timestamps per date to avoid duplicate createdAt values
      // This ensures deterministic ordering for transactions on the same date
      const dateCounters = new Map<string, number>();

      // Import transactions
      for (const qifTx of result.transactions) {
        try {
          // Check for duplicates if requested
          if (dto.skipDuplicates) {
            const existing = await queryRunner.manager.findOne(Transaction, {
              where: {
                userId,
                accountId: dto.accountId,
                transactionDate: qifTx.date,
                amount: qifTx.amount,
              },
            });
            if (existing) {
              importResult.skipped++;
              continue;
            }

            // For transfers, also check if a linked transaction already exists
            // This handles the case where Account B was imported first with a transfer to Account A,
            // and now we're importing Account A - we don't want to duplicate the transfer
            if (qifTx.isTransfer && qifTx.transferAccount) {
              const mappedTransferAccountId = accountMap.get(qifTx.transferAccount);
              if (mappedTransferAccountId) {
                // Find transfers in the current account that link to transactions in the transfer account
                const existingLinkedTransfers = await queryRunner.manager
                  .createQueryBuilder(Transaction, 't')
                  .innerJoin(
                    Transaction,
                    'linked',
                    't.linked_transaction_id = linked.id',
                  )
                  .where('t.user_id = :userId', { userId })
                  .andWhere('t.account_id = :accountId', { accountId: dto.accountId })
                  .andWhere('t.is_transfer = true')
                  .andWhere('t.transaction_date = :date', { date: qifTx.date })
                  .andWhere('t.amount = :amount', { amount: qifTx.amount })
                  .andWhere('linked.account_id = :linkedAccountId', {
                    linkedAccountId: mappedTransferAccountId,
                  })
                  .getOne();

                if (existingLinkedTransfers) {
                  importResult.skipped++;
                  continue;
                }
              }
            }
          }

          // Get or create payee
          let payeeId: string | null = null;
          if (qifTx.payee) {
            const existingPayee = await queryRunner.manager.findOne(Payee, {
              where: { userId, name: qifTx.payee },
            });
            if (existingPayee) {
              payeeId = existingPayee.id;
            } else {
              const newPayee = queryRunner.manager.create(Payee, {
                userId,
                name: qifTx.payee,
              });
              const savedPayee = await queryRunner.manager.save(newPayee);
              payeeId = savedPayee.id;
              importResult.payeesCreated++;
            }
          }

          // Determine category
          let categoryId: string | null = null;
          if (qifTx.isTransfer) {
            // For transfers, we don't set a category
            categoryId = null;
          } else if (qifTx.category) {
            categoryId = categoryMap.get(qifTx.category) || null;
          }

          // Determine transfer account
          let transferAccountId: string | null = null;
          if (qifTx.isTransfer && qifTx.transferAccount) {
            transferAccountId = accountMap.get(qifTx.transferAccount) || null;
          }

          // Check if this is a split transaction
          const isSplit = qifTx.splits && qifTx.splits.length > 0;

          // Generate unique createdAt timestamp for deterministic ordering
          // Increment by 1ms for each transaction on the same date
          const counter = dateCounters.get(qifTx.date) || 0;
          dateCounters.set(qifTx.date, counter + 1);
          const baseTime = new Date();
          baseTime.setMilliseconds(baseTime.getMilliseconds() + counter);

          // Determine status from QIF cleared/reconciled flags
          // QIF: C field with '*' = cleared, 'X' = reconciled
          const status = qifTx.reconciled
            ? TransactionStatus.RECONCILED
            : qifTx.cleared
              ? TransactionStatus.CLEARED
              : TransactionStatus.UNRECONCILED;

          // Create transaction
          const transaction = queryRunner.manager.create(Transaction, {
            userId,
            accountId: dto.accountId,
            transactionDate: qifTx.date,
            amount: qifTx.amount,
            payeeName: qifTx.payee,
            payeeId,
            description: qifTx.memo,
            referenceNumber: qifTx.number,
            categoryId: isSplit ? null : categoryId,
            status,
            currencyCode: account.currencyCode,
            isSplit,
            isTransfer: qifTx.isTransfer,
            linkedAccountId: transferAccountId,
            createdAt: baseTime,
          });

          const savedTx = await queryRunner.manager.save(transaction);

          // Handle splits
          if (isSplit) {
            for (const split of qifTx.splits) {
              let splitCategoryId: string | null = null;
              let splitTransferAccountId: string | null = null;

              if (split.isTransfer && split.transferAccount) {
                splitTransferAccountId = accountMap.get(split.transferAccount) || null;
              } else if (split.category) {
                splitCategoryId = categoryMap.get(split.category) || null;
              }

              const transactionSplit = queryRunner.manager.create(TransactionSplit, {
                transactionId: savedTx.id,
                categoryId: splitCategoryId,
                amount: split.amount,
                memo: split.memo,
              });

              await queryRunner.manager.save(transactionSplit);
            }
          }

          // Update account balance
          await queryRunner.manager.increment(
            Account,
            { id: dto.accountId },
            'currentBalance',
            qifTx.amount,
          );

          // If it's a transfer and we have a linked account, create the opposite transaction
          if (qifTx.isTransfer && transferAccountId) {
            // Use same timestamp as the main transaction (slightly offset to ensure uniqueness)
            const linkedTime = new Date(baseTime.getTime() + 0.5);
            const linkedTx = queryRunner.manager.create(Transaction, {
              userId,
              accountId: transferAccountId,
              transactionDate: qifTx.date,
              amount: -qifTx.amount,
              payeeName: qifTx.payee || `Transfer from ${account.name}`,
              description: qifTx.memo,
              referenceNumber: qifTx.number,
              status, // Use same status as the main transaction
              currencyCode: account.currencyCode,
              isTransfer: true,
              linkedAccountId: dto.accountId,
              linkedTransactionId: savedTx.id,
              createdAt: linkedTime,
            });

            const savedLinkedTx = await queryRunner.manager.save(linkedTx);

            // Update the original transaction with linked ID
            await queryRunner.manager.update(Transaction, savedTx.id, {
              linkedTransactionId: savedLinkedTx.id,
            });

            // Update linked account balance
            await queryRunner.manager.increment(
              Account,
              { id: transferAccountId },
              'currentBalance',
              -qifTx.amount,
            );
          }

          importResult.imported++;
        } catch (error) {
          importResult.errors++;
          importResult.errorMessages.push(
            `Error importing transaction on ${qifTx.date}: ${error.message}`,
          );
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException(`Import failed: ${error.message}`);
    } finally {
      await queryRunner.release();
    }

    return importResult;
  }

  async getExistingCategories(userId: string): Promise<Category[]> {
    return this.categoriesRepository.find({
      where: { userId },
      order: { name: 'ASC' },
    });
  }

  async getExistingAccounts(userId: string): Promise<Account[]> {
    return this.accountsRepository.find({
      where: { userId },
      order: { name: 'ASC' },
    });
  }
}
