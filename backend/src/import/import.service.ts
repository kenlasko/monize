import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { Transaction, TransactionStatus } from '../transactions/entities/transaction.entity';
import { TransactionSplit } from '../transactions/entities/transaction-split.entity';
import { Account, AccountType, AccountSubType } from '../accounts/entities/account.entity';
import { Category } from '../categories/entities/category.entity';
import { Payee } from '../payees/entities/payee.entity';
import { Security } from '../securities/entities/security.entity';
import { InvestmentTransaction, InvestmentAction } from '../securities/entities/investment-transaction.entity';
import { Holding } from '../securities/entities/holding.entity';
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
  SecurityMappingDto,
} from './dto/import.dto';

/**
 * Map stock exchanges to their primary currency.
 * Used to set the correct currency when creating new securities.
 */
const EXCHANGE_CURRENCY_MAP: Record<string, string> = {
  // US exchanges
  NYSE: 'USD',
  NASDAQ: 'USD',
  AMEX: 'USD',
  NYSEARCA: 'USD',
  BATS: 'USD',
  // Canadian exchanges
  TSX: 'CAD',
  'TSX-V': 'CAD',
  TSXV: 'CAD',
  NEO: 'CAD',
  CSE: 'CAD',
  // UK exchanges
  LSE: 'GBP',
  LON: 'GBP',
  // European exchanges
  XETRA: 'EUR',
  FRA: 'EUR',
  EPA: 'EUR',
  AMS: 'EUR',
  // Asian exchanges
  TYO: 'JPY',
  HKG: 'HKD',
  SHA: 'CNY',
  SHE: 'CNY',
  // Australian exchanges
  ASX: 'AUD',
};

/**
 * Get currency code from exchange name.
 * Returns the mapped currency or null if exchange is unknown.
 */
function getCurrencyFromExchange(exchange: string | null | undefined): string | null {
  if (!exchange) return null;
  const normalized = exchange.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return EXCHANGE_CURRENCY_MAP[normalized] || null;
}

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
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
    @InjectRepository(InvestmentTransaction)
    private investmentTransactionsRepository: Repository<InvestmentTransaction>,
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
  ) {}

  /**
   * Update account balance with proper decimal rounding.
   * Uses explicit read-modify-write to avoid TypeORM increment precision issues.
   */
  private async updateAccountBalance(
    queryRunner: any,
    accountId: string,
    amount: number,
  ): Promise<void> {
    const account = await queryRunner.manager.findOne(Account, {
      where: { id: accountId },
    });
    if (account) {
      // Round to 2 decimal places to avoid floating-point precision errors
      const newBalance =
        Math.round((Number(account.currentBalance) + Number(amount)) * 100) / 100;
      await queryRunner.manager.update(Account, accountId, {
        currentBalance: newBalance,
      });
    }
  }

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
      securities: result.securities,
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

    // Validate QIF type matches destination account type
    // Investment QIF files should only go to brokerage accounts
    // Regular QIF files should not go to brokerage accounts, but CAN go to investment cash accounts
    const isQifInvestment = result.accountType === 'INVESTMENT';
    const isAccountBrokerage = account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE;

    if (isQifInvestment && !isAccountBrokerage) {
      throw new BadRequestException(
        'This QIF file contains investment transactions but the selected account is not an investment brokerage account. ' +
        'Please select a brokerage account for this import.',
      );
    }

    if (!isQifInvestment && isAccountBrokerage) {
      throw new BadRequestException(
        'This QIF file contains regular banking transactions but the selected account is an investment brokerage account. ' +
        'Please select a cash account (including investment cash accounts) for this import.',
      );
    }

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

    // Build security mapping lookup (for investment transactions)
    const securityMap = new Map<string, string | null>();
    const securitiesToCreate: SecurityMappingDto[] = [];

    if (dto.securityMappings) {
      for (const mapping of dto.securityMappings) {
        if (mapping.securityId) {
          securityMap.set(mapping.originalName, mapping.securityId);
        } else if (mapping.createNew) {
          securitiesToCreate.push(mapping);
        } else {
          securityMap.set(mapping.originalName, null);
        }
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
      securitiesCreated: 0,
    };

    try {
      // Create new categories (deduplicating by name + parentId to avoid constraint violations)
      const processedCategories = new Map<string, string>(); // key: "name|parentId", value: categoryId
      for (const catMapping of categoriesToCreate) {
        const categoryName = catMapping.createNew;
        const parentId = catMapping.parentCategoryId || null;
        const cacheKey = `${categoryName}|${parentId || 'null'}`;

        // Check if we already processed this category in this import
        if (processedCategories.has(cacheKey)) {
          categoryMap.set(catMapping.originalName, processedCategories.get(cacheKey)!);
          continue;
        }

        // Check if category already exists in database
        const existingCategory = await queryRunner.manager.findOne(Category, {
          where: {
            userId,
            name: categoryName,
            parentId: parentId || IsNull(),
          },
        });

        if (existingCategory) {
          // Use existing category instead of creating duplicate
          categoryMap.set(catMapping.originalName, existingCategory.id);
          processedCategories.set(cacheKey, existingCategory.id);
          continue;
        }

        const newCategory = queryRunner.manager.create(Category, {
          userId,
          name: categoryName,
          parentId,
          isIncome: false,
        });
        const saved = await queryRunner.manager.save(newCategory);
        categoryMap.set(catMapping.originalName, saved.id);
        processedCategories.set(cacheKey, saved.id);
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

      // Create new securities (for investment transactions)
      for (const secMapping of securitiesToCreate) {
        if (!secMapping.createNew) continue;
        const symbol = secMapping.createNew.toUpperCase();

        // Check if security with this symbol already exists
        const existingSecurity = await queryRunner.manager.findOne(Security, {
          where: { symbol },
        });

        if (existingSecurity) {
          // Use existing security instead of creating duplicate
          securityMap.set(secMapping.originalName, existingSecurity.id);
        } else {
          // Determine currency: use provided currency, derive from exchange, or fall back to account currency
          const currencyCode =
            secMapping.currencyCode ||
            getCurrencyFromExchange(secMapping.exchange) ||
            account.currencyCode;

          const newSecurity = new Security();
          newSecurity.symbol = symbol;
          newSecurity.name = secMapping.securityName || secMapping.createNew;
          newSecurity.securityType = secMapping.securityType || null;
          newSecurity.exchange = secMapping.exchange || null;
          newSecurity.currencyCode = currencyCode;
          newSecurity.isActive = true;
          const saved = await queryRunner.manager.save(newSecurity);
          securityMap.set(secMapping.originalName, saved.id);
          importResult.securitiesCreated++;
        }
      }

      // Apply opening balance if present (round to 2 decimal places)
      if (result.openingBalance !== null) {
        const newBalance = Math.round(
          (account.currentBalance + result.openingBalance - (account.openingBalance || 0)) * 100,
        ) / 100;
        await queryRunner.manager.update(Account, dto.accountId, {
          openingBalance: Math.round(result.openingBalance * 100) / 100,
          currentBalance: newBalance,
        });
      }

      // Track timestamps per date to avoid duplicate createdAt values
      // This ensures deterministic ordering for transactions on the same date
      const dateCounters = new Map<string, number>();

      // Import transactions
      let txIndex = 0;
      const totalTransactions = result.transactions.length;
      for (const qifTx of result.transactions) {
        txIndex++;
        try {
          // Handle investment transactions differently
          if (isQifInvestment) {
            // Map QIF action to InvestmentAction enum
            const actionMap: Record<string, InvestmentAction> = {
              'buy': InvestmentAction.BUY,
              'sell': InvestmentAction.SELL,
              'div': InvestmentAction.DIVIDEND,
              'intinc': InvestmentAction.INTEREST,
              'cglong': InvestmentAction.CAPITAL_GAIN,
              'cgshort': InvestmentAction.CAPITAL_GAIN,
              'stksplit': InvestmentAction.SPLIT,
              'shrsin': InvestmentAction.TRANSFER_IN,
              'shrsout': InvestmentAction.TRANSFER_OUT,
              'reinvdiv': InvestmentAction.REINVEST,
              'reinvint': InvestmentAction.REINVEST,
              'reinvlg': InvestmentAction.REINVEST,
              'reinvsh': InvestmentAction.REINVEST,
            };

            const qifAction = (qifTx.action || '').toLowerCase();
            const action = actionMap[qifAction] || InvestmentAction.BUY;

            // Get security ID from mapping
            const securityId = qifTx.security ? securityMap.get(qifTx.security) || null : null;

            // Check for duplicate investment transactions
            if (dto.skipDuplicates && securityId) {
              const existingInvTx = await queryRunner.manager.findOne(InvestmentTransaction, {
                where: {
                  userId,
                  accountId: dto.accountId,
                  transactionDate: qifTx.date,
                  securityId,
                  action,
                  quantity: qifTx.quantity || 0,
                },
              });
              if (existingInvTx) {
                importResult.skipped++;
                continue;
              }
            }

            // Calculate total amount
            const quantity = qifTx.quantity || 0;
            const price = qifTx.price || 0;
            const commission = qifTx.commission || 0;
            // Use the transaction amount if provided, otherwise calculate
            // Round to 2 decimal places to avoid floating-point precision errors
            let totalAmount = qifTx.amount
              ? Math.round(qifTx.amount * 100) / 100
              : Math.round(((quantity * price) + commission) * 100) / 100;

            // Adjust totalAmount based on action type
            // For BUY: total = quantity * price + commission
            // For SELL: total = quantity * price - commission
            // Round to 2 decimal places to avoid floating-point precision errors
            if (action === InvestmentAction.BUY) {
              totalAmount = Math.round(((quantity * price) + commission) * 100) / 100;
            } else if (action === InvestmentAction.SELL) {
              totalAmount = Math.round(((quantity * price) - commission) * 100) / 100;
            }

            // Create investment transaction
            const investmentTx = new InvestmentTransaction();
            investmentTx.userId = userId;
            investmentTx.accountId = dto.accountId;
            investmentTx.securityId = securityId;
            investmentTx.action = action;
            investmentTx.transactionDate = qifTx.date;
            investmentTx.quantity = quantity || null;
            investmentTx.price = price || null;
            investmentTx.commission = commission;
            investmentTx.totalAmount = totalAmount;
            investmentTx.description = qifTx.memo || qifTx.payee || null;

            await queryRunner.manager.save(investmentTx);

            // Find the cash account for cash-affecting transactions
            // For paired accounts (brokerage + cash), use the linked cash account
            // For standalone accounts, use the same account
            let cashAccountId = dto.accountId;
            if (account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE && account.linkedAccountId) {
              cashAccountId = account.linkedAccountId;
            }

            // Determine if this action affects cash
            const cashAffectingActions = [
              InvestmentAction.BUY,
              InvestmentAction.SELL,
              InvestmentAction.DIVIDEND,
              InvestmentAction.INTEREST,
              InvestmentAction.CAPITAL_GAIN,
            ];

            if (cashAffectingActions.includes(action)) {
              // Determine the cash amount (negative for outflows like BUY, positive for inflows like SELL/DIVIDEND)
              const cashAmount = action === InvestmentAction.BUY ? -totalAmount : totalAmount;

              // Get the security symbol from the database (not the raw QIF name)
              let securitySymbol = 'Unknown';
              if (securityId) {
                const security = await queryRunner.manager.findOne(Security, {
                  where: { id: securityId },
                });
                if (security) {
                  securitySymbol = security.symbol;
                }
              }

              // Convert action to title case (e.g., "BUY" -> "Buy", "CAPITAL_GAIN" -> "Capital Gain")
              const formatAction = (act: string) => {
                return act
                  .split('_')
                  .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                  .join(' ');
              };
              const actionLabel = formatAction(action);

              // Format payee name for the cash transaction
              let payeeName: string;
              if (action === InvestmentAction.BUY || action === InvestmentAction.SELL) {
                payeeName = `${actionLabel}: ${securitySymbol} ${quantity} @ $${price.toFixed(2)}`;
              } else if (action === InvestmentAction.INTEREST) {
                payeeName = `${actionLabel}: $${totalAmount.toFixed(2)}`;
              } else {
                payeeName = `${actionLabel}: ${securitySymbol} $${totalAmount.toFixed(2)}`;
              }

              // Create cash transaction
              const cashTx = new Transaction();
              cashTx.userId = userId;
              cashTx.accountId = cashAccountId;
              cashTx.transactionDate = qifTx.date;
              cashTx.amount = cashAmount;
              cashTx.currencyCode = account.currencyCode;
              cashTx.exchangeRate = 1;
              cashTx.payeeName = payeeName;
              cashTx.payeeId = null;
              cashTx.description = qifTx.memo || null;
              cashTx.status = TransactionStatus.CLEARED;

              const savedCashTx = await queryRunner.manager.save(cashTx);

              // Link the cash transaction to the investment transaction
              investmentTx.transactionId = savedCashTx.id;
              await queryRunner.manager.save(investmentTx);

              // Update cash account balance
              await this.updateAccountBalance(queryRunner, cashAccountId, cashAmount);
            }

            // Update holdings for actions that affect share counts
            const holdingsActions = [
              InvestmentAction.BUY,
              InvestmentAction.SELL,
              InvestmentAction.REINVEST,
              InvestmentAction.TRANSFER_IN,
              InvestmentAction.TRANSFER_OUT,
            ];

            if (holdingsActions.includes(action) && securityId && quantity) {
              // Determine quantity change (negative for sells/transfers out)
              const quantityChange = [InvestmentAction.SELL, InvestmentAction.TRANSFER_OUT].includes(action)
                ? -quantity
                : quantity;

              // Find existing holding
              let holding = await queryRunner.manager.findOne(Holding, {
                where: { accountId: dto.accountId, securityId },
              });

              if (!holding) {
                // Create new holding
                holding = new Holding();
                holding.accountId = dto.accountId;
                holding.securityId = securityId;
                holding.quantity = quantityChange;
                holding.averageCost = price || 0;
              } else {
                // Update existing holding
                const currentQuantity = Number(holding.quantity);
                const currentAvgCost = Number(holding.averageCost || 0);
                const newQuantity = currentQuantity + quantityChange;

                if (quantityChange > 0 && price) {
                  // Buying shares - calculate new average cost
                  const totalCostBefore = currentQuantity * currentAvgCost;
                  const totalCostAdded = quantityChange * price;
                  holding.averageCost = newQuantity > 0
                    ? (totalCostBefore + totalCostAdded) / newQuantity
                    : 0;
                }
                // For sells, average cost doesn't change

                holding.quantity = newQuantity;
              }

              await queryRunner.manager.save(holding);
            }

            importResult.imported++;
            continue; // Skip the regular transaction handling
          }

          // Check for duplicates if requested
          // A duplicate must match: date, amount, payee, AND description
          // This allows importing transactions with same date/amount but different categories
          if (dto.skipDuplicates) {
            const existing = await queryRunner.manager.findOne(Transaction, {
              where: {
                userId,
                accountId: dto.accountId,
                transactionDate: qifTx.date,
                amount: qifTx.amount,
                payeeName: qifTx.payee || IsNull(),
                description: qifTx.memo || IsNull(),
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
                transferAccountId: splitTransferAccountId,
                amount: split.amount,
                memo: split.memo,
              });

              const savedSplit = await queryRunner.manager.save(transactionSplit);

              // For transfer splits, create linked transaction in target account
              if (splitTransferAccountId) {
                const linkedSplitTx = queryRunner.manager.create(Transaction, {
                  userId,
                  accountId: splitTransferAccountId,
                  transactionDate: qifTx.date,
                  amount: -split.amount, // Inverse amount
                  payeeName: qifTx.payee || `Transfer from ${account.name}`,
                  description: split.memo || qifTx.memo,
                  status,
                  currencyCode: account.currencyCode,
                  isTransfer: true,
                  createdAt: new Date(baseTime.getTime() + 0.1), // Slightly offset
                });

                const savedLinkedSplitTx = await queryRunner.manager.save(linkedSplitTx);

                // Update the split with the linked transaction ID
                await queryRunner.manager.update(TransactionSplit, savedSplit.id, {
                  linkedTransactionId: savedLinkedSplitTx.id,
                });

                // Update target account balance
                await queryRunner.manager.increment(
                  Account,
                  { id: splitTransferAccountId },
                  'currentBalance',
                  Math.round(-split.amount * 100) / 100,
                );
              }
            }
          }

          // Update account balance (round to 2 decimal places)
          await queryRunner.manager.increment(
            Account,
            { id: dto.accountId },
            'currentBalance',
            Math.round(qifTx.amount * 100) / 100,
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
              linkedTransactionId: savedTx.id,
              createdAt: linkedTime,
            });

            const savedLinkedTx = await queryRunner.manager.save(linkedTx);

            // Update the original transaction with linked ID
            await queryRunner.manager.update(Transaction, savedTx.id, {
              linkedTransactionId: savedLinkedTx.id,
            });

            // Update linked account balance (round to 2 decimal places)
            await queryRunner.manager.increment(
              Account,
              { id: transferAccountId },
              'currentBalance',
              Math.round(-qifTx.amount * 100) / 100,
            );
          }

          importResult.imported++;
        } catch (error) {
          importResult.errors++;
          importResult.errorMessages.push(
            `Error importing transaction ${txIndex}/${totalTransactions} on ${qifTx.date}: ${error.message}`,
          );
          console.error(`Error importing transaction ${txIndex}/${totalTransactions}:`, error.message);
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      console.error('=== IMPORT FAILED ===');
      console.error('Error:', error.message);
      console.error('Stack:', error.stack);
      console.error(`Progress: ${importResult.imported} imported, ${importResult.errors} errors`);
      await queryRunner.rollbackTransaction();
      throw new BadRequestException(
        `Import failed after ${importResult.imported} transactions: ${error.message}`,
      );
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
