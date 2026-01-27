'use client';

import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Security, CreateSecurityData } from '@/types/investment';

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
  const {
    register,
    handleSubmit,
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
      <Input
        label="Symbol"
        {...register('symbol', {
          required: 'Symbol is required',
          maxLength: { value: 20, message: 'Symbol must be 20 characters or less' },
        })}
        error={errors.symbol?.message}
        placeholder="e.g., AAPL, XEQT, BTC"
        className="uppercase"
      />

      <Input
        label="Name"
        {...register('name', {
          required: 'Name is required',
          maxLength: { value: 255, message: 'Name must be 255 characters or less' },
        })}
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
