'use client';

import { useState, useCallback, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Security, CreateSecurityData } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';

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
  const [isLookingUp, setIsLookingUp] = useState(false);
  const lookupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<CreateSecurityData>({
    defaultValues: {
      symbol: security?.symbol || '',
      name: security?.name || '',
      securityType: security?.securityType || '',
      exchange: security?.exchange || '',
      currencyCode: security?.currencyCode || 'CAD',
    },
  });

  const performLookup = useCallback(async (query: string, source: 'symbol' | 'name') => {
    if (!query || query.length < 2) return;

    // Clear any pending lookup
    if (lookupTimeoutRef.current) {
      clearTimeout(lookupTimeoutRef.current);
    }

    // Debounce the lookup
    lookupTimeoutRef.current = setTimeout(async () => {
      setIsLookingUp(true);
      try {
        const result = await investmentsApi.lookupSecurity(query);
        if (result) {
          const currentValues = getValues();

          // Fill in missing values based on what was searched
          if (source === 'symbol' && !currentValues.name) {
            setValue('name', result.name);
          } else if (source === 'name' && !currentValues.symbol) {
            setValue('symbol', result.symbol);
          }

          // Fill in exchange if not already set
          if (!currentValues.exchange && result.exchange) {
            setValue('exchange', result.exchange);
          }

          // Fill in security type if not already set
          if (!currentValues.securityType && result.securityType) {
            setValue('securityType', result.securityType);
          }
        }
      } catch (error) {
        console.error('Security lookup failed:', error);
      } finally {
        setIsLookingUp(false);
      }
    }, 500);
  }, [getValues, setValue]);

  const handleSymbolBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.target.value.trim();
    if (value && !security) {
      performLookup(value, 'symbol');
    }
  };

  const handleNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.target.value.trim();
    if (value && !security && !getValues('symbol')) {
      performLookup(value, 'name');
    }
  };

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

  const symbolRegister = register('symbol', {
    required: 'Symbol is required',
    maxLength: { value: 20, message: 'Symbol must be 20 characters or less' },
  });

  const nameRegister = register('name', {
    required: 'Name is required',
    maxLength: { value: 255, message: 'Name must be 255 characters or less' },
  });

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      <div className="relative">
        <Input
          label="Symbol"
          {...symbolRegister}
          onBlur={(e) => {
            symbolRegister.onBlur(e);
            handleSymbolBlur(e);
          }}
          error={errors.symbol?.message}
          placeholder="e.g., AAPL, XEQT, BTC"
          className="uppercase"
        />
        {isLookingUp && (
          <div className="absolute right-3 top-8 text-xs text-gray-400">
            Looking up...
          </div>
        )}
      </div>

      <Input
        label="Name"
        {...nameRegister}
        onBlur={(e) => {
          nameRegister.onBlur(e);
          handleNameBlur(e);
        }}
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
        {...register('currencyCode', { required: 'Currency is required' })}
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
