'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { ImportResult } from '@/lib/import';
import { Account } from '@/types/account';
import { ImportFileData, BulkImportResult } from '@/app/import/import-utils';

interface CompleteStepProps {
  importFiles: ImportFileData[];
  isBulkImport: boolean;
  fileName: string;
  selectedAccountId: string;
  accounts: Account[];
  importResult: ImportResult | null;
  bulkImportResult: BulkImportResult | null;
  onImportMore: () => void;
}

export function CompleteStep({
  importFiles,
  isBulkImport,
  fileName,
  selectedAccountId,
  accounts,
  importResult,
  bulkImportResult,
  onImportMore,
}: CompleteStepProps) {
  const router = useRouter();
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
          <Button onClick={onImportMore}>
            Import More Files
          </Button>
        </div>
      </div>
    </div>
  );
}
