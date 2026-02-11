'use client';

import { RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { CategoryMappingRow } from '@/components/import/CategoryMappingRow';
import { CategoryMapping } from '@/lib/import';
import { Account } from '@/types/account';

type ImportStep = 'upload' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';

interface MapCategoriesStepProps {
  categoryMappings: CategoryMapping[];
  setCategoryMappings: React.Dispatch<React.SetStateAction<CategoryMapping[]>>;
  categoryOptions: Array<{ value: string; label: string }>;
  parentCategoryOptions: Array<{ value: string; label: string }>;
  accounts: Account[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  formatCategoryPath: (path: string) => string;
  securityMappings: { length: number };
  shouldShowMapAccounts: boolean;
  setStep: (step: ImportStep) => void;
}

export function MapCategoriesStep({
  categoryMappings,
  setCategoryMappings,
  categoryOptions,
  parentCategoryOptions,
  accounts,
  scrollContainerRef,
  formatCategoryPath,
  securityMappings,
  shouldShowMapAccounts,
  setStep,
}: MapCategoriesStepProps) {
  const isFullyMapped = (m: CategoryMapping) =>
    m.categoryId || (m.isLoanCategory && (m.loanAccountId || (m.createNewLoan && m.newLoanAmount !== undefined)));
  const unmatchedCategories = categoryMappings.filter((m) => !isFullyMapped(m));
  const matchedCategoriesOnly = categoryMappings.filter((m) => m.categoryId);
  const matchedLoansOnly = categoryMappings.filter((m) => m.isLoanCategory && (m.loanAccountId || (m.createNewLoan && m.newLoanAmount !== undefined)));
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
        <div className="flex flex-wrap gap-4 mb-4 text-sm">
          <span className="text-amber-600 dark:text-amber-400">
            {unmatchedCategories.length} need attention
          </span>
          <span className="text-green-600 dark:text-green-400">
            {matchedCategoriesOnly.length} matched to categories
          </span>
          {matchedLoansOnly.length > 0 && (
            <span className="text-blue-600 dark:text-blue-400">
              {matchedLoansOnly.length} matched to loans
            </span>
          )}
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

          {/* Matched loans - shown separately with blue styling */}
          {matchedLoansOnly.length > 0 && (
            <details className="group" open>
              <summary className="cursor-pointer text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 py-2">
                <span className="ml-1">Show {matchedLoansOnly.length} auto-matched to loan accounts</span>
              </summary>
              <div className="space-y-2 mt-2">
                {matchedLoansOnly.map((mapping) => {
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

          {/* Matched categories - minimized */}
          {matchedCategoriesOnly.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 py-2">
                <span className="ml-1">Show {matchedCategoriesOnly.length} auto-matched to categories</span>
              </summary>
              <div className="space-y-2 mt-2">
                {matchedCategoriesOnly.map((mapping) => {
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
            onClick={() => setStep('selectAccount')}
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
}
