'use client';

import { useState, useEffect, useCallback, useMemo, MutableRefObject } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { Security, CreateSecurityData } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { EXCHANGE_OPTIONS } from '@/lib/constants';

const logger = createLogger('SecurityForm');

const securitySchema = z.object({
  symbol: z.string().min(1, 'Symbol is required').max(20, 'Symbol must be 20 characters or less'),
  name: z.string().min(1, 'Name is required').max(255, 'Name must be 255 characters or less'),
  securityType: z.string().optional(),
  exchange: z.string().optional(),
  currencyCode: z.string().min(1, 'Currency is required'),
});

type SecurityFormData = z.infer<typeof securitySchema>;

interface SecurityFormProps {
  security?: Security;
  onSubmit: (data: CreateSecurityData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

const securityTypeOptions = [
  { value: '', label: 'Select type...' },
  { value: 'STOCK', label: 'Stock' },
  { value: 'ETF', label: 'ETF' },
  { value: 'MUTUAL_FUND', label: 'Mutual Fund' },
  { value: 'BOND', label: 'Bond' },
  { value: 'OPTION', label: 'Option' },
  { value: 'CRYPTO', label: 'Cryptocurrency' },
  { value: 'OTHER', label: 'Other' },
];

export function SecurityForm({ security, onSubmit, onCancel, onDirtyChange, submitRef }: SecurityFormProps) {
  const { defaultCurrency } = useNumberFormat();
  const rawPreferredExchanges = usePreferencesStore((s) => s.preferences?.preferredExchanges);
  const preferredExchanges = useMemo(() => rawPreferredExchanges || [], [rawPreferredExchanges]);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);

  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setCurrencies).catch(() => {});
  }, []);

  const currencyOptions = useMemo(() => {
    const sorted = [...currencies].sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
    return sorted.map((c) => ({
      value: c.code,
      label: `${c.code} - ${c.name} (${c.symbol})`,
    }));
  }, [currencies, defaultCurrency]);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    watch,
    reset,
    formState: { errors, isSubmitting, isDirty, defaultValues },
  } = useForm<SecurityFormData>({
    resolver: zodResolver(securitySchema),
    defaultValues: {
      symbol: security?.symbol || '',
      name: security?.name || '',
      securityType: security?.securityType || '',
      exchange: security?.exchange || '',
      currencyCode: security?.currencyCode || defaultCurrency,
    },
  });

  // Manual lookup - prioritize symbol, fall back to name
  const handleLookup = useCallback(async () => {
    const { symbol, name, exchange: currentExchange } = getValues();
    const query = (symbol?.trim() || name?.trim() || '');
    if (query.length < 2) {
      toast.error('Enter a symbol or name (at least 2 characters) to lookup');
      return;
    }

    // Merge current exchange selection with preferred exchanges
    const exchanges = currentExchange
      ? [currentExchange, ...preferredExchanges.filter((e) => e !== currentExchange)]
      : preferredExchanges.length > 0
        ? preferredExchanges
        : undefined;

    setIsLookingUp(true);
    try {
      const result = await investmentsApi.lookupSecurity(query, exchanges);
      if (result) {
        // Fill in all fields from the lookup result
        setValue('symbol', result.symbol);
        setValue('name', result.name);
        setValue('exchange', result.exchange || '');
        setValue('securityType', result.securityType || '');
        if (result.currencyCode) {
          setValue('currencyCode', result.currencyCode);
        }
        setHasLookupResult(true);

        const details = [`Symbol: ${result.symbol}`, `Name: ${result.name}`];
        if (result.exchange) details.push(`Exchange: ${result.exchange}`);
        if (result.securityType) details.push(`Type: ${result.securityType}`);
        if (result.currencyCode) details.push(`Currency: ${result.currencyCode}`);
        toast.success(`Found: ${details.join(', ')}`);
      } else {
        toast.error(`No security found for "${query}"`);
      }
    } catch (error) {
      logger.error('Security lookup failed:', error);
      toast.error('Lookup failed - please try again');
    } finally {
      setIsLookingUp(false);
    }
  }, [getValues, setValue, preferredExchanges]);

  // Clear all looked-up values back to defaults
  const handleClear = useCallback(() => {
    reset({
      symbol: '',
      name: '',
      securityType: '',
      exchange: '',
      currencyCode: defaultValues?.currencyCode || defaultCurrency,
    });
    setHasLookupResult(false);
  }, [reset, defaultValues, defaultCurrency]);

  const onFormSubmit = async (data: CreateSecurityData) => {
    // Clean up empty strings
    const cleanedData: CreateSecurityData = {
      ...data,
      symbol: data.symbol.toUpperCase().trim(),
      name: data.name.trim(),
      securityType: data.securityType || undefined,
      exchange: data.exchange?.trim() || undefined,
    };
    await onSubmit(cleanedData);
  };

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      {/* Symbol + Lookup / Clear buttons */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Input
            label="Symbol"
            {...register('symbol')}
            error={errors.symbol?.message}
            placeholder="e.g., AAPL, XEQT, BTC"
            className="uppercase"
          />
        </div>
        {!security && (
          <div className="flex gap-1.5">
            <Button
              type="button"
              variant="outline"
              onClick={handleLookup}
              disabled={isLookingUp}
              className="mb-[1px]"
            >
              {isLookingUp ? 'Looking up...' : 'Lookup'}
            </Button>
            {hasLookupResult && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleClear}
                className="mb-[1px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                title="Clear all fields"
              >
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      <Input
        label="Name"
        {...register('name')}
        error={errors.name?.message}
        placeholder="e.g., Apple Inc., iShares Core Equity ETF"
      />

      <Select
        label="Type"
        options={securityTypeOptions}
        value={watch('securityType') || ''}
        onChange={(e) => setValue('securityType', e.target.value, { shouldDirty: true })}
        error={errors.securityType?.message}
      />

      <Combobox
        label="Exchange"
        options={EXCHANGE_OPTIONS}
        value={watch('exchange') || ''}
        onChange={(value, label) => setValue('exchange', value || label, { shouldDirty: true })}
        error={errors.exchange?.message}
        placeholder="Search exchanges..."
        allowCustomValue
        usePortal
        alwaysShowSubtitle
        priorityValues={preferredExchanges}
      />

      <Select
        label="Currency"
        options={currencyOptions}
        {...register('currencyCode')}
        error={errors.currencyCode?.message}
      />

      <FormActions onCancel={onCancel} submitLabel={security ? 'Update Security' : 'Create Security'} isSubmitting={isSubmitting} />
    </form>
  );
}
