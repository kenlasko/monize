'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { importApi, ParsedQifResponse, CategoryMapping, AccountMapping, SecurityMapping, ImportResult, DateFormat } from '@/lib/import';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { investmentsApi } from '@/lib/investments';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { Account, AccountType } from '@/types/account';
import { Category } from '@/types/category';
import { Security } from '@/types/investment';

type ImportStep = 'upload' | 'selectAccount' | 'dateFormat' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';

const formatAccountType = (type: AccountType): string => {
  const labels: Record<AccountType, string> = {
    CHEQUING: 'Chequing',
    SAVINGS: 'Savings',
    CREDIT_CARD: 'Credit Card',
    INVESTMENT: 'Investment',
    LOAN: 'Loan',
    MORTGAGE: 'Mortgage',
    RRSP: 'RRSP',
    TFSA: 'TFSA',
    RESP: 'RESP',
    CASH: 'Cash',
    LINE_OF_CREDIT: 'Line of Credit',
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
  const [fileContent, setFileContent] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [parsedData, setParsedData] = useState<ParsedQifResponse | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(preselectedAccountId || '');
  const [categoryMappings, setCategoryMappings] = useState<CategoryMapping[]>([]);
  const [accountMappings, setAccountMappings] = useState<AccountMapping[]>([]);
  const [securityMappings, setSecurityMappings] = useState<SecurityMapping[]>([]);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [dateFormat, setDateFormat] = useState<DateFormat>('MM/DD/YYYY');
  const [isLoading, setIsLoading] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

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

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setIsLoading(true);

    try {
      const content = await file.text();
      setFileContent(content);

      const parsed = await importApi.parseQif(content);
      setParsedData(parsed);

      // Set the detected date format
      if (parsed.detectedDateFormat) {
        setDateFormat(parsed.detectedDateFormat);
      }

      // Build a map of full category paths to category IDs
      const getCategoryPath = (category: Category): string => {
        if (category.parentId) {
          const parent = categories.find((c) => c.id === category.parentId);
          if (parent) {
            return `${parent.name}: ${category.name}`;
          }
        }
        return category.name;
      };

      // Initialize category mappings
      const catMappings: CategoryMapping[] = parsed.categories.map((cat) => {
        // Normalize the QIF category path for comparison (add space after colon)
        // "Bills:Cell Phone" -> "bills: cell phone"
        const normalizedQifCat = formatCategoryPath(cat).toLowerCase();
        // Get the last part of the path (subcategory name)
        const qifSubcategory = cat.split(':').pop()?.trim().toLowerCase() || '';
        // Get the parent part if it exists (e.g., "Automobile" from "Automobile:Gasoline")
        const qifParts = cat.split(':');
        const qifParentName = qifParts.length > 1 ? qifParts[0].trim().toLowerCase() : null;

        // Try to find an existing category match - prioritize exact matches
        // First, try exact full path match
        let existingCat = categories.find((c) => {
          const fullPath = getCategoryPath(c).toLowerCase();
          return fullPath === normalizedQifCat;
        });

        // If no exact path match, try matching category name against full normalized path
        if (!existingCat) {
          existingCat = categories.find((c) => {
            return c.name.toLowerCase() === normalizedQifCat;
          });
        }

        // If still no match and there's a parent in the QIF path, try matching subcategory with correct parent
        if (!existingCat && qifParentName) {
          existingCat = categories.find((c) => {
            if (c.name.toLowerCase() !== qifSubcategory) return false;
            // Check if this category's parent matches the QIF parent
            if (c.parentId) {
              const parent = categories.find((p) => p.id === c.parentId);
              return parent?.name.toLowerCase() === qifParentName;
            }
            return false;
          });
        }

        // Last resort: match just the subcategory name (only if no parent specified in QIF)
        if (!existingCat && !qifParentName) {
          existingCat = categories.find((c) => {
            return c.name.toLowerCase() === qifSubcategory;
          });
        }

        // If no match found, suggest creating with just the subcategory name
        // (user can select parent category separately)
        const suggestedName = cat.split(':').pop()?.trim() || cat;

        return {
          originalName: cat,
          categoryId: existingCat?.id,
          // Pre-populate createNew only if no existing match found
          createNew: existingCat ? undefined : suggestedName,
        };
      });
      setCategoryMappings(catMappings);

      // Initialize account mappings for transfers
      const accMappings: AccountMapping[] = parsed.transferAccounts.map((acc) => {
        const existingAcc = accounts.find(
          (a) => a.name.toLowerCase() === acc.toLowerCase()
        );
        return {
          originalName: acc,
          accountId: existingAcc?.id,
        };
      });
      setAccountMappings(accMappings);

      // Initialize security mappings for investment transactions
      const secMappings: SecurityMapping[] = (parsed.securities || []).map((sec) => {
        // Try to find an existing security by symbol or name (case-insensitive)
        const existingSec = securities.find(
          (s) =>
            s.symbol.toLowerCase() === sec.toLowerCase() ||
            s.name.toLowerCase() === sec.toLowerCase()
        );
        return {
          originalName: sec,
          securityId: existingSec?.id,
          // Pre-populate createNew only if no existing match found
          createNew: existingSec ? undefined : sec,
          securityName: existingSec ? undefined : sec,
          securityType: undefined,
        };
      });
      setSecurityMappings(secMappings);

      // Check if preselected account is compatible with QIF file type
      // Investment QIF files should only go to brokerage accounts
      // Regular QIF files should not go to any investment accounts
      const isQifInvestmentType = parsed.accountType === 'INVESTMENT';
      let canUsePreselectedAccount = false;

      if (selectedAccountId) {
        const preselectedAcc = accounts.find((a) => a.id === selectedAccountId);
        if (preselectedAcc) {
          if (isQifInvestmentType) {
            // Investment QIF requires a brokerage account
            canUsePreselectedAccount = isInvestmentBrokerageAccount(preselectedAcc);
          } else {
            // Regular QIF requires a non-investment account
            canUsePreselectedAccount = !isInvestmentAccount(preselectedAcc);
          }

          if (!canUsePreselectedAccount) {
            // Clear incompatible preselected account
            setSelectedAccountId('');
            toast.error(
              isQifInvestmentType
                ? 'The preselected account is not an investment brokerage account. Please select a compatible account.'
                : 'The preselected account is an investment account. Please select a compatible account.'
            );
          }
        }
      }

      // If account is already selected (from URL parameter) and is compatible, skip to date format step
      if (selectedAccountId && canUsePreselectedAccount) {
        setStep('dateFormat');
      } else {
        setStep('selectAccount');
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to parse QIF file');
    } finally {
      setIsLoading(false);
    }
  }, [accounts, categories, securities, selectedAccountId]);

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
        };
      } else if (field === 'createNew') {
        updated[index] = {
          ...updated[index],
          securityId: undefined,
          createNew: value || undefined,
          // Don't overwrite securityName if user has already edited it
        };
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
      }
      return updated;
    });
  };

  const handleImport = async () => {
    if (!selectedAccountId || !fileContent) return;

    setIsLoading(true);
    try {
      const result = await importApi.importQif({
        content: fileContent,
        accountId: selectedAccountId,
        categoryMappings,
        accountMappings,
        securityMappings,
        skipDuplicates,
        dateFormat,
      });

      setImportResult(result);
      setStep('complete');

      if (result.errors === 0) {
        toast.success(`Successfully imported ${result.imported} transactions`);
      } else {
        toast.success(`Imported ${result.imported} transactions with ${result.errors} errors`);
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Import failed');
    } finally {
      setIsLoading(false);
    }
  };

  const getCategoryOptions = () => {
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
  };

  const getParentCategoryOptions = () => {
    const options = [{ value: '', label: 'No parent (top-level)' }];
    categories
      .filter((c) => !c.parentId)
      .forEach((c) => {
        options.push({ value: c.id, label: c.name });
      });
    return options;
  };

  const getAccountOptions = () => {
    return [
      { value: '', label: 'Skip (no transfer)' },
      ...accounts.map((a) => ({ value: a.id, label: `${a.name} (${formatAccountType(a.accountType)})` })),
    ];
  };

  const accountTypeOptions = [
    { value: 'CHEQUING', label: 'Chequing' },
    { value: 'SAVINGS', label: 'Savings' },
    { value: 'CREDIT_CARD', label: 'Credit Card' },
    { value: 'CASH', label: 'Cash' },
    { value: 'INVESTMENT', label: 'Investment' },
    { value: 'ASSET', label: 'Asset' },
    { value: 'LIABILITY', label: 'Liability' },
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
        const preselectedAccount = accounts.find((a) => a.id === selectedAccountId);
        return (
          <div className="max-w-xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Upload QIF File
              </h2>
              {preselectedAccount && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    Importing to: <strong>{preselectedAccount.name}</strong> ({formatAccountType(preselectedAccount.accountType)})
                  </p>
                </div>
              )}
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Select a QIF file to import transactions from. QIF is a common format exported by
                many financial applications.
              </p>
              <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center">
                <input
                  type="file"
                  accept=".qif"
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
                    {isLoading ? 'Processing...' : 'Click to select a QIF file'}
                  </span>
                </label>
              </div>
            </div>
          </div>
        );

      case 'selectAccount':
        // Determine if QIF file is investment type
        const isQifInvestment = parsedData?.accountType === 'INVESTMENT';

        // Filter accounts based on QIF type
        // Investment QIF files should only go to brokerage accounts
        // Regular QIF files should not go to any investment accounts
        const compatibleAccounts = accounts.filter((a) => {
          if (isQifInvestment) {
            // Only show brokerage accounts for investment QIF files
            return isInvestmentBrokerageAccount(a);
          } else {
            // Hide all investment accounts for regular QIF files
            return !isInvestmentAccount(a);
          }
        });

        return (
          <div className="max-w-xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Select Destination Account
              </h2>
              {parsedData && (
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
              )}

              {/* Show notice about account filtering */}
              {isQifInvestment ? (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    This file contains investment transactions. Only brokerage accounts are shown.
                  </p>
                </div>
              ) : (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    This file contains regular banking transactions. Investment accounts are hidden.
                  </p>
                </div>
              )}

              {compatibleAccounts.length === 0 ? (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">
                    No compatible accounts found. {isQifInvestment
                      ? 'Please create an investment brokerage account first.'
                      : 'Please create a non-investment account first.'}
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
              <div className="mt-4">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={skipDuplicates}
                    onChange={(e) => setSkipDuplicates(e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded dark:border-gray-600 dark:bg-gray-800"
                  />
                  <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                    Skip duplicate transactions (same date and amount)
                  </span>
                </label>
              </div>
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
                    if (parsedData?.categories.length) {
                      setStep('mapCategories');
                    } else if (parsedData?.securities?.length) {
                      setStep('mapSecurities');
                    } else if (parsedData?.transferAccounts.length) {
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
        const unmatchedCategories = categoryMappings.filter((m) => !m.categoryId);
        const matchedCategories = categoryMappings.filter((m) => m.categoryId);

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

              <div className="space-y-3 max-h-[32rem] overflow-y-auto">
                {/* Unmatched categories first - highlighted */}
                {unmatchedCategories.map((mapping) => {
                  const index = categoryMappings.findIndex((m) => m.originalName === mapping.originalName);
                  return (
                    <div
                      key={mapping.originalName}
                      className="border-2 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4"
                    >
                      <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                        {formatCategoryPath(mapping.originalName)}
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Select
                          label="Map to existing"
                          options={getCategoryOptions()}
                          value={mapping.categoryId || ''}
                          onChange={(e) =>
                            handleCategoryMappingChange(index, 'categoryId', e.target.value)
                          }
                        />
                        <div>
                          <Input
                            label="Or create new"
                            placeholder="New category name"
                            value={mapping.createNew || ''}
                            onChange={(e) =>
                              handleCategoryMappingChange(index, 'createNew', e.target.value)
                            }
                          />
                          {mapping.createNew && (
                            <div className="mt-2">
                              <Select
                                label="Parent category"
                                options={getParentCategoryOptions()}
                                value={mapping.parentCategoryId || ''}
                                onChange={(e) =>
                                  handleCategoryMappingChange(index, 'parentCategoryId', e.target.value)
                                }
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
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
                          <div
                            key={mapping.originalName}
                            className="border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-lg p-3"
                          >
                            <div className="flex items-center gap-3">
                              <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap min-w-[200px]">
                                {formatCategoryPath(mapping.originalName)}
                              </span>
                              <span className="text-gray-400">→</span>
                              <Select
                                options={getCategoryOptions()}
                                value={mapping.categoryId || ''}
                                onChange={(e) =>
                                  handleCategoryMappingChange(index, 'categoryId', e.target.value)
                                }
                                className="flex-1"
                              />
                            </div>
                          </div>
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
                    if (parsedData?.securities?.length) {
                      setStep('mapSecurities');
                    } else if (parsedData?.transferAccounts.length) {
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
        const unmatchedSecurities = securityMappings.filter((m) => !m.securityId);
        const matchedSecurities = securityMappings.filter((m) => m.securityId);

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
                  {unmatchedSecurities.length} need attention
                </span>
                <span className="text-green-600 dark:text-green-400">
                  {matchedSecurities.length} auto-matched
                </span>
              </div>

              <div className="space-y-3 max-h-[32rem] overflow-y-auto">
                {/* Unmatched securities first - highlighted */}
                {unmatchedSecurities.map((mapping) => {
                  const index = securityMappings.findIndex((m) => m.originalName === mapping.originalName);
                  return (
                    <div
                      key={mapping.originalName}
                      className="border-2 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4"
                    >
                      <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                        {mapping.originalName}
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Select
                          label="Map to existing"
                          options={getSecurityOptions()}
                          value={mapping.securityId || ''}
                          onChange={(e) =>
                            handleSecurityMappingChange(index, 'securityId', e.target.value)
                          }
                        />
                        <div>
                          <Input
                            label="Or create new (symbol)"
                            placeholder="e.g., AAPL"
                            value={mapping.createNew || ''}
                            onChange={(e) =>
                              handleSecurityMappingChange(index, 'createNew', e.target.value)
                            }
                          />
                          {mapping.createNew && (
                            <div className="mt-2 space-y-2">
                              <Input
                                label="Security name"
                                placeholder="e.g., Apple Inc."
                                value={mapping.securityName || ''}
                                onChange={(e) =>
                                  handleSecurityMappingChange(index, 'securityName', e.target.value)
                                }
                              />
                              <Select
                                label="Security type"
                                options={securityTypeOptions}
                                value={mapping.securityType || 'STOCK'}
                                onChange={(e) =>
                                  handleSecurityMappingChange(index, 'securityType', e.target.value)
                                }
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Matched securities - minimized */}
                {matchedSecurities.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 py-2">
                      <span className="ml-1">Show {matchedSecurities.length} auto-matched securities</span>
                    </summary>
                    <div className="space-y-2 mt-2">
                      {matchedSecurities.map((mapping) => {
                        const index = securityMappings.findIndex((m) => m.originalName === mapping.originalName);
                        return (
                          <div
                            key={mapping.originalName}
                            className="border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-lg p-3"
                          >
                            <div className="flex items-center gap-3">
                              <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap min-w-[200px]">
                                {mapping.originalName}
                              </span>
                              <span className="text-gray-400">→</span>
                              <Select
                                options={getSecurityOptions()}
                                value={mapping.securityId || ''}
                                onChange={(e) =>
                                  handleSecurityMappingChange(index, 'securityId', e.target.value)
                                }
                                className="flex-1"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (parsedData?.categories.length) {
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
                    if (parsedData?.transferAccounts.length) {
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
              <div className="space-y-4 max-h-96 overflow-y-auto">
                {accountMappings.map((mapping, index) => (
                  <div
                    key={mapping.originalName}
                    className="border dark:border-gray-700 rounded-lg p-4"
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
                ))}
              </div>
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    if (parsedData?.securities?.length) {
                      setStep('mapSecurities');
                    } else if (parsedData?.categories.length) {
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
        const targetAccount = accounts.find((a) => a.id === selectedAccountId);
        const mappedCategories = categoryMappings.filter((m) => m.categoryId || m.createNew).length;
        const newCategories = categoryMappings.filter((m) => m.createNew).length;
        const mappedAccounts = accountMappings.filter((m) => m.accountId || m.createNew).length;
        const newAccounts = accountMappings.filter((m) => m.createNew).length;
        const mappedSecuritiesCount = securityMappings.filter((m) => m.securityId || m.createNew).length;
        const newSecuritiesCount = securityMappings.filter((m) => m.createNew).length;

        return (
          <div className="max-w-xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Review Import
              </h2>
              <div className="space-y-4">
                <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                  <h3 className="font-medium text-gray-900 dark:text-gray-100 mb-2">Summary</h3>
                  <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                    <li>
                      <strong>File:</strong> {fileName}
                    </li>
                    <li>
                      <strong>Transactions to import:</strong> {parsedData?.transactionCount}
                    </li>
                    <li>
                      <strong>Target account:</strong> {targetAccount?.name}
                    </li>
                    <li>
                      <strong>Skip duplicates:</strong> {skipDuplicates ? 'Yes' : 'No'}
                    </li>
                  </ul>
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
                        <strong>Mapped:</strong> {mappedCategories}
                      </li>
                      <li>
                        <strong>New to create:</strong> {newCategories}
                      </li>
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
                    if (parsedData?.transferAccounts.length) {
                      setStep('mapAccounts');
                    } else if (parsedData?.securities?.length) {
                      setStep('mapSecurities');
                    } else if (parsedData?.categories.length) {
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
        return (
          <div className="max-w-xl mx-auto">
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

              {importResult && (
                <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-6">
                  <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
                    <li>
                      <strong>Imported:</strong> {importResult.imported} transactions
                    </li>
                    <li>
                      <strong>Skipped:</strong> {importResult.skipped} duplicates
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
                <Button variant="outline" onClick={() => router.push('/transactions')}>
                  View Transactions
                </Button>
                <Button
                  onClick={() => {
                    setStep('upload');
                    setFileContent('');
                    setFileName('');
                    setParsedData(null);
                    setImportResult(null);
                    setSelectedAccountId('');
                    setCategoryMappings([]);
                    setAccountMappings([]);
                    setSecurityMappings([]);
                  }}
                >
                  Import Another File
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
                if (s === 'mapCategories' && !parsedData?.categories.length) return null;
                if (s === 'mapSecurities' && !parsedData?.securities?.length) return null;
                if (s === 'mapAccounts' && !parsedData?.transferAccounts.length) return null;

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
