'use client';

import { Account } from '@/types/account';
import { formatAccountType } from '@/lib/account-utils';

interface UploadStepProps {
  preselectedAccount: Account | undefined;
  isLoading: boolean;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function UploadStep({ preselectedAccount, isLoading, onFileSelect }: UploadStepProps) {
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
            onChange={onFileSelect}
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
}
