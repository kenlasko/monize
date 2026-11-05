import { Injectable } from "@nestjs/common";
import { EntityManager, IsNull } from "typeorm";
import { applyOpeningBalanceChange } from "../accounts/accounts.service";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { returnedRows } from "../common/db/query-result";
import { Security } from "../securities/entities/security.entity";
import {
  ImportResultDto,
  CategoryMappingDto,
  AccountMappingDto,
  SecurityMappingDto,
} from "./dto/import.dto";
import { splitCategoryPath } from "./category-path.util";
import { assertAccountCurrencyKindIn } from "../accounts/account-currency-kind.util";
import { assertSecurityCurrencyIsFiatIn } from "../securities/security-currency-kind.util";

/**
 * Map stock exchanges to their primary currency.
 */
const EXCHANGE_CURRENCY_MAP: Record<string, string> = {
  // North America
  NYSE: "USD",
  NASDAQ: "USD",
  AMEX: "USD",
  NYSEARCA: "USD",
  ARCA: "USD",
  BATS: "USD",
  TSX: "CAD",
  "TSX-V": "CAD",
  TSXV: "CAD",
  NEO: "CAD",
  CSE: "CAD",
  // Europe
  LSE: "GBP",
  LON: "GBP",
  XETRA: "EUR",
  FRA: "EUR",
  FRANKFURT: "EUR",
  EPA: "EUR",
  PARIS: "EUR",
  AMS: "EUR",
  MIL: "EUR",
  STO: "SEK",
  // Asia-Pacific
  TYO: "JPY",
  TOKYO: "JPY",
  HKG: "HKD",
  HKEX: "HKD",
  SHA: "CNY",
  SHE: "CNY",
  ASX: "AUD",
  KRX: "KRW",
  TAI: "TWD",
  SGX: "SGD",
  BSE: "INR",
  NSE: "INR",
};

function getCurrencyFromExchange(
  exchange: string | null | undefined,
): string | null {
  if (!exchange) return null;
  const normalized = exchange.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return EXCHANGE_CURRENCY_MAP[normalized] || null;
}

@Injectable()
export class ImportEntityCreatorService {
  async createCategories(
    manager: EntityManager,
    userId: string,
    categoriesToCreate: CategoryMappingDto[],
    categoryMap: Map<string, string | null>,
    importResult: ImportResultDto,
  ): Promise<void> {
    const processedCategories = new Map<string, string>();
    for (const catMapping of categoriesToCreate) {
      const categoryName = catMapping.createNew;
      let parentId = catMapping.parentCategoryId || null;

      // If a new parent category name is provided, create (or find) the parent
      // first. It is a colon-delimited path ("Housing:Mortgage"), so every
      // level of a deeper QIF or CSV category gets its own row.
      if (!parentId && catMapping.createNewParentCategoryName) {
        parentId = await this.findOrCreateParentCategoryPath(
          manager,
          userId,
          catMapping.createNewParentCategoryName,
          processedCategories,
          importResult,
        );
      }

      const cacheKey = `${categoryName}|${parentId || "null"}`;

      if (processedCategories.has(cacheKey)) {
        categoryMap.set(
          catMapping.originalName,
          processedCategories.get(cacheKey)!,
        );
        continue;
      }

      const existingCategory = await manager.findOne(Category, {
        where: {
          userId,
          name: categoryName,
          parentId: parentId || IsNull(),
        },
      });

      if (existingCategory) {
        categoryMap.set(catMapping.originalName, existingCategory.id);
        processedCategories.set(cacheKey, existingCategory.id);
        continue;
      }

      const created = await this.insertCategoryIfAbsent(
        manager,
        userId,
        // A mapping selected for creation always carries the new name, the same
        // assumption `createAccounts` makes of `accMapping.createNew`.
        categoryName!,
        parentId ?? null,
      );
      categoryMap.set(catMapping.originalName, created.id);
      processedCategories.set(cacheKey, created.id);
      if (created.inserted) importResult.categoriesCreated++;
      importResult.createdMappings!.categories[catMapping.originalName] =
        created.id;
    }
  }

  /**
   * Find or create every level of a parent path, root first, and return the id
   * of the deepest; null when the path has no segments (the new category is
   * then top-level).
   */
  private async findOrCreateParentCategoryPath(
    manager: EntityManager,
    userId: string,
    parentPath: string,
    processedCategories: Map<string, string>,
    importResult: ImportResultDto,
  ): Promise<string | null> {
    let parentId: string | null = null;
    for (const name of splitCategoryPath(parentPath)) {
      parentId = await this.findOrCreateParentCategory(
        manager,
        userId,
        name,
        parentId,
        processedCategories,
        importResult,
      );
    }
    return parentId;
  }

  private async findOrCreateParentCategory(
    manager: EntityManager,
    userId: string,
    name: string,
    parentId: string | null,
    processedCategories: Map<string, string>,
    importResult: ImportResultDto,
  ): Promise<string> {
    const cacheKey = `${name}|${parentId || "null"}`;
    if (processedCategories.has(cacheKey)) {
      return processedCategories.get(cacheKey)!;
    }

    const existing = await manager.findOne(Category, {
      where: { userId, name, parentId: parentId ?? IsNull() },
    });

    if (existing) {
      processedCategories.set(cacheKey, existing.id);
      return existing.id;
    }

    const created = await this.insertCategoryIfAbsent(
      manager,
      userId,
      name,
      parentId,
    );
    processedCategories.set(cacheKey, created.id);
    if (created.inserted) importResult.categoriesCreated++;
    return created.id;
  }

  /**
   * Create a category unless one with the same name and parent is already there,
   * and report which of the two happened.
   *
   * The pre-checks above are a fast path, not a guarantee: `UNIQUE(user_id, name,
   * parent_id)` is what actually decides, and an import runs as one long
   * transaction, so a unique violation does not merely fail this row -- it aborts
   * the entire import. A user creating "Groceries" by hand while their CSV import
   * is running was enough to lose the whole thing. `ON CONFLICT DO NOTHING` lets
   * the insert lose and adopt what is there instead.
   *
   * No conflict target, so it covers the constraint however it is spelled. Note
   * that the constraint does not constrain top-level categories at all --
   * `parent_id` is NULL there and NULL never equals NULL -- so two of those can
   * still both be created. That is a schema gap rather than one this statement
   * can close; see the note in `database/CLAUDE.md` about `COALESCE` in a unique
   * index over a nullable column.
   */
  private async insertCategoryIfAbsent(
    manager: EntityManager,
    userId: string,
    name: string,
    parentId: string | null,
  ): Promise<{ id: string; inserted: boolean }> {
    const rows: unknown = await manager.query(
      `INSERT INTO categories (user_id, name, parent_id, is_income)
       VALUES ($1, $2, $3, false)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [userId, name, parentId],
    );
    const insertedId = returnedRows<{ id: string }>(rows)[0]?.id;
    if (insertedId) {
      return { id: insertedId, inserted: true };
    }

    const existing = await manager.findOne(Category, {
      where: { userId, name, parentId: parentId ?? IsNull() },
    });
    if (!existing) {
      throw new Error(
        `Category insert for "${name}" conflicted but no matching row exists`,
      );
    }
    return { id: existing.id, inserted: false };
  }

  async createAccounts(
    manager: EntityManager,
    userId: string,
    accountsToCreate: AccountMappingDto[],
    accountMap: Map<string, string | null>,
    account: Account,
    importResult: ImportResultDto,
  ): Promise<void> {
    const processedAccounts = new Map<string, string>();
    for (const accMapping of accountsToCreate) {
      const accountName = accMapping.createNew!;
      const accountType = (accMapping.accountType as any) || "CHEQUING";
      const currencyCode = accMapping.currencyCode || account.currencyCode;

      if (processedAccounts.has(accountName)) {
        const existingId = processedAccounts.get(accountName)!;
        accountMap.set(accMapping.originalName, existingId);
        importResult.createdMappings!.accounts[accMapping.originalName] =
          existingId;
        continue;
      }

      let existingAccount = await manager.findOne(Account, {
        where: { userId, name: accountName },
      });
      if (!existingAccount && accountType === AccountType.INVESTMENT) {
        existingAccount = await manager.findOne(Account, {
          where: { userId, name: `${accountName} - Cash` },
        });
      }
      if (existingAccount) {
        const targetId =
          existingAccount.accountSubType === AccountSubType.INVESTMENT_BROKERAGE
            ? existingAccount.linkedAccountId!
            : existingAccount.id;
        accountMap.set(accMapping.originalName, targetId);
        processedAccounts.set(accountName, targetId);
        importResult.createdMappings!.accounts[accMapping.originalName] =
          targetId;
        continue;
      }

      // INV-CRYPTO-001, before this account's write; a refusal rolls the
      // whole import back.
      await assertAccountCurrencyKindIn(manager, accountType, currencyCode);

      if (accountType === AccountType.INVESTMENT) {
        const cashAccount = manager.create(Account, {
          userId,
          name: `${accountName} - Cash`,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
        });
        const savedCash = await manager.save(cashAccount);

        const brokerageAccount = manager.create(Account, {
          userId,
          name: `${accountName} - Brokerage`,
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

        accountMap.set(accMapping.originalName, savedCash.id);
        processedAccounts.set(accountName, savedCash.id);
        importResult.accountsCreated += 2;
        importResult.createdMappings!.accounts[accMapping.originalName] =
          savedCash.id;
      } else {
        const newAccount = manager.create(Account, {
          userId,
          name: accountName,
          accountType,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
        });
        const saved = await manager.save(newAccount);
        accountMap.set(accMapping.originalName, saved.id);
        processedAccounts.set(accountName, saved.id);
        importResult.accountsCreated++;
        importResult.createdMappings!.accounts[accMapping.originalName] =
          saved.id;
      }
    }
  }

  async createLoanAccounts(
    manager: EntityManager,
    userId: string,
    loanAccountsToCreate: CategoryMappingDto[],
    loanCategoryMap: Map<string, string>,
    account: Account,
    importResult: ImportResultDto,
  ): Promise<void> {
    for (const loanMapping of loanAccountsToCreate) {
      const loanAmount = loanMapping.newLoanAmount || 0;
      const loanType =
        loanMapping.newLoanType === "MORTGAGE"
          ? AccountType.MORTGAGE
          : AccountType.LOAN;
      await assertAccountCurrencyKindIn(
        manager,
        loanType,
        account.currencyCode,
      );
      const newLoanAccount = manager.create(Account, {
        userId,
        name: loanMapping.createNewLoan,
        accountType: loanType,
        currencyCode: account.currencyCode,
        institution: loanMapping.newLoanInstitution || null,
        openingBalance: -loanAmount,
        currentBalance: -loanAmount,
      });
      const saved = await manager.save(newLoanAccount);
      loanCategoryMap.set(loanMapping.originalName, saved.id);
      importResult.accountsCreated++;
      importResult.createdMappings!.loans[loanMapping.originalName] = saved.id;
    }
  }

  async createSecurities(
    manager: EntityManager,
    userId: string,
    securitiesToCreate: SecurityMappingDto[],
    securityMap: Map<string, string | null>,
    account: Account,
    importResult: ImportResultDto,
  ): Promise<void> {
    for (const secMapping of securitiesToCreate) {
      if (!secMapping.createNew) continue;
      const symbol = secMapping.createNew.toUpperCase();

      const existingSecurity = await manager.findOne(Security, {
        where: { symbol, userId },
      });

      if (existingSecurity) {
        securityMap.set(secMapping.originalName, existingSecurity.id);
      } else {
        // Exchange-derived currency takes priority over frontend-supplied value,
        // because the user may have changed the exchange after an auto-lookup
        // that set a stale currencyCode (e.g., lookup found USD, user changed to LSE).
        const currencyCode =
          getCurrencyFromExchange(secMapping.exchange) ||
          secMapping.currencyCode ||
          account.currencyCode;
        // A security is priced in fiat (INV-CRYPTO-001).
        await assertSecurityCurrencyIsFiatIn(manager, currencyCode);

        const newSecurity = new Security();
        newSecurity.userId = userId;
        newSecurity.symbol = symbol;
        newSecurity.name = secMapping.securityName || secMapping.createNew;
        newSecurity.securityType = secMapping.securityType || null;
        newSecurity.exchange = secMapping.exchange || null;
        newSecurity.currencyCode = currencyCode;
        newSecurity.isActive = true;
        const saved = await manager.save(newSecurity);
        securityMap.set(secMapping.originalName, saved.id);
        importResult.securitiesCreated++;
        importResult.createdMappings!.securities[secMapping.originalName] =
          saved.id;
      }
    }
  }

  async applyOpeningBalance(
    manager: EntityManager,
    accountId: string,
    account: Account,
    openingBalance: number,
  ): Promise<void> {
    // A delta under the account lock, at 4dp, rather than an absolute write
    // computed from `account`, which the caller read in an earlier
    // transaction (A26-M13). Only the owner is taken from it.
    await applyOpeningBalanceChange(
      manager,
      account.userId,
      accountId,
      openingBalance,
    );
  }
}
