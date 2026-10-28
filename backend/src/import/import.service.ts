import {
  prepareImportAccrualSources,
  assertImportAccrualIds,
} from "./import-accrual-guard";
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { DataSource, EntityManager, In, IsNull } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { lockHoldingScope } from "../common/db/locks";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
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
import {
  accountsMissingType,
  applyAccountTypeChoices,
} from "./qif-account-type-choice";
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
import {
  ImportContext,
  recordSkippedRow,
  restoreRowCounters,
  snapshotRowCounters,
  updateAccountBalance,
} from "./import-context";
import { loadHeldExternalIds } from "./ofx-external-id";
import { isExternalIdConflict } from "../transactions/transaction-external-id";
import { ImportEntityCreatorService } from "./import-entity-creator.service";
import { ImportPostProcessingService } from "./import-post-processing.service";
import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { orderByDateStable } from "../common/date-order.util";
import { Security } from "../securities/entities/security.entity";
import { HoldingsService } from "../securities/holdings.service";
import { Tag } from "../tags/entities/tag.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { tr } from "../i18n/translate";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";
import { insertCategoryIfAbsent } from "./insert-category-if-absent";
import { splitCategoryPath } from "./category-path.util";

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private dataSource: DataSource,
    private postProcessing: ImportPostProcessingService,
    private entityCreator: ImportEntityCreatorService,
    private investmentProcessor: ImportInvestmentProcessorService,
    private regularProcessor: ImportRegularProcessorService,
    private rulesApplier: TransactionRulesApplierService,
    @Inject(forwardRef(() => HoldingsService))
    private holdingsService: HoldingsService,
  ) {}

  /**
   * Take the holdings advisory lock for every investment account this import
   * can reach, as the first lock of the import's transaction.
   *
   * Advisory locks come before row locks (`common/db/locks.ts`). An import
   * row-locks `accounts` on every balance write and only then reached
   * `rebuildImportedHoldings`, which takes the advisory lock -- the opposite
   * order from an investment write, so an import running beside a trade on
   * the same account could deadlock both (40P01).
   *
   * The scope is every investment account the user already has rather than
   * the set the import turns out to touch, because that set is discovered as
   * the file is read. Accounts the import creates inside this transaction are
   * covered by the rebuild's own re-entrant call: no other transaction can
   * see them, so nothing can be holding their lock.
   */
  private async lockImportedHoldingScopes(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    const accounts = await manager.find(Account, {
      where: { userId, accountType: AccountType.INVESTMENT },
      select: ["id"],
    });
    await lockHoldingScope(
      manager,
      accounts.map((account) => account.id),
    );
  }

  /**
   * Re-derive the imported accounts' holdings from the ledger the import has
   * just written, inside the import's own transaction.
   *
   * An import arrives in file order, which is not date order. A per-row
   * incremental average cost therefore blended a later-dated purchase into a
   * position that, replayed, had already been sold down -- the stored figure
   * and `POST /holdings/rebuild` disagreed (issue #1388). The rebuild filters
   * non-investment accounts out itself, so the caller passes whatever it
   * touched.
   */
  private async rebuildImportedHoldings(
    manager: EntityManager,
    userId: string,
    accountIds: Iterable<string>,
  ): Promise<void> {
    const ids = Array.from(new Set(accountIds));
    if (ids.length === 0) return;
    await this.holdingsService.rebuildAccountsFromTransactions(
      userId,
      ids,
      manager,
    );
  }

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

    const parsed = parseQifFull(dto.content, dto.dateFormat as DateFormat);
    const result: QifFullParseResult = {
      ...parsed,
      accountBlocks: applyAccountTypeChoices(
        parsed.accountBlocks,
        dto.accountTypes,
      ),
    };

    if (result.accountBlocks.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.import.noAccountBlocks",
          "No account blocks found in QIF file. This file may not be a multi-account export.",
        ),
      );
    }

    // An account the file gives no type is never created under an assumed
    // one; the review step asks, and the import refuses before writing.
    const untyped = accountsMissingType(result.accountBlocks);
    if (untyped.length > 0) {
      throw new BadRequestException(
        tr(
          "errors.import.accountTypeRequired",
          `Choose an account type for: ${untyped.join(", ")}`,
          { accounts: untyped.join(", ") },
        ),
      );
    }

    const affectedAccountIds = new Set<string>();
    const settledScheduleIds = new Set<string>();
    const importStartTime = new Date();
    let hasInvestment = false;

    const importResult: ImportResultDto = {
      imported: 0,
      skipped: 0,
      skippedRows: [],
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

    // One transaction for the whole multi-account import, exactly as the former
    // QueryRunner block was: per-transaction SAVEPOINTs inside it let a single
    // bad row roll back without discarding the rest of the file.
    try {
      await withScopedDb(this.dataSource, async (manager) => {
        // First lock of the transaction: advisory before row locks.
        await this.lockImportedHoldingScopes(manager, userId);
        await prepareImportAccrualSources(manager, userId);

        // The user's import-trigger rules, once for the whole file (design 6.3).
        const importRules = await this.rulesApplier.loadRulesFor(
          manager,
          userId,
          "import",
        );

        // Step 1: Create categories from !Type:Cat definitions. `categoryMap`
        // is keyed by the full path a transaction names; `processedCategories`
        // by one level ("name|parentId"), shared so step 1b reuses step 1's.
        const categoryMap = new Map<string, string | null>();
        const processedCategories = new Map<string, string>();
        await this.createCategoriesFromDefs(
          manager,
          userId,
          result.categoryDefs,
          categoryMap,
          processedCategories,
          importResult,
        );

        // Step 1b: Also create categories referenced in transaction L-lines
        // that are not covered by !Type:Cat (common in Quicken exports)
        await this.createCategoriesFromBlocks(
          manager,
          userId,
          result.accountBlocks,
          categoryMap,
          processedCategories,
          importResult,
        );

        // Step 2: Create accounts from !Account blocks
        const accountNameToId = new Map<string, string>();
        await this.createAccountsFromBlocks(
          manager,
          userId,
          result.accountBlocks,
          dto.currencyCode,
          accountNameToId,
          importResult,
        );

        // Step 3: Build transfer account map from all known accounts
        // Include both newly created and pre-existing accounts so transfers resolve correctly
        const accountMap = new Map<string, string | null>();
        const allUserAccounts = await manager.find(Account, {
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
        await this.createTagsFromDefs(manager, userId, result.tagDefs, tagMap);
        await this.resolveMultiAccountTags(
          manager,
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
            ? await manager.findOne(Account, {
                where: { id: refAccountId },
              })
            : undefined;

          if (refAccount) {
            await this.entityCreator.createSecurities(
              manager,
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

          let account = await manager.findOne(Account, {
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
            const brokerageAccount = await manager.findOne(Account, {
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
            manager,
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
            settledScheduleIds,
            importResult,
            transferDupCounts: new Map(),
            // A QIF file carries no bank ids.
            heldExternalIds: new Map(),
            importRules,
          };

          // Apply opening balance
          if (block.openingBalance !== null) {
            await this.entityCreator.applyOpeningBalance(
              manager,
              accountId,
              account,
              block.openingBalance,
            );
          }

          // Process transactions oldest first, and within a date in file
          // order, so a rule that settles loan installments folds forward
          // through time (INV-RULE-005). `txIndex` stays the row's place in
          // the file, which the messages name.
          for (const { row: qifTx, position: txIndex } of orderByDateStable(
            block.transactions,
            (row) => row.date,
          )) {
            try {
              const savepointName = `tx_import_${txIndex}`;
              await manager.query(`SAVEPOINT ${savepointName}`);
              const counters = snapshotRowCounters(importResult);
              try {
                if (isInvestment) {
                  await this.investmentProcessor.processTransaction(ctx, qifTx);
                } else {
                  await this.regularProcessor.processTransaction(ctx, qifTx);
                }
                await manager.query(`RELEASE SAVEPOINT ${savepointName}`);
              } catch (error) {
                await manager.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
                restoreRowCounters(importResult, counters);
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

          // An investment file after which a removal of a bond-program security
          // is not covered by the lots is refused as a whole (INV-BOND-007); the
          // rows are not in date order, so it is checked once, here.
          await ctx.bond?.guard.verify();
        }

        await this.rebuildImportedHoldings(manager, userId, affectedAccountIds);

        // Post-block cleanup: detect and remove Quicken merged split transfers
        // that were imported before their split counterparts (reverse block order).
        await this.cleanupMergedSplitTransfers(
          manager,
          userId,
          affectedAccountIds,
          importStartTime,
          importResult,
        );
      });
    } catch (error) {
      this.logger.error(
        `Multi-account import failed after ${importResult.imported} transactions`,
        error.stack,
      );
      throw new BadRequestException(
        tr(
          "errors.import.importFailed",
          `Import failed after ${importResult.imported} transactions: ${error.message}`,
          { imported: importResult.imported, message: error.message },
        ),
      );
    }

    // Post-import processing
    await this.postImportProcessing(
      userId,
      hasInvestment,
      affectedAccountIds,
      settledScheduleIds,
    );

    // Detect loan/mortgage accounts needing payment setup
    importResult.loanAccountsNeedingSetup =
      await this.findLoanAccountsNeedingSetup(userId, affectedAccountIds);

    return importResult;
  }

  /**
   * Create categories from !Type:Cat definitions.
   * Every colon is a level (e.g., "Housing:Mortgage:Interest" is three
   * categories, each the parent of the next); see `splitCategoryPath`.
   * Sets isIncome based on QIF I/E flags.
   */
  private async createCategoriesFromDefs(
    manager: EntityManager,
    userId: string,
    categoryDefs: QifFullParseResult["categoryDefs"],
    categoryMap: Map<string, string | null>,
    processedCategories: Map<string, string>,
    importResult: ImportResultDto,
  ): Promise<void> {
    for (const def of categoryDefs) {
      // For Quicken categories starting with underscore, use description as name
      const effectiveName =
        def.name.startsWith("_") && def.description
          ? def.description
          : def.name;

      const leafId = await this.findOrCreateCategoryPath(
        manager,
        userId,
        splitCategoryPath(effectiveName),
        def.isIncome,
        processedCategories,
        importResult,
      );
      if (leafId === null) continue;

      // Map the full effective name for transaction category resolution
      categoryMap.set(effectiveName, leafId);
      // Also map the original QIF name if it differs (underscore substitution)
      if (def.name !== effectiveName) {
        categoryMap.set(def.name, leafId);
      }
    }
  }

  /**
   * Find or create every level of a category path, root first, and return the
   * id of the last one; null for a path with no segments.
   *
   * The caller maps the id to the full path. No level is mapped by its bare
   * name: "Interest" under "Housing:Mortgage" is not the top-level "Interest",
   * and a bare-name entry would file transactions and later paths under the
   * wrong branch.
   */
  private async findOrCreateCategoryPath(
    manager: EntityManager,
    userId: string,
    segments: readonly string[],
    isIncome: boolean,
    processedCategories: Map<string, string>,
    importResult: ImportResultDto,
  ): Promise<string | null> {
    let parentId: string | null = null;
    for (const segment of segments) {
      parentId = await this.findOrCreateCategoryDef(
        manager,
        userId,
        segment,
        parentId,
        isIncome,
        processedCategories,
        importResult,
      );
    }
    return parentId;
  }

  private async findOrCreateCategoryDef(
    manager: EntityManager,
    userId: string,
    name: string,
    parentId: string | null,
    isIncome: boolean,
    processedCategories: Map<string, string>,
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

    const existing = await manager.findOne(Category, {
      where: whereClause,
    });

    if (existing) {
      processedCategories.set(cacheKey, existing.id);
      return existing.id;
    }

    // Adopts a row another transaction created since the lookup above rather
    // than aborting the whole import on its unique violation (INV-IMPORT-003).
    const saved = await insertCategoryIfAbsent(manager, {
      userId,
      name,
      parentId,
      isIncome,
    });
    processedCategories.set(cacheKey, saved.id);
    if (saved.inserted) {
      importResult.categoriesCreated++;
    }
    return saved.id;
  }

  /**
   * Create categories referenced in transaction L-lines across all account blocks
   * that were not already created from !Type:Cat definitions.
   * This handles Quicken exports where some categories are used in transactions
   * but missing from the !Type:Cat section.
   */
  private async createCategoriesFromBlocks(
    manager: EntityManager,
    userId: string,
    blocks: QifFullParseResult["accountBlocks"],
    categoryMap: Map<string, string | null>,
    processedCategories: Map<string, string>,
    importResult: ImportResultDto,
  ): Promise<void> {
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
      const leafId = await this.findOrCreateCategoryPath(
        manager,
        userId,
        splitCategoryPath(categoryName),
        false,
        processedCategories,
        importResult,
      );
      if (leafId !== null) {
        categoryMap.set(categoryName, leafId);
      }
    }
  }

  /**
   * Create accounts from QIF account blocks.
   * Uses find-or-create to avoid duplicates.
   */
  private async createAccountsFromBlocks(
    manager: EntityManager,
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
      let existing = await manager.findOne(Account, {
        where: { userId, name: block.accountName },
      });

      // For investment accounts, also check the " - Cash" variant
      if (!existing && block.accountType === "INVESTMENT") {
        existing = await manager.findOne(Account, {
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

      // Create new account. Every named block has a type by now: the
      // import refused before its transaction began otherwise.
      const accountType = block.accountType as AccountType;

      if (accountType === AccountType.INVESTMENT) {
        // Create investment account pair
        const cashAccount = manager.create(Account, {
          userId,
          name: `${block.accountName} - Cash`,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
        });
        const savedCash = await manager.save(cashAccount);

        const brokerageAccount = manager.create(Account, {
          userId,
          name: `${block.accountName} - Brokerage`,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
          linkedAccountId: savedCash.id,
        });
        const savedBrokerage = await manager.save(brokerageAccount);

        savedCash.linkedAccountId = savedBrokerage.id;
        await manager.save(savedCash);

        accountNameToId.set(block.accountName, savedCash.id);
        importResult.accountsCreated += 2;
      } else {
        const newAccount = manager.create(Account, {
          userId,
          name: block.accountName,
          accountType,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
          creditLimit: block.creditLimit ?? null,
        });
        const saved = await manager.save(newAccount);
        accountNameToId.set(block.accountName, saved.id);
        importResult.accountsCreated++;
      }
    }
  }

  /**
   * Create tags from !Type:Tag definitions in QIF file.
   */
  private async createTagsFromDefs(
    manager: EntityManager,
    userId: string,
    tagDefs: QifFullParseResult["tagDefs"],
    tagMap: Map<string, string>,
  ): Promise<void> {
    if (tagDefs.length === 0) return;

    const existingTags = await manager.find(Tag, {
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
        const newTag = manager.create(Tag, {
          userId,
          name: def.name,
        });
        const saved = await manager.save(newTag);
        tagMap.set(key, saved.id);
        existingByName.set(key, saved);
      }
    }
  }

  /**
   * Resolve tags from all account blocks for multi-account import.
   */
  private async resolveMultiAccountTags(
    manager: EntityManager,
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

    const existingTags = await manager.find(Tag, {
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
        const newTag = manager.create(Tag, { userId, name });
        const saved = await manager.save(newTag);
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
      tags: dto.columnMapping.tags,
      reconciliationStatus: dto.columnMapping.reconciliationStatus,
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
      investmentMode: dto.columnMapping.investmentMode,
      actionColumn: dto.columnMapping.actionColumn,
      securityColumn: dto.columnMapping.securityColumn,
      quantityColumn: dto.columnMapping.quantityColumn,
      priceColumn: dto.columnMapping.priceColumn,
      commissionColumn: dto.columnMapping.commissionColumn,
      actionKeywords: dto.columnMapping.actionKeywords,
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
      dto.securityMappings || [],
      dto.dateFormat as DateFormat,
    );
  }

  // --- Column Mapping CRUD ---

  async getColumnMappings(userId: string): Promise<ColumnMappingResponseDto[]> {
    const mappings = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(ImportColumnMapping).find({
        where: { userId },
        order: { name: "ASC" },
      }),
    );
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
    // Upsert by name: read and write in one transaction so two concurrent
    // saves of the same name cannot both take the insert branch.
    const saved = await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(ImportColumnMapping);
      const existing = await repo.findOne({
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
        return repo.save(existing);
      }

      const mapping = repo.create({
        userId,
        name: dto.name,
        columnMappings: dto.columnMappings as unknown as Record<
          string,
          unknown
        >,
        transferRules: (dto.transferRules || []) as unknown as Record<
          string,
          unknown
        >[],
      });
      return repo.save(mapping);
    });
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
    // The load, the duplicate-name check and the save are one read-modify-write.
    const saved = await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(ImportColumnMapping);
      const mapping = await repo.findOne({
        where: { id, userId },
      });
      if (!mapping) {
        throw new NotFoundException(
          tr("errors.import.columnMappingNotFound", "Column mapping not found"),
        );
      }

      if (dto.name !== undefined && dto.name !== mapping.name) {
        const duplicate = await repo.findOne({
          where: { userId, name: dto.name },
        });
        if (duplicate) {
          throw new ConflictException(
            tr(
              "errors.import.columnMappingDuplicate",
              `A column mapping named "${dto.name}" already exists`,
              { name: dto.name },
            ),
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

      return repo.save(mapping);
    });
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
    await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(ImportColumnMapping);
      const mapping = await repo.findOne({
        where: { id, userId },
      });
      if (!mapping) {
        throw new NotFoundException(
          tr("errors.import.columnMappingNotFound", "Column mapping not found"),
        );
      }
      await repo.remove(mapping);
    });
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
      investmentSummary: result.investmentSummary,
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
    const account = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Account).findOne({
        where: { id: accountId, userId },
      }),
    );
    if (!account) {
      throw new NotFoundException(
        tr("errors.import.accountNotFound", "Account not found"),
      );
    }

    // Validate file type matches destination account type
    const isInvestment = result.accountType === "INVESTMENT";
    const isAccountBrokerage =
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE;

    if (isInvestment && !isAccountBrokerage) {
      throw new BadRequestException(
        tr(
          "errors.import.investmentFileNeedsBrokerageAccount",
          "This file contains investment transactions but the selected account is not an investment brokerage account. " +
            "Please select a brokerage account for this import.",
        ),
      );
    }

    if (!isInvestment && isAccountBrokerage) {
      throw new BadRequestException(
        tr(
          "errors.import.regularFileNeedsCashAccount",
          "This file contains regular banking transactions but the selected account is an investment brokerage account. " +
            "Please select a cash account (including investment cash accounts) for this import.",
        ),
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

    const affectedAccountIds = new Set<string>();
    affectedAccountIds.add(accountId);
    const settledScheduleIds = new Set<string>();
    const importStartTime = new Date();

    const importResult: ImportResultDto = {
      imported: 0,
      skipped: 0,
      skippedRows: [],
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

    // One transaction for the whole import, exactly as the former QueryRunner
    // block was: per-transaction SAVEPOINTs inside it let a single bad row roll
    // back without discarding the rest of the file.
    try {
      await withScopedDb(this.dataSource, async (manager) => {
        // First lock of the transaction: advisory before row locks.
        await this.lockImportedHoldingScopes(manager, userId);
        await prepareImportAccrualSources(manager, userId);

        const ctx: ImportContext = {
          manager,
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
          settledScheduleIds,
          importResult,
          transferDupCounts: new Map<string, number>(),
          // One lookup for every bank id the file carries, not one per row.
          heldExternalIds: isInvestment
            ? new Map()
            : await loadHeldExternalIds(
                manager,
                accountId,
                result.transactions,
              ),
          // The user's import-trigger rules, once for the whole file (design
          // 6.3). An investment file has no regular rows to evaluate.
          importRules: isInvestment
            ? []
            : await this.rulesApplier.loadRulesFor(manager, userId, "import"),
        };

        // Create new entities
        await this.entityCreator.createCategories(
          manager,
          userId,
          categoriesToCreate,
          categoryMap,
          importResult,
        );
        await this.entityCreator.createAccounts(
          manager,
          userId,
          accountsToCreate,
          accountMap,
          account,
          importResult,
        );
        await this.entityCreator.createLoanAccounts(
          manager,
          userId,
          loanAccountsToCreate,
          loanCategoryMap,
          account,
          importResult,
        );
        await this.entityCreator.createSecurities(
          manager,
          userId,
          securitiesToCreate,
          securityMap,
          account,
          importResult,
        );

        // Create or resolve tags from QIF data
        await this.resolveImportTags(manager, userId, result, ctx.tagMap);

        // Apply opening balance
        if (result.openingBalance !== null) {
          await this.entityCreator.applyOpeningBalance(
            manager,
            accountId,
            account,
            result.openingBalance,
          );
        }

        // Import transactions oldest first, and within a date in file order,
        // so a rule that settles loan installments folds forward through time
        // (INV-RULE-005). `txIndex` stays the row's place in the file, which
        // the messages name.
        const totalTransactions = result.transactions.length;
        for (const { row: qifTx, position: txIndex } of orderByDateStable(
          result.transactions,
          (row) => row.date,
        )) {
          try {
            const savepointName = `tx_import_${txIndex}`;
            await manager.query(`SAVEPOINT ${savepointName}`);
            const counters = snapshotRowCounters(importResult);
            try {
              if (isInvestment) {
                await this.investmentProcessor.processTransaction(ctx, qifTx);
              } else {
                await this.regularProcessor.processTransaction(ctx, qifTx);
              }
              await manager.query(`RELEASE SAVEPOINT ${savepointName}`);
            } catch (error) {
              await manager.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
              // The payee the row created and the rule change it counted were
              // rolled back with it, so their counters go back too.
              restoreRowCounters(importResult, counters);
              if (isExternalIdConflict(error)) {
                // Another writer committed a row holding this row's bank id
                // after the processor's lookup missed it; the unique index
                // refused this insert, so the row is already in the account.
                recordSkippedRow(
                  importResult,
                  qifTx,
                  "alreadyImported",
                  account.currencyCode,
                );
              } else {
                importResult.errors++;
                importResult.errorMessages.push(
                  `Error importing transaction ${txIndex}/${totalTransactions} on ${qifTx.date}: ${error.message}`,
                );
                this.logger.warn(
                  `Error importing transaction ${txIndex}/${totalTransactions}: ${error.message}`,
                );
              }
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

        // See the multi-account import: checked once, after the whole file.
        await ctx.bond?.guard.verify();

        await this.rebuildImportedHoldings(manager, userId, affectedAccountIds);
      });
    } catch (error) {
      this.logger.error(
        `Import failed after ${importResult.imported} transactions`,
        error.stack,
      );
      throw new BadRequestException(
        tr(
          "errors.import.importFailed",
          `Import failed after ${importResult.imported} transactions: ${error.message}`,
          { imported: importResult.imported, message: error.message },
        ),
      );
    }

    // Post-import processing
    await this.postImportProcessing(
      userId,
      isInvestment,
      affectedAccountIds,
      settledScheduleIds,
    );

    // Detect loan/mortgage accounts needing payment setup
    importResult.loanAccountsNeedingSetup =
      await this.findLoanAccountsNeedingSetup(userId, affectedAccountIds);

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
      const foundAccounts = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).find({
          where: { id: In(mappedAccountIds), userId },
          select: ["id"],
        }),
      );
      const foundAccountIdSet = new Set(foundAccounts.map((a) => a.id));
      for (const accId of mappedAccountIds) {
        if (!foundAccountIdSet.has(accId)) {
          throw new BadRequestException(
            tr(
              "errors.import.invalidAccountMapping",
              `Account mapping references an invalid account: ${accId}`,
              { accId },
            ),
          );
        }
      }
    }

    // Batch-validate categories
    const mappedCategoryIds = [
      ...new Set([...categoryMap.values()].filter(Boolean) as string[]),
    ];
    if (mappedCategoryIds.length > 0) {
      const foundCategories = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Category).find({
          where: { id: In(mappedCategoryIds), userId },
          select: ["id"],
        }),
      );
      const foundCategoryIdSet = new Set(foundCategories.map((c) => c.id));
      for (const catId of mappedCategoryIds) {
        if (!foundCategoryIdSet.has(catId)) {
          throw new BadRequestException(
            tr(
              "errors.import.invalidCategoryMapping",
              `Category mapping references an invalid category: ${catId}`,
              { catId },
            ),
          );
        }
      }
    }

    // Batch-validate securities
    const mappedSecurityIds = [
      ...new Set([...securityMap.values()].filter(Boolean) as string[]),
    ];
    if (mappedSecurityIds.length > 0) {
      const foundSecurities = await withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Security).find({
          where: { id: In(mappedSecurityIds), userId },
          select: ["id"],
        }),
      );
      const foundSecurityIdSet = new Set(foundSecurities.map((sec) => sec.id));
      for (const secId of mappedSecurityIds) {
        if (!foundSecurityIdSet.has(secId)) {
          throw new BadRequestException(
            tr(
              "errors.import.invalidSecurityMapping",
              `Security mapping references an invalid security: ${secId}`,
              { secId },
            ),
          );
        }
      }
    }
  }

  /**
   * Detect and remove Quicken merged split transfers.
   *
   * When Quicken exports a split transaction with multiple splits to the same
   * destination account, it merges them into a single transaction on the
   * receiving side. Since we create individual split-linked transactions for
   * each split, the merged transaction is a duplicate that inflates balances.
   *
   * This handles the case where the merged transfer was imported before its
   * split counterparts (i.e., the receiving account block appeared first in
   * the QIF file). The isDuplicateTransfer check in ImportRegularProcessorService
   * handles the reverse order.
   */
  private async cleanupMergedSplitTransfers(
    manager: EntityManager,
    userId: string,
    affectedAccountIds: Set<string>,
    importStartTime: Date,
    importResult: ImportResultDto,
  ): Promise<void> {
    if (affectedAccountIds.size === 0) return;

    const accountIds = Array.from(affectedAccountIds);

    // Find transfer transactions created during this import that are NOT
    // referenced by any TransactionSplit (i.e., standalone transfers, not
    // individual split-linked transfers created by processSplitTransfer).
    const candidates: Array<{
      id: string;
      amount: string;
      transaction_date: string;
      account_id: string;
      linked_transaction_id: string | null;
      // Selected because the deletion below must not reverse a VOID row's
      // contribution -- it has none. A raw select that omits the column would
      // hand `deletionBalanceEffect` an `undefined` status and quietly reverse it.
      status: TransactionStatus;
    }> = await manager
      .createQueryBuilder(Transaction, "t")
      .leftJoin(TransactionSplit, "split", "split.linked_transaction_id = t.id")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.account_id IN (:...accountIds)", { accountIds })
      .andWhere("t.is_transfer = true")
      .andWhere("t.is_split = false")
      .andWhere("t.created_at >= :importStartTime", { importStartTime })
      .andWhere("split.id IS NULL")
      .select([
        "t.id AS id",
        "t.amount AS amount",
        "t.transaction_date AS transaction_date",
        "t.account_id AS account_id",
        "t.linked_transaction_id AS linked_transaction_id",
        "t.status AS status",
      ])
      .getRawMany();

    if (candidates.length === 0) return;

    let mergedCount = 0;
    const warnings: string[] = [];

    for (const candidate of candidates) {
      // Determine which account is the transfer target (the other side)
      let transferAccountId: string | null = null;
      if (candidate.linked_transaction_id) {
        const linkedTx = await manager.findOne(Transaction, {
          where: { id: candidate.linked_transaction_id },
        });
        if (linkedTx) {
          transferAccountId = linkedTx.accountId;
        }
      }
      if (!transferAccountId) continue;

      // Find split-linked transactions in the same account, same date,
      // whose split parent is in the transfer account and is a split transaction.
      const splitGroups: Array<{
        parentId: string;
        totalAmount: string;
        splitCount: string;
      }> = await manager
        .createQueryBuilder(Transaction, "st")
        .innerJoin(TransactionSplit, "s", "s.linked_transaction_id = st.id")
        .innerJoin(Transaction, "parent", "s.transaction_id = parent.id")
        .where("st.user_id = :userId", { userId })
        .andWhere("st.account_id = :accountId", {
          accountId: candidate.account_id,
        })
        .andWhere("st.transaction_date = :date", {
          date: candidate.transaction_date,
        })
        .andWhere("st.is_transfer = true")
        .andWhere("parent.account_id = :transferAccountId", {
          transferAccountId,
        })
        .andWhere("parent.is_split = true")
        .select("parent.id", "parentId")
        .addSelect("SUM(st.amount)", "totalAmount")
        .addSelect("COUNT(*)", "splitCount")
        .groupBy("parent.id")
        .getRawMany();

      let matched = false;
      for (const group of splitGroups) {
        const total = Math.round(Number(group.totalAmount) * 10000);
        const expected = Math.round(Number(candidate.amount) * 10000);
        if (total === expected && Number(group.splitCount) >= 2) {
          // Reliable match: delete the merged transfer and its linked counterpart
          const linkedId = candidate.linked_transaction_id;
          await assertImportAccrualIds(manager, userId, [
            candidate.id,
            linkedId,
          ]);

          // Reverse only what each row contributed: a VOID or future-dated row
          // was never in the balance, and reversing it would create money.
          // `needsRecalc` (the future-dated case) is deliberately subsumed
          // here rather than acted on: the import pipeline ends with
          // ImportPostProcessingService recomputing every account in
          // `affectedAccountIds` absolutely, so membership in that set is the
          // recalculation -- which is why each deleted row's account is added
          // to it below.
          const candidateDelta = deletionBalanceEffect({
            amount: candidate.amount,
            status: candidate.status,
            transactionDate: candidate.transaction_date,
          }).delta;
          if (candidateDelta !== 0) {
            await updateAccountBalance(
              manager,
              candidate.account_id,
              candidateDelta,
            );
          }
          affectedAccountIds.add(candidate.account_id);

          if (linkedId) {
            const linkedTx = await manager.findOne(Transaction, {
              where: { id: linkedId },
            });
            if (linkedTx) {
              const linkedDelta = deletionBalanceEffect(linkedTx).delta;
              if (linkedDelta !== 0) {
                await updateAccountBalance(
                  manager,
                  linkedTx.accountId,
                  linkedDelta,
                );
              }
              // The counterpart can live in an account this import never
              // touched; without this the post-import recompute skips it.
              affectedAccountIds.add(linkedTx.accountId);
              await manager.delete(Transaction, linkedId);
            }
          }

          await manager.delete(Transaction, candidate.id);
          mergedCount++;
          matched = true;

          this.logger.log(
            `Deleted Quicken merged split transfer: ${candidate.amount} on ${candidate.transaction_date} ` +
              `(matched sum of ${group.splitCount} split transfers from parent ${group.parentId})`,
          );
          break;
        }
      }

      if (!matched && splitGroups.length > 0) {
        // There are split-linked transfers from the same source on the same date
        // but the amounts do not match exactly. Flag for manual review.
        const groupSummaries = splitGroups.map(
          (g) =>
            `parent ${g.parentId}: ${g.splitCount} splits totaling ${Number(g.totalAmount).toFixed(2)}`,
        );
        warnings.push(
          `Suspect merged transfer: ${Number(candidate.amount).toFixed(2)} on ${candidate.transaction_date} ` +
            `in account ${candidate.account_id}. ` +
            `Related split groups: ${groupSummaries.join("; ")}. ` +
            `This may be a Quicken merged split transfer that needs manual removal.`,
        );
      }
    }

    if (mergedCount > 0) {
      importResult.mergedTransfersDeleted = mergedCount;
      this.logger.log(
        `Cleaned up ${mergedCount} Quicken merged split transfer(s)`,
      );
    }

    if (warnings.length > 0) {
      importResult.warnings = [...(importResult.warnings || []), ...warnings];
    }
  }

  /**
   * Shared with the `.mny` pipeline: balance recalculation, price/FX backfill
   * and net-worth recalc live in `ImportPostProcessingService` so both importers
   * run one implementation. See that file for why the balance query matters.
   */
  private async postImportProcessing(
    userId: string,
    isInvestment: boolean,
    affectedAccountIds: Set<string>,
    settledScheduleIds: ReadonlySet<string>,
  ): Promise<void> {
    await this.postProcessing.run(
      userId,
      isInvestment,
      affectedAccountIds,
      settledScheduleIds,
    );
  }

  /**
   * Find loan/mortgage accounts among the affected accounts that do not yet
   * have a scheduled payment configured. Returns info for the frontend to
   * prompt the user to set up recurring payments.
   */
  private async findLoanAccountsNeedingSetup(
    userId: string,
    affectedAccountIds: Set<string>,
  ): Promise<
    Array<{
      accountId: string;
      accountName: string;
      accountType: string;
      currencyCode: string;
    }>
  > {
    if (affectedAccountIds.size === 0) return [];

    const accounts = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Account).find({
        where: { userId },
      }),
    );

    const loanTypes = new Set([AccountType.LOAN, AccountType.MORTGAGE]);

    return accounts
      .filter(
        (a) =>
          affectedAccountIds.has(a.id) &&
          loanTypes.has(a.accountType) &&
          !a.scheduledTransactionId,
      )
      .map((a) => ({
        accountId: a.id,
        accountName: a.name,
        accountType: a.accountType,
        currencyCode: a.currencyCode,
      }));
  }

  /**
   * Collect all unique tag names from parsed transactions (and splits),
   * then find or create each tag. Populates tagMap with lowercase name -> tag ID.
   */
  private async resolveImportTags(
    manager: EntityManager,
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
    const existingTags = await manager.find(Tag, {
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
        const newTag = manager.create(Tag, {
          userId,
          name,
        });
        const saved = await manager.save(newTag);
        tagMap.set(key, saved.id);
        existingByName.set(key, saved);
      }
    }
  }

  async getExistingCategories(userId: string): Promise<Category[]> {
    return withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Category).find({
        where: { userId },
        order: { name: "ASC" },
      }),
    );
  }

  async getExistingAccounts(userId: string): Promise<Account[]> {
    return withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Account).find({
        where: { userId },
        order: { name: "ASC" },
      }),
    );
  }
}
