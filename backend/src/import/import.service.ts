import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource, In, IsNull } from "typeorm";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ImportColumnMapping } from "./entities/import-column-mapping.entity";
import {
  parseQif,
  parseQifFull,
  validateQifContent,
  DateFormat,
} from "./qif-parser";
import type {
  QifParseResult,
  QifFullParseResult,
  QifAccountBlock,
} from "./qif-parser";
import { parseOfx, validateOfxContent } from "./ofx-parser";
import {
  parseCsv,
  parseCsvHeaders as parseCsvHeadersFn,
  validateCsvContent,
} from "./csv-parser";
import type { CsvColumnMappingConfig, CsvTransferRule } from "./csv-parser";
import {
  ImportQifDto,
  ImportQifMultiAccountDto,
  ImportOfxDto,
  ImportCsvDto,
  ParsedQifResponseDto,
  ParsedQifMultiAccountResponseDto,
  ImportResultDto,
  CategoryMappingDto,
  AccountMappingDto,
  SecurityMappingDto,
  CreateColumnMappingDto,
  UpdateColumnMappingDto,
  CsvHeadersResponseDto,
  ColumnMappingResponseDto,
} from "./dto/import.dto";
import { ImportContext } from "./import-context";
import { ImportEntityCreatorService } from "./import-entity-creator.service";
import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { Tag } from "../tags/entities/tag.entity";

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private dataSource: DataSource,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
    @InjectRepository(ImportColumnMapping)
    private columnMappingRepository: Repository<ImportColumnMapping>,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    @Inject(forwardRef(() => SecurityPriceService))
    private securityPriceService: SecurityPriceService,
    @Inject(forwardRef(() => ExchangeRateService))
    private exchangeRateService: ExchangeRateService,
    private entityCreator: ImportEntityCreatorService,
    private investmentProcessor: ImportInvestmentProcessorService,
    private regularProcessor: ImportRegularProcessorService,
  ) {}

  // --- QIF ---

  async parseQifFile(
    userId: string,
    content: string,
  ): Promise<ParsedQifResponseDto> {
    const validation = validateQifContent(content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseQif(content);
    return this.buildParsedResponse(result);
  }

  async importQifFile(
    userId: string,
    dto: ImportQifDto,
  ): Promise<ImportResultDto> {
    const validation = validateQifContent(dto.content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseQif(dto.content, dto.dateFormat as DateFormat);

    return this.importParsedTransactions(
      userId,
      result,
      dto.accountId,
      dto.categoryMappings,
      dto.accountMappings,
      dto.securityMappings,
      dto.dateFormat as DateFormat,
    );
  }

  // --- Multi-account QIF ---

  async parseQifMultiAccountFile(
    userId: string,
    content: string,
  ): Promise<ParsedQifMultiAccountResponseDto> {
    const validation = validateQifContent(content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseQifFull(content);

    const accounts = result.accountBlocks.map((block) => {
      const dates = block.transactions
        .map((t) => t.date)
        .filter((d) => d)
        .sort();
      return {
        accountName: block.accountName,
        accountType: block.accountType,
        transactionCount: block.transactions.length,
        dateRange: {
          start: dates[0] || "",
          end: dates[dates.length - 1] || "",
        },
      };
    });

    const totalTransactionCount = result.accountBlocks.reduce(
      (sum, b) => sum + b.transactions.length,
      0,
    );

    // Collect unique securities across all investment account blocks
    const allSecurities = new Set<string>();
    for (const block of result.accountBlocks) {
      for (const sec of block.securities) {
        allSecurities.add(sec);
      }
    }

    return {
      isMultiAccount: result.isMultiAccount,
      categoryDefs: result.categoryDefs.map((c) => ({
        name: c.name,
        description: c.description,
        isIncome: c.isIncome,
      })),
      tagDefs: result.tagDefs.map((t) => ({
        name: t.name,
        description: t.description,
      })),
      accounts,
      totalTransactionCount,
      securities: Array.from(allSecurities).sort(),
      detectedDateFormat: result.detectedDateFormat,
      sampleDates: result.sampleDates,
    };
  }

  async importQifMultiAccountFile(
    userId: string,
    dto: ImportQifMultiAccountDto,
  ): Promise<ImportResultDto> {
    const validation = validateQifContent(dto.content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseQifFull(dto.content, dto.dateFormat as DateFormat);

    if (result.accountBlocks.length === 0) {
      throw new BadRequestException(
        "No account blocks found in QIF file. This file may not be a multi-account export.",
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const affectedAccountIds = new Set<string>();
    const importStartTime = new Date();
    let hasInvestment = false;

    const importResult: ImportResultDto = {
      imported: 0,
      skipped: 0,
      errors: 0,
      errorMessages: [],
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
      createdMappings: {
        categories: {},
        accounts: {},
        loans: {},
        securities: {},
      },
    };

    try {
      // Step 1: Create categories from !Type:Cat definitions
      const categoryMap = new Map<string, string | null>();
      await this.createCategoriesFromDefs(
        queryRunner,
        userId,
        result.categoryDefs,
        categoryMap,
        importResult,
      );

      // Step 1b: Also create categories referenced in transaction L-lines
      // that are not covered by !Type:Cat (common in Quicken exports)
      await this.createCategoriesFromBlocks(
        queryRunner,
        userId,
        result.accountBlocks,
        categoryMap,
        importResult,
      );

      // Step 2: Create accounts from !Account blocks
      const accountNameToId = new Map<string, string>();
      await this.createAccountsFromBlocks(
        queryRunner,
        userId,
        result.accountBlocks,
        dto.currencyCode,
        accountNameToId,
        importResult,
      );

      // Step 3: Build transfer account map from all known accounts
      // Include both newly created and pre-existing accounts so transfers resolve correctly
      const accountMap = new Map<string, string | null>();
      const allUserAccounts = await queryRunner.manager.find(Account, {
        where: { userId },
      });
      for (const acct of allUserAccounts) {
        accountMap.set(acct.name, acct.id);
      }
      // Override with newly created/resolved accounts (may have different target IDs for investment pairs)
      for (const [name, id] of accountNameToId) {
        accountMap.set(name, id);
      }

      // Step 4: Resolve tags from !Type:Tag definitions and transaction blocks
      const tagMap = new Map<string, string>();
      await this.createTagsFromDefs(
        queryRunner,
        userId,
        result.tagDefs,
        tagMap,
      );
      await this.resolveMultiAccountTags(
        queryRunner,
        userId,
        result.accountBlocks,
        tagMap,
      );

      // Step 5: Build security map from user-provided security mappings
      const { securityMap, securitiesToCreate } = this.buildSecurityMappings(
        dto.securityMappings,
      );

      // Create any new securities that the user requested
      if (securitiesToCreate.length > 0) {
        // Use the first investment account as the reference for security creation
        const firstInvestmentBlock = result.accountBlocks.find(
          (b) => b.accountType === "INVESTMENT",
        );
        const refAccountId = firstInvestmentBlock
          ? accountNameToId.get(firstInvestmentBlock.accountName)
          : undefined;
        const refAccount = refAccountId
          ? await queryRunner.manager.findOne(Account, {
              where: { id: refAccountId },
            })
          : undefined;

        if (refAccount) {
          await this.entityCreator.createSecurities(
            queryRunner,
            userId,
            securitiesToCreate,
            securityMap,
            refAccount,
            importResult,
          );
        }
      }

      // Step 6: Import transactions per account block
      for (const block of result.accountBlocks) {
        let accountId = accountNameToId.get(block.accountName);
        if (!accountId) {
          importResult.errors += block.transactions.length;
          importResult.errorMessages.push(
            `Skipped ${block.transactions.length} transactions: could not resolve account "${block.accountName}"`,
          );
          continue;
        }

        let account = await queryRunner.manager.findOne(Account, {
          where: { id: accountId },
        });
        if (!account) {
          importResult.errors += block.transactions.length;
          importResult.errorMessages.push(
            `Account "${block.accountName}" (${accountId}) not found in database`,
          );
          continue;
        }

        const isInvestment = block.accountType === "INVESTMENT";
        if (isInvestment) hasInvestment = true;

        // For investment blocks, the accountNameToId maps to the cash account
        // (for transfer resolution), but the investment processor needs the
        // brokerage account so that investment transactions and holdings are
        // recorded there, and the cash-side transaction is routed to the
        // linked cash account.
        if (
          isInvestment &&
          account.accountSubType === AccountSubType.INVESTMENT_CASH &&
          account.linkedAccountId
        ) {
          const brokerageAccount = await queryRunner.manager.findOne(Account, {
            where: { id: account.linkedAccountId },
          });
          if (
            brokerageAccount &&
            brokerageAccount.accountSubType ===
              AccountSubType.INVESTMENT_BROKERAGE
          ) {
            accountId = brokerageAccount.id;
            account = brokerageAccount;
          }
        }

        affectedAccountIds.add(accountId);

        const ctx: ImportContext = {
          queryRunner,
          userId,
          accountId,
          account,
          categoryMap,
          accountMap,
          loanCategoryMap: new Map(),
          securityMap,
          tagMap,
          importStartTime,
          dateCounters: new Map(),
          affectedAccountIds,
          importResult,
          transferDupCounts: new Map(),
        };

        // Apply opening balance
        if (block.openingBalance !== null) {
          await this.entityCreator.applyOpeningBalance(
            queryRunner,
            accountId,
            account,
            block.openingBalance,
          );
        }

        // Process transactions
        let txIndex = 0;
        for (const qifTx of block.transactions) {
          txIndex++;
          try {
            const savepointName = `tx_import_${txIndex}`;
            await queryRunner.query(`SAVEPOINT ${savepointName}`);
            try {
              if (isInvestment) {
                await this.investmentProcessor.processTransaction(ctx, qifTx);
              } else {
                await this.regularProcessor.processTransaction(ctx, qifTx);
              }
              await queryRunner.query(`RELEASE SAVEPOINT ${savepointName}`);
            } catch (error) {
              await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
              importResult.errors++;
              importResult.errorMessages.push(
                `Error importing transaction ${txIndex}/${block.transactions.length} in "${block.accountName}" on ${qifTx.date}: ${error.message}`,
              );
              this.logger.warn(
                `Error importing transaction in "${block.accountName}": ${error.message}`,
              );
            }
          } catch (savepointError) {
            importResult.errors++;
            importResult.errorMessages.push(
              `Error importing transaction ${txIndex}/${block.transactions.length} in "${block.accountName}" on ${qifTx.date}: ${savepointError.message}`,
            );
            this.logger.warn(
              `Savepoint error in "${block.accountName}": ${savepointError.message}`,
            );
          }
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      this.logger.error(
        `Multi-account import failed after ${importResult.imported} transactions`,
        error.stack,
      );
      await queryRunner.rollbackTransaction();
      throw new BadRequestException(
        `Import failed after ${importResult.imported} transactions: ${error.message}`,
      );
    } finally {
      await queryRunner.release();
    }

    // Post-import processing
    await this.postImportProcessing(userId, hasInvestment, affectedAccountIds);

    return importResult;
  }

  /**
   * Create categories from !Type:Cat definitions.
   * Handles parent:child hierarchy (e.g., "Utilities:Electricity").
   * Sets isIncome based on QIF I/E flags.
   */
  private async createCategoriesFromDefs(
    queryRunner: any,
    userId: string,
    categoryDefs: QifFullParseResult["categoryDefs"],
    categoryMap: Map<string, string | null>,
    importResult: ImportResultDto,
  ): Promise<void> {
    // Cache to avoid duplicate creation: "name|parentId" -> categoryId
    const processedCategories = new Map<string, string>();

    for (const def of categoryDefs) {
      // For Quicken categories starting with underscore, use description as name
      const effectiveName =
        def.name.startsWith("_") && def.description
          ? def.description
          : def.name;
      const parts = effectiveName.split(":");
      const isSubcategory = parts.length > 1;

      if (isSubcategory) {
        const parentName = parts[0].trim();
        const childName = parts.slice(1).join(":").trim();

        // Find or create parent
        const parentId = await this.findOrCreateCategoryDef(
          queryRunner,
          userId,
          parentName,
          null,
          def.isIncome,
          processedCategories,
          categoryMap,
          importResult,
        );

        // Find or create child
        await this.findOrCreateCategoryDef(
          queryRunner,
          userId,
          childName,
          parentId,
          def.isIncome,
          processedCategories,
          categoryMap,
          importResult,
        );

        // Map the full effective name for transaction category resolution
        const childId = processedCategories.get(`${childName}|${parentId}`)!;
        categoryMap.set(effectiveName, childId);
        // Also map the original QIF name if it differs (underscore substitution)
        if (def.name !== effectiveName) {
          categoryMap.set(def.name, childId);
        }
      } else {
        // Top-level category
        const catId = await this.findOrCreateCategoryDef(
          queryRunner,
          userId,
          effectiveName,
          null,
          def.isIncome,
          processedCategories,
          categoryMap,
          importResult,
        );
        // Also map the original QIF name if it differs (underscore substitution)
        if (def.name !== effectiveName) {
          categoryMap.set(def.name, catId);
        }
      }
    }
  }

  private async findOrCreateCategoryDef(
    queryRunner: any,
    userId: string,
    name: string,
    parentId: string | null,
    isIncome: boolean,
    processedCategories: Map<string, string>,
    categoryMap: Map<string, string | null>,
    importResult: ImportResultDto,
  ): Promise<string> {
    const cacheKey = `${name}|${parentId || "null"}`;

    if (processedCategories.has(cacheKey)) {
      return processedCategories.get(cacheKey)!;
    }

    const whereClause: any = { userId, name };
    if (parentId) {
      whereClause.parentId = parentId;
    } else {
      whereClause.parentId = IsNull();
    }

    const existing = await queryRunner.manager.findOne(Category, {
      where: whereClause,
    });

    if (existing) {
      processedCategories.set(cacheKey, existing.id);
      categoryMap.set(name, existing.id);
      return existing.id;
    }

    const newCategory = queryRunner.manager.create(Category, {
      userId,
      name,
      parentId,
      isIncome,
    });
    const saved = await queryRunner.manager.save(newCategory);
    processedCategories.set(cacheKey, saved.id);
    categoryMap.set(name, saved.id);
    importResult.categoriesCreated++;
    return saved.id;
  }

  /**
   * Create categories referenced in transaction L-lines across all account blocks
   * that were not already created from !Type:Cat definitions.
   * This handles Quicken exports where some categories are used in transactions
   * but missing from the !Type:Cat section.
   */
  private async createCategoriesFromBlocks(
    queryRunner: any,
    userId: string,
    blocks: QifFullParseResult["accountBlocks"],
    categoryMap: Map<string, string | null>,
    importResult: ImportResultDto,
  ): Promise<void> {
    const processedCategories = new Map<string, string>();

    // Copy existing categoryMap entries into processedCategories for dedup
    for (const [name, id] of categoryMap) {
      if (id) {
        processedCategories.set(`${name}|null`, id);
      }
    }

    // Collect all unique category names from all blocks
    const allCategories = new Set<string>();
    for (const block of blocks) {
      for (const cat of block.categories) {
        if (cat && !categoryMap.has(cat)) {
          allCategories.add(cat);
        }
      }
    }

    for (const categoryName of allCategories) {
      const parts = categoryName.split(":");
      const isSubcategory = parts.length > 1;

      if (isSubcategory) {
        const parentName = parts[0].trim();
        const childName = parts.slice(1).join(":").trim();

        const parentId = await this.findOrCreateCategoryDef(
          queryRunner,
          userId,
          parentName,
          null,
          false,
          processedCategories,
          categoryMap,
          importResult,
        );

        await this.findOrCreateCategoryDef(
          queryRunner,
          userId,
          childName,
          parentId,
          false,
          processedCategories,
          categoryMap,
          importResult,
        );

        const childId = processedCategories.get(`${childName}|${parentId}`)!;
        categoryMap.set(categoryName, childId);
      } else {
        await this.findOrCreateCategoryDef(
          queryRunner,
          userId,
          categoryName,
          null,
          false,
          processedCategories,
          categoryMap,
          importResult,
        );
      }
    }
  }

  /**
   * Create accounts from QIF account blocks.
   * Uses find-or-create to avoid duplicates.
   */
  private async createAccountsFromBlocks(
    queryRunner: any,
    userId: string,
    blocks: QifAccountBlock[],
    currencyCode: string,
    accountNameToId: Map<string, string>,
    importResult: ImportResultDto,
  ): Promise<void> {
    for (const block of blocks) {
      if (!block.accountName) continue;

      // Skip if already processed (duplicate account names)
      if (accountNameToId.has(block.accountName)) continue;

      // Check for existing account by name
      let existing = await queryRunner.manager.findOne(Account, {
        where: { userId, name: block.accountName },
      });

      // For investment accounts, also check the " - Cash" variant
      if (!existing && block.accountType === "INVESTMENT") {
        existing = await queryRunner.manager.findOne(Account, {
          where: { userId, name: `${block.accountName} - Cash` },
        });
      }

      if (existing) {
        // For investment brokerage accounts, target the linked cash account
        const targetId =
          existing.accountSubType === AccountSubType.INVESTMENT_BROKERAGE
            ? existing.linkedAccountId!
            : existing.id;
        accountNameToId.set(block.accountName, targetId);
        continue;
      }

      // Create new account
      const accountType =
        (block.accountType as AccountType) || AccountType.CHEQUING;

      if (accountType === AccountType.INVESTMENT) {
        // Create investment account pair
        const cashAccount = queryRunner.manager.create(Account, {
          userId,
          name: `${block.accountName} - Cash`,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
        });
        const savedCash = await queryRunner.manager.save(cashAccount);

        const brokerageAccount = queryRunner.manager.create(Account, {
          userId,
          name: `${block.accountName} - Brokerage`,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
          linkedAccountId: savedCash.id,
        });
        const savedBrokerage = await queryRunner.manager.save(brokerageAccount);

        savedCash.linkedAccountId = savedBrokerage.id;
        await queryRunner.manager.save(savedCash);

        accountNameToId.set(block.accountName, savedCash.id);
        importResult.accountsCreated += 2;
      } else {
        const newAccount = queryRunner.manager.create(Account, {
          userId,
          name: block.accountName,
          accountType,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
          creditLimit: block.creditLimit ?? null,
        });
        const saved = await queryRunner.manager.save(newAccount);
        accountNameToId.set(block.accountName, saved.id);
        importResult.accountsCreated++;
      }
    }
  }

  /**
   * Create tags from !Type:Tag definitions in QIF file.
   */
  private async createTagsFromDefs(
    queryRunner: any,
    userId: string,
    tagDefs: QifFullParseResult["tagDefs"],
    tagMap: Map<string, string>,
  ): Promise<void> {
    if (tagDefs.length === 0) return;

    const existingTags = await queryRunner.manager.find(Tag, {
      where: { userId },
    });

    const existingByName = new Map<string, Tag>();
    for (const tag of existingTags) {
      existingByName.set(tag.name.toLowerCase(), tag);
    }

    for (const def of tagDefs) {
      const key = def.name.toLowerCase();
      const existing = existingByName.get(key);
      if (existing) {
        tagMap.set(key, existing.id);
      } else {
        const newTag = queryRunner.manager.create(Tag, {
          userId,
          name: def.name,
        });
        const saved = await queryRunner.manager.save(newTag);
        tagMap.set(key, saved.id);
        existingByName.set(key, saved);
      }
    }
  }

  /**
   * Resolve tags from all account blocks for multi-account import.
   */
  private async resolveMultiAccountTags(
    queryRunner: any,
    userId: string,
    blocks: QifAccountBlock[],
    tagMap: Map<string, string>,
  ): Promise<void> {
    const tagNamesSet = new Set<string>();
    for (const block of blocks) {
      for (const tx of block.transactions) {
        for (const name of tx.tagNames ?? []) {
          tagNamesSet.add(name);
        }
        for (const split of tx.splits) {
          for (const name of split.tagNames ?? []) {
            tagNamesSet.add(name);
          }
        }
      }
    }

    if (tagNamesSet.size === 0) return;

    const existingTags = await queryRunner.manager.find(Tag, {
      where: { userId },
    });

    const existingByName = new Map<string, Tag>();
    for (const tag of existingTags) {
      existingByName.set(tag.name.toLowerCase(), tag);
    }

    for (const name of tagNamesSet) {
      const key = name.toLowerCase();
      const existing = existingByName.get(key);
      if (existing) {
        tagMap.set(key, existing.id);
      } else {
        const newTag = queryRunner.manager.create(Tag, { userId, name });
        const saved = await queryRunner.manager.save(newTag);
        tagMap.set(key, saved.id);
        existingByName.set(key, saved);
      }
    }
  }

  // --- OFX ---

  async parseOfxFile(
    userId: string,
    content: string,
  ): Promise<ParsedQifResponseDto> {
    const validation = validateOfxContent(content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseOfx(content);
    return this.buildParsedResponse(result);
  }

  async importOfxFile(
    userId: string,
    dto: ImportOfxDto,
  ): Promise<ImportResultDto> {
    const validation = validateOfxContent(dto.content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseOfx(dto.content);

    return this.importParsedTransactions(
      userId,
      result,
      dto.accountId,
      dto.categoryMappings,
      dto.accountMappings,
      [],
      dto.dateFormat as DateFormat,
    );
  }

  // --- CSV ---

  async parseCsvHeaders(
    userId: string,
    content: string,
    delimiter?: string,
  ): Promise<CsvHeadersResponseDto> {
    const validation = validateCsvContent(content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    return parseCsvHeadersFn(content, delimiter);
  }

  async parseCsvFile(
    userId: string,
    content: string,
    columnMapping: CsvColumnMappingConfig,
    transferRules?: CsvTransferRule[],
  ): Promise<ParsedQifResponseDto> {
    const validation = validateCsvContent(content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseCsv(content, columnMapping, transferRules);
    return this.buildParsedResponse(result);
  }

  async importCsvFile(
    userId: string,
    dto: ImportCsvDto,
  ): Promise<ImportResultDto> {
    const validation = validateCsvContent(dto.content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const csvConfig: CsvColumnMappingConfig = {
      date: dto.columnMapping.date,
      amount: dto.columnMapping.amount,
      debit: dto.columnMapping.debit,
      credit: dto.columnMapping.credit,
      payee: dto.columnMapping.payee,
      category: dto.columnMapping.category,
      subcategory: dto.columnMapping.subcategory,
      memo: dto.columnMapping.memo,
      referenceNumber: dto.columnMapping.referenceNumber,
      dateFormat: dto.columnMapping.dateFormat as DateFormat,
      reverseSign: dto.columnMapping.reverseSign,
      hasHeader: dto.columnMapping.hasHeader,
      delimiter: dto.columnMapping.delimiter,
      amountTypeColumn: dto.columnMapping.amountTypeColumn,
      incomeValues: dto.columnMapping.incomeValues,
      expenseValues: dto.columnMapping.expenseValues,
      transferOutValues: dto.columnMapping.transferOutValues,
      transferInValues: dto.columnMapping.transferInValues,
      transferAccountColumn: dto.columnMapping.transferAccountColumn,
    };

    const transferRules: CsvTransferRule[] | undefined = dto.transferRules?.map(
      (r) => ({
        type: r.type,
        pattern: r.pattern,
        accountName: r.accountName,
      }),
    );

    const result = parseCsv(dto.content, csvConfig, transferRules);

    return this.importParsedTransactions(
      userId,
      result,
      dto.accountId,
      dto.categoryMappings,
      dto.accountMappings,
      [],
      dto.dateFormat as DateFormat,
    );
  }

  // --- Column Mapping CRUD ---

  async getColumnMappings(userId: string): Promise<ColumnMappingResponseDto[]> {
    const mappings = await this.columnMappingRepository.find({
      where: { userId },
      order: { name: "ASC" },
    });
    return mappings.map((m) => ({
      id: m.id,
      name: m.name,
      columnMappings: m.columnMappings,
      transferRules: m.transferRules,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  async createColumnMapping(
    userId: string,
    dto: CreateColumnMappingDto,
  ): Promise<ColumnMappingResponseDto> {
    const existing = await this.columnMappingRepository.findOne({
      where: { userId, name: dto.name },
    });
    if (existing) {
      existing.columnMappings = dto.columnMappings as unknown as Record<
        string,
        unknown
      >;
      existing.transferRules = (dto.transferRules || []) as unknown as Record<
        string,
        unknown
      >[];
      const saved = await this.columnMappingRepository.save(existing);
      return {
        id: saved.id,
        name: saved.name,
        columnMappings: saved.columnMappings,
        transferRules: saved.transferRules,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      };
    }

    const mapping = this.columnMappingRepository.create({
      userId,
      name: dto.name,
      columnMappings: dto.columnMappings as unknown as Record<string, unknown>,
      transferRules: (dto.transferRules || []) as unknown as Record<
        string,
        unknown
      >[],
    });
    const saved = await this.columnMappingRepository.save(mapping);
    return {
      id: saved.id,
      name: saved.name,
      columnMappings: saved.columnMappings,
      transferRules: saved.transferRules,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  async updateColumnMapping(
    userId: string,
    id: string,
    dto: UpdateColumnMappingDto,
  ): Promise<ColumnMappingResponseDto> {
    const mapping = await this.columnMappingRepository.findOne({
      where: { id, userId },
    });
    if (!mapping) {
      throw new NotFoundException("Column mapping not found");
    }

    if (dto.name !== undefined && dto.name !== mapping.name) {
      const duplicate = await this.columnMappingRepository.findOne({
        where: { userId, name: dto.name },
      });
      if (duplicate) {
        throw new ConflictException(
          `A column mapping named "${dto.name}" already exists`,
        );
      }
      mapping.name = dto.name;
    }

    if (dto.columnMappings !== undefined) {
      mapping.columnMappings = dto.columnMappings as unknown as Record<
        string,
        unknown
      >;
    }
    if (dto.transferRules !== undefined) {
      mapping.transferRules = dto.transferRules as unknown as Record<
        string,
        unknown
      >[];
    }

    const saved = await this.columnMappingRepository.save(mapping);
    return {
      id: saved.id,
      name: saved.name,
      columnMappings: saved.columnMappings,
      transferRules: saved.transferRules,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  async deleteColumnMapping(userId: string, id: string): Promise<void> {
    const mapping = await this.columnMappingRepository.findOne({
      where: { id, userId },
    });
    if (!mapping) {
      throw new NotFoundException("Column mapping not found");
    }
    await this.columnMappingRepository.remove(mapping);
  }

  // --- Shared Import Pipeline ---

  private buildParsedResponse(result: QifParseResult): ParsedQifResponseDto {
    let startDate = "";
    let endDate = "";
    if (result.transactions.length > 0) {
      const dates = result.transactions
        .map((t) => t.date)
        .filter((d) => d)
        .sort();
      startDate = dates[0] || "";
      endDate = dates[dates.length - 1] || "";
    }

    return {
      accountType: result.accountType,
      accountName: result.accountName,
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

  private async importParsedTransactions(
    userId: string,
    result: QifParseResult,
    accountId: string,
    categoryMappings: CategoryMappingDto[],
    accountMappings: AccountMappingDto[],
    securityMappings?: SecurityMappingDto[],
    _dateFormat?: DateFormat,
  ): Promise<ImportResultDto> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId, userId },
    });
    if (!account) {
      throw new NotFoundException("Account not found");
    }

    // Validate file type matches destination account type
    const isInvestment = result.accountType === "INVESTMENT";
    const isAccountBrokerage =
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE;

    if (isInvestment && !isAccountBrokerage) {
      throw new BadRequestException(
        "This file contains investment transactions but the selected account is not an investment brokerage account. " +
          "Please select a brokerage account for this import.",
      );
    }

    if (!isInvestment && isAccountBrokerage) {
      throw new BadRequestException(
        "This file contains regular banking transactions but the selected account is an investment brokerage account. " +
          "Please select a cash account (including investment cash accounts) for this import.",
      );
    }

    // Build mapping lookups
    const {
      categoryMap,
      categoriesToCreate,
      loanCategoryMap,
      loanAccountsToCreate,
    } = this.buildCategoryMappings(categoryMappings);
    const { accountMap, accountsToCreate } =
      this.buildAccountMappings(accountMappings);
    const { securityMap, securitiesToCreate } =
      this.buildSecurityMappings(securityMappings);

    // Validate mapped entity IDs belong to user
    await this.validateMappedEntities(
      userId,
      accountMap,
      loanCategoryMap,
      categoryMap,
      securityMap,
    );

    // Start transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const affectedAccountIds = new Set<string>();
    affectedAccountIds.add(accountId);
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
      createdMappings: {
        categories: {},
        accounts: {},
        loans: {},
        securities: {},
      },
    };

    const ctx: ImportContext = {
      queryRunner,
      userId,
      accountId,
      account,
      categoryMap,
      accountMap,
      loanCategoryMap,
      securityMap,
      tagMap: new Map<string, string>(),
      importStartTime,
      dateCounters: new Map<string, number>(),
      affectedAccountIds,
      importResult,
      transferDupCounts: new Map<string, number>(),
    };

    try {
      // Create new entities
      await this.entityCreator.createCategories(
        queryRunner,
        userId,
        categoriesToCreate,
        categoryMap,
        importResult,
      );
      await this.entityCreator.createAccounts(
        queryRunner,
        userId,
        accountsToCreate,
        accountMap,
        account,
        importResult,
      );
      await this.entityCreator.createLoanAccounts(
        queryRunner,
        userId,
        loanAccountsToCreate,
        loanCategoryMap,
        account,
        importResult,
      );
      await this.entityCreator.createSecurities(
        queryRunner,
        userId,
        securitiesToCreate,
        securityMap,
        account,
        importResult,
      );

      // Create or resolve tags from QIF data
      await this.resolveImportTags(queryRunner, userId, result, ctx.tagMap);

      // Apply opening balance
      if (result.openingBalance !== null) {
        await this.entityCreator.applyOpeningBalance(
          queryRunner,
          accountId,
          account,
          result.openingBalance,
        );
      }

      // Import transactions
      let txIndex = 0;
      const totalTransactions = result.transactions.length;
      for (const qifTx of result.transactions) {
        txIndex++;
        try {
          const savepointName = `tx_import_${txIndex}`;
          await queryRunner.query(`SAVEPOINT ${savepointName}`);
          try {
            if (isInvestment) {
              await this.investmentProcessor.processTransaction(ctx, qifTx);
            } else {
              await this.regularProcessor.processTransaction(ctx, qifTx);
            }
            await queryRunner.query(`RELEASE SAVEPOINT ${savepointName}`);
          } catch (error) {
            await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            importResult.errors++;
            importResult.errorMessages.push(
              `Error importing transaction ${txIndex}/${totalTransactions} on ${qifTx.date}: ${error.message}`,
            );
            this.logger.warn(
              `Error importing transaction ${txIndex}/${totalTransactions}: ${error.message}`,
            );
          }
        } catch (savepointError) {
          importResult.errors++;
          importResult.errorMessages.push(
            `Error importing transaction ${txIndex}/${totalTransactions} on ${qifTx.date}: ${savepointError.message}`,
          );
          this.logger.warn(
            `Savepoint error for transaction ${txIndex}/${totalTransactions}: ${savepointError.message}`,
          );
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      this.logger.error(
        `Import failed after ${importResult.imported} transactions`,
        error.stack,
      );
      await queryRunner.rollbackTransaction();
      throw new BadRequestException(
        `Import failed after ${importResult.imported} transactions: ${error.message}`,
      );
    } finally {
      await queryRunner.release();
    }

    // Post-import processing
    await this.postImportProcessing(userId, isInvestment, affectedAccountIds);

    return importResult;
  }

  private buildCategoryMappings(mappings: CategoryMappingDto[]): {
    categoryMap: Map<string, string | null>;
    categoriesToCreate: CategoryMappingDto[];
    loanCategoryMap: Map<string, string>;
    loanAccountsToCreate: CategoryMappingDto[];
  } {
    const categoryMap = new Map<string, string | null>();
    const categoriesToCreate: CategoryMappingDto[] = [];
    const loanCategoryMap = new Map<string, string>();
    const loanAccountsToCreate: CategoryMappingDto[] = [];

    for (const mapping of mappings) {
      if (mapping.isLoanCategory) {
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

    return {
      categoryMap,
      categoriesToCreate,
      loanCategoryMap,
      loanAccountsToCreate,
    };
  }

  private buildAccountMappings(mappings: AccountMappingDto[]): {
    accountMap: Map<string, string | null>;
    accountsToCreate: AccountMappingDto[];
  } {
    const accountMap = new Map<string, string | null>();
    const accountsToCreate: AccountMappingDto[] = [];

    for (const mapping of mappings) {
      if (mapping.accountId) {
        accountMap.set(mapping.originalName, mapping.accountId);
      } else if (mapping.createNew) {
        accountsToCreate.push(mapping);
      } else {
        accountMap.set(mapping.originalName, null);
      }
    }

    return { accountMap, accountsToCreate };
  }

  private buildSecurityMappings(mappings?: SecurityMappingDto[]): {
    securityMap: Map<string, string | null>;
    securitiesToCreate: SecurityMappingDto[];
  } {
    const securityMap = new Map<string, string | null>();
    const securitiesToCreate: SecurityMappingDto[] = [];

    if (mappings) {
      for (const mapping of mappings) {
        if (mapping.securityId) {
          securityMap.set(mapping.originalName, mapping.securityId);
        } else if (mapping.createNew) {
          securitiesToCreate.push(mapping);
        } else {
          securityMap.set(mapping.originalName, null);
        }
      }
    }

    return { securityMap, securitiesToCreate };
  }

  private async validateMappedEntities(
    userId: string,
    accountMap: Map<string, string | null>,
    loanCategoryMap: Map<string, string>,
    categoryMap: Map<string, string | null>,
    securityMap: Map<string, string | null>,
  ): Promise<void> {
    // Batch-validate accounts
    const mappedAccountIds = [
      ...new Set(
        [
          ...accountMap.values(),
          ...Array.from(loanCategoryMap.values()),
        ].filter(Boolean) as string[],
      ),
    ];
    if (mappedAccountIds.length > 0) {
      const foundAccounts = await this.accountsRepository.find({
        where: { id: In(mappedAccountIds), userId },
        select: ["id"],
      });
      const foundAccountIdSet = new Set(foundAccounts.map((a) => a.id));
      for (const accId of mappedAccountIds) {
        if (!foundAccountIdSet.has(accId)) {
          throw new BadRequestException(
            `Account mapping references an invalid account: ${accId}`,
          );
        }
      }
    }

    // Batch-validate categories
    const mappedCategoryIds = [
      ...new Set([...categoryMap.values()].filter(Boolean) as string[]),
    ];
    if (mappedCategoryIds.length > 0) {
      const foundCategories = await this.categoriesRepository.find({
        where: { id: In(mappedCategoryIds), userId },
        select: ["id"],
      });
      const foundCategoryIdSet = new Set(foundCategories.map((c) => c.id));
      for (const catId of mappedCategoryIds) {
        if (!foundCategoryIdSet.has(catId)) {
          throw new BadRequestException(
            `Category mapping references an invalid category: ${catId}`,
          );
        }
      }
    }

    // Batch-validate securities
    const mappedSecurityIds = [
      ...new Set([...securityMap.values()].filter(Boolean) as string[]),
    ];
    if (mappedSecurityIds.length > 0) {
      const foundSecurities = await this.dataSource
        .getRepository("Security")
        .find({ where: { id: In(mappedSecurityIds), userId }, select: ["id"] });
      const foundSecurityIdSet = new Set(
        foundSecurities.map((s: { id: string }) => s.id),
      );
      for (const secId of mappedSecurityIds) {
        if (!foundSecurityIdSet.has(secId)) {
          throw new BadRequestException(
            `Security mapping references an invalid security: ${secId}`,
          );
        }
      }
    }
  }

  private async postImportProcessing(
    userId: string,
    isInvestment: boolean,
    affectedAccountIds: Set<string>,
  ): Promise<void> {
    if (isInvestment) {
      try {
        this.logger.log("Post-import: backfilling historical security prices");
        await this.securityPriceService.backfillHistoricalPrices();
        this.logger.log("Post-import: historical price backfill complete");
      } catch (err) {
        this.logger.warn(
          `Post-import historical price backfill failed: ${err.message}`,
        );
      }

      try {
        this.logger.log("Post-import: backfilling transaction-derived prices");
        await this.securityPriceService.backfillTransactionPrices();
        this.logger.log("Post-import: transaction price backfill complete");
      } catch (err) {
        this.logger.warn(
          `Post-import transaction price backfill failed: ${err.message}`,
        );
      }
    }

    try {
      this.logger.log("Post-import: backfilling historical exchange rates");
      await this.exchangeRateService.backfillHistoricalRates(
        userId,
        Array.from(affectedAccountIds),
      );
      this.logger.log("Post-import: historical rate backfill complete");
    } catch (err) {
      this.logger.warn(
        `Post-import historical rate backfill failed: ${err.message}`,
      );
    }

    for (const accountId of affectedAccountIds) {
      this.netWorthService
        .recalculateAccount(userId, accountId)
        .catch((err) =>
          this.logger.warn(
            `Post-import net worth recalc failed for account ${accountId}: ${err.message}`,
          ),
        );
    }
  }

  /**
   * Collect all unique tag names from parsed transactions (and splits),
   * then find or create each tag. Populates tagMap with lowercase name -> tag ID.
   */
  private async resolveImportTags(
    queryRunner: any,
    userId: string,
    result: QifParseResult,
    tagMap: Map<string, string>,
  ): Promise<void> {
    // Collect all unique tag names
    const tagNamesSet = new Set<string>();
    for (const tx of result.transactions) {
      for (const name of tx.tagNames ?? []) {
        tagNamesSet.add(name);
      }
      for (const split of tx.splits) {
        for (const name of split.tagNames ?? []) {
          tagNamesSet.add(name);
        }
      }
    }

    if (tagNamesSet.size === 0) return;

    // Load existing tags for this user
    const existingTags = await queryRunner.manager.find(Tag, {
      where: { userId },
    });

    // Build case-insensitive lookup
    const existingByName = new Map<string, Tag>();
    for (const tag of existingTags) {
      existingByName.set(tag.name.toLowerCase(), tag);
    }

    // Find or create each tag
    for (const name of tagNamesSet) {
      const key = name.toLowerCase();
      const existing = existingByName.get(key);
      if (existing) {
        tagMap.set(key, existing.id);
      } else {
        const newTag = queryRunner.manager.create(Tag, {
          userId,
          name,
        });
        const saved = await queryRunner.manager.save(newTag);
        tagMap.set(key, saved.id);
        existingByName.set(key, saved);
      }
    }
  }

  async getExistingCategories(userId: string): Promise<Category[]> {
    return this.categoriesRepository.find({
      where: { userId },
      order: { name: "ASC" },
    });
  }

  async getExistingAccounts(userId: string): Promise<Account[]> {
    return this.accountsRepository.find({
      where: { userId },
      order: { name: "ASC" },
    });
  }
}
