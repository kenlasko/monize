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
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SecurityLookupPicker, LookupCandidate } from './SecurityLookupPicker';
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
  quoteProvider: z.enum(['', 'yahoo', 'msn']).optional(),
  msnInstrumentId: z.string().max(50).optional(),
});

type SecurityFormData = z.infer<typeof securitySchema>;

const quoteProviderOverrideOptions = [
  { value: '', label: 'Use default' },
  { value: 'yahoo', label: 'Yahoo Finance' },
  { value: 'msn', label: 'MSN Money' },
];

const lookupProviderOptions = [
  { value: 'auto', label: 'Auto' },
  { value: 'yahoo', label: 'Yahoo' },
  { value: 'msn', label: 'MSN' },
];

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
  const userDefaultProvider = usePreferencesStore((s) => s.preferences?.defaultQuoteProvider) ?? 'yahoo';
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [lookupProvider, setLookupProvider] = useState<'auto' | 'yahoo' | 'msn'>('auto');
  const [pickerQuery, setPickerQuery] = useState<string>('');
  const [pickerCandidates, setPickerCandidates] = useState<LookupCandidate[]>([]);
  const [msnReady, setMsnReady] = useState<boolean | null>(null);

  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setCurrencies).catch(() => {});
  }, []);

  useEffect(() => {
    investmentsApi
      .getProviderStatus()
      .then((status) => setMsnReady(status.msn.ready))
      .catch(() => setMsnReady(null));
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
      quoteProvider: security?.quoteProvider || '',
      msnInstrumentId: security?.msnInstrumentId || '',
    },
  });

  const applyLookupResult = useCallback(
    (result: LookupCandidate) => {
      const setOpts = { shouldDirty: true, shouldTouch: true, shouldValidate: true };

      setValue('symbol', result.symbol, setOpts);
      setValue('name', result.name, setOpts);
      if (result.exchange) setValue('exchange', result.exchange, setOpts);
      if (result.securityType) setValue('securityType', result.securityType, setOpts);
      if (result.currencyCode) setValue('currencyCode', result.currencyCode, setOpts);

      if (result.provider) {
        const explicit = lookupProvider !== 'auto';
        const differsFromDefault = result.provider !== userDefaultProvider;
        if (explicit || differsFromDefault) {
          setValue('quoteProvider', result.provider, setOpts);
        }
      }

      if (result.msnInstrumentId) {
        setValue('msnInstrumentId', result.msnInstrumentId, setOpts);
      }

      setHasLookupResult(true);

      const details = [`Symbol: ${result.symbol}`, `Name: ${result.name}`];
      if (result.exchange) details.push(`Exchange: ${result.exchange}`);
      if (result.securityType) details.push(`Type: ${result.securityType}`);
      if (result.currencyCode) details.push(`Currency: ${result.currencyCode}`);
      if (result.provider) details.push(`Provider: ${result.provider === 'msn' ? 'MSN' : 'Yahoo'}`);
      toast.success(`Found: ${details.join(', ')}`);
    },
    [setValue, lookupProvider, userDefaultProvider],
  );

  const handleLookup = useCallback(async () => {
    const { symbol, name, exchange: currentExchange } = getValues();
    const query = (symbol?.trim() || name?.trim() || '');
    if (query.length < 2) {
      toast.error('Enter a symbol or name (at least 2 characters) to lookup');
      return;
    }

    const exchanges = currentExchange
      ? [currentExchange, ...preferredExchanges.filter((e) => e !== currentExchange)]
      : preferredExchanges.length > 0
        ? preferredExchanges
        : undefined;

    setIsLookingUp(true);
    try {
      const candidates = await investmentsApi.lookupSecurityCandidates(
        query,
        exchanges,
        lookupProvider,
      );
      if (candidates.length === 0) {
        toast.error(`No security found for "${query}"`);
      } else if (candidates.length === 1) {
        applyLookupResult(candidates[0]);
      } else {
        setPickerQuery(query);
        setPickerCandidates(candidates);
      }
    } catch (error) {
      logger.error('Security lookup failed:', error);
      toast.error('Lookup failed - please try again');
    } finally {
      setIsLookingUp(false);
    }
  }, [getValues, preferredExchanges, lookupProvider, applyLookupResult]);

  // In edit mode, revert to the original security values. In create mode,
  // blank everything out (keeping the user's default currency).
  const handleClear = useCallback(() => {
    if (security) {
      reset();
    } else {
      reset({
        symbol: '',
        name: '',
        securityType: '',
        exchange: '',
        currencyCode: defaultValues?.currencyCode || defaultCurrency,
        quoteProvider: '',
        msnInstrumentId: '',
      });
    }
    setHasLookupResult(false);
  }, [reset, defaultValues, defaultCurrency, security]);

  const onFormSubmit = async (data: SecurityFormData) => {
    const cleanedData: CreateSecurityData = {
      symbol: data.symbol.toUpperCase().trim(),
      name: data.name.trim(),
      securityType: data.securityType || undefined,
      exchange: data.exchange?.trim() || undefined,
      currencyCode: data.currencyCode,
      // Send null (not undefined) when the user picks "Use Default" so the
      // backend clears any existing override. Undefined would be stripped by
      // axios and treated as "no change", leaving the previous override in place.
      quoteProvider: data.quoteProvider === '' ? null : data.quoteProvider,
      msnInstrumentId: data.msnInstrumentId?.trim() || undefined,
    };
    await onSubmit(cleanedData);
  };

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);

  return (
    <>
    <SecurityLookupPicker
      isOpen={pickerCandidates.length > 0}
      query={pickerQuery}
      candidates={pickerCandidates}
      onPick={(c) => {
        applyLookupResult(c);
        setPickerCandidates([]);
        setPickerQuery('');
      }}
      onCancel={() => {
        setPickerCandidates([]);
        setPickerQuery('');
      }}
    />
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
        <div className="flex gap-1.5">
          <Select
            aria-label="Lookup provider"
            options={lookupProviderOptions}
            value={lookupProvider}
            onChange={(e) =>
              setLookupProvider(e.target.value as 'auto' | 'yahoo' | 'msn')
            }
            className="mb-[1px] w-24"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleLookup}
            disabled={isLookingUp}
            className="mb-[1px] relative"
          >
            <span className={isLookingUp ? 'invisible' : ''}>Lookup</span>
            {isLookingUp && (
              <span className="absolute inset-0 flex items-center justify-center">
                <LoadingSpinner size="sm" fullContainer={false} />
              </span>
            )}
          </Button>
          {hasLookupResult && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleClear}
              className="mb-[1px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              title={security ? 'Revert to original values' : 'Clear all fields'}
            >
              {security ? 'Revert' : 'Clear'}
            </Button>
          )}
        </div>
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

      <div>
        <Select
          label="Quote Provider"
          options={[
            { value: '', label: `Use default (${userDefaultProvider === 'msn' ? 'MSN Money' : 'Yahoo Finance'})` },
            ...quoteProviderOverrideOptions.slice(1),
          ]}
          value={watch('quoteProvider') || ''}
          onChange={(e) =>
            setValue('quoteProvider', (e.target.value as 'yahoo' | 'msn' | ''), {
              shouldDirty: true,
            })
          }
          error={errors.quoteProvider?.message}
        />
        {watch('quoteProvider') === 'msn' && msnReady === false && (
          <p
            role="alert"
            className="text-sm text-red-600 dark:text-red-400 mt-2"
            data-testid="msn-not-configured-error"
          >
            MSN is selected as the default quote provider, but{' '}
            <code>MSN_API_KEY</code> is not configured on the server. MSN
            quotes will fail until an administrator sets the env var and
            restarts the backend.
          </p>
        )}
      </div>

      {watch('quoteProvider') === 'msn' && (
        <Input
          label="MSN Instrument ID (advanced)"
          {...register('msnInstrumentId')}
          error={errors.msnInstrumentId?.message}
          placeholder="Auto-resolved from ticker; override only if wrong"
        />
      )}

      <FormActions onCancel={onCancel} submitLabel={security ? 'Update Security' : 'Create Security'} isSubmitting={isSubmitting} />
    </form>
    </>
  );
}
