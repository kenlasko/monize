'use client';

import { useState, useCallback, MutableRefObject } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zodResolver';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInfo, CreateCurrencyData } from '@/lib/exchange-rates';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { createLogger } from '@/lib/logger';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const logger = createLogger('CurrencyForm');

const currencySchema = z.object({
  code: z.string().length(3, 'Currency code must be exactly 3 characters'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
  symbol: z.string().min(1, 'Symbol is required').max(10, 'Symbol must be 10 characters or less'),
  decimalPlaces: z.coerce.number().int().min(0).max(4).default(2),
});

type CurrencyFormData = z.infer<typeof currencySchema>;

interface CurrencyFormProps {
  currency?: CurrencyInfo;
  onSubmit: (data: CreateCurrencyData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function CurrencyForm({ currency, onSubmit, onCancel, onDirtyChange, submitRef }: CurrencyFormProps) {
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting, isDirty, defaultValues },
  } = useForm<CurrencyFormData>({
    resolver: zodResolver(currencySchema),
    defaultValues: {
      code: currency?.code || '',
      name: currency?.name || '',
      symbol: currency?.symbol || '',
      decimalPlaces: currency?.decimalPlaces ?? 2,
    },
  });

  const handleLookup = useCallback(async () => {
    const { code, name } = getValues();
    // Use code if provided, otherwise fall back to name field (for country/currency name search)
    const codeQuery = code?.trim() || '';
    const nameQuery = name?.trim() || '';
    const query = codeQuery.length >= 2 ? codeQuery : nameQuery;

    if (query.length < 2) {
      toast.error('Enter a currency code or name (at least 2 characters) to lookup');
      return;
    }

    setIsLookingUp(true);
    try {
      const result = await exchangeRatesApi.lookupCurrency(query);
      if (result) {
        setValue('code', result.code);
        setValue('name', result.name);
        setValue('symbol', result.symbol);
        setValue('decimalPlaces', result.decimalPlaces);
        setHasLookupResult(true);

        const details = [`Code: ${result.code}`, `Name: ${result.name}`, `Symbol: ${result.symbol}`];
        toast.success(`Found: ${details.join(', ')}`);
      } else {
        toast.error(`No currency found for "${query}"`);
      }
    } catch (error) {
      logger.error('Currency lookup failed:', error);
      toast.error('Lookup failed - please try again');
    } finally {
      setIsLookingUp(false);
    }
  }, [getValues, setValue]);

  const handleClear = useCallback(() => {
    reset({
      code: '',
      name: '',
      symbol: '',
      decimalPlaces: 2,
    });
    setHasLookupResult(false);
  }, [reset]);

  const onFormSubmit = async (data: CurrencyFormData) => {
    const cleanedData: CreateCurrencyData = {
      code: data.code.toUpperCase().trim(),
      name: data.name.trim(),
      symbol: data.symbol.trim(),
      decimalPlaces: data.decimalPlaces,
    };
    await onSubmit(cleanedData);
  };

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      {/* Code + Lookup / Clear buttons */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Input
            label="Currency Code"
            {...register('code')}
            error={errors.code?.message}
            placeholder="e.g., USD, EUR, GBP"
            className="uppercase"
            disabled={!!currency}
          />
        </div>
        {!currency && (
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
        placeholder={currency ? 'e.g., Canadian Dollar' : 'e.g., Canadian Dollar, Malaysia, Ringgit (used for lookup too)'}
      />

      <Input
        label="Symbol"
        {...register('symbol')}
        error={errors.symbol?.message}
        placeholder="e.g., $, €, £, ¥"
      />

      <Input
        label="Decimal Places"
        type="number"
        {...register('decimalPlaces')}
        error={errors.decimalPlaces?.message}
        min={0}
        max={4}
      />

      <FormActions onCancel={onCancel} submitLabel={currency ? 'Update Currency' : 'Create Currency'} isSubmitting={isSubmitting} />
    </form>
  );
}
