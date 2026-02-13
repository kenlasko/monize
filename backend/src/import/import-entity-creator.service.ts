import { Injectable } from "@nestjs/common";
import { IsNull } from "typeorm";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Security } from "../securities/entities/security.entity";
import {
  ImportResultDto,
  CategoryMappingDto,
  AccountMappingDto,
  SecurityMappingDto,
} from "./dto/import.dto";

/**
 * Map stock exchanges to their primary currency.
 */
const EXCHANGE_CURRENCY_MAP: Record<string, string> = {
  NYSE: "USD",
  NASDAQ: "USD",
  AMEX: "USD",
  NYSEARCA: "USD",
  BATS: "USD",
  TSX: "CAD",
  "TSX-V": "CAD",
  TSXV: "CAD",
  NEO: "CAD",
  CSE: "CAD",
  LSE: "GBP",
  LON: "GBP",
  XETRA: "EUR",
  FRA: "EUR",
  EPA: "EUR",
  AMS: "EUR",
  TYO: "JPY",
  HKG: "HKD",
  SHA: "CNY",
  SHE: "CNY",
  ASX: "AUD",
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
    queryRunner: any,
    userId: string,
    categoriesToCreate: CategoryMappingDto[],
    categoryMap: Map<string, string | null>,
    importResult: ImportResultDto,
  ): Promise<void> {
    const processedCategories = new Map<string, string>();
    for (const catMapping of categoriesToCreate) {
      const categoryName = catMapping.createNew;
      const parentId = catMapping.parentCategoryId || null;
      const cacheKey = `${categoryName}|${parentId || "null"}`;

      if (processedCategories.has(cacheKey)) {
        categoryMap.set(
          catMapping.originalName,
          processedCategories.get(cacheKey)!,
        );
        continue;
      }

      const existingCategory = await queryRunner.manager.findOne(Category, {
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
      importResult.createdMappings!.categories[catMapping.originalName] =
        saved.id;
    }
  }

  async createAccounts(
    queryRunner: any,
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

      let existingAccount = await queryRunner.manager.findOne(Account, {
        where: { userId, name: accountName },
      });
      if (!existingAccount && accountType === AccountType.INVESTMENT) {
        existingAccount = await queryRunner.manager.findOne(Account, {
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

      if (accountType === AccountType.INVESTMENT) {
        const cashAccount = queryRunner.manager.create(Account, {
          userId,
          name: `${accountName} - Cash`,
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_CASH,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
        });
        const savedCash = await queryRunner.manager.save(cashAccount);

        const brokerageAccount = queryRunner.manager.create(Account, {
          userId,
          name: `${accountName} - Brokerage`,
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

        accountMap.set(accMapping.originalName, savedCash.id);
        processedAccounts.set(accountName, savedCash.id);
        importResult.accountsCreated += 2;
        importResult.createdMappings!.accounts[accMapping.originalName] =
          savedCash.id;
      } else {
        const newAccount = queryRunner.manager.create(Account, {
          userId,
          name: accountName,
          accountType,
          currencyCode,
          openingBalance: 0,
          currentBalance: 0,
        });
        const saved = await queryRunner.manager.save(newAccount);
        accountMap.set(accMapping.originalName, saved.id);
        processedAccounts.set(accountName, saved.id);
        importResult.accountsCreated++;
        importResult.createdMappings!.accounts[accMapping.originalName] =
          saved.id;
      }
    }
  }

  async createLoanAccounts(
    queryRunner: any,
    userId: string,
    loanAccountsToCreate: CategoryMappingDto[],
    loanCategoryMap: Map<string, string>,
    account: Account,
    importResult: ImportResultDto,
  ): Promise<void> {
    for (const loanMapping of loanAccountsToCreate) {
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
      importResult.createdMappings!.loans[loanMapping.originalName] = saved.id;
    }
  }

  async createSecurities(
    queryRunner: any,
    userId: string,
    securitiesToCreate: SecurityMappingDto[],
    securityMap: Map<string, string | null>,
    account: Account,
    importResult: ImportResultDto,
  ): Promise<void> {
    for (const secMapping of securitiesToCreate) {
      if (!secMapping.createNew) continue;
      const symbol = secMapping.createNew.toUpperCase();

      const existingSecurity = await queryRunner.manager.findOne(Security, {
        where: { symbol, userId },
      });

      if (existingSecurity) {
        securityMap.set(secMapping.originalName, existingSecurity.id);
      } else {
        const currencyCode =
          secMapping.currencyCode ||
          getCurrencyFromExchange(secMapping.exchange) ||
          account.currencyCode;

        const newSecurity = new Security();
        newSecurity.userId = userId;
        newSecurity.symbol = symbol;
        newSecurity.name = secMapping.securityName || secMapping.createNew;
        newSecurity.securityType = secMapping.securityType || null;
        newSecurity.exchange = secMapping.exchange || null;
        newSecurity.currencyCode = currencyCode;
        newSecurity.isActive = true;
        const saved = await queryRunner.manager.save(newSecurity);
        securityMap.set(secMapping.originalName, saved.id);
        importResult.securitiesCreated++;
        importResult.createdMappings!.securities[secMapping.originalName] =
          saved.id;
      }
    }
  }

  async applyOpeningBalance(
    queryRunner: any,
    accountId: string,
    account: Account,
    openingBalance: number,
  ): Promise<void> {
    const existingOpeningBalance = Number(account.openingBalance) || 0;
    const existingCurrentBalance = Number(account.currentBalance) || 0;
    const newOpeningBalance = Math.round(openingBalance * 100) / 100;

    const newCurrentBalance =
      Math.round(
        (existingCurrentBalance - existingOpeningBalance + newOpeningBalance) *
          100,
      ) / 100;

    await queryRunner.manager.update(Account, accountId, {
      openingBalance: newOpeningBalance,
      currentBalance: newCurrentBalance,
    });
  }
}
