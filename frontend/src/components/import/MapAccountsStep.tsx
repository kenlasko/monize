'use client';

import { RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { AccountMapping } from '@/lib/import';

type ImportStep = 'upload' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';

interface MapAccountsStepProps {
  accountMappings: AccountMapping[];
  handleAccountMappingChange: (index: number, field: keyof AccountMapping, value: string) => void;
  accountOptions: Array<{ value: string; label: string }>;
  accountTypeOptions: Array<{ value: string; label: string }>;
  currencyOptions: Array<{ value: string; label: string }>;
  defaultCurrency: string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  categoryMappings: { length: number };
  securityMappings: { length: number };
  setStep: (step: ImportStep) => void;
}

export function MapAccountsStep({
  accountMappings,
  handleAccountMappingChange,
  accountOptions,
  accountTypeOptions,
  currencyOptions,
  defaultCurrency,
  scrollContainerRef,
  categoryMappings,
  securityMappings,
  setStep,
}: MapAccountsStepProps) {
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
                  options={accountOptions}
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
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Select
                        label="Account type"
                        options={accountTypeOptions}
                        value={mapping.accountType || 'CHEQUING'}
                        onChange={(e) =>
                          handleAccountMappingChange(index, 'accountType', e.target.value)
                        }
                      />
                      <Select
                        label="Currency"
                        options={currencyOptions}
                        value={mapping.currencyCode || defaultCurrency}
                        onChange={(e) =>
                          handleAccountMappingChange(index, 'currencyCode', e.target.value)
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
                setStep('selectAccount');
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
}
