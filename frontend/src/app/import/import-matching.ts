/**
 * Pure functions for matching QIF data to existing entities during import.
 * These do not depend on React state and can be called from the import wizard hook.
 */
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Security } from '@/types/investment';
import { CategoryMapping, AccountMapping, SecurityMapping } from '@/lib/import';
import {
  MatchConfidence,
  suggestAccountType,
  formatCategoryPath,
  isInvestmentBrokerageAccount,
} from './import-utils';

/** Get the full path for a category (e.g., "Parent: Child") */
export function getCategoryPath(category: Category, categories: Category[]): string {
  if (category.parentId) {
    const parent = categories.find((c) => c.id === category.parentId);
    if (parent) {
      return `${parent.name}: ${category.name}`;
    }
  }
  return category.name;
}

/** Find an existing category that matches a QIF category string */
export function findMatchingCategory(cat: string, categories: Category[]): string | undefined {
  const normalizedQifCat = formatCategoryPath(cat).toLowerCase();
  const qifSubcategory = cat.split(':').pop()?.trim().toLowerCase() || '';
  const qifParts = cat.split(':');
  const qifParentName = qifParts.length > 1 ? qifParts[0].trim().toLowerCase() : null;

  // QIF files replace / with - in category names, so also try matching with - replaced by /
  const normalizedQifCatWithSlash = normalizedQifCat.replace(/-/g, '/');
  const qifSubcategoryWithSlash = qifSubcategory.replace(/-/g, '/');
  const qifParentNameWithSlash = qifParentName?.replace(/-/g, '/') || null;

  // Try exact full path match
  let existingCat = categories.find((c) => {
    const catPath = getCategoryPath(c, categories).toLowerCase();
    return catPath === normalizedQifCat || catPath === normalizedQifCatWithSlash;
  });

  // Try matching category name against full normalized path
  if (!existingCat) {
    existingCat = categories.find((c) => {
      const catName = c.name.toLowerCase();
      return catName === normalizedQifCat || catName === normalizedQifCatWithSlash;
    });
  }

  // Try matching subcategory with correct parent
  if (!existingCat && qifParentName) {
    existingCat = categories.find((c) => {
      const catName = c.name.toLowerCase();
      if (catName !== qifSubcategory && catName !== qifSubcategoryWithSlash) return false;
      if (c.parentId) {
        const parent = categories.find((p) => p.id === c.parentId);
        const parentName = parent?.name.toLowerCase();
        return parentName === qifParentName || parentName === qifParentNameWithSlash;
      }
      return false;
    });
  }

  // Match just the subcategory name (only if no parent specified in QIF)
  if (!existingCat && !qifParentName) {
    existingCat = categories.find((c) => {
      const catName = c.name.toLowerCase();
      return catName === qifSubcategory || catName === qifSubcategoryWithSlash;
    });
  }

  return existingCat?.id;
}

/** Find a loan/mortgage account that matches a QIF category name */
export function findMatchingLoanAccount(cat: string, accounts: Account[]): string | undefined {
  const loanAccounts = accounts.filter(
    (a) => a.accountType === 'LOAN' || a.accountType === 'MORTGAGE'
  );

  if (loanAccounts.length === 0) return undefined;

  const normalizedCat = cat.toLowerCase().trim();
  const normalizedCatWithSlash = normalizedCat.replace(/-/g, '/');

  let matchedLoan = loanAccounts.find((a) => {
    const loanName = a.name.toLowerCase();
    return loanName === normalizedCat || loanName === normalizedCatWithSlash;
  });

  if (!matchedLoan) {
    matchedLoan = loanAccounts.find((a) => {
      const loanName = a.name.toLowerCase();
      return normalizedCat.includes(loanName) || loanName.includes(normalizedCat) ||
             normalizedCatWithSlash.includes(loanName) || loanName.includes(normalizedCatWithSlash);
    });
  }

  return matchedLoan?.id;
}

/** Match a filename to an existing account */
export function matchFilenameToAccount(
  fName: string,
  isInvestmentType: boolean,
  accounts: Account[],
  qifAccountType?: string,
): { id: string; confidence: MatchConfidence } {
  const baseName = fName.replace(/\.[^/.]+$/, '').trim().toLowerCase();
  const baseNameWithSlash = baseName.replace(/-/g, '/');

  const compatibleAccounts = accounts.filter((a) => {
    if (isInvestmentType) {
      return isInvestmentBrokerageAccount(a);
    } else {
      return !isInvestmentBrokerageAccount(a);
    }
  });

  const exactMatch = compatibleAccounts.find((a) => {
    const accountName = a.name.toLowerCase();
    return accountName === baseName || accountName === baseNameWithSlash;
  });
  if (exactMatch) return { id: exactMatch.id, confidence: 'exact' };

  const partialMatch = compatibleAccounts.find((a) => {
    const accountName = a.name.toLowerCase();
    return accountName.includes(baseName) || baseName.includes(accountName)
      || accountName.includes(baseNameWithSlash) || baseNameWithSlash.includes(accountName);
  });
  if (partialMatch) return { id: partialMatch.id, confidence: 'partial' };

  const typeMatch = qifAccountType
    ? compatibleAccounts.find((a) => a.accountType === qifAccountType)
    : undefined;
  if (typeMatch) return { id: typeMatch.id, confidence: 'type' };

  return { id: '', confidence: 'none' };
}

/** Build category mappings from QIF categories */
export function buildCategoryMappings(
  allCategories: Set<string>,
  categories: Category[],
  accounts: Account[],
): CategoryMapping[] {
  return Array.from(allCategories).map((cat) => {
    const categoryId = findMatchingCategory(cat, categories);
    if (categoryId) {
      return { originalName: cat, categoryId, createNew: undefined };
    }

    const loanAccountId = findMatchingLoanAccount(cat, accounts);
    if (loanAccountId) {
      return { originalName: cat, isLoanCategory: true, loanAccountId };
    }

    return { originalName: cat, categoryId: undefined, createNew: undefined };
  });
}

/** Build account mappings from QIF transfer accounts */
export function buildAccountMappings(
  allTransferAccounts: Set<string>,
  accounts: Account[],
  defaultCurrency: string,
): AccountMapping[] {
  return Array.from(allTransferAccounts).map((acc) => {
    const accLower = acc.toLowerCase();
    const accWithSlash = accLower.replace(/-/g, '/');
    const existingAcc = accounts.find((a) => {
      const aName = a.name.toLowerCase();
      return aName === accLower || aName === accWithSlash;
    });
    if (existingAcc) {
      const targetId = existingAcc.accountSubType === 'INVESTMENT_BROKERAGE' && existingAcc.linkedAccountId
        ? existingAcc.linkedAccountId
        : existingAcc.id;
      return { originalName: acc, accountId: targetId };
    }
    const investmentCashAcc = accounts.find((a) => {
      const aName = a.name.toLowerCase();
      return (aName === `${accLower} - cash` || aName === `${accWithSlash} - cash`)
        && a.accountSubType === 'INVESTMENT_CASH';
    });
    if (investmentCashAcc) {
      return { originalName: acc, accountId: investmentCashAcc.id };
    }
    return {
      originalName: acc,
      createNew: acc,
      accountType: suggestAccountType(acc),
      currencyCode: defaultCurrency,
    };
  });
}

/** Build security mappings from QIF securities */
export function buildSecurityMappings(
  allSecurities: Set<string>,
  securities: Security[],
): SecurityMapping[] {
  return Array.from(allSecurities).map((sec) => {
    const existingSec = securities.find(
      (s) => s.symbol.toLowerCase() === sec.toLowerCase() || s.name.toLowerCase() === sec.toLowerCase()
    );
    return {
      originalName: sec,
      securityId: existingSec?.id,
      createNew: undefined,
      securityName: undefined,
      securityType: undefined,
      exchange: undefined,
    };
  });
}

/** Check if a symbol matches an existing security */
export function findMatchingSecurityBySymbol(symbol: string, securities: Security[]): Security | undefined {
  if (!symbol) return undefined;
  const upperSymbol = symbol.toUpperCase().trim();
  return securities.find((s) => s.symbol.toUpperCase() === upperSymbol);
}
