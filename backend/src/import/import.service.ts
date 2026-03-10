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
import { Repository, DataSource, In } from "typeorm";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ImportColumnMapping } from "./entities/import-column-mapping.entity";
import { parseQif, validateQifContent, DateFormat } from "./qif-parser";
import type { QifParseResult } from "./qif-parser";
import { parseOfx, validateOfxContent } from "./ofx-parser";
import {
  parseCsv,
  parseCsvHeaders as parseCsvHeadersFn,
  validateCsvContent,
} from "./csv-parser";
import type { CsvColumnMappingConfig, CsvTransferRule } from "./csv-parser";
import {
  ImportQifDto,
  ImportOfxDto,
  ImportCsvDto,
  ParsedQifResponseDto,
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
      memo: dto.columnMapping.memo,
      referenceNumber: dto.columnMapping.referenceNumber,
      dateFormat: dto.columnMapping.dateFormat as DateFormat,
      hasHeader: dto.columnMapping.hasHeader,
      delimiter: dto.columnMapping.delimiter,
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

  async getColumnMappings(
    userId: string,
  ): Promise<ColumnMappingResponseDto[]> {
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
      throw new ConflictException(
        `A column mapping named "${dto.name}" already exists`,
      );
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
      mapping.columnMappings =
        dto.columnMappings as unknown as Record<string, unknown>;
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
    dateFormat?: DateFormat,
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
      importStartTime,
      dateCounters: new Map<string, number>(),
      affectedAccountIds,
      importResult,
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
          if (isInvestment) {
            await this.investmentProcessor.processTransaction(ctx, qifTx);
          } else {
            await this.regularProcessor.processTransaction(ctx, qifTx);
          }
        } catch (error) {
          importResult.errors++;
          importResult.errorMessages.push(
            `Error importing transaction ${txIndex}/${totalTransactions} on ${qifTx.date}: ${error.message}`,
          );
          this.logger.warn(
            `Error importing transaction ${txIndex}/${totalTransactions}: ${error.message}`,
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
    await this.postImportProcessing(
      userId,
      isInvestment,
      affectedAccountIds,
    );

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
