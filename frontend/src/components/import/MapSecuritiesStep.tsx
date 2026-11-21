'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { SecurityMapping } from '@/lib/import';
import { EXCHANGE_OPTIONS } from '@/lib/constants';
import { usePreferencesStore } from '@/store/preferencesStore';
import { SecurityLookupPicker, LookupCandidate } from '@/components/securities/SecurityLookupPicker';
import { CARD_CLASS } from '@/components/ui/Card';

type ImportStep = 'upload' | 'selectAccount' | 'mapCategories' | 'mapSecurities' | 'mapAccounts' | 'review' | 'multiAccountReview' | 'complete';

interface MapSecuritiesStepProps {
  securityMappings: SecurityMapping[];
  handleSecurityMappingChange: (index: number, field: keyof SecurityMapping, value: string) => void;
  handleSecurityLookup: (index: number, query: string, exchange?: string) => void;
  lookupLoadingIndex: number | null;
  bulkLookupInProgress: boolean;
  securityOptions: Array<{ value: string; label: string }>;
  securityTypeOptions: Array<{ value: string; label: string }>;
  currencyOptions: Array<{ value: string; label: string }>;
  categoryMappings: { length: number };
  shouldShowMapAccounts: boolean;
  setStep: (step: ImportStep) => void;
  isMultiAccountImport?: boolean;
  isLoading?: boolean;
  onMultiAccountImport?: () => void;
  lookupPickerQuery?: string;
  lookupPickerCandidates?: LookupCandidate[];
  handleLookupPickerPick?: (candidate: LookupCandidate) => void;
  handleLookupPickerCancel?: () => void;
}

export function MapSecuritiesStep({
  securityMappings,
  handleSecurityMappingChange,
  handleSecurityLookup,
  lookupLoadingIndex,
  bulkLookupInProgress,
  securityOptions,
  securityTypeOptions,
  currencyOptions,
  categoryMappings,
  shouldShowMapAccounts,
  setStep,
  isMultiAccountImport = false,
  isLoading = false,
  onMultiAccountImport,
  lookupPickerQuery = '',
  lookupPickerCandidates = [],
  handleLookupPickerPick,
  handleLookupPickerCancel,
}: MapSecuritiesStepProps) {
  const t = useTranslations('import');
  const preferredExchanges = usePreferencesStore((s) => s.preferences?.preferredExchanges) || [];
  const readyCount = securityMappings.filter((m) => m.securityId || (m.createNew && m.securityName)).length;
  const needsAttentionCount = securityMappings.length - readyCount;

  return (
    <>
    <SecurityLookupPicker
      isOpen={lookupPickerCandidates.length > 0}
      query={lookupPickerQuery}
      candidates={lookupPickerCandidates}
      onPick={(c) => handleLookupPickerPick?.(c)}
      onCancel={() => handleLookupPickerCancel?.()}
    />
    <div className="max-w-4xl mx-auto">
      <div className={`${CARD_CLASS} p-6`}>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('mapSecurities.heading')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          {t('mapSecurities.description')}
        </p>

        {/* Summary */}
        <div className="flex gap-4 mb-4 text-sm">
          <span className="text-amber-600 dark:text-amber-400">
            {t('mapSecurities.needAttention', { count: needsAttentionCount })}
          </span>
          <span className="text-green-600 dark:text-green-400">
            {t('mapSecurities.ready', { count: readyCount })}
          </span>
          {bulkLookupInProgress && (
            <span className="text-blue-600 dark:text-blue-400">
              {t('mapSecurities.lookingUp')}
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
                    onClick={() => handleSecurityLookup(index, mapping.createNew || mapping.securityName || mapping.originalName, mapping.exchange)}
                    disabled={lookupLoadingIndex === index}
                  >
                    {lookupLoadingIndex === index ? t('mapSecurities.lookingUpSingle') : t('mapSecurities.lookup')}
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Select
                    label={t('mapSecurities.mapToExisting')}
                    options={securityOptions}
                    value={mapping.securityId || ''}
                    onChange={(e) =>
                      handleSecurityMappingChange(index, 'securityId', e.target.value)
                    }
                  />
                  <div className="space-y-2">
                    <Input
                      label={t('mapSecurities.orCreateNew')}
                      placeholder={t('mapSecurities.symbolPlaceholder')}
                      value={mapping.createNew || ''}
                      onChange={(e) =>
                        handleSecurityMappingChange(index, 'createNew', e.target.value)
                      }
                    />
                    <Input
                      label={t('mapSecurities.securityName')}
                      placeholder={t('mapSecurities.securityNamePlaceholder')}
                      value={mapping.securityName || ''}
                      onChange={(e) =>
                        handleSecurityMappingChange(index, 'securityName', e.target.value)
                      }
                    />
                    <div className="grid grid-cols-3 gap-2">
                      <Select
                        label={t('mapSecurities.securityType')}
                        options={securityTypeOptions}
                        value={mapping.securityType || 'STOCK'}
                        onChange={(e) =>
                          handleSecurityMappingChange(index, 'securityType', e.target.value)
                        }
                      />
                      <Combobox
                        label={t('mapSecurities.exchange')}
                        options={EXCHANGE_OPTIONS}
                        value={mapping.exchange || ''}
                        onChange={(value, label) =>
                          handleSecurityMappingChange(index, 'exchange', value || label)
                        }
                        placeholder={t('mapSecurities.exchangePlaceholder')}
                        allowCustomValue
                        usePortal
                        alwaysShowSubtitle
                        priorityValues={preferredExchanges}
                      />
                      <Combobox
                        label={t('mapSecurities.currency')}
                        options={currencyOptions}
                        value={mapping.currencyCode || ''}
                        onChange={(value) =>
                          handleSecurityMappingChange(index, 'currencyCode', value)
                        }
                        placeholder={t('mapSecurities.currencyPlaceholder')}
                        usePortal
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
              if (isMultiAccountImport) {
                setStep('multiAccountReview');
              } else if (categoryMappings.length > 0) {
                setStep('mapCategories');
              } else {
                setStep('selectAccount');
              }
            }}
          >
            {t('navigation.back')}
          </Button>
          {isMultiAccountImport ? (
            <Button
              onClick={onMultiAccountImport}
              isLoading={isLoading}
            >
              {t('mapSecurities.importAll')}
            </Button>
          ) : (
            <Button
              onClick={() => {
                if (shouldShowMapAccounts) {
                  setStep('mapAccounts');
                } else {
                  setStep('review');
                }
              }}
            >
              {t('navigation.next')}
            </Button>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
