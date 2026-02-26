'use client';

import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { ParsedQifResponse } from '@/lib/import';
import { Account } from '@/types/account';
import { formatAccountType, isInvestmentBrokerageAccount } from '@/lib/account-utils';
import { ImportFileData, ImportStep } from '@/app/import/import-utils';

interface SelectAccountStepProps {
  accounts: Account[];
  importFiles: ImportFileData[];
  isBulkImport: boolean;
  fileName: string;
  parsedData: ParsedQifResponse | null;
  selectedAccountId: string;
  setSelectedAccountId: (id: string) => void;
  setFileAccountId: (index: number, id: string) => void;
  showCreateAccount: boolean;
  setShowCreateAccount: (show: boolean) => void;
  creatingForFileIndex: number;
  setCreatingForFileIndex: (index: number) => void;
  newAccountName: string;
  setNewAccountName: (name: string) => void;
  newAccountType: string;
  setNewAccountType: (type: string) => void;
  newAccountCurrency: string;
  setNewAccountCurrency: (currency: string) => void;
  isCreatingAccount: boolean;
  handleCreateAccount: (fileIndex: number) => void;
  accountTypeOptions: Array<{ value: string; label: string }>;
  currencyOptions: Array<{ value: string; label: string }>;
  categoryMappings: { length: number };
  securityMappings: { length: number };
  shouldShowMapAccounts: boolean;
  setStep: (step: ImportStep) => void;
}

export function SelectAccountStep({
  accounts,
  importFiles,
  isBulkImport,
  fileName,
  parsedData,
  selectedAccountId,
  setSelectedAccountId,
  setFileAccountId,
  showCreateAccount,
  setShowCreateAccount,
  creatingForFileIndex,
  setCreatingForFileIndex,
  newAccountName,
  setNewAccountName,
  newAccountType,
  setNewAccountType,
  newAccountCurrency,
  setNewAccountCurrency,
  isCreatingAccount,
  handleCreateAccount,
  accountTypeOptions,
  currencyOptions,
  categoryMappings,
  securityMappings,
  shouldShowMapAccounts,
  setStep,
}: SelectAccountStepProps) {
  const getCompatibleAccountsForType = (isInvestment: boolean) => {
    return accounts.filter((a) => {
      if (isInvestment) {
        return isInvestmentBrokerageAccount(a);
      } else {
        return !isInvestmentBrokerageAccount(a);
      }
    }).sort((a, b) => a.name.localeCompare(b.name));
  };

  const allFilesHaveAccounts = importFiles.every((f) => f.selectedAccountId);

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

          {compatibleAccounts.length > 0 && (
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

          {!showCreateAccount ? (
            <button
              type="button"
              onClick={() => {
                setShowCreateAccount(true);
                setCreatingForFileIndex(0);
                setNewAccountName(fileName.replace(/\.[^/.]+$/, '').trim());
                setNewAccountType(parsedData.accountType || 'CHEQUING');
              }}
              className="mt-3 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              + Create new account
            </button>
          ) : creatingForFileIndex === 0 && (
            <div className="mt-4 border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Create New Account</p>
              <Input
                label="Account name"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="e.g. My Chequing"
              />
              <Select
                label="Account type"
                options={accountTypeOptions}
                value={newAccountType}
                onChange={(e) => setNewAccountType(e.target.value)}
              />
              <Select
                label="Currency"
                options={currencyOptions}
                value={newAccountCurrency}
                onChange={(e) => setNewAccountCurrency(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => handleCreateAccount(0)}
                  disabled={isCreatingAccount || !newAccountName.trim()}
                >
                  {isCreatingAccount ? 'Creating...' : 'Create'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setShowCreateAccount(false); setCreatingForFileIndex(-1); setNewAccountName(''); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="flex justify-between mt-6">
            <Button variant="outline" onClick={() => setStep('upload')}>
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
              disabled={!selectedAccountId}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    );
  }

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
            const isHighConfidence = fileData.selectedAccountId && fileData.matchConfidence === 'exact';

            return (
              <div
                key={index}
                className={`border rounded-lg p-4 ${
                  isHighConfidence
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
                    {creatingForFileIndex !== index ? (
                      <button
                        type="button"
                        onClick={() => {
                          setCreatingForFileIndex(index);
                          setShowCreateAccount(true);
                          setNewAccountType(fileData.parsedData.accountType || 'CHEQUING');
                          setNewAccountName(fileData.fileName.replace(/\.[^/.]+$/, '').trim());
                        }}
                        className="mt-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                      >
                        + Create new
                      </button>
                    ) : (
                      <div className="mt-2 border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 space-y-2">
                        <Input
                          label="Account name"
                          value={newAccountName}
                          onChange={(e) => setNewAccountName(e.target.value)}
                          placeholder="e.g. My Chequing"
                        />
                        <Select
                          label="Account type"
                          options={accountTypeOptions}
                          value={newAccountType}
                          onChange={(e) => setNewAccountType(e.target.value)}
                        />
                        <Select
                          label="Currency"
                          options={currencyOptions}
                          value={newAccountCurrency}
                          onChange={(e) => setNewAccountCurrency(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => handleCreateAccount(index)} disabled={isCreatingAccount || !newAccountName.trim()}>
                            {isCreatingAccount ? 'Creating...' : 'Create'}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => { setCreatingForFileIndex(-1); setShowCreateAccount(false); setNewAccountName(''); }}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
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
            disabled={!allFilesHaveAccounts}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
