import {
  Injectable,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { Account, AccountSubType } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { parseQif, validateQifContent } from "./qif-parser";
import {
  ImportQifDto,
  ParsedQifResponseDto,
  ImportResultDto,
  CategoryMappingDto,
  AccountMappingDto,
  SecurityMappingDto,
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

  async parseQifFile(
    userId: string,
    content: string,
  ): Promise<ParsedQifResponseDto> {
    const validation = validateQifContent(content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const result = parseQif(content);

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

  async importQifFile(
    userId: string,
    dto: ImportQifDto,
  ): Promise<ImportResultDto> {
    const validation = validateQifContent(dto.content);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const account = await this.accountsRepository.findOne({
      where: { id: dto.accountId, userId },
    });
    if (!account) {
      throw new BadRequestException("Account not found");
    }

    const result = parseQif(dto.content, dto.dateFormat as any);

    // Validate QIF type matches destination account type
    const isQifInvestment = result.accountType === "INVESTMENT";
    const isAccountBrokerage =
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE;

    if (isQifInvestment && !isAccountBrokerage) {
      throw new BadRequestException(
        "This QIF file contains investment transactions but the selected account is not an investment brokerage account. " +
          "Please select a brokerage account for this import.",
      );
    }

    if (!isQifInvestment && isAccountBrokerage) {
      throw new BadRequestException(
        "This QIF file contains regular banking transactions but the selected account is an investment brokerage account. " +
          "Please select a cash account (including investment cash accounts) for this import.",
      );
    }

    // Build mapping lookups
    const { categoryMap, categoriesToCreate, loanCategoryMap, loanAccountsToCreate } =
      this.buildCategoryMappings(dto.categoryMappings);
    const { accountMap, accountsToCreate } =
      this.buildAccountMappings(dto.accountMappings);
    const { securityMap, securitiesToCreate } =
      this.buildSecurityMappings(dto.securityMappings);

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
    affectedAccountIds.add(dto.accountId);
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
      accountId: dto.accountId,
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
        queryRunner, userId, categoriesToCreate, categoryMap, importResult,
      );
      await this.entityCreator.createAccounts(
        queryRunner, userId, accountsToCreate, accountMap, account, importResult,
      );
      await this.entityCreator.createLoanAccounts(
        queryRunner, userId, loanAccountsToCreate, loanCategoryMap, account, importResult,
      );
      await this.entityCreator.createSecurities(
        queryRunner, userId, securitiesToCreate, securityMap, account, importResult,
      );

      // Apply opening balance
      if (result.openingBalance !== null) {
        await this.entityCreator.applyOpeningBalance(
          queryRunner, dto.accountId, account, result.openingBalance,
        );
      }

      // Import transactions
      let txIndex = 0;
      const totalTransactions = result.transactions.length;
      for (const qifTx of result.transactions) {
        txIndex++;
        try {
          if (isQifInvestment) {
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
    await this.postImportProcessing(userId, isQifInvestment, affectedAccountIds);

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

    return { categoryMap, categoriesToCreate, loanCategoryMap, loanAccountsToCreate };
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
    const mappedAccountIds = [
      ...accountMap.values(),
      ...Array.from(loanCategoryMap.values()),
    ].filter(Boolean) as string[];
    for (const accId of mappedAccountIds) {
      const acc = await this.accountsRepository.findOne({
        where: { id: accId, userId },
      });
      if (!acc) {
        throw new BadRequestException(
          `Account mapping references an invalid account: ${accId}`,
        );
      }
    }

    const mappedCategoryIds = [...categoryMap.values()].filter(
      Boolean,
    ) as string[];
    for (const catId of mappedCategoryIds) {
      const cat = await this.dataSource
        .getRepository("Category")
        .findOne({ where: { id: catId, userId } });
      if (!cat) {
        throw new BadRequestException(
          `Category mapping references an invalid category: ${catId}`,
        );
      }
    }

    const mappedSecurityIds = [...securityMap.values()].filter(
      Boolean,
    ) as string[];
    for (const secId of mappedSecurityIds) {
      const sec = await this.dataSource
        .getRepository("Security")
        .findOne({ where: { id: secId, userId } });
      if (!sec) {
        throw new BadRequestException(
          `Security mapping references an invalid security: ${secId}`,
        );
      }
    }
  }

  private async postImportProcessing(
    userId: string,
    isQifInvestment: boolean,
    affectedAccountIds: Set<string>,
  ): Promise<void> {
    if (isQifInvestment) {
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
