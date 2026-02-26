'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { importApi, CategoryMapping, AccountMapping, SecurityMapping, ImportResult, DateFormat } from '@/lib/import';
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
import {
  ImportStep,
  MatchConfidence,
  ImportFileData,
  BulkImportResult,
  formatAccountType,
  isInvestmentBrokerageAccount,
  ACCOUNT_TYPE_OPTIONS,
  SECURITY_TYPE_OPTIONS,
} from '@/app/import/import-utils';
import {
  matchFilenameToAccount,
  buildCategoryMappings,
  buildAccountMappings,
  buildSecurityMappings,
  findMatchingSecurityBySymbol,
} from '@/app/import/import-matching';

const logger = createLogger('Import');

export function useImportWizard() {
  const searchParams = useSearchParams();
  const preselectedAccountId = searchParams.get('accountId');
  const defaultCurrency = usePreferencesStore((s) => s.preferences?.defaultCurrency) || 'USD';

  const [step, setStep] = useState<ImportStep>('upload');
  const [importFiles, setImportFiles] = useState<ImportFileData[]>([]);
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
  const [creatingForFileIndex, setCreatingForFileIndex] = useState(-1);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isBulkImport = importFiles.length > 1;

  const setFileAccountId = useCallback((fileIndex: number, accountId: string, confidence: MatchConfidence = 'exact') => {
    setImportFiles(prev => prev.map((f, i) =>
      i === fileIndex ? { ...f, selectedAccountId: accountId, matchConfidence: confidence } : f
    ));
  }, []);

  const setSelectedAccountId = useCallback((accountId: string, confidence: MatchConfidence = 'exact') => setFileAccountId(0, accountId, confidence), [setFileAccountId]);

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
        const pair = await accountsApi.createInvestmentPair(accountData);
        setAccounts(prev => [...prev, pair.cashAccount, pair.brokerageAccount]);
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

  // Load accounts, categories, and securities
  useEffect(() => {
    const loadData = async () => {
      try {
        const [accountsData, categoriesData, securitiesData, currenciesData] = await Promise.all([
          accountsApi.getAll(),
          categoriesApi.getAll(),
          investmentsApi.getSecurities(true),
          exchangeRatesApi.getCurrencies(),
        ]);
        setAccounts(accountsData);
        setCategories(categoriesData);
        setSecurities(securitiesData);
        setCurrencies(currenciesData);

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
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [step]);

  // Auto-select best matching account when on selectAccount step with no selection
  useEffect(() => {
    if (step !== 'selectAccount' || selectedAccountId || accounts.length === 0) return;

    const qifType = parsedData?.accountType;
    const isQifInvestment = qifType === 'INVESTMENT';
    const compatibleAccounts = accounts.filter((a) => {
      if (isQifInvestment) return isInvestmentBrokerageAccount(a);
      return !isInvestmentBrokerageAccount(a);
    });

    if (compatibleAccounts.length > 0) {
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
  useEffect(() => {
    if (step !== 'mapAccounts' || accountMappings.length === 0) return;

    setAccountMappings(prev => prev.map(mapping => {
      if (mapping.accountId) return mapping;

      const accLower = mapping.originalName.toLowerCase();
      const accWithSlash = accLower.replace(/-/g, '/');
      const existingAcc = accounts.find((a) => {
        const aName = a.name.toLowerCase();
        return aName === accLower || aName === accWithSlash;
      });
      if (existingAcc) {
        const targetId = existingAcc.accountSubType === 'INVESTMENT_BROKERAGE' && existingAcc.linkedAccountId
          ? existingAcc.linkedAccountId
          : existingAcc.id;
        return { originalName: mapping.originalName, accountId: targetId };
      }
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
    if (step !== 'mapSecurities' || initialLookupDone || securityMappings.length === 0) return;

    const runBulkLookup = async () => {
      setBulkLookupInProgress(true);
      setInitialLookupDone(true);

      const unmappedIndices = securityMappings
        .map((m, i) => (!m.securityId ? i : -1))
        .filter((i) => i !== -1);

      for (const index of unmappedIndices) {
        const mapping = securityMappings[index];
        const query = mapping.originalName;
        if (!query || query.length < 2) continue;

        try {
          const result = await investmentsApi.lookupSecurity(query);
          if (result && result.symbol.length <= 6) {
            setSecurityMappings((prev) => {
              const updated = [...prev];
              const current = updated[index];
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
          logger.error(`Bulk lookup failed for ${query}:`, error);
        }
      }

      setBulkLookupInProgress(false);
    };

    runBulkLookup();
  }, [step, initialLookupDone, securityMappings]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsLoading(true);
    setInitialLookupDone(false);

    try {
      const fileDataArray: ImportFileData[] = [];
      const allCats: Set<string> = new Set();
      const allTransferAccounts: Set<string> = new Set();
      const allSecs: Set<string> = new Set();
      let detectedFormat: DateFormat | null = null;

      for (const file of Array.from(files)) {
        const content = await file.text();
        const parsed = await importApi.parseQif(content);

        if (!detectedFormat && parsed.detectedDateFormat) {
          detectedFormat = parsed.detectedDateFormat;
        }

        parsed.categories.forEach((cat) => allCats.add(cat));
        parsed.transferAccounts.forEach((acc) => allTransferAccounts.add(acc));
        (parsed.securities || []).forEach((sec) => allSecs.add(sec));

        const isInvestmentType = parsed.accountType === 'INVESTMENT';
        const match = matchFilenameToAccount(file.name, isInvestmentType, accounts, parsed.accountType);

        fileDataArray.push({
          fileName: file.name,
          fileContent: content,
          parsedData: parsed,
          selectedAccountId: match.id,
          matchConfidence: match.confidence,
        });
      }

      if (detectedFormat) setDateFormat(detectedFormat);
      setImportFiles(fileDataArray);
      setCategoryMappings(buildCategoryMappings(allCats, categories, accounts));
      setAccountMappings(buildAccountMappings(allTransferAccounts, accounts, defaultCurrency));
      setSecurityMappings(buildSecurityMappings(allSecs, securities));
      setStep('selectAccount');

      if (fileDataArray.length > 1) {
        toast.success(`Loaded ${fileDataArray.length} files for import`);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to parse QIF file(s)'));
    } finally {
      setIsLoading(false);
    }
  }, [accounts, categories, securities, defaultCurrency]);

  const handleAccountMappingChange = (index: number, field: keyof AccountMapping, value: string) => {
    setAccountMappings((prev) => {
      const updated = [...prev];
      if (field === 'accountId') {
        updated[index] = { ...updated[index], accountId: value || undefined, createNew: undefined, accountType: undefined, currencyCode: undefined };
      } else if (field === 'createNew') {
        updated[index] = { ...updated[index], accountId: undefined, createNew: value || undefined };
      } else if (field === 'accountType') {
        updated[index] = { ...updated[index], accountType: value || undefined };
      } else if (field === 'currencyCode') {
        updated[index] = { ...updated[index], currencyCode: value || undefined };
      }
      return updated;
    });
  };

  const handleSecurityMappingChange = (index: number, field: keyof SecurityMapping, value: string) => {
    setSecurityMappings((prev) => {
      const updated = [...prev];
      if (field === 'securityId') {
        updated[index] = { ...updated[index], securityId: value || undefined, createNew: undefined, securityName: undefined, securityType: undefined, exchange: undefined };
      } else if (field === 'createNew') {
        const matchingSecurity = findMatchingSecurityBySymbol(value, securities);
        if (matchingSecurity) {
          updated[index] = { ...updated[index], securityId: matchingSecurity.id, createNew: undefined, securityName: undefined, securityType: undefined, exchange: undefined };
          toast.success(`Found existing security: ${matchingSecurity.symbol} - ${matchingSecurity.name}`);
        } else {
          updated[index] = { ...updated[index], securityId: undefined, createNew: value || undefined };
        }
      } else if (field === 'securityName') {
        updated[index] = { ...updated[index], securityName: value || undefined };
      } else if (field === 'securityType') {
        updated[index] = { ...updated[index], securityType: value || undefined };
      } else if (field === 'exchange') {
        updated[index] = { ...updated[index], exchange: value || undefined };
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
        const existingSecurity = findMatchingSecurityBySymbol(result.symbol, securities);
        setSecurityMappings((prev) => {
          const updated = [...prev];
          updated[index] = {
            ...updated[index],
            securityId: undefined,
            createNew: result.symbol,
            securityName: result.name,
            securityType: result.securityType || 'STOCK',
            exchange: result.exchange || undefined,
            currencyCode: result.currencyCode || undefined,
          };
          return updated;
        });

        const details = [`Symbol: ${result.symbol}`, `Name: ${result.name}`];
        if (result.exchange) details.push(`Exchange: ${result.exchange}`);
        if (result.currencyCode) details.push(`Currency: ${result.currencyCode}`);
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

    const allFilesValid = importFiles.every((f) => f.selectedAccountId);
    if (!allFilesValid) {
      toast.error('Please select an account for all files');
      return;
    }

    setIsLoading(true);
    try {
      if (isBulkImport) {
        const fileResults: BulkImportResult['fileResults'] = [];
        let totalImported = 0;
        let totalSkipped = 0;
        let totalErrors = 0;
        let categoriesCreated = 0;
        let accountsCreated = 0;
        let payeesCreated = 0;
        let securitiesCreated = 0;

        let currentCatMappings = [...categoryMappings];
        let currentAccMappings = [...accountMappings];
        let currentSecMappings = [...securityMappings];

        for (const fileData of importFiles) {
          try {
            const result = await importApi.importQif({
              content: fileData.fileContent,
              accountId: fileData.selectedAccountId,
              categoryMappings: currentCatMappings,
              accountMappings: currentAccMappings,
              securityMappings: currentSecMappings,
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
            if (fileResults.length === 1) {
              categoriesCreated = result.categoriesCreated;
              accountsCreated = result.accountsCreated;
              payeesCreated = result.payeesCreated;
              securitiesCreated = result.securitiesCreated;
            }

            if (result.createdMappings) {
              const { categories: cats, accounts: accts, loans, securities: secs } = result.createdMappings;

              if (Object.keys(cats).length > 0 || Object.keys(loans).length > 0) {
                currentCatMappings = currentCatMappings.map((m) => {
                  if (m.createNew && cats[m.originalName]) {
                    return { originalName: m.originalName, categoryId: cats[m.originalName] };
                  }
                  if (m.createNewLoan && loans[m.originalName]) {
                    return { originalName: m.originalName, isLoanCategory: true, loanAccountId: loans[m.originalName] };
                  }
                  return m;
                });
              }

              if (Object.keys(accts).length > 0) {
                currentAccMappings = currentAccMappings.map((m) => {
                  if (m.createNew && accts[m.originalName]) {
                    return { originalName: m.originalName, accountId: accts[m.originalName] };
                  }
                  return m;
                });
              }

              if (Object.keys(secs).length > 0) {
                currentSecMappings = currentSecMappings.map((m) => {
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
              imported: 0, skipped: 0, errors: 1,
              errorMessages: [getErrorMessage(error, 'Import failed')],
            });
            totalErrors += 1;
          }
        }

        setBulkImportResult({ totalImported, totalSkipped, totalErrors, categoriesCreated, accountsCreated, payeesCreated, securitiesCreated, fileResults });
        setStep('complete');

        if (totalErrors === 0) {
          toast.success(`Successfully imported ${totalImported} transactions from ${importFiles.length} files`);
        } else {
          toast.success(`Imported ${totalImported} transactions with ${totalErrors} errors`);
        }
      } else {
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
        ? categories.find((c) => c.id === category.parentId) : null;
      options.push({
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      });
    });
    return options;
  }, [categories]);

  const parentCategoryOptions = useMemo(() => {
    const options = [{ value: '', label: 'No parent (top-level)' }];
    categories.filter((c) => !c.parentId).forEach((c) => {
      options.push({ value: c.id, label: c.name });
    });
    return options;
  }, [categories]);

  const getAccountOptions = () => {
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

  const isInvestmentImport = parsedData?.accountType === 'INVESTMENT' ||
    (isBulkImport && importFiles.some((f) => f.parsedData.accountType === 'INVESTMENT'));
  const shouldShowMapAccounts = accountMappings.length > 0 && !isInvestmentImport;

  const currencyOptions = useMemo(() => {
    const sorted = [...currencies].sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
    return sorted.map((c) => ({ value: c.code, label: `${c.code} - ${c.name}` }));
  }, [currencies, defaultCurrency]);

  const getSecurityOptions = () => [
    { value: '', label: 'Skip (no security)' },
    ...securities.map((s) => ({ value: s.id, label: `${s.symbol} - ${s.name}` })),
  ];

  const preselectedAccount = accounts.find((a) => a.id === preselectedAccountId);

  const handleImportMore = () => {
    setStep('upload');
    setImportFiles([]);
    setImportResult(null);
    setBulkImportResult(null);
    setCategoryMappings([]);
    setAccountMappings([]);
    setSecurityMappings([]);
    setInitialLookupDone(false);
  };

  return {
    step, setStep,
    importFiles, isBulkImport, fileName, parsedData, selectedAccountId, setSelectedAccountId, setFileAccountId, fileContent,
    accounts, categories, securities,
    categoryMappings, setCategoryMappings, accountMappings, securityMappings,
    handleAccountMappingChange, handleSecurityMappingChange, handleSecurityLookup,
    isLoading, importResult, bulkImportResult, handleImport, handleFileSelect, handleImportMore,
    lookupLoadingIndex, bulkLookupInProgress,
    showCreateAccount, setShowCreateAccount, creatingForFileIndex, setCreatingForFileIndex,
    newAccountName, setNewAccountName, newAccountType, setNewAccountType, newAccountCurrency, setNewAccountCurrency,
    isCreatingAccount, handleCreateAccount,
    categoryOptions, parentCategoryOptions, getAccountOptions,
    accountTypeOptions: ACCOUNT_TYPE_OPTIONS, currencyOptions, getSecurityOptions, securityTypeOptions: SECURITY_TYPE_OPTIONS,
    shouldShowMapAccounts, preselectedAccount,
    scrollContainerRef, dateFormat, defaultCurrency,
  };
}
