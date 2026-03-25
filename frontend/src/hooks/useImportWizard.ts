'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import {
  importApi,
  CategoryMapping,
  AccountMapping,
  SecurityMapping,
  ImportResult,
  DateFormat,
  CsvColumnMappingConfig,
  CsvTransferRule,
  SavedColumnMapping,
  ParsedQifMultiAccountResponse,
  autoMatchCsvColumns,
} from '@/lib/import';
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
  ImportFileType,
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

function detectFileType(fileName: string): ImportFileType {
  const ext = fileName.toLowerCase().split('.').pop() || '';
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  if (ext === 'csv') return 'csv';
  return 'qif';
}

const DEFAULT_CSV_COLUMN_MAPPING: CsvColumnMappingConfig = {
  date: 0,
  amount: 1,
  payee: undefined,
  category: undefined,
  memo: undefined,
  referenceNumber: undefined,
  dateFormat: 'MM/DD/YYYY',
  hasHeader: true,
  delimiter: ',',
};

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

  // Multi-account QIF state
  const [multiAccountData, setMultiAccountData] = useState<ParsedQifMultiAccountResponse | null>(null);
  const [multiAccountContent, setMultiAccountContent] = useState<string>('');
  const [multiAccountCurrency, setMultiAccountCurrency] = useState(defaultCurrency);

  // CSV-specific state
  const [fileType, setFileType] = useState<ImportFileType>('qif');
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvSampleRows, setCsvSampleRows] = useState<string[][]>([]);
  const [csvColumnMapping, setCsvColumnMapping] = useState<CsvColumnMappingConfig>(DEFAULT_CSV_COLUMN_MAPPING);
  const [csvTransferRules, setCsvTransferRules] = useState<CsvTransferRule[]>([]);
  const [savedColumnMappings, setSavedColumnMappings] = useState<SavedColumnMapping[]>([]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isBulkImport = importFiles.length > 1;

  // Determine the next step after account selection, based on what mappings exist
  const getStepAfterAccountSelection = (
    catMappings: CategoryMapping[],
    secMappings: SecurityMapping[],
    accMappings: AccountMapping[],
    isInvestment: boolean,
  ): ImportStep => {
    const showMapAccounts = accMappings.length > 0 && !isInvestment;
    if (catMappings.length > 0) return 'mapCategories';
    if (secMappings.length > 0) return 'mapSecurities';
    if (showMapAccounts) return 'mapAccounts';
    return 'review';
  };

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

  // Load accounts, categories, securities, and saved column mappings
  useEffect(() => {
    const loadData = async () => {
      try {
        const [accountsData, categoriesData, securitiesData, currenciesData, columnMappingsData] = await Promise.all([
          accountsApi.getAll(),
          categoriesApi.getAll(),
          investmentsApi.getSecurities(true),
          exchangeRatesApi.getCurrencies(),
          importApi.getColumnMappings().catch(() => [] as SavedColumnMapping[]),
        ]);
        setAccounts(accountsData);
        setCategories(categoriesData);
        setSecurities(securitiesData);
        setCurrencies(currenciesData);
        setSavedColumnMappings(columnMappingsData);

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
      const fileArray = Array.from(files);

      // Detect file types and enforce same type
      const detectedTypes = fileArray.map((f) => detectFileType(f.name));
      const uniqueTypes = [...new Set(detectedTypes)];
      if (uniqueTypes.length > 1) {
        toast.error('All files must be the same type. Cannot mix QIF, OFX, and CSV files.');
        setIsLoading(false);
        return;
      }

      const detectedFileType = uniqueTypes[0];
      setFileType(detectedFileType);

      if (detectedFileType === 'csv') {
        // For CSV, read the first file and get headers
        const firstFile = fileArray[0];
        const content = await firstFile.text();

        const headersResponse = await importApi.parseCsvHeaders(content);
        setCsvHeaders(headersResponse.headers);
        setCsvSampleRows(headersResponse.sampleRows);

        // Store all file contents
        const fileDataArray: ImportFileData[] = [];
        for (const file of fileArray) {
          const fileContent = file === firstFile ? content : await file.text();
          fileDataArray.push({
            fileName: file.name,
            fileContent,
            fileType: 'csv',
            parsedData: null as unknown as ImportFileData['parsedData'],
            selectedAccountId: preselectedAccountId || '',
            matchConfidence: preselectedAccountId ? 'exact' : 'none',
          });
        }
        setImportFiles(fileDataArray);
        const autoMatched = autoMatchCsvColumns(headersResponse.headers);
        setCsvColumnMapping({ ...DEFAULT_CSV_COLUMN_MAPPING, ...autoMatched });
        setCsvTransferRules([]);
        setStep('csvColumnMapping');

        if (fileArray.length > 1) {
          toast.success(`Loaded ${fileArray.length} CSV files for import`);
        }
      } else {
        // QIF or OFX: parse all files

        // For a single QIF file, check if it's a multi-account export
        if (detectedFileType === 'qif' && fileArray.length === 1) {
          const content = await fileArray[0].text();

          // Quick check: does this file contain multiple !Account sections or !Type:Cat?
          const accountMatches = content.match(/^!Account$/gm);
          const hasCatSection = /^!Type:Cat\s*$/im.test(content);

          if ((accountMatches && accountMatches.length > 1) || hasCatSection) {
            // Multi-account QIF detected
            const multiResult = await importApi.parseQifMultiAccount(content);

            if (multiResult.isMultiAccount) {
              setMultiAccountData(multiResult);
              setMultiAccountContent(content);
              setMultiAccountCurrency(defaultCurrency);
              if (multiResult.detectedDateFormat) {
                setDateFormat(multiResult.detectedDateFormat);
              }
              // Build security mappings if the file contains investment securities
              if (multiResult.securities && multiResult.securities.length > 0) {
                const newSecMappings = buildSecurityMappings(
                  new Set(multiResult.securities),
                  securities,
                );
                setSecurityMappings(newSecMappings);
              } else {
                setSecurityMappings([]);
              }
              setStep('multiAccountReview');
              setIsLoading(false);
              return;
            }
          }
        }

        const fileDataArray: ImportFileData[] = [];
        const allCats: Set<string> = new Set();
        const allTransferAccounts: Set<string> = new Set();
        const allSecs: Set<string> = new Set();
        let detectedFormat: DateFormat | null = null;

        for (const file of fileArray) {
          const content = await file.text();
          const parsed = detectedFileType === 'ofx'
            ? await importApi.parseOfx(content)
            : await importApi.parseQif(content);

          if (!detectedFormat && parsed.detectedDateFormat) {
            detectedFormat = parsed.detectedDateFormat;
          }

          parsed.categories.forEach((cat) => allCats.add(cat));
          parsed.transferAccounts.forEach((acc) => allTransferAccounts.add(acc));
          (parsed.securities || []).forEach((sec) => allSecs.add(sec));

          const isInvestmentType = parsed.accountType === 'INVESTMENT';
          const match = matchFilenameToAccount(file.name, isInvestmentType, accounts, parsed.accountType);
          const accountId = preselectedAccountId || match.id;
          const confidence: MatchConfidence = preselectedAccountId ? 'exact' : match.confidence;

          fileDataArray.push({
            fileName: file.name,
            fileContent: content,
            fileType: detectedFileType,
            parsedData: parsed,
            selectedAccountId: accountId,
            matchConfidence: confidence,
          });
        }

        if (detectedFormat) setDateFormat(detectedFormat);
        const newCatMappings = buildCategoryMappings(allCats, categories, accounts);
        const newAccMappings = buildAccountMappings(allTransferAccounts, accounts, defaultCurrency);
        const newSecMappings = buildSecurityMappings(allSecs, securities);
        setImportFiles(fileDataArray);
        setCategoryMappings(newCatMappings);
        setAccountMappings(newAccMappings);
        setSecurityMappings(newSecMappings);

        // Skip account selection when a single file is imported with a preselected account
        if (preselectedAccountId && fileDataArray.length === 1) {
          const isInvestment = fileDataArray[0].parsedData?.accountType === 'INVESTMENT';
          setStep(getStepAfterAccountSelection(newCatMappings, newSecMappings, newAccMappings, isInvestment));
        } else {
          setStep('selectAccount');
        }

        if (fileDataArray.length > 1) {
          toast.success(`Loaded ${fileDataArray.length} files for import`);
        }
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to parse file(s)'));
    } finally {
      setIsLoading(false);
    }
  }, [accounts, categories, securities, defaultCurrency, preselectedAccountId]);

  // CSV column mapping handlers
  const handleCsvColumnMappingChange = useCallback((mapping: CsvColumnMappingConfig) => {
    setCsvColumnMapping(mapping);
  }, []);

  const handleCsvTransferRulesChange = useCallback((rules: CsvTransferRule[]) => {
    setCsvTransferRules(rules);
  }, []);

  const handleCsvDelimiterChange = useCallback(async (delimiter: string) => {
    if (importFiles.length === 0) return;
    setIsLoading(true);
    try {
      const headersResponse = await importApi.parseCsvHeaders(importFiles[0].fileContent, delimiter);
      setCsvHeaders(headersResponse.headers);
      setCsvSampleRows(headersResponse.sampleRows);
      setCsvColumnMapping(prev => ({ ...prev, delimiter }));
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to parse CSV with new delimiter'));
    } finally {
      setIsLoading(false);
    }
  }, [importFiles]);

  const handleCsvHasHeaderChange = useCallback(async (hasHeader: boolean) => {
    if (importFiles.length === 0) return;
    setCsvColumnMapping(prev => ({ ...prev, hasHeader }));
    // Re-fetch headers to update sample rows display
    setIsLoading(true);
    try {
      const headersResponse = await importApi.parseCsvHeaders(importFiles[0].fileContent, csvColumnMapping.delimiter);
      setCsvHeaders(headersResponse.headers);
      setCsvSampleRows(headersResponse.sampleRows);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update CSV preview'));
    } finally {
      setIsLoading(false);
    }
  }, [importFiles, csvColumnMapping.delimiter]);

  const handleCsvMappingComplete = useCallback(async () => {
    if (importFiles.length === 0) return;

    setIsLoading(true);
    try {
      // Parse all CSV files using the column mapping
      const fileDataArray: ImportFileData[] = [];
      const allCats: Set<string> = new Set();
      const allTransferAccounts: Set<string> = new Set();
      let detectedFormat: DateFormat | null = null;

      // For bulk CSV, check if subsequent files have matching headers
      let currentMapping = csvColumnMapping;
      let currentRules = csvTransferRules;

      for (let i = 0; i < importFiles.length; i++) {
        const fileData = importFiles[i];

        // For bulk CSV (file index > 0), check if headers match the first file
        if (i > 0) {
          const headersResponse = await importApi.parseCsvHeaders(fileData.fileContent, currentMapping.delimiter);
          const headersMatch = headersResponse.headers.length === csvHeaders.length &&
            headersResponse.headers.every((h, idx) => h === csvHeaders[idx]);

          if (!headersMatch) {
            // Headers differ - stop here and prompt user for new mapping
            // For now, we'll use the same mapping and let the backend handle any issues
            logger.warn(`CSV file "${fileData.fileName}" has different headers than the first file`);
          }
        }

        const parsed = await importApi.parseCsv(fileData.fileContent, currentMapping, currentRules);

        if (!detectedFormat && parsed.detectedDateFormat) {
          detectedFormat = parsed.detectedDateFormat;
        }

        parsed.categories.forEach((cat) => allCats.add(cat));
        parsed.transferAccounts.forEach((acc) => allTransferAccounts.add(acc));

        const match = matchFilenameToAccount(fileData.fileName, false, accounts, parsed.accountType);

        fileDataArray.push({
          fileName: fileData.fileName,
          fileContent: fileData.fileContent,
          fileType: 'csv',
          parsedData: parsed,
          selectedAccountId: match.id,
          matchConfidence: match.confidence,
        });
      }

      if (detectedFormat) setDateFormat(detectedFormat);
      const newCatMappings = buildCategoryMappings(allCats, categories, accounts);
      const newAccMappings = buildAccountMappings(allTransferAccounts, accounts, defaultCurrency);
      setImportFiles(fileDataArray);
      setCategoryMappings(newCatMappings);
      setAccountMappings(newAccMappings);
      setSecurityMappings([]);

      // Skip account selection when a single file is imported with a preselected account
      if (preselectedAccountId && fileDataArray.length === 1) {
        setStep(getStepAfterAccountSelection(newCatMappings, [], newAccMappings, false));
      } else {
        setStep('selectAccount');
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to parse CSV file(s)'));
    } finally {
      setIsLoading(false);
    }
  }, [importFiles, csvColumnMapping, csvTransferRules, csvHeaders, accounts, categories, defaultCurrency, preselectedAccountId]);

  const handleSaveColumnMapping = useCallback(async (name: string) => {
    try {
      const saved = await importApi.createColumnMapping({
        name,
        columnMappings: csvColumnMapping,
        transferRules: csvTransferRules,
      });
      setSavedColumnMappings(prev => {
        const existingIndex = prev.findIndex(m => m.id === saved.id);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = saved;
          return updated;
        }
        return [...prev, saved];
      });
      toast.success(`Column mapping "${name}" saved`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save column mapping'));
    }
  }, [csvColumnMapping, csvTransferRules]);

  const handleLoadColumnMapping = useCallback((mapping: SavedColumnMapping) => {
    setCsvColumnMapping(mapping.columnMappings as unknown as CsvColumnMappingConfig);
    setCsvTransferRules((mapping.transferRules || []) as unknown as CsvTransferRule[]);
    toast.success(`Loaded mapping "${mapping.name}"`);
  }, []);

  const handleDeleteColumnMapping = useCallback(async (id: string) => {
    try {
      await importApi.deleteColumnMapping(id);
      setSavedColumnMappings(prev => prev.filter(m => m.id !== id));
      toast.success('Column mapping deleted');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete column mapping'));
    }
  }, []);

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

  const handleMultiAccountImport = async () => {
    if (!multiAccountContent || !multiAccountData) return;

    setIsLoading(true);
    try {
      const result = await importApi.importQifMultiAccount({
        content: multiAccountContent,
        currencyCode: multiAccountCurrency,
        dateFormat,
        securityMappings: securityMappings.length > 0 ? securityMappings : undefined,
      });

      setImportResult(result);
      setStep('complete');

      if (result.errors === 0) {
        toast.success(`Successfully imported ${result.imported} transactions across ${multiAccountData.accounts.length} accounts`);
      } else {
        toast.success(`Imported ${result.imported} transactions with ${result.errors} errors`);
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Multi-account import failed'));
    } finally {
      setIsLoading(false);
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
      const importFn = (fileData: ImportFileData, catMappings: CategoryMapping[], accMappings: AccountMapping[], secMappings: SecurityMapping[]) => {
        if (fileType === 'csv') {
          return importApi.importCsv({
            content: fileData.fileContent,
            accountId: fileData.selectedAccountId,
            columnMapping: csvColumnMapping,
            transferRules: csvTransferRules,
            categoryMappings: catMappings,
            accountMappings: accMappings,
            dateFormat,
          });
        } else if (fileType === 'ofx') {
          return importApi.importOfx({
            content: fileData.fileContent,
            accountId: fileData.selectedAccountId,
            categoryMappings: catMappings,
            accountMappings: accMappings,
            dateFormat,
          });
        } else {
          return importApi.importQif({
            content: fileData.fileContent,
            accountId: fileData.selectedAccountId,
            categoryMappings: catMappings,
            accountMappings: accMappings,
            securityMappings: secMappings,
            dateFormat,
          });
        }
      };

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
            const result = await importFn(fileData, currentCatMappings, currentAccMappings, currentSecMappings);

            const targetAccount = accounts.find((a) => a.id === fileData.selectedAccountId);
            fileResults.push({
              fileName: fileData.fileName,
              accountName: targetAccount?.name || 'Unknown',
              imported: result.imported,
              skipped: result.skipped,
              errors: result.errors,
              errorMessages: result.errorMessages,
              loanAccountsNeedingSetup: result.loanAccountsNeedingSetup,
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

        // Aggregate loan accounts needing setup across all file results
        const seenLoanIds = new Set<string>();
        const allLoanAccountsNeedingSetup: Array<{ accountId: string; accountName: string; accountType: string }> = [];
        for (const fr of fileResults) {
          if (fr.loanAccountsNeedingSetup) {
            for (const la of fr.loanAccountsNeedingSetup) {
              if (!seenLoanIds.has(la.accountId)) {
                seenLoanIds.add(la.accountId);
                allLoanAccountsNeedingSetup.push(la);
              }
            }
          }
        }

        setBulkImportResult({
          totalImported, totalSkipped, totalErrors, categoriesCreated, accountsCreated, payeesCreated, securitiesCreated, fileResults,
          loanAccountsNeedingSetup: allLoanAccountsNeedingSetup.length > 0 ? allLoanAccountsNeedingSetup : undefined,
        });
        setStep('complete');

        if (totalErrors === 0) {
          toast.success(`Successfully imported ${totalImported} transactions from ${importFiles.length} files`);
        } else {
          toast.success(`Imported ${totalImported} transactions with ${totalErrors} errors`);
        }
      } else {
        const result = await importFn(importFiles[0], categoryMappings, accountMappings, securityMappings);

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
    (isBulkImport && importFiles.some((f) => f.parsedData?.accountType === 'INVESTMENT'));
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
    setFileType('qif');
    setMultiAccountData(null);
    setMultiAccountContent('');
    setMultiAccountCurrency(defaultCurrency);
    setCsvHeaders([]);
    setCsvSampleRows([]);
    setCsvColumnMapping(DEFAULT_CSV_COLUMN_MAPPING);
    setCsvTransferRules([]);
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
    scrollContainerRef, dateFormat, setDateFormat, defaultCurrency,
    // Multi-account QIF
    multiAccountData, multiAccountCurrency, setMultiAccountCurrency, handleMultiAccountImport,
    // CSV-specific exports
    fileType,
    csvHeaders, csvSampleRows,
    csvColumnMapping, handleCsvColumnMappingChange,
    csvTransferRules, handleCsvTransferRulesChange,
    savedColumnMappings,
    handleCsvMappingComplete,
    handleCsvDelimiterChange,
    handleCsvHasHeaderChange,
    handleSaveColumnMapping,
    handleLoadColumnMapping,
    handleDeleteColumnMapping,
  };
}
