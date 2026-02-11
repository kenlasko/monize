'use client';

import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { SecurityMapping } from '@/lib/import';

type ImportStep = 'upload' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'complete';

interface MapSecuritiesStepProps {
  securityMappings: SecurityMapping[];
  handleSecurityMappingChange: (index: number, field: keyof SecurityMapping, value: string) => void;
  handleSecurityLookup: (index: number, query: string) => void;
  lookupLoadingIndex: number | null;
  bulkLookupInProgress: boolean;
  securityOptions: Array<{ value: string; label: string }>;
  securityTypeOptions: Array<{ value: string; label: string }>;
  categoryMappings: { length: number };
  shouldShowMapAccounts: boolean;
  setStep: (step: ImportStep) => void;
}

export function MapSecuritiesStep({
  securityMappings,
  handleSecurityMappingChange,
  handleSecurityLookup,
  lookupLoadingIndex,
  bulkLookupInProgress,
  securityOptions,
  securityTypeOptions,
  categoryMappings,
  shouldShowMapAccounts,
  setStep,
}: MapSecuritiesStepProps) {
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
                    options={securityOptions}
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
                setStep('selectAccount');
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
}
