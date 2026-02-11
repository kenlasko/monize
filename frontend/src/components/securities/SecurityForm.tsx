'use client';

import { useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@/lib/zodResolver';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Security, CreateSecurityData } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';

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

const currencyOptions = [
  { value: 'CAD', label: 'CAD - Canadian Dollar' },
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
];

export function SecurityForm({ security, onSubmit, onCancel }: SecurityFormProps) {
  const { defaultCurrency } = useNumberFormat();
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting, defaultValues },
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
    const { symbol, name } = getValues();
    const query = (symbol?.trim() || name?.trim() || '');
    if (query.length < 2) {
      toast.error('Enter a symbol or name (at least 2 characters) to lookup');
      return;
    }

    setIsLookingUp(true);
    try {
      const result = await investmentsApi.lookupSecurity(query);
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
  }, [getValues, setValue]);

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
        {...register('securityType')}
        error={errors.securityType?.message}
      />

      <Input
        label="Exchange"
        {...register('exchange')}
        error={errors.exchange?.message}
        placeholder="e.g., NYSE, TSX, NASDAQ"
      />

      <Select
        label="Currency"
        options={currencyOptions}
        {...register('currencyCode')}
        error={errors.currencyCode?.message}
      />

      <div className="flex justify-end gap-3 pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {security ? 'Update' : 'Create'} Security
        </Button>
      </div>
    </form>
  );
}
