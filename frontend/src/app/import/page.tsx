'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { UploadStep } from '@/components/import/UploadStep';
import { SelectAccountStep } from '@/components/import/SelectAccountStep';
import { MapCategoriesStep } from '@/components/import/MapCategoriesStep';
import { MapSecuritiesStep } from '@/components/import/MapSecuritiesStep';
import { MapAccountsStep } from '@/components/import/MapAccountsStep';
import { ReviewStep } from '@/components/import/ReviewStep';
import { CompleteStep } from '@/components/import/CompleteStep';
import { importApi, ParsedQifResponse, CategoryMapping, AccountMapping, SecurityMapping, ImportResult, DateFormat } from '@/lib/import';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { investmentsApi } from '@/lib/investments';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { getErrorMessage } from '@/lib/errors';
import { Account, AccountType } from '@/types/account';
import { Category } from '@/types/category';
import { Security } from '@/types/investment';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Import');

type ImportStep = 'upload' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';

function suggestAccountType(name: string): string {
  const n = name.toLowerCase();
  if (/visa|mastercard|amex|credit\s*card|credit/.test(n)) return 'CREDIT_CARD';
  if (/savings?/.test(n)) return 'SAVINGS';
  if (/mortgage/.test(n)) return 'MORTGAGE';
  if (/line\s*of\s*credit|\bloc\b/.test(n)) return 'LINE_OF_CREDIT';
  if (/loan/.test(n)) return 'LOAN';
  if (/invest|brokerage|rrsp|tfsa|401k|ira/.test(n)) return 'INVESTMENT';
  if (/\bcash\b/.test(n)) return 'CASH';
  if (/\basset\b/.test(n)) return 'ASSET';
  return 'CHEQUING';
}

// Data for each file in bulk import
type MatchConfidence = 'exact' | 'partial' | 'type' | 'none';

interface ImportFileData {
  fileName: string;
  fileContent: string;
  parsedData: ParsedQifResponse;
  selectedAccountId: string;
  matchConfidence: MatchConfidence;
}

// Combined import result for bulk imports
interface BulkImportResult {
  totalImported: number;
  totalSkipped: number;
  totalErrors: number;
  categoriesCreated: number;
  accountsCreated: number;
  payeesCreated: number;
  securitiesCreated: number;
  fileResults: Array<{
    fileName: string;
    accountName: string;
    imported: number;
    skipped: number;
    errors: number;
    errorMessages: string[];
  }>;
}

const formatAccountType = (type: AccountType): string => {
  const labels: Record<AccountType, string> = {
    CHEQUING: 'Chequing',
    SAVINGS: 'Savings',
    CREDIT_CARD: 'Credit Card',
    INVESTMENT: 'Investment',
    LOAN: 'Loan',
    MORTGAGE: 'Mortgage',
    CASH: 'Cash',
    LINE_OF_CREDIT: 'Line of Credit',
    ASSET: 'Asset',
    OTHER: 'Other',
  };
  return labels[type] || type;
};

// Format QIF category path to have spaces after colons (e.g., "Bills:Cell Phone" -> "Bills: Cell Phone")
const formatCategoryPath = (path: string): string => {
  return path.replace(/:/g, ': ').replace(/:  /g, ': ');
};

// Check if an account is specifically an investment brokerage account
const isInvestmentBrokerageAccount = (account: Account): boolean => {
  return account.accountSubType === 'INVESTMENT_BROKERAGE';
};

export default function ImportPage() {
  return (
    <ProtectedRoute>
      <ImportContent />
    </ProtectedRoute>
  );
}

function ImportContent() {
  const searchParams = useSearchParams();
  const preselectedAccountId = searchParams.get('accountId');
  const defaultCurrency = usePreferencesStore((s) => s.preferences?.defaultCurrency) || 'USD';

  const [step, setStep] = useState<ImportStep>('upload');
  // Bulk import: array of files with their data
  const [importFiles, setImportFiles] = useState<ImportFileData[]>([]);
  // Legacy single-file state (used as derived from importFiles[0] for compatibility)
  const fileContent = importFiles[0]?.fileContent || '';
  const fileName = importFiles[0]?.fileName || '';
  const parsedData = importFiles[0]?.parsedData || null;
  const selectedAccountId = importFiles[0]?.selectedAccountId || '';

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [categoryMappings, setCategoryMappings] = useState<CategoryMapping[]>([]);
  const [accountMappings, setAccountMappings] = useState<AccountMapping[]>([]);
  const [securityMappings, setSecurityMappings] = useState<SecurityMapping[]>([]);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [dateFormat, setDateFormat] = useState<DateFormat>('MM/DD/YYYY');
  const [isLoading, setIsLoading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [bulkImportResult, setBulkImportResult] = useState<BulkImportResult | null>(null);
  const [lookupLoadingIndex, setLookupLoadingIndex] = useState<number | null>(null);
  const [initialLookupDone, setInitialLookupDone] = useState(false);
  const [bulkLookupInProgress, setBulkLookupInProgress] = useState(false);
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountType, setNewAccountType] = useState<string>('CHEQUING');
  const [newAccountCurrency, setNewAccountCurrency] = useState(defaultCurrency);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);
  // For bulk: which file index is creating an account (-1 = none)
  const [creatingForFileIndex, setCreatingForFileIndex] = useState(-1);

  // Helper to check if this is a bulk import (multiple files)
  const isBulkImport = importFiles.length > 1;

  // Helper to update a specific file's account selection
  const setFileAccountId = useCallback((fileIndex: number, accountId: string, confidence: MatchConfidence = 'exact') => {
    setImportFiles(prev => prev.map((f, i) =>
      i === fileIndex ? { ...f, selectedAccountId: accountId, matchConfidence: confidence } : f
    ));
  }, []);

  // Legacy setter for single file (updates first file)
  const setSelectedAccountId = useCallback((accountId: string, confidence: MatchConfidence = 'exact') => setFileAccountId(0, accountId, confidence), [setFileAccountId]);

  // Create a new account inline and select it for the given file index
  const handleCreateAccount = async (fileIndex: number) => {
    if (!newAccountName.trim()) {
      toast.error('Account name is required');
      return;
    }
    setIsCreatingAccount(true);
    try {
      const accountData = {
        name: newAccountName.trim(),
        accountType: newAccountType as AccountType,
        currencyCode: newAccountCurrency,
        openingBalance: 0,
      };

      if (newAccountType === 'INVESTMENT') {
        // Create investment pair (cash + brokerage)
        const pair = await accountsApi.createInvestmentPair(accountData);
        setAccounts(prev => [...prev, pair.cashAccount, pair.brokerageAccount]);
        // Select the brokerage account for import (investment transactions go there)
        setFileAccountId(fileIndex, pair.brokerageAccount.id);
        toast.success(`Investment accounts "${pair.cashAccount.name}" and "${pair.brokerageAccount.name}" created`);
      } else {
        const created = await accountsApi.create(accountData);
        setAccounts(prev => [...prev, created]);
        setFileAccountId(fileIndex, created.id);
        toast.success(`Account "${created.name}" created`);
      }

      setShowCreateAccount(false);
      setCreatingForFileIndex(-1);
      setNewAccountName('');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create account'));
    } finally {
      setIsCreatingAccount(false);
    }
  };

  // Refs for scrollable containers
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Load accounts, categories, and securities
  useEffect(() => {
    const loadData = async () => {
      try {
        const [accountsData, categoriesData, securitiesData, currenciesData] = await Promise.all([
          accountsApi.getAll(),
          categoriesApi.getAll(),
          investmentsApi.getSecurities(true), // Include inactive securities
          exchangeRatesApi.getCurrencies(),
        ]);
        setAccounts(accountsData);
        setCategories(categoriesData);
        setSecurities(securitiesData);
        setCurrencies(currenciesData);

        // If preselected account ID is provided, validate it exists
        if (preselectedAccountId) {
          const accountExists = accountsData.some((a) => a.id === preselectedAccountId);
          if (accountExists) {
            setSelectedAccountId(preselectedAccountId);
          }
        }
      } catch (error) {
        toast.error(getErrorMessage(error, 'Failed to load data'));
      }
    };
    loadData();
  }, [preselectedAccountId, setSelectedAccountId]);

  // Scroll to top whenever the step changes
  useEffect(() => {
    window.scrollTo(0, 0);
    // Also scroll any inner scrollable container to the top
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [step]);

  // Auto-select best matching account when on selectAccount step with no selection
  useEffect(() => {
    if (step !== 'selectAccount' || selectedAccountId || accounts.length === 0) {
      return;
    }

    const qifType = parsedData?.accountType;
    const isQifInvestment = qifType === 'INVESTMENT';
    const compatibleAccounts = accounts.filter((a) => {
      if (isQifInvestment) {
        return isInvestmentBrokerageAccount(a);
      } else {
        return !isInvestmentBrokerageAccount(a);
      }
    });

    if (compatibleAccounts.length > 0) {
      // Prefer account matching the QIF detected type
      const typeMatch = qifType
        ? compatibleAccounts.find((a) => a.accountType === qifType)
        : undefined;
      if (typeMatch) {
        setSelectedAccountId(typeMatch.id, 'type');
      } else {
        setSelectedAccountId(compatibleAccounts[0].id, 'none');
      }
    }
  }, [step, selectedAccountId, accounts, parsedData, setSelectedAccountId]);

  // Re-match account mappings when entering mapAccounts step
  // This picks up accounts created inline during the selectAccount step
  useEffect(() => {
    if (step !== 'mapAccounts' || accountMappings.length === 0) return;

    setAccountMappings(prev => prev.map(mapping => {
      // Skip already matched to existing account
      if (mapping.accountId) return mapping;

      const accLower = mapping.originalName.toLowerCase();
      const accWithSlash = accLower.replace(/-/g, '/');
      const existingAcc = accounts.find((a) => {
        const aName = a.name.toLowerCase();
        return aName === accLower || aName === accWithSlash;
      });
      if (existingAcc) {
        // If matched account is a brokerage, use its linked cash account for transfers
        const targetId = existingAcc.accountSubType === 'INVESTMENT_BROKERAGE' && existingAcc.linkedAccountId
          ? existingAcc.linkedAccountId
          : existingAcc.id;
        return { originalName: mapping.originalName, accountId: targetId };
      }
      // Also check for investment cash account naming pattern (e.g., "RRSP" matches "RRSP - Cash")
      const investmentCashAcc = accounts.find((a) => {
        const aName = a.name.toLowerCase();
        return (aName === `${accLower} - cash` || aName === `${accWithSlash} - cash`)
          && a.accountSubType === 'INVESTMENT_CASH';
      });
      if (investmentCashAcc) {
        return { originalName: mapping.originalName, accountId: investmentCashAcc.id };
      }
      return mapping;
    }));
  }, [step, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run bulk security lookup when entering mapSecurities step
  useEffect(() => {
    if (step !== 'mapSecurities' || initialLookupDone || securityMappings.length === 0) {
      return;
    }

    const runBulkLookup = async () => {
      setBulkLookupInProgress(true);
      setInitialLookupDone(true);

      // Process all securities that don't have a securityId (not already mapped)
      const unmappedIndices = securityMappings
        .map((m, i) => (!m.securityId ? i : -1))
        .filter((i) => i !== -1);

      for (const index of unmappedIndices) {
        const mapping = securityMappings[index];
        const query = mapping.originalName;

        if (!query || query.length < 2) continue;

        try {
          const result = await investmentsApi.lookupSecurity(query);
          // Ignore results where the discovered symbol is longer than 6 characters
          // (likely a bad match rather than a real ticker symbol)
          if (result && result.symbol.length <= 6) {
            setSecurityMappings((prev) => {
              const updated = [...prev];
              const current = updated[index];
              // Only update if not already filled in
              if (!current.createNew && !current.securityName) {
                updated[index] = {
                  ...current,
                  securityId: undefined,
                  createNew: result.symbol,
                  securityName: result.name,
                  securityType: result.securityType || 'STOCK',
                  exchange: result.exchange || undefined,
                  currencyCode: result.currencyCode || undefined,
                };
              }
              return updated;
            });
          }
        } catch (error) {
          // Silently ignore errors during bulk lookup
          logger.error(`Bulk lookup failed for ${query}:`, error);
        }
      }

      setBulkLookupInProgress(false);
    };

    runBulkLookup();
  }, [step, initialLookupDone, securityMappings]);

  // Helper to get category path
  const getCategoryPath = useCallback((category: Category): string => {
    if (category.parentId) {
      const parent = categories.find((c) => c.id === category.parentId);
      if (parent) {
        return `${parent.name}: ${category.name}`;
      }
    }
    return category.name;
  }, [categories]);

  // Helper to find matching category
  const findMatchingCategory = useCallback((cat: string): string | undefined => {
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
      const catPath = getCategoryPath(c).toLowerCase();
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
  }, [categories, getCategoryPath]);

  // Helper to find matching loan account for a category name
  const findMatchingLoanAccount = useCallback((cat: string): string | undefined => {
    // Get loan/mortgage accounts
    const loanAccounts = accounts.filter(
      (a) => a.accountType === 'LOAN' || a.accountType === 'MORTGAGE'
    );

    if (loanAccounts.length === 0) return undefined;

    // Normalize the category name (QIF files replace / with - in names)
    const normalizedCat = cat.toLowerCase().trim();
    const normalizedCatWithSlash = normalizedCat.replace(/-/g, '/');

    // Try exact match first
    let matchedLoan = loanAccounts.find((a) => {
      const loanName = a.name.toLowerCase();
      return loanName === normalizedCat || loanName === normalizedCatWithSlash;
    });

    // Try partial match (category contains loan name or vice versa)
    if (!matchedLoan) {
      matchedLoan = loanAccounts.find((a) => {
        const loanName = a.name.toLowerCase();
        return normalizedCat.includes(loanName) || loanName.includes(normalizedCat) ||
               normalizedCatWithSlash.includes(loanName) || loanName.includes(normalizedCatWithSlash);
      });
    }

    return matchedLoan?.id;
  }, [accounts]);

  // Helper to match filename to account
  // QIF files replace / with - in account names, so also try matching with - replaced by /
  const matchFilenameToAccount = useCallback((fileName: string, isInvestmentType: boolean, qifAccountType?: string): { id: string; confidence: MatchConfidence } => {
    const baseName = fileName.replace(/\.[^/.]+$/, '').trim().toLowerCase();
    const baseNameWithSlash = baseName.replace(/-/g, '/');

    const compatibleAccounts = accounts.filter((a) => {
      if (isInvestmentType) {
        return isInvestmentBrokerageAccount(a);
      } else {
        return !isInvestmentBrokerageAccount(a);
      }
    });

    // Try exact match first (with both - and / variants)
    const exactMatch = compatibleAccounts.find((a) => {
      const accountName = a.name.toLowerCase();
      return accountName === baseName || accountName === baseNameWithSlash;
    });
    if (exactMatch) return { id: exactMatch.id, confidence: 'exact' };

    // Then try partial matches
    const partialMatch = compatibleAccounts.find((a) => {
      const accountName = a.name.toLowerCase();
      return accountName.includes(baseName) || baseName.includes(accountName)
        || accountName.includes(baseNameWithSlash) || baseNameWithSlash.includes(accountName);
    });
    if (partialMatch) return { id: partialMatch.id, confidence: 'partial' };

    // Then try matching by QIF account type
    const typeMatch = qifAccountType
      ? compatibleAccounts.find((a) => a.accountType === qifAccountType)
      : undefined;
    if (typeMatch) return { id: typeMatch.id, confidence: 'type' };

    return { id: '', confidence: 'none' };
  }, [accounts]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsLoading(true);
    setInitialLookupDone(false);

    try {
      const fileDataArray: ImportFileData[] = [];
      const allCategories: Set<string> = new Set();
      const allTransferAccounts: Set<string> = new Set();
      const allSecurities: Set<string> = new Set();
      let detectedFormat: DateFormat | null = null;

      // Process each file
      for (const file of Array.from(files)) {
        const content = await file.text();
        const parsed = await importApi.parseQif(content);

        // Use first detected date format
        if (!detectedFormat && parsed.detectedDateFormat) {
          detectedFormat = parsed.detectedDateFormat;
        }

        // Collect unique categories, transfer accounts, and securities
        parsed.categories.forEach((cat) => allCategories.add(cat));
        parsed.transferAccounts.forEach((acc) => allTransferAccounts.add(acc));
        (parsed.securities || []).forEach((sec) => allSecurities.add(sec));

        // Match filename to account
        const isInvestmentType = parsed.accountType === 'INVESTMENT';
        const match = matchFilenameToAccount(file.name, isInvestmentType, parsed.accountType);

        fileDataArray.push({
          fileName: file.name,
          fileContent: content,
          parsedData: parsed,
          selectedAccountId: match.id,
          matchConfidence: match.confidence,
        });
      }

      // Set the detected date format
      if (detectedFormat) {
        setDateFormat(detectedFormat);
      }

      // Store all file data
      setImportFiles(fileDataArray);

      // Initialize combined category mappings
      // First try to match to a category, then try to match to a loan account
      const catMappings: CategoryMapping[] = Array.from(allCategories).map((cat) => {
        const categoryId = findMatchingCategory(cat);
        if (categoryId) {
          return {
            originalName: cat,
            categoryId,
            createNew: undefined,
          };
        }

        // If no category match, try to match to a loan account
        const loanAccountId = findMatchingLoanAccount(cat);
        if (loanAccountId) {
          return {
            originalName: cat,
            isLoanCategory: true,
            loanAccountId,
          };
        }

        // No match found
        return {
          originalName: cat,
          categoryId: undefined,
          createNew: undefined,
        };
      });
      setCategoryMappings(catMappings);

      // Initialize combined account mappings
      // QIF files replace / with - in account names, so also try matching with - replaced by /
      // Also match investment cash accounts by base name (e.g., "RRSP" matches "RRSP - Cash")
      const accMappings: AccountMapping[] = Array.from(allTransferAccounts).map((acc) => {
        const accLower = acc.toLowerCase();
        const accWithSlash = accLower.replace(/-/g, '/');
        const existingAcc = accounts.find((a) => {
          const aName = a.name.toLowerCase();
          return aName === accLower || aName === accWithSlash;
        });
        if (existingAcc) {
          // If matched account is a brokerage, use its linked cash account for transfers
          const targetId = existingAcc.accountSubType === 'INVESTMENT_BROKERAGE' && existingAcc.linkedAccountId
            ? existingAcc.linkedAccountId
            : existingAcc.id;
          return { originalName: acc, accountId: targetId };
        }
        // Check for investment cash account naming pattern
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
      setAccountMappings(accMappings);

      // Initialize combined security mappings
      const secMappings: SecurityMapping[] = Array.from(allSecurities).map((sec) => {
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
      setSecurityMappings(secMappings);

      // Always go to selectAccount step for bulk import to let user verify/adjust account mappings
      setStep('selectAccount');

      if (fileDataArray.length > 1) {
        toast.success(`Loaded ${fileDataArray.length} files for import`);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to parse QIF file(s)'));
    } finally {
      setIsLoading(false);
    }
  }, [accounts, securities, findMatchingCategory, findMatchingLoanAccount, matchFilenameToAccount, defaultCurrency]);

  const handleAccountMappingChange = (index: number, field: keyof AccountMapping, value: string) => {
    setAccountMappings((prev) => {
      const updated = [...prev];
      if (field === 'accountId') {
        updated[index] = {
          ...updated[index],
          accountId: value || undefined,
          createNew: undefined,
          accountType: undefined,
          currencyCode: undefined,
        };
      } else if (field === 'createNew') {
        updated[index] = {
          ...updated[index],
          accountId: undefined,
          createNew: value || undefined,
        };
      } else if (field === 'accountType') {
        updated[index] = {
          ...updated[index],
          accountType: value || undefined,
        };
      } else if (field === 'currencyCode') {
        updated[index] = {
          ...updated[index],
          currencyCode: value || undefined,
        };
      }
      return updated;
    });
  };

  // Check if a symbol matches an existing security
  const findMatchingSecurityBySymbol = (symbol: string): Security | undefined => {
    if (!symbol) return undefined;
    const upperSymbol = symbol.toUpperCase().trim();
    return securities.find(
      (s) => s.symbol.toUpperCase() === upperSymbol
    );
  };

  const handleSecurityMappingChange = (index: number, field: keyof SecurityMapping, value: string) => {
    setSecurityMappings((prev) => {
      const updated = [...prev];
      if (field === 'securityId') {
        updated[index] = {
          ...updated[index],
          securityId: value || undefined,
          createNew: undefined,
          securityName: undefined,
          securityType: undefined,
          exchange: undefined,
        };
      } else if (field === 'createNew') {
        // Check if entered symbol matches an existing security
        const matchingSecurity = findMatchingSecurityBySymbol(value);
        if (matchingSecurity) {
          // Auto-select the existing security instead of creating new
          updated[index] = {
            ...updated[index],
            securityId: matchingSecurity.id,
            createNew: undefined,
            securityName: undefined,
            securityType: undefined,
            exchange: undefined,
          };
          toast.success(`Found existing security: ${matchingSecurity.symbol} - ${matchingSecurity.name}`);
        } else {
          updated[index] = {
            ...updated[index],
            securityId: undefined,
            createNew: value || undefined,
            // Don't overwrite securityName if user has already edited it
          };
        }
      } else if (field === 'securityName') {
        updated[index] = {
          ...updated[index],
          securityName: value || undefined,
        };
      } else if (field === 'securityType') {
        updated[index] = {
          ...updated[index],
          securityType: value || undefined,
        };
      } else if (field === 'exchange') {
        updated[index] = {
          ...updated[index],
          exchange: value || undefined,
        };
      }
      return updated;
    });
  };

  const handleSecurityLookup = async (index: number, query: string) => {
    if (!query || query.length < 2) {
      toast.error('Enter at least 2 characters to lookup');
      return;
    }

    setLookupLoadingIndex(index);
    try {
      const result = await investmentsApi.lookupSecurity(query);
      if (result) {
        // Check if the looked up symbol already exists in our securities
        const existingSecurity = findMatchingSecurityBySymbol(result.symbol);

        // Always fill in the Create New fields with lookup result
        // This allows user to review before import
        setSecurityMappings((prev) => {
          const updated = [...prev];
          const current = updated[index];
          updated[index] = {
            ...current,
            securityId: undefined, // Don't auto-select, let user review
            createNew: result.symbol,
            securityName: result.name,
            securityType: result.securityType || 'STOCK',
            exchange: result.exchange || undefined,
            currencyCode: result.currencyCode || undefined,
          };
          return updated;
        });

        // Build a detailed message showing what was found
        const details = [`Symbol: ${result.symbol}`, `Name: ${result.name}`];
        if (result.exchange) {
          details.push(`Exchange: ${result.exchange}`);
        }
        if (result.currencyCode) {
          details.push(`Currency: ${result.currencyCode}`);
        }
        if (existingSecurity) {
          toast.success(`Found (exists in database): ${details.join(', ')}`);
        } else {
          toast.success(`Found: ${details.join(', ')}`);
        }
      } else {
        toast.error(`No security found for "${query}"`);
      }
    } catch (error) {
      logger.error('Security lookup failed:', error);
      toast.error('Lookup failed - please try again');
    } finally {
      setLookupLoadingIndex(null);
    }
  };

  const handleImport = async () => {
    if (importFiles.length === 0) return;

    // Validate all files have accounts selected
    const allFilesValid = importFiles.every((f) => f.selectedAccountId);
    if (!allFilesValid) {
      toast.error('Please select an account for all files');
      return;
    }

    setIsLoading(true);
    try {
      if (isBulkImport) {
        // Bulk import: process each file sequentially
        const fileResults: BulkImportResult['fileResults'] = [];
        let totalImported = 0;
        let totalSkipped = 0;
        let totalErrors = 0;
        let categoriesCreated = 0;
        let accountsCreated = 0;
        let payeesCreated = 0;
        let securitiesCreated = 0;

        // Use mutable copies so we can replace createNew with actual IDs after the first file
        let currentCategoryMappings = [...categoryMappings];
        let currentAccountMappings = [...accountMappings];
        let currentSecurityMappings = [...securityMappings];

        for (const fileData of importFiles) {
          try {
            const result = await importApi.importQif({
              content: fileData.fileContent,
              accountId: fileData.selectedAccountId,
              categoryMappings: currentCategoryMappings,
              accountMappings: currentAccountMappings,
              securityMappings: currentSecurityMappings,
              dateFormat,
            });

            const targetAccount = accounts.find((a) => a.id === fileData.selectedAccountId);
            fileResults.push({
              fileName: fileData.fileName,
              accountName: targetAccount?.name || 'Unknown',
              imported: result.imported,
              skipped: result.skipped,
              errors: result.errors,
              errorMessages: result.errorMessages,
            });

            totalImported += result.imported;
            totalSkipped += result.skipped;
            totalErrors += result.errors;
            // Only count created items from first file (they're shared across imports)
            if (fileResults.length === 1) {
              categoriesCreated = result.categoriesCreated;
              accountsCreated = result.accountsCreated;
              payeesCreated = result.payeesCreated;
              securitiesCreated = result.securitiesCreated;
            }

            // Replace createNew entries with actual IDs so subsequent files reuse them
            if (result.createdMappings) {
              const { categories, accounts: accts, loans, securities: secs } = result.createdMappings;

              if (Object.keys(categories).length > 0 || Object.keys(loans).length > 0) {
                currentCategoryMappings = currentCategoryMappings.map((m) => {
                  if (m.createNew && categories[m.originalName]) {
                    return { originalName: m.originalName, categoryId: categories[m.originalName] };
                  }
                  if (m.createNewLoan && loans[m.originalName]) {
                    return { originalName: m.originalName, isLoanCategory: true, loanAccountId: loans[m.originalName] };
                  }
                  return m;
                });
              }

              if (Object.keys(accts).length > 0) {
                currentAccountMappings = currentAccountMappings.map((m) => {
                  if (m.createNew && accts[m.originalName]) {
                    return { originalName: m.originalName, accountId: accts[m.originalName] };
                  }
                  return m;
                });
              }

              if (Object.keys(secs).length > 0) {
                currentSecurityMappings = currentSecurityMappings.map((m) => {
                  if (m.createNew && secs[m.originalName]) {
                    return { originalName: m.originalName, securityId: secs[m.originalName] };
                  }
                  return m;
                });
              }
            }
          } catch (error) {
            const targetAccount = accounts.find((a) => a.id === fileData.selectedAccountId);
            fileResults.push({
              fileName: fileData.fileName,
              accountName: targetAccount?.name || 'Unknown',
              imported: 0,
              skipped: 0,
              errors: 1,
              errorMessages: [getErrorMessage(error, 'Import failed')],
            });
            totalErrors += 1;
          }
        }

        setBulkImportResult({
          totalImported,
          totalSkipped,
          totalErrors,
          categoriesCreated,
          accountsCreated,
          payeesCreated,
          securitiesCreated,
          fileResults,
        });

        setStep('complete');

        if (totalErrors === 0) {
          toast.success(`Successfully imported ${totalImported} transactions from ${importFiles.length} files`);
        } else {
          toast.success(`Imported ${totalImported} transactions with ${totalErrors} errors`);
        }
      } else {
        // Single file import
        const result = await importApi.importQif({
          content: fileContent,
          accountId: selectedAccountId,
          categoryMappings,
          accountMappings,
          securityMappings,
          dateFormat,
        });

        setImportResult(result);
        setStep('complete');

        if (result.errors === 0) {
          toast.success(`Successfully imported ${result.imported} transactions`);
        } else {
          toast.success(`Imported ${result.imported} transactions with ${result.errors} errors`);
        }
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Import failed'));
    } finally {
      setIsLoading(false);
    }
  };

  const categoryOptions = useMemo(() => {
    const options = [{ value: '', label: 'Skip (no category)' }];
    const tree = buildCategoryTree(categories);
    tree.forEach(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find((c) => c.id === category.parentId)
        : null;
      options.push({
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      });
    });
    return options;
  }, [categories]);

  const parentCategoryOptions = useMemo(() => {
    const options = [{ value: '', label: 'No parent (top-level)' }];
    categories
      .filter((c) => !c.parentId)
      .forEach((c) => {
        options.push({ value: c.id, label: c.name });
      });
    return options;
  }, [categories]);

  const getAccountOptions = () => {
    // Filter out loan/mortgage accounts (balances built from transactions in other accounts)
    // and brokerage accounts (transfers redirect to linked cash account automatically)
    const transferableAccounts = accounts.filter(
      (a) => a.accountType !== 'LOAN' && a.accountType !== 'MORTGAGE' && !isInvestmentBrokerageAccount(a)
    );
    return [
      { value: '', label: 'Skip (no transfer)' },
      ...transferableAccounts
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a) => ({ value: a.id, label: `${a.name} (${formatAccountType(a.accountType)})` })),
    ];
  };

  // Helper to determine if mapAccounts step should be shown
  // Never show for investment imports - transfers always go to the linked cash account
  const isInvestmentImport = parsedData?.accountType === 'INVESTMENT' ||
    (isBulkImport && importFiles.some((f) => f.parsedData.accountType === 'INVESTMENT'));
  const shouldShowMapAccounts = accountMappings.length > 0 && !isInvestmentImport;

  const accountTypeOptions = [
    { value: 'CHEQUING', label: 'Chequing' },
    { value: 'SAVINGS', label: 'Savings' },
    { value: 'CREDIT_CARD', label: 'Credit Card' },
    { value: 'INVESTMENT', label: 'Investment' },
    { value: 'LOAN', label: 'Loan' },
    { value: 'LINE_OF_CREDIT', label: 'Line of Credit' },
    { value: 'MORTGAGE', label: 'Mortgage' },
    { value: 'CASH', label: 'Cash' },
    { value: 'ASSET', label: 'Asset' },
    { value: 'OTHER', label: 'Other' },
  ];

  // Build currency options: default currency first, then alphabetical
  const currencyOptions = useMemo(() => {
    const sorted = [...currencies].sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
    return sorted.map((c) => ({ value: c.code, label: `${c.code} - ${c.name}` }));
  }, [currencies, defaultCurrency]);

  const getSecurityOptions = () => {
    return [
      { value: '', label: 'Skip (no security)' },
      ...securities.map((s) => ({ value: s.id, label: `${s.symbol} - ${s.name}` })),
    ];
  };

  const securityTypeOptions = [
    { value: 'STOCK', label: 'Stock' },
    { value: 'ETF', label: 'ETF' },
    { value: 'MUTUAL_FUND', label: 'Mutual Fund' },
    { value: 'BOND', label: 'Bond' },
    { value: 'GIC', label: 'GIC' },
    { value: 'CASH', label: 'Cash/Money Market' },
    { value: 'OTHER', label: 'Other' },
  ];

  const preselectedAccount = accounts.find((a) => a.id === preselectedAccountId);

  const renderStep = () => {
    switch (step) {
      case 'upload':
        return (
          <UploadStep
            preselectedAccount={preselectedAccount}
            isLoading={isLoading}
            onFileSelect={handleFileSelect}
          />
        );

      case 'selectAccount':
        return (
          <SelectAccountStep
            accounts={accounts}
            importFiles={importFiles}
            isBulkImport={isBulkImport}
            fileName={fileName}
            parsedData={parsedData}
            selectedAccountId={selectedAccountId}
            setSelectedAccountId={(id) => setSelectedAccountId(id)}
            setFileAccountId={setFileAccountId}
            showCreateAccount={showCreateAccount}
            setShowCreateAccount={setShowCreateAccount}
            creatingForFileIndex={creatingForFileIndex}
            setCreatingForFileIndex={setCreatingForFileIndex}
            newAccountName={newAccountName}
            setNewAccountName={setNewAccountName}
            newAccountType={newAccountType}
            setNewAccountType={setNewAccountType}
            newAccountCurrency={newAccountCurrency}
            setNewAccountCurrency={setNewAccountCurrency}
            isCreatingAccount={isCreatingAccount}
            handleCreateAccount={handleCreateAccount}
            accountTypeOptions={accountTypeOptions}
            currencyOptions={currencyOptions}
            categoryMappings={categoryMappings}
            securityMappings={securityMappings}
            shouldShowMapAccounts={shouldShowMapAccounts}
            setStep={setStep}
          />
        );

      case 'mapCategories':
        return (
          <MapCategoriesStep
            categoryMappings={categoryMappings}
            setCategoryMappings={setCategoryMappings}
            categoryOptions={categoryOptions}
            parentCategoryOptions={parentCategoryOptions}
            accounts={accounts}
            scrollContainerRef={scrollContainerRef}
            formatCategoryPath={formatCategoryPath}
            securityMappings={securityMappings}
            shouldShowMapAccounts={shouldShowMapAccounts}
            setStep={setStep}
          />
        );

      case 'mapSecurities':
        return (
          <MapSecuritiesStep
            securityMappings={securityMappings}
            handleSecurityMappingChange={handleSecurityMappingChange}
            handleSecurityLookup={handleSecurityLookup}
            lookupLoadingIndex={lookupLoadingIndex}
            bulkLookupInProgress={bulkLookupInProgress}
            securityOptions={getSecurityOptions()}
            securityTypeOptions={securityTypeOptions}
            categoryMappings={categoryMappings}
            shouldShowMapAccounts={shouldShowMapAccounts}
            setStep={setStep}
          />
        );

      case 'mapAccounts':
        return (
          <MapAccountsStep
            accountMappings={accountMappings}
            handleAccountMappingChange={handleAccountMappingChange}
            accountOptions={getAccountOptions()}
            accountTypeOptions={accountTypeOptions}
            currencyOptions={currencyOptions}
            defaultCurrency={defaultCurrency}
            scrollContainerRef={scrollContainerRef}
            categoryMappings={categoryMappings}
            securityMappings={securityMappings}
            setStep={setStep}
          />
        );

      case 'review':
        return (
          <ReviewStep
            importFiles={importFiles}
            isBulkImport={isBulkImport}
            fileName={fileName}
            parsedData={parsedData}
            selectedAccountId={selectedAccountId}
            accounts={accounts}
            categoryMappings={categoryMappings}
            accountMappings={accountMappings}
            securityMappings={securityMappings}
            shouldShowMapAccounts={shouldShowMapAccounts}
            isLoading={isLoading}
            handleImport={handleImport}
            setStep={setStep}
          />
        );

      case 'complete':
        return (
          <CompleteStep
            importFiles={importFiles}
            isBulkImport={isBulkImport}
            fileName={fileName}
            selectedAccountId={selectedAccountId}
            accounts={accounts}
            importResult={importResult}
            bulkImportResult={bulkImportResult}
            onImportMore={() => {
              setStep('upload');
              setImportFiles([]);
              setImportResult(null);
              setBulkImportResult(null);
              setCategoryMappings([]);
              setAccountMappings([]);
              setSecurityMappings([]);
              setInitialLookupDone(false);
            }}
          />
        );
    }
  };

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 py-8">
        <PageHeader
          title="Import Transactions"
          subtitle="Import transactions from a QIF file"
        />
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center space-x-4">
            {['upload', 'selectAccount', 'mapCategories', 'mapSecurities', 'mapAccounts', 'review', 'complete'].map(
              (s, i) => {
                const stepOrder = ['upload', 'selectAccount', 'mapCategories', 'mapSecurities', 'mapAccounts', 'review', 'complete'];
                const currentIndex = stepOrder.indexOf(step);
                const stepIndex = stepOrder.indexOf(s);
                const isActive = s === step;
                const isComplete = stepIndex < currentIndex;

                // Skip steps that aren't needed
                if (s === 'mapCategories' && categoryMappings.length === 0) return null;
                if (s === 'mapSecurities' && securityMappings.length === 0) return null;
                if (s === 'mapAccounts' && !shouldShowMapAccounts) return null;

                return (
                  <div key={s} className="flex items-center">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                        isComplete
                          ? 'bg-blue-600 text-white'
                          : isActive
                          ? 'bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400 border-2 border-blue-600'
                          : 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {isComplete ? (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      ) : (
                        i + 1
                      )}
                    </div>
                    {i < 6 && (
                      <div
                        className={`w-12 h-1 ${
                          isComplete ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                      />
                    )}
                  </div>
                );
              }
            )}
          </div>
        </div>

        {renderStep()}
      </main>
    </PageLayout>
  );
}
