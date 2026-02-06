import { Injectable, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import { NetWorthService } from '../net-worth/net-worth.service';
import { SecurityPriceService } from '../securities/security-price.service';
import { ExchangeRateService } from '../currencies/exchange-rate.service';
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
  private readonly logger = new Logger(ImportService.name);

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
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    @Inject(forwardRef(() => SecurityPriceService))
    private securityPriceService: SecurityPriceService,
    @Inject(forwardRef(() => ExchangeRateService))
    private exchangeRateService: ExchangeRateService,
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
      // Handle null/undefined currentBalance (treat as 0)
      const currentBalance = Number(account.currentBalance) || 0;
      // Round to 2 decimal places to avoid floating-point precision errors
      const newBalance = Math.round((currentBalance + Number(amount)) * 100) / 100;
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
    // Loan category mappings - maps category name to loan account ID
    const loanCategoryMap = new Map<string, string>();
    const loanAccountsToCreate: CategoryMappingDto[] = [];

    for (const mapping of dto.categoryMappings) {
      if (mapping.isLoanCategory) {
        // This category represents a loan payment - will be handled as transfer
        if (mapping.loanAccountId) {
          loanCategoryMap.set(mapping.originalName, mapping.loanAccountId);
        } else if (mapping.createNewLoan) {
          loanAccountsToCreate.push(mapping);
        }
      } else if (mapping.categoryId) {
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

    // Track all affected account IDs for post-import net worth recalculation
    const affectedAccountIds = new Set<string>();
    affectedAccountIds.add(dto.accountId);

    // Record import start time - used to only check for duplicates against
    // transactions that existed BEFORE this import started
    const importStartTime = new Date();

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

      // Create new loan accounts for loan category mappings
      for (const loanMapping of loanAccountsToCreate) {
        // Initial loan amount is stored as negative opening balance (liability)
        // Current balance starts at the loan amount (what's owed)
        const loanAmount = loanMapping.newLoanAmount || 0;
        const newLoanAccount = queryRunner.manager.create(Account, {
          userId,
          name: loanMapping.createNewLoan,
          accountType: AccountType.LOAN,
          currencyCode: account.currencyCode,
          institution: loanMapping.newLoanInstitution || null,
          openingBalance: -loanAmount,
          currentBalance: -loanAmount,
        });
        const saved = await queryRunner.manager.save(newLoanAccount);
        loanCategoryMap.set(loanMapping.originalName, saved.id);
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

      // Apply opening balance from QIF file
      if (result.openingBalance !== null) {
        const existingOpeningBalance = Number(account.openingBalance) || 0;
        const existingCurrentBalance = Number(account.currentBalance) || 0;
        const newOpeningBalance = Math.round(result.openingBalance * 100) / 100;

        // Calculate new current balance by adjusting for the opening balance change
        // currentBalance = openingBalance + sum(transactions)
        // So: new currentBalance = old currentBalance - old openingBalance + new openingBalance
        const newCurrentBalance = Math.round(
          (existingCurrentBalance - existingOpeningBalance + newOpeningBalance) * 100,
        ) / 100;

        await queryRunner.manager.update(Account, dto.accountId, {
          openingBalance: newOpeningBalance,
          currentBalance: newCurrentBalance,
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
            // Handle "X" suffix actions (e.g., BuyX, SellX, DivX) - these indicate transfer from/to another account
            // Strip the 'x' suffix for action mapping
            const baseAction = qifAction.replace(/x$/, '');
            const action = actionMap[baseAction] || actionMap[qifAction] || InvestmentAction.BUY;

            // Get security ID from mapping, or auto-create if not mapped
            let securityId = qifTx.security ? securityMap.get(qifTx.security) || null : null;

            // If no security mapping exists but we have a security name, auto-create one
            if (!securityId && qifTx.security) {
              // Generate symbol from first letter of each word (e.g., "Vanguard Total Stock Market" -> "VTSM")
              const words = qifTx.security.trim().split(/\s+/);
              let generatedSymbol = words
                .map(word => word.charAt(0).toUpperCase())
                .join('');

              // Ensure symbol is at least 2 characters
              if (generatedSymbol.length < 2) {
                generatedSymbol = qifTx.security.substring(0, 4).toUpperCase().replace(/[^A-Z]/g, '');
              }
              // Limit to 9 characters max (leaving room for * suffix)
              generatedSymbol = generatedSymbol.substring(0, 9);
              // Add * suffix to indicate auto-generated symbol
              generatedSymbol = `${generatedSymbol}*`;

              // Check if this generated symbol already exists
              let existingSecurity = await queryRunner.manager.findOne(Security, {
                where: { symbol: generatedSymbol },
              });

              // If symbol exists but for a different security, append a number
              if (existingSecurity && existingSecurity.name !== qifTx.security) {
                let counter = 2;
                let uniqueSymbol = `${generatedSymbol}${counter}`;
                while (await queryRunner.manager.findOne(Security, { where: { symbol: uniqueSymbol } })) {
                  counter++;
                  uniqueSymbol = `${generatedSymbol}${counter}`;
                }
                generatedSymbol = uniqueSymbol;
                existingSecurity = null; // Force creation of new security
              }

              if (existingSecurity) {
                securityId = existingSecurity.id;
              } else {
                // Create the security with skipPriceUpdates=true since it's an auto-generated symbol
                const newSecurity = new Security();
                newSecurity.symbol = generatedSymbol;
                newSecurity.name = qifTx.security;
                newSecurity.securityType = null;
                newSecurity.exchange = null;
                newSecurity.currencyCode = account.currencyCode;
                newSecurity.isActive = true;
                newSecurity.skipPriceUpdates = true; // Auto-generated symbols can't be looked up
                const savedSecurity = await queryRunner.manager.save(newSecurity);
                securityId = savedSecurity.id;
                importResult.securitiesCreated++;
                this.logger.log(`Auto-created security: ${generatedSymbol} for "${qifTx.security}" (price updates disabled)`);
              }

              // Cache the mapping for subsequent transactions with the same security name
              securityMap.set(qifTx.security, securityId);
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
            // Always use the linked cash account for brokerage imports,
            // ignoring QIF transfer account fields (they redirect to the associated cash account)
            let cashAccountId = dto.accountId;
            let cashAccountCurrency = account.currencyCode;

            if (account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE && account.linkedAccountId) {
              cashAccountId = account.linkedAccountId;
              affectedAccountIds.add(cashAccountId);
              // Get the linked account's currency
              const linkedAccount = await queryRunner.manager.findOne(Account, {
                where: { id: account.linkedAccountId },
              });
              if (linkedAccount) {
                cashAccountCurrency = linkedAccount.currencyCode;
              }
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
              cashTx.currencyCode = cashAccountCurrency;
              cashTx.exchangeRate = 1;
              cashTx.payeeName = payeeName;
              cashTx.payeeId = null;
              cashTx.description = qifTx.memo || null;
              cashTx.status = TransactionStatus.CLEARED;
              // Cash transactions for investment imports always go to the linked cash account, not a transfer
              cashTx.isTransfer = false;

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

          // Check for duplicate transfers that existed BEFORE this import started
          // We only skip transfers that already exist in the database from a previous import,
          // NOT transfers within the same QIF file (those are legitimate duplicates)
          if (qifTx.isTransfer && qifTx.transferAccount) {
            const mappedTransferAccountId = accountMap.get(qifTx.transferAccount);
            if (mappedTransferAccountId) {
              // Find transfers in the current account that link to transactions in the transfer account
              // Only check transactions created BEFORE this import started
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
                .andWhere('t.created_at < :importStartTime', { importStartTime })
                .getOne();

              if (existingLinkedTransfers) {
                importResult.skipped++;
                continue;
              }
            }
          }

          // Also check if this transaction already exists as a linked transaction
          // from a SPLIT transfer in another account. Split transfers create a linked
          // transaction but don't set linkedTransactionId on that transaction - only the
          // split has the reference. So we need to look for transactions that are
          // referenced by a split's linkedTransactionId.
          // Only check transactions created BEFORE this import started
          if (qifTx.isTransfer) {
            const existingSplitLinkedTx = await queryRunner.manager
              .createQueryBuilder(Transaction, 't')
              .innerJoin(
                TransactionSplit,
                'split',
                'split.linked_transaction_id = t.id',
              )
              .where('t.user_id = :userId', { userId })
              .andWhere('t.account_id = :accountId', { accountId: dto.accountId })
              .andWhere('t.is_transfer = true')
              .andWhere('t.transaction_date = :date', { date: qifTx.date })
              .andWhere('t.amount = :amount', { amount: qifTx.amount })
              .andWhere('t.created_at < :importStartTime', { importStartTime })
              .getOne();

            if (existingSplitLinkedTx) {
              importResult.skipped++;
              continue;
            }
          }

          // For transfers: Check if there's a pending cross-currency transfer waiting to be updated
          // This happens when the other account was imported first and created a placeholder
          if (qifTx.isTransfer && qifTx.transferAccount) {
            const mappedTransferAccountId = accountMap.get(qifTx.transferAccount);
            if (mappedTransferAccountId) {
              // Look for a pending transfer in THIS account that was created by importing the other account
              // It should have the pending note and be linked to a transaction in the transfer account
              const expectedSign = qifTx.amount >= 0 ? 1 : -1;
              const pendingTransfer = await queryRunner.manager
                .createQueryBuilder(Transaction, 't')
                .leftJoinAndSelect('t.linkedTransaction', 'linked')
                .where('t.user_id = :userId', { userId })
                .andWhere('t.account_id = :accountId', { accountId: dto.accountId })
                .andWhere('t.transaction_date = :date', { date: qifTx.date })
                .andWhere('t.is_transfer = true')
                .andWhere('t.description LIKE :note', { note: '%PENDING IMPORT%' })
                .andWhere(expectedSign > 0 ? 't.amount > 0' : 't.amount < 0')
                .andWhere('linked.account_id = :linkedAccountId', { linkedAccountId: mappedTransferAccountId })
                .getOne();

              if (pendingTransfer) {
                // Found a pending transfer - update its amount and clear the note
                const oldAmount = Number(pendingTransfer.amount);
                const newAmount = qifTx.amount;
                const balanceDiff = newAmount - oldAmount;

                await queryRunner.manager.update(Transaction, pendingTransfer.id, {
                  amount: newAmount,
                  description: qifTx.memo || null, // Clear the pending note, use QIF memo
                  payeeName: qifTx.payee || pendingTransfer.payeeName,
                  referenceNumber: qifTx.number || pendingTransfer.referenceNumber,
                });

                // Adjust the balance difference
                if (balanceDiff !== 0) {
                  await this.updateAccountBalance(queryRunner, dto.accountId, balanceDiff);
                }

                importResult.imported++;
                continue; // Skip normal transaction creation
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

          // Check if this is a split transaction - must check early as it affects other logic
          const isSplit = qifTx.splits && qifTx.splits.length > 0;

          // Determine category and check for loan category mapping
          // Note: For split transactions, loan payment logic is handled at the split level, not here
          let categoryId: string | null = null;
          let isLoanPaymentTx = false;
          if (qifTx.isTransfer) {
            // For transfers, we don't set a category
            categoryId = null;
          } else if (account.accountType === AccountType.ASSET && account.assetCategoryId) {
            // For asset accounts, use the account's configured asset category
            categoryId = account.assetCategoryId;
          } else if (qifTx.category) {
            // Check if this category is mapped as a loan payment (only for non-split transactions)
            // Split transactions handle loan payments at the individual split level
            if (!isSplit && loanCategoryMap.has(qifTx.category)) {
              // This will be treated as a transfer to the loan account
              categoryId = null;
              isLoanPaymentTx = true;
            } else {
              categoryId = categoryMap.get(qifTx.category) || null;
            }
          }

          // Determine transfer account
          // For split transactions, transfers are handled at the split level, not the main transaction
          let transferAccountId: string | null = null;
          if (!isSplit) {
            if (qifTx.isTransfer && qifTx.transferAccount) {
              transferAccountId = accountMap.get(qifTx.transferAccount) || null;
            } else if (isLoanPaymentTx && qifTx.category) {
              // For loan payment transactions (non-split only), treat as transfer to loan account
              transferAccountId = loanCategoryMap.get(qifTx.category) || null;
            }
          }

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
          // Loan payments are treated as transfers to the loan account
          // For split transactions, the main transaction is NOT a transfer - transfers are at the split level
          const isTransfer = !isSplit && (qifTx.isTransfer || isLoanPaymentTx);
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
            isTransfer,
            createdAt: baseTime,
          });

          const savedTx = await queryRunner.manager.save(transaction);

          // Handle splits
          if (isSplit) {
            for (const split of qifTx.splits) {
              let splitCategoryId: string | null = null;
              let splitTransferAccountId: string | null = null;
              let isLoanPayment = false;

              if (split.isTransfer && split.transferAccount) {
                splitTransferAccountId = accountMap.get(split.transferAccount) || null;
              } else if (split.category) {
                // Check if this category is mapped as a loan payment
                if (loanCategoryMap.has(split.category)) {
                  splitTransferAccountId = loanCategoryMap.get(split.category) || null;
                  isLoanPayment = true;
                } else {
                  splitCategoryId = categoryMap.get(split.category) || null;
                }
              }

              const transactionSplit = queryRunner.manager.create(TransactionSplit, {
                transactionId: savedTx.id,
                categoryId: splitCategoryId,
                transferAccountId: splitTransferAccountId,
                amount: split.amount,
                memo: split.memo,
              });

              const savedSplit = await queryRunner.manager.save(transactionSplit);

              // For transfer splits (including loan payments), create linked transaction in target account
              if (splitTransferAccountId) {
                affectedAccountIds.add(splitTransferAccountId);
                const linkedAmount = -split.amount; // Inverse amount

                // Check if there's an existing transaction from a previous import that matches
                // This handles the case where the other side of the transfer was imported first
                // The existing transaction may already have a linkedTransactionId (pointing back to
                // a placeholder in this account that we'll need to clean up)
                const existingLinkedTx = await queryRunner.manager
                  .createQueryBuilder(Transaction, 't')
                  .where('t.user_id = :userId', { userId })
                  .andWhere('t.account_id = :accountId', { accountId: splitTransferAccountId })
                  .andWhere('t.transaction_date = :date', { date: qifTx.date })
                  .andWhere('t.amount = :amount', { amount: linkedAmount })
                  .andWhere('t.is_transfer = true')
                  .andWhere('t.created_at < :importStartTime', { importStartTime })
                  .getOne();

                if (existingLinkedTx) {
                  // Found existing transaction from previous import - link to it
                  await queryRunner.manager.update(TransactionSplit, savedSplit.id, {
                    linkedTransactionId: existingLinkedTx.id,
                  });

                  // Also set linkedTransactionId on the existing transaction to point back to the parent
                  // This allows traversing from the target account transaction back to the source splits
                  if (!existingLinkedTx.linkedTransactionId) {
                    await queryRunner.manager.update(Transaction, existingLinkedTx.id, {
                      linkedTransactionId: savedTx.id,
                    });
                  }

                  // Check if there's a placeholder transaction in the CURRENT account that was
                  // created when the other side was imported - if so, delete it and reverse balance
                  if (existingLinkedTx.linkedTransactionId) {
                    const placeholderTx = await queryRunner.manager.findOne(Transaction, {
                      where: {
                        id: existingLinkedTx.linkedTransactionId,
                        accountId: dto.accountId, // In current account
                      },
                    });
                    if (placeholderTx) {
                      // Reverse the balance impact of the placeholder
                      await this.updateAccountBalance(
                        queryRunner,
                        dto.accountId,
                        -Number(placeholderTx.amount),
                      );
                      // Delete the placeholder
                      await queryRunner.manager.delete(Transaction, placeholderTx.id);
                      // Clear the linkedTransactionId on the existing transaction
                      await queryRunner.manager.update(Transaction, existingLinkedTx.id, {
                        linkedTransactionId: null,
                      });
                    }
                  }
                  // No balance update needed for target account - it was already applied
                } else {
                  // Also check for pending transfers (cross-currency case)
                  const expectedSign = linkedAmount >= 0 ? 1 : -1;
                  const pendingTransfer = await queryRunner.manager
                    .createQueryBuilder(Transaction, 't')
                    .where('t.user_id = :userId', { userId })
                    .andWhere('t.account_id = :accountId', { accountId: splitTransferAccountId })
                    .andWhere('t.transaction_date = :date', { date: qifTx.date })
                    .andWhere('t.is_transfer = true')
                    .andWhere('t.linked_transaction_id IS NULL')
                    .andWhere('t.description LIKE :note', { note: '%PENDING IMPORT%' })
                    .andWhere(expectedSign > 0 ? 't.amount > 0' : 't.amount < 0')
                    .getOne();

                  if (pendingTransfer) {
                    // Update the pending transfer with correct amount
                    const oldAmount = Number(pendingTransfer.amount);
                    const balanceDiff = linkedAmount - oldAmount;

                    await queryRunner.manager.update(Transaction, pendingTransfer.id, {
                      amount: linkedAmount,
                      description: split.memo || qifTx.memo || null,
                      linkedTransactionId: savedTx.id, // Point back to the parent transaction
                    });

                    await queryRunner.manager.update(TransactionSplit, savedSplit.id, {
                      linkedTransactionId: pendingTransfer.id,
                    });

                    // Adjust balance for any difference
                    if (balanceDiff !== 0) {
                      await this.updateAccountBalance(queryRunner, splitTransferAccountId, balanceDiff);
                    }
                  } else {
                    // No existing transaction - create new linked transaction
                    const linkedSplitTx = queryRunner.manager.create(Transaction, {
                      userId,
                      accountId: splitTransferAccountId,
                      transactionDate: qifTx.date,
                      amount: linkedAmount,
                      payeeName: isLoanPayment
                        ? qifTx.payee || `Loan Payment from ${account.name}`
                        : qifTx.payee || `Transfer from ${account.name}`,
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

                    // Also set linkedTransactionId on the created transaction pointing back to the parent
                    // This allows traversing from the target account transaction back to the source splits
                    await queryRunner.manager.update(Transaction, savedLinkedSplitTx.id, {
                      linkedTransactionId: savedTx.id,
                    });

                    // Update target account balance
                    await this.updateAccountBalance(
                      queryRunner,
                      splitTransferAccountId,
                      linkedAmount,
                    );
                  }
                }
              }
            }
          }

          // Update account balance
          await this.updateAccountBalance(queryRunner, dto.accountId, qifTx.amount);

          // If it's a transfer (including loan payments) and we have a linked account, create the opposite transaction
          if (isTransfer && transferAccountId) {
            affectedAccountIds.add(transferAccountId);
            // Get the target account to check currency
            const targetAccount = await queryRunner.manager.findOne(Account, {
              where: { id: transferAccountId },
            });

            const isCrossCurrency = targetAccount && targetAccount.currencyCode !== account.currencyCode;
            const PENDING_IMPORT_NOTE = '⚠️ PENDING IMPORT: Amount may need adjustment when importing the other account.';

            // For cross-currency transfers, check if there's already a pending transfer waiting to be matched
            let existingPendingTransfer: Transaction | null = null;
            if (isCrossCurrency) {
              // Look for a pending transfer in the target account that:
              // 1. Is on the same date
              // 2. Is a transfer
              // 3. Has the pending import note
              // 4. Amount sign matches what we expect (we're depositing, so target should be positive if our amount is negative)
              const expectedSign = qifTx.amount < 0 ? 1 : -1; // If we're withdrawing (negative), target should be positive
              existingPendingTransfer = await queryRunner.manager
                .createQueryBuilder(Transaction, 't')
                .where('t.user_id = :userId', { userId })
                .andWhere('t.account_id = :accountId', { accountId: transferAccountId })
                .andWhere('t.transaction_date = :date', { date: qifTx.date })
                .andWhere('t.is_transfer = true')
                .andWhere('t.linked_transaction_id IS NULL')
                .andWhere('t.description LIKE :note', { note: '%PENDING IMPORT%' })
                .andWhere(expectedSign > 0 ? 't.amount > 0' : 't.amount < 0')
                .getOne();
            }

            if (existingPendingTransfer) {
              // Found a pending transfer - link them together and clear the note
              const linkedPayeeName = isLoanPaymentTx
                ? qifTx.payee || `Loan Payment from ${account.name}`
                : qifTx.payee || `Transfer from ${account.name}`;
              await queryRunner.manager.update(Transaction, existingPendingTransfer.id, {
                linkedTransactionId: savedTx.id,
                payeeName: linkedPayeeName,
                description: qifTx.memo || null, // Clear the pending note
              });

              await queryRunner.manager.update(Transaction, savedTx.id, {
                linkedTransactionId: existingPendingTransfer.id,
              });

              // Balance was already updated when the pending transfer was created
            } else {
              // Use same timestamp as the main transaction (slightly offset to ensure uniqueness)
              const linkedTime = new Date(baseTime.getTime() + 0.5);

              // For cross-currency, use the source amount but mark as pending
              const linkedAmount = -qifTx.amount;
              const linkedDescription = isCrossCurrency
                ? `${qifTx.memo || ''} ${PENDING_IMPORT_NOTE}`.trim()
                : qifTx.memo;

              const linkedPayeeName = isLoanPaymentTx
                ? qifTx.payee || `Loan Payment from ${account.name}`
                : qifTx.payee || `Transfer from ${account.name}`;
              const linkedTx = queryRunner.manager.create(Transaction, {
                userId,
                accountId: transferAccountId,
                transactionDate: qifTx.date,
                amount: linkedAmount,
                payeeName: linkedPayeeName,
                description: linkedDescription,
                referenceNumber: qifTx.number,
                status, // Use same status as the main transaction
                currencyCode: targetAccount?.currencyCode || account.currencyCode,
                isTransfer: true,
                linkedTransactionId: savedTx.id,
                createdAt: linkedTime,
              });

              const savedLinkedTx = await queryRunner.manager.save(linkedTx);

              // Update the original transaction with linked ID
              await queryRunner.manager.update(Transaction, savedTx.id, {
                linkedTransactionId: savedLinkedTx.id,
              });

              // Update linked account balance
              await this.updateAccountBalance(queryRunner, transferAccountId, linkedAmount);
            }
          }

          importResult.imported++;
        } catch (error) {
          importResult.errors++;
          importResult.errorMessages.push(
            `Error importing transaction ${txIndex}/${totalTransactions} on ${qifTx.date}: ${error.message}`,
          );
          // SECURITY: Log error details server-side only, don't expose stack traces
          this.logger.warn(`Error importing transaction ${txIndex}/${totalTransactions}: ${error.message}`);
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      // SECURITY: Log detailed error server-side only, return generic message to client
      this.logger.error(`Import failed after ${importResult.imported} transactions`, error.stack);
      await queryRunner.rollbackTransaction();
      throw new BadRequestException(
        `Import failed after ${importResult.imported} transactions: ${error.message}`,
      );
    } finally {
      await queryRunner.release();
    }

    // For investment imports, backfill historical security prices before recalculating net worth
    if (isQifInvestment) {
      try {
        this.logger.log('Post-import: backfilling historical security prices');
        await this.securityPriceService.backfillHistoricalPrices();
        this.logger.log('Post-import: historical price backfill complete');
      } catch (err) {
        this.logger.warn(`Post-import historical price backfill failed: ${err.message}`);
      }
    }

    // Backfill historical exchange rates for any affected accounts with non-default currencies
    try {
      this.logger.log('Post-import: backfilling historical exchange rates');
      await this.exchangeRateService.backfillHistoricalRates(
        userId,
        Array.from(affectedAccountIds),
      );
      this.logger.log('Post-import: historical rate backfill complete');
    } catch (err) {
      this.logger.warn(`Post-import historical rate backfill failed: ${err.message}`);
    }

    // Trigger net worth recalculation for all affected accounts (fire-and-forget)
    for (const accountId of affectedAccountIds) {
      this.netWorthService.recalculateAccount(userId, accountId).catch((err) =>
        this.logger.warn(`Post-import net worth recalc failed for account ${accountId}: ${err.message}`),
      );
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
