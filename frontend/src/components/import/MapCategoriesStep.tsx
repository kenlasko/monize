'use client';

import { RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { CategoryMappingRow } from '@/components/import/CategoryMappingRow';
import { CategoryMapping } from '@/lib/import';
import { Account } from '@/types/account';
import type { IconSelectOption } from '@/components/ui/IconSelect';
import { CARD_CLASS } from '@/components/ui/Card';

type ImportStep = 'upload' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';

interface MapCategoriesStepProps {
  categoryMappings: CategoryMapping[];
  setCategoryMappings: React.Dispatch<React.SetStateAction<CategoryMapping[]>>;
  categoryOptions: IconSelectOption[];
  parentCategoryOptions: IconSelectOption[];
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
  const t = useTranslations('import');
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
      <div className={`${CARD_CLASS} p-6`}>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('mapCategories.heading')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          {t('mapCategories.description')}
        </p>

        {/* Summary */}
        <div className="flex flex-wrap gap-4 mb-4 text-sm">
          <span className="text-amber-600 dark:text-amber-400">
            {t('mapCategories.needAttention', { count: unmatchedCategories.length })}
          </span>
          <span className="text-green-600 dark:text-green-400">
            {t('mapCategories.matchedCategories', { count: matchedCategoriesOnly.length })}
          </span>
          {matchedLoansOnly.length > 0 && (
            <span className="text-blue-600 dark:text-blue-400">
              {t('mapCategories.matchedLoans', { count: matchedLoansOnly.length })}
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
                <span className="ml-1">{t('mapCategories.showMatchedLoans', { count: matchedLoansOnly.length })}</span>
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
                <span className="ml-1">{t('mapCategories.showMatchedCategories', { count: matchedCategoriesOnly.length })}</span>
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
            {t('navigation.back')}
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
            {t('navigation.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}
