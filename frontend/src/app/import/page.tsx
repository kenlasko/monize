'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { CategoryMappingRow } from '@/components/import/CategoryMappingRow';
import { importApi, ParsedQifResponse, CategoryMapping, AccountMapping, SecurityMapping, ImportResult, DateFormat } from '@/lib/import';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { investmentsApi } from '@/lib/investments';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { Account, AccountType } from '@/types/account';
import { Category } from '@/types/category';
import { Security } from '@/types/investment';

type ImportStep = 'upload' | 'selectAccount' | 'dateFormat' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';

// Data for each file in bulk import
interface ImportFileData {
  fileName: string;
  fileContent: string;
  parsedData: ParsedQifResponse;
  selectedAccountId: string;
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

// Check if an account is an investment account (any type)
const isInvestmentAccount = (account: Account): boolean => {
  return (
    account.accountType === 'INVESTMENT' ||
    account.accountSubType === 'INVESTMENT_CASH' ||
    account.accountSubType === 'INVESTMENT_BROKERAGE'
  );
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedAccountId = searchParams.get('accountId');

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

  // Helper to check if this is a bulk import (multiple files)
  const isBulkImport = importFiles.length > 1;

  // Helper to update a specific file's account selection
  const setFileAccountId = (fileIndex: number, accountId: string) => {
    setImportFiles(prev => prev.map((f, i) =>
      i === fileIndex ? { ...f, selectedAccountId: accountId } : f
    ));
  };

  // Legacy setter for single file (updates first file)
  const setSelectedAccountId = (accountId: string) => setFileAccountId(0, accountId);

  // Refs for scrollable containers
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Load accounts, categories, and securities
  useEffect(() => {
    const loadData = async () => {
      try {
        const [accountsData, categoriesData, securitiesData] = await Promise.all([
          accountsApi.getAll(),
          categoriesApi.getAll(),
          investmentsApi.getSecurities(true), // Include inactive securities
        ]);
        setAccounts(accountsData);
        setCategories(categoriesData);
        setSecurities(securitiesData);

        // If preselected account ID is provided, validate it exists
        if (preselectedAccountId) {
          const accountExists = accountsData.some((a) => a.id === preselectedAccountId);
          if (accountExists) {
            setSelectedAccountId(preselectedAccountId);
          }
        }
      } catch (error) {
        toast.error('Failed to load data');
      }
    };
    loadData();
  }, [preselectedAccountId]);

  // Scroll to top whenever the step changes
  useEffect(() => {
    window.scrollTo(0, 0);
    // Also scroll any inner scrollable container to the top
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [step]);

  // Auto-select first compatible account when on selectAccount step with no selection
  useEffect(() => {
    if (step !== 'selectAccount' || selectedAccountId || accounts.length === 0) {
      return;
    }

    const isQifInvestment = parsedData?.accountType === 'INVESTMENT';
    const compatibleAccounts = accounts.filter((a) => {
      if (isQifInvestment) {
        return isInvestmentBrokerageAccount(a);
      } else {
        return !isInvestmentBrokerageAccount(a);
      }
    });

    if (compatibleAccounts.length > 0) {
      setSelectedAccountId(compatibleAccounts[0].id);
    }
  }, [step, selectedAccountId, accounts, parsedData]);

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
          if (result) {
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
          console.error(`Bulk lookup failed for ${query}:`, error);
        }
      }

      setBulkLookupInProgress(false);
    };

    runBulkLookup();
  }, [step, initialLookupDone, securityMappings.length]);

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

  // Helper to match filename to account
  // QIF files replace / with - in account names, so also try matching with - replaced by /
  const matchFilenameToAccount = useCallback((fileName: string, isInvestmentType: boolean): string => {
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
    const matchedAccount = compatibleAccounts.find((a) => {
      const accountName = a.name.toLowerCase();
      return accountName === baseName || accountName === baseNameWithSlash;
    })
      // Then try partial matches
      || compatibleAccounts.find((a) => {
        const accountName = a.name.toLowerCase();
        return accountName.includes(baseName) || baseName.includes(accountName)
          || accountName.includes(baseNameWithSlash) || baseNameWithSlash.includes(accountName);
      });

    return matchedAccount?.id || '';
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
        const matchedAccountId = matchFilenameToAccount(file.name, isInvestmentType);

        fileDataArray.push({
          fileName: file.name,
          fileContent: content,
          parsedData: parsed,
          selectedAccountId: matchedAccountId,
        });
      }

      // Set the detected date format
      if (detectedFormat) {
        setDateFormat(detectedFormat);
      }

      // Store all file data
      setImportFiles(fileDataArray);

      // Initialize combined category mappings
      const catMappings: CategoryMapping[] = Array.from(allCategories).map((cat) => ({
        originalName: cat,
        categoryId: findMatchingCategory(cat),
        createNew: undefined,
      }));
      setCategoryMappings(catMappings);

      // Initialize combined account mappings
      // QIF files replace / with - in account names, so also try matching with - replaced by /
      const accMappings: AccountMapping[] = Array.from(allTransferAccounts).map((acc) => {
        const accLower = acc.toLowerCase();
        const accWithSlash = accLower.replace(/-/g, '/');
        const existingAcc = accounts.find((a) => {
          const aName = a.name.toLowerCase();
          return aName === accLower || aName === accWithSlash;
        });
        return {
          originalName: acc,
          accountId: existingAcc?.id,
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
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to parse QIF file(s)');
    } finally {
      setIsLoading(false);
    }
  }, [accounts, securities, findMatchingCategory, matchFilenameToAccount]);

  const handleCategoryMappingChange = (index: number, field: keyof CategoryMapping, value: string) => {
    setCategoryMappings((prev) => {
      const updated = [...prev];
      if (field === 'categoryId') {
        updated[index] = {
          ...updated[index],
          categoryId: value || undefined,
          createNew: undefined,
          parentCategoryId: undefined,
        };
      } else if (field === 'createNew') {
        updated[index] = {
          ...updated[index],
          categoryId: undefined,
          createNew: value || undefined,
        };
      } else if (field === 'parentCategoryId') {
        updated[index] = {
          ...updated[index],
          parentCategoryId: value || undefined,
        };
      }
      return updated;
    });
  };

  const handleAccountMappingChange = (index: number, field: keyof AccountMapping, value: string) => {
    setAccountMappings((prev) => {
      const updated = [...prev];
      if (field === 'accountId') {
        updated[index] = {
          ...updated[index],
          accountId: value || undefined,
          createNew: undefined,
          accountType: undefined,
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

        // Get current values to show what changed
        const currentMapping = securityMappings[index];

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
      console.error('Security lookup failed:', error);
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

        for (const fileData of importFiles) {
          try {
            const result = await importApi.importQif({
              content: fileData.fileContent,
              accountId: fileData.selectedAccountId,
              categoryMappings,
              accountMappings,
              securityMappings,
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
          } catch (error: any) {
            const targetAccount = accounts.find((a) => a.id === fileData.selectedAccountId);
            fileResults.push({
              fileName: fileData.fileName,
              accountName: targetAccount?.name || 'Unknown',
              imported: 0,
              skipped: 0,
              errors: 1,
              errorMessages: [error.response?.data?.message || 'Import failed'],
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
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Import failed');
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
    // Filter out brokerage accounts and loan accounts
    // Brokerage accounts - transfers should go to cash accounts
    // Loan accounts - balances are built using transactions from other accounts
    const transferableAccounts = accounts.filter(
      (a) => !isInvestmentBrokerageAccount(a) && a.accountType !== 'LOAN'
    );
    return [
      { value: '', label: 'Skip (no transfer)' },
      ...transferableAccounts
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a) => ({ value: a.id, label: `${a.name} (${formatAccountType(a.accountType)})` })),
    ];
  };

  // Check if ALL files are going to asset accounts (skip transfer mapping if so)
  // For single file, check if the selected account is an asset account
  // For bulk import, check if all files are going to asset accounts
  const allFilesAreAssetImports = importFiles.length > 0 && importFiles.every((f) => {
    const targetAccount = accounts.find((a) => a.id === f.selectedAccountId);
    return targetAccount?.accountType === 'ASSET';
  });

  // Helper to determine if mapAccounts step should be shown
  // Show if there are transfer accounts AND not all files are asset imports
  const shouldShowMapAccounts = accountMappings.length > 0 && !allFilesAreAssetImports;

  const accountTypeOptions = [
    { value: 'CHEQUING', label: 'Chequing' },
    { value: 'SAVINGS', label: 'Savings' },
    { value: 'CREDIT_CARD', label: 'Credit Card' },
    { value: 'INVESTMENT', label: 'Investment' },
    { value: 'LOAN', label: 'Loan' },
    { value: 'LINE_OF_CREDIT', label: 'Line of Credit' },
    { value: 'MORTGAGE', label: 'Mortgage' },
    { value: 'CASH', label: 'Cash' },
    { value: 'OTHER', label: 'Other' },
  ];

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

  const dateFormatOptions: { value: DateFormat; label: string; example: string }[] = [
    { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY', example: '12/31/2024' },
    { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY', example: '31/12/2024' },
    { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD', example: '2024-12-31' },
    { value: 'YYYY-DD-MM', label: 'YYYY-DD-MM', example: '2024-31-12' },
  ];

  const renderStep = () => {
    switch (step) {
      case 'upload':
        const preselectedAccount = accounts.find((a) => a.id === preselectedAccountId);
        return (
          <div className="max-w-xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Upload QIF Files
              </h2>
              {preselectedAccount && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    Importing to: <strong>{preselectedAccount.name}</strong> ({formatAccountType(preselectedAccount.accountType)})
                  </p>
                </div>
              )}
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Select one or more QIF files to import. You can select multiple files at once for bulk import.
                Files will be automatically matched to accounts based on filename.
              </p>
              <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center">
                <input
                  type="file"
                  accept=".qif"
                  multiple
                  onChange={handleFileSelect}
                  className="hidden"
                  id="qif-file"
                  disabled={isLoading}
                />
                <label
                  htmlFor="qif-file"
                  className="cursor-pointer inline-flex flex-col items-center"
                >
                  <svg
                    className="w-12 h-12 text-gray-400 mb-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                  <span className="text-gray-600 dark:text-gray-400">
                    {isLoading ? 'Processing...' : 'Click to select QIF file(s)'}
                  </span>
                </label>
              </div>
            </div>
          </div>
        );

      case 'selectAccount':
        // Helper to get compatible accounts for a file type
        const getCompatibleAccountsForType = (isInvestment: boolean) => {
          return accounts.filter((a) => {
            if (isInvestment) {
              return isInvestmentBrokerageAccount(a);
            } else {
              return !isInvestmentBrokerageAccount(a);
            }
          }).sort((a, b) => a.name.localeCompare(b.name));
        };

        // Check if all files have valid account selections
        const allFilesHaveAccounts = importFiles.every((f) => f.selectedAccountId);

        // For single file, use the old display
        if (!isBulkImport && parsedData) {
          const isQifInvestment = parsedData.accountType === 'INVESTMENT';
          const compatibleAccounts = getCompatibleAccountsForType(isQifInvestment);

          return (
            <div className="max-w-xl mx-auto">
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  Select Destination Account
                </h2>
                <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-6">
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    <strong>File:</strong> {fileName}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    <strong>Transactions:</strong> {parsedData.transactionCount}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    <strong>Date Range:</strong> {parsedData.dateRange.start} to {parsedData.dateRange.end}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    <strong>Detected Type:</strong> {parsedData.accountType}
                  </p>
                </div>

                {isQifInvestment && (
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
                    <p className="text-sm text-blue-700 dark:text-blue-300">
                      This file contains investment transactions. Only brokerage accounts are shown.
                    </p>
                  </div>
                )}

                {compatibleAccounts.length === 0 ? (
                  <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                    <p className="text-sm text-yellow-700 dark:text-yellow-300">
                      No compatible accounts found. {isQifInvestment
                        ? 'Please create an investment brokerage account first.'
                        : 'Please create an account first.'}
                    </p>
                  </div>
                ) : (
                  <Select
                    label="Import into account"
                    options={compatibleAccounts.map((a) => ({
                      value: a.id,
                      label: `${a.name} (${formatAccountType(a.accountType)})`,
                    }))}
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                  />
                )}
                <div className="flex justify-between mt-6">
                  <Button variant="outline" onClick={() => setStep('upload')}>
                    Back
                  </Button>
                  <Button
                    onClick={() => setStep('dateFormat')}
                    disabled={!selectedAccountId || compatibleAccounts.length === 0}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          );
        }

        // Bulk import: show all files with their account selections
        return (
          <div className="max-w-4xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Select Destination Accounts
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Verify or change the destination account for each file. Files have been automatically matched based on filename.
              </p>

              <div className="space-y-4 max-h-[32rem] overflow-y-auto">
                {importFiles.map((fileData, index) => {
                  const isInvestment = fileData.parsedData.accountType === 'INVESTMENT';
                  const compatibleAccounts = getCompatibleAccountsForType(isInvestment);
                  const hasValidAccount = !!fileData.selectedAccountId;

                  return (
                    <div
                      key={index}
                      className={`border rounded-lg p-4 ${
                        hasValidAccount
                          ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20'
                          : 'border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900 dark:text-gray-100 truncate">
                            {fileData.fileName}
                          </p>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {fileData.parsedData.transactionCount} transactions
                            {isInvestment && ' (Investment)'}
                          </p>
                        </div>
                        <div className="sm:w-80">
                          <Select
                            options={compatibleAccounts.map((a) => ({
                              value: a.id,
                              label: `${a.name} (${formatAccountType(a.accountType)})`,
                            }))}
                            value={fileData.selectedAccountId}
                            onChange={(e) => setFileAccountId(index, e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 text-sm text-gray-600 dark:text-gray-400">
                <strong>Total:</strong> {importFiles.length} files,{' '}
                {importFiles.reduce((sum, f) => sum + f.parsedData.transactionCount, 0)} transactions
              </div>

              <div className="flex justify-between mt-6">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  Back
                </Button>
                <Button
                  onClick={() => setStep('dateFormat')}
                  disabled={!allFilesHaveAccounts}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        );

      case 'dateFormat':
        return (
          <div className="max-w-xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Confirm Date Format
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                We detected the date format from your file. Please verify it is correct or select
                a different format.
              </p>

              {parsedData?.sampleDates && parsedData.sampleDates.length > 0 && (
                <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-6">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Sample dates from your file:
                  </p>
                  <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                    {parsedData.sampleDates.map((date, i) => (
                      <li key={i} className="font-mono">{date}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-3">
                {dateFormatOptions.map((option) => (
                  <label
                    key={option.value}
                    className={`flex items-center justify-between p-4 border rounded-lg cursor-pointer transition-colors ${
                      dateFormat === option.value
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center">
                      <input
                        type="radio"
                        name="dateFormat"
                        value={option.value}
                        checked={dateFormat === option.value}
                        onChange={() => setDateFormat(option.value)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 dark:border-gray-600"
                      />
                      <span className="ml-3 font-medium text-gray-900 dark:text-gray-100">
                        {option.label}
                      </span>
                      {parsedData?.detectedDateFormat === option.value && (
                        <span className="ml-2 text-xs px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded">
                          Detected
                        </span>
                      )}
                    </div>
                    <span className="text-sm text-gray-500 dark:text-gray-400 font-mono">
                      e.g., {option.example}
                    </span>
                  </label>
                ))}
              </div>

              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => setStep(preselectedAccountId ? 'upload' : 'selectAccount')}
                >
                  Back
                </Button>
                <Button
                  onClick={() => {
                    if (categoryMappings.length > 0) {
                      setStep('mapCategories');
                    } else if (securityMappings.length > 0) {
                      setStep('mapSecurities');
                    } else if (shouldShowMapAccounts) {
                      setStep('mapAccounts');
                    } else {
                      setStep('review');
                    }
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        );

      case 'mapCategories':
        // A category is "matched" only if it has a category mapped OR is a loan with an account selected/created
        // For new loans, require both the name AND the initial amount before considering it fully mapped
        const isFullyMapped = (m: CategoryMapping) =>
          m.categoryId || (m.isLoanCategory && (m.loanAccountId || (m.createNewLoan && m.newLoanAmount !== undefined)));
        const unmatchedCategories = categoryMappings.filter((m) => !isFullyMapped(m));
        const matchedCategories = categoryMappings.filter((m) => isFullyMapped(m));
        // Filter loan accounts for the loan category mapping feature
        const loanAccounts = accounts
          .filter((a) => a.accountType === 'LOAN' || a.accountType === 'MORTGAGE')
          .sort((a, b) => a.name.localeCompare(b.name));

        return (
          <div className="max-w-4xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Map Categories
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                The following categories were found in your QIF file. Map them to existing
                categories or create new ones.
              </p>

              {/* Summary */}
              <div className="flex gap-4 mb-4 text-sm">
                <span className="text-amber-600 dark:text-amber-400">
                  {unmatchedCategories.length} need attention
                </span>
                <span className="text-green-600 dark:text-green-400">
                  {matchedCategories.length} auto-matched
                </span>
              </div>

              <div ref={scrollContainerRef} className="space-y-3 max-h-[32rem] overflow-y-auto">
                {/* Unmatched categories first - highlighted */}
                {unmatchedCategories.map((mapping) => {
                  const index = categoryMappings.findIndex((m) => m.originalName === mapping.originalName);
                  return (
                    <CategoryMappingRow
                      key={mapping.originalName}
                      mapping={mapping}
                      categoryOptions={categoryOptions}
                      parentCategoryOptions={parentCategoryOptions}
                      loanAccounts={loanAccounts}
                      onMappingChange={(update) => {
                        setCategoryMappings((prev) => {
                          const updated = [...prev];
                          updated[index] = { ...updated[index], ...update };
                          return updated;
                        });
                      }}
                      formatCategoryPath={formatCategoryPath}
                      isHighlighted={true}
                    />
                  );
                })}

                {/* Matched categories - minimized */}
                {matchedCategories.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 py-2">
                      <span className="ml-1">Show {matchedCategories.length} auto-matched categories</span>
                    </summary>
                    <div className="space-y-2 mt-2">
                      {matchedCategories.map((mapping) => {
                        const index = categoryMappings.findIndex((m) => m.originalName === mapping.originalName);
                        return (
                          <CategoryMappingRow
                            key={mapping.originalName}
                            mapping={mapping}
                            categoryOptions={categoryOptions}
                            parentCategoryOptions={parentCategoryOptions}
                            loanAccounts={loanAccounts}
                            onMappingChange={(update) => {
                              setCategoryMappings((prev) => {
                                const updated = [...prev];
                                updated[index] = { ...updated[index], ...update };
                                return updated;
                              });
                            }}
                            formatCategoryPath={formatCategoryPath}
                            isHighlighted={false}
                          />
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => setStep('dateFormat')}
                >
                  Back
                </Button>
                <Button
                  onClick={() => {
                    if (securityMappings.length > 0) {
                      setStep('mapSecurities');
                    } else if (shouldShowMapAccounts) {
                      setStep('mapAccounts');
                    } else {
                      setStep('review');
                    }
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        );

      case 'mapSecurities':
        // Count securities that have been looked up (have symbol and name filled in) or mapped to existing
        const readyCount = securityMappings.filter((m) => m.securityId || (m.createNew && m.securityName)).length;
        const needsAttentionCount = securityMappings.length - readyCount;

        return (
          <div className="max-w-4xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Map Securities
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                The following securities were found in your QIF file. Map them to existing
                securities or create new ones.
              </p>

              {/* Summary */}
              <div className="flex gap-4 mb-4 text-sm">
                <span className="text-amber-600 dark:text-amber-400">
                  {needsAttentionCount} need attention
                </span>
                <span className="text-green-600 dark:text-green-400">
                  {readyCount} ready
                </span>
                {bulkLookupInProgress && (
                  <span className="text-blue-600 dark:text-blue-400">
                    Looking up securities...
                  </span>
                )}
              </div>

              <div className="space-y-3 max-h-[32rem] overflow-y-auto">
                {securityMappings.map((mapping, index) => {
                  // Green if mapped to existing OR has symbol and name filled in
                  const isReady = mapping.securityId || (mapping.createNew && mapping.securityName);
                  return (
                    <div
                      key={mapping.originalName}
                      className={isReady
                        ? "border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-lg p-4"
                        : "border-2 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4"
                      }
                    >
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          {mapping.originalName}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleSecurityLookup(index, mapping.createNew || mapping.originalName)}
                          disabled={lookupLoadingIndex === index}
                        >
                          {lookupLoadingIndex === index ? 'Looking up...' : 'Lookup'}
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Select
                          label="Map to existing"
                          options={getSecurityOptions()}
                          value={mapping.securityId || ''}
                          onChange={(e) =>
                            handleSecurityMappingChange(index, 'securityId', e.target.value)
                          }
                        />
                        <div className="space-y-2">
                          <Input
                            label="Or create new (symbol)"
                            placeholder="e.g., AAPL"
                            value={mapping.createNew || ''}
                            onChange={(e) =>
                              handleSecurityMappingChange(index, 'createNew', e.target.value)
                            }
                          />
                          <Input
                            label="Security name"
                            placeholder="e.g., Apple Inc."
                            value={mapping.securityName || ''}
                            onChange={(e) =>
                              handleSecurityMappingChange(index, 'securityName', e.target.value)
                            }
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <Select
                              label="Security type"
                              options={securityTypeOptions}
                              value={mapping.securityType || 'STOCK'}
                              onChange={(e) =>
                                handleSecurityMappingChange(index, 'securityType', e.target.value)
                              }
                            />
                            <Input
                              label="Exchange"
                              placeholder="e.g., TSX, NYSE"
                              value={mapping.exchange || ''}
                              onChange={(e) =>
                                handleSecurityMappingChange(index, 'exchange', e.target.value)
                              }
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (categoryMappings.length > 0) {
                      setStep('mapCategories');
                    } else {
                      setStep('dateFormat');
                    }
                  }}
                >
                  Back
                </Button>
                <Button
                  onClick={() => {
                    if (shouldShowMapAccounts) {
                      setStep('mapAccounts');
                    } else {
                      setStep('review');
                    }
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        );

      case 'mapAccounts':
        return (
          <div className="max-w-4xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Map Transfer Accounts
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                The following transfer accounts were found in your QIF file. Map them to existing
                accounts or create new ones.
              </p>
              <div ref={scrollContainerRef} className="space-y-4 max-h-96 overflow-y-auto">
                {accountMappings.map((mapping, index) => {
                  const isReady = !!(mapping.accountId || mapping.createNew);
                  return (
                  <div
                    key={mapping.originalName}
                    className={isReady
                      ? "border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-lg p-4"
                      : "border-2 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4"
                    }
                  >
                    <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                      {mapping.originalName}
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <Select
                        label="Map to existing"
                        options={getAccountOptions()}
                        value={mapping.accountId || ''}
                        onChange={(e) =>
                          handleAccountMappingChange(index, 'accountId', e.target.value)
                        }
                      />
                      <div>
                        <Input
                          label="Or create new"
                          placeholder="New account name"
                          value={mapping.createNew || ''}
                          onChange={(e) =>
                            handleAccountMappingChange(index, 'createNew', e.target.value)
                          }
                        />
                        {mapping.createNew && (
                          <div className="mt-2">
                            <Select
                              label="Account type"
                              options={accountTypeOptions}
                              value={mapping.accountType || 'CHEQUING'}
                              onChange={(e) =>
                                handleAccountMappingChange(index, 'accountType', e.target.value)
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (securityMappings.length > 0) {
                      setStep('mapSecurities');
                    } else if (categoryMappings.length > 0) {
                      setStep('mapCategories');
                    } else {
                      setStep('dateFormat');
                    }
                  }}
                >
                  Back
                </Button>
                <Button onClick={() => setStep('review')}>Next</Button>
              </div>
            </div>
          </div>
        );

      case 'review':
        const mappedCategories = categoryMappings.filter((m) => m.categoryId || m.createNew).length;
        const newCategories = categoryMappings.filter((m) => m.createNew).length;
        const loanCategories = categoryMappings.filter((m) => m.isLoanCategory).length;
        const newLoanAccounts = categoryMappings.filter((m) => m.isLoanCategory && m.createNewLoan).length;
        const mappedAccounts = accountMappings.filter((m) => m.accountId || m.createNew).length;
        const newAccounts = accountMappings.filter((m) => m.createNew).length;
        const mappedSecuritiesCount = securityMappings.filter((m) => m.securityId || m.createNew).length;
        const newSecuritiesCount = securityMappings.filter((m) => m.createNew).length;
        const totalTransactions = importFiles.reduce((sum, f) => sum + f.parsedData.transactionCount, 0);

        return (
          <div className="max-w-xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Review Import
              </h2>
              <div className="space-y-4">
                <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                  <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                    {isBulkImport ? 'Files to Import' : 'Summary'}
                  </h3>
                  {isBulkImport ? (
                    <div className="space-y-2">
                      {importFiles.map((fileData, index) => {
                        const targetAcc = accounts.find((a) => a.id === fileData.selectedAccountId);
                        return (
                          <div key={index} className="text-sm text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-600 pb-2 last:border-0">
                            <p><strong>{fileData.fileName}</strong></p>
                            <p className="ml-4">
                              {fileData.parsedData.transactionCount} transactions → {targetAcc?.name}
                            </p>
                          </div>
                        );
                      })}
                      <div className="pt-2 text-sm text-gray-600 dark:text-gray-400">
                        <strong>Total:</strong> {importFiles.length} files, {totalTransactions} transactions
                      </div>
                    </div>
                  ) : (
                    <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                      <li>
                        <strong>File:</strong> {fileName}
                      </li>
                      <li>
                        <strong>Transactions to import:</strong> {parsedData?.transactionCount}
                      </li>
                      <li>
                        <strong>Target account:</strong> {accounts.find((a) => a.id === selectedAccountId)?.name}
                      </li>
                    </ul>
                  )}
                </div>

                {categoryMappings.length > 0 && (
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                      Categories
                    </h3>
                    <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                      <li>
                        <strong>Total:</strong> {categoryMappings.length}
                      </li>
                      <li>
                        <strong>Mapped to categories:</strong> {mappedCategories}
                      </li>
                      <li>
                        <strong>New categories to create:</strong> {newCategories}
                      </li>
                      {loanCategories > 0 && (
                        <>
                          <li>
                            <strong>Mapped to loan accounts:</strong> {loanCategories}
                          </li>
                          {newLoanAccounts > 0 && (
                            <li>
                              <strong>New loan accounts to create:</strong> {newLoanAccounts}
                            </li>
                          )}
                        </>
                      )}
                    </ul>
                  </div>
                )}

                {accountMappings.length > 0 && (
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                      Transfer Accounts
                    </h3>
                    <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                      <li>
                        <strong>Total:</strong> {accountMappings.length}
                      </li>
                      <li>
                        <strong>Mapped:</strong> {mappedAccounts}
                      </li>
                      <li>
                        <strong>New to create:</strong> {newAccounts}
                      </li>
                    </ul>
                  </div>
                )}

                {securityMappings.length > 0 && (
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                      Securities
                    </h3>
                    <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                      <li>
                        <strong>Total:</strong> {securityMappings.length}
                      </li>
                      <li>
                        <strong>Mapped:</strong> {mappedSecuritiesCount}
                      </li>
                      <li>
                        <strong>New to create:</strong> {newSecuritiesCount}
                      </li>
                    </ul>
                  </div>
                )}
              </div>
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (shouldShowMapAccounts) {
                      setStep('mapAccounts');
                    } else if (securityMappings.length > 0) {
                      setStep('mapSecurities');
                    } else if (categoryMappings.length > 0) {
                      setStep('mapCategories');
                    } else {
                      setStep('dateFormat');
                    }
                  }}
                >
                  Back
                </Button>
                <Button onClick={handleImport} isLoading={isLoading}>
                  Import Transactions
                </Button>
              </div>
            </div>
          </div>
        );

      case 'complete':
        // Check if any file was an investment type
        const hasInvestmentFile = importFiles.some((f) => f.parsedData.accountType === 'INVESTMENT');

        return (
          <div className={isBulkImport ? "max-w-4xl mx-auto" : "max-w-xl mx-auto"}>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <div className="text-center mb-6">
                <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 dark:bg-green-900 mb-4">
                  <svg
                    className="h-6 w-6 text-green-600 dark:text-green-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Import Complete
                </h2>
              </div>

              {/* Bulk import results */}
              {bulkImportResult && (
                <div className="space-y-4 mb-6">
                  {/* Overall summary */}
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">Overall Summary</h3>
                    <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                      <li><strong>Files imported:</strong> {bulkImportResult.fileResults.length}</li>
                      <li><strong>Total imported:</strong> {bulkImportResult.totalImported} transactions</li>
                      <li><strong>Total skipped:</strong> {bulkImportResult.totalSkipped} duplicate transfers</li>
                      <li><strong>Total errors:</strong> {bulkImportResult.totalErrors}</li>
                      <li><strong>Categories created:</strong> {bulkImportResult.categoriesCreated}</li>
                      <li><strong>Accounts created:</strong> {bulkImportResult.accountsCreated}</li>
                      <li><strong>Payees created:</strong> {bulkImportResult.payeesCreated}</li>
                      <li><strong>Securities created:</strong> {bulkImportResult.securitiesCreated}</li>
                    </ul>
                  </div>

                  {/* Per-file results */}
                  <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">Per-File Results</h3>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {bulkImportResult.fileResults.map((result, index) => (
                        <div
                          key={index}
                          className={`text-sm p-2 rounded ${
                            result.errors > 0
                              ? 'bg-red-50 dark:bg-red-900/20'
                              : 'bg-green-50 dark:bg-green-900/20'
                          }`}
                        >
                          <p className="font-medium text-gray-900 dark:text-gray-100">{result.fileName}</p>
                          <p className="text-gray-600 dark:text-gray-400">
                            → {result.accountName}: {result.imported} imported, {result.skipped} skipped
                            {result.errors > 0 && <span className="text-red-600 dark:text-red-400">, {result.errors} errors</span>}
                          </p>
                          {result.errorMessages.length > 0 && (
                            <ul className="text-xs text-red-500 dark:text-red-400 mt-1">
                              {result.errorMessages.slice(0, 3).map((msg, i) => (
                                <li key={i}>{msg}</li>
                              ))}
                              {result.errorMessages.length > 3 && (
                                <li>...and {result.errorMessages.length - 3} more errors</li>
                              )}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Single file import result */}
              {importResult && !bulkImportResult && (
                <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-6">
                  <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                    <li>
                      <strong>File:</strong> {fileName}
                    </li>
                    <li>
                      <strong>Target Account:</strong> {accounts.find(a => a.id === selectedAccountId)?.name || 'Unknown'}
                    </li>
                    <li>
                      <strong>Imported:</strong> {importResult.imported} transactions
                    </li>
                    <li>
                      <strong>Skipped:</strong> {importResult.skipped} duplicate transfers
                    </li>
                    <li>
                      <strong>Errors:</strong> {importResult.errors}
                    </li>
                    <li>
                      <strong>Categories created:</strong> {importResult.categoriesCreated}
                    </li>
                    <li>
                      <strong>Accounts created:</strong> {importResult.accountsCreated}
                    </li>
                    <li>
                      <strong>Payees created:</strong> {importResult.payeesCreated}
                    </li>
                    <li>
                      <strong>Securities created:</strong> {importResult.securitiesCreated}
                    </li>
                  </ul>
                  {importResult.errorMessages.length > 0 && (
                    <div className="mt-4">
                      <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-2">
                        Errors:
                      </p>
                      <ul className="text-xs text-red-500 dark:text-red-400 space-y-1 max-h-32 overflow-y-auto">
                        {importResult.errorMessages.map((msg, i) => (
                          <li key={i}>{msg}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-center space-x-4">
                <Button
                  variant="outline"
                  onClick={() => router.push(hasInvestmentFile ? '/investments' : '/transactions')}
                >
                  {hasInvestmentFile ? 'View Investments' : 'View Transactions'}
                </Button>
                <Button
                  onClick={() => {
                    setStep('upload');
                    setImportFiles([]);
                    setImportResult(null);
                    setBulkImportResult(null);
                    setCategoryMappings([]);
                    setAccountMappings([]);
                    setSecurityMappings([]);
                    setInitialLookupDone(false);
                  }}
                >
                  Import More Files
                </Button>
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 lg:px-12 py-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Import Transactions</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Import transactions from a QIF file
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Progress indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-center space-x-4">
            {['upload', 'selectAccount', 'dateFormat', 'mapCategories', 'mapSecurities', 'mapAccounts', 'review', 'complete'].map(
              (s, i) => {
                const stepOrder = ['upload', 'selectAccount', 'dateFormat', 'mapCategories', 'mapSecurities', 'mapAccounts', 'review', 'complete'];
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
                    {i < 7 && (
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
      </div>
    </div>
  );
}
