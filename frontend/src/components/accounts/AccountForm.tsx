'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Account, AccountType } from '@/types/account';

// Helper to handle optional numeric fields that may be NaN from empty inputs
const optionalNumber = z.preprocess(
  (val: unknown) => (val === '' || val === undefined || (typeof val === 'number' && isNaN(val)) ? undefined : val),
  z.number().optional()
);

const optionalNumberWithRange = (min: number, max: number) =>
  z.preprocess(
    (val: unknown) => (val === '' || val === undefined || (typeof val === 'number' && isNaN(val)) ? undefined : val),
    z.number().min(min).max(max).optional()
  );

const accountSchema = z.object({
  name: z.string().min(1, 'Account name is required').max(255),
  accountType: z.enum([
    'CHEQUING',
    'SAVINGS',
    'CREDIT_CARD',
    'LOAN',
    'MORTGAGE',
    'RRSP',
    'TFSA',
    'RESP',
    'INVESTMENT',
    'CASH',
    'LINE_OF_CREDIT',
    'OTHER',
  ]),
  currencyCode: z.string().length(3, 'Currency code must be 3 characters'),
  openingBalance: optionalNumber,
  creditLimit: optionalNumber,
  interestRate: optionalNumberWithRange(0, 100),
  description: z.string().optional(),
  accountNumber: z.string().optional(),
  institution: z.string().optional(),
});

type AccountFormData = z.infer<typeof accountSchema>;

interface AccountFormProps {
  account?: Account;
  onSubmit: (data: AccountFormData) => Promise<void>;
  onCancel: () => void;
}

const accountTypeOptions = [
  { value: 'CHEQUING', label: 'Chequing' },
  { value: 'SAVINGS', label: 'Savings' },
  { value: 'CREDIT_CARD', label: 'Credit Card' },
  { value: 'INVESTMENT', label: 'Investment' },
  { value: 'LOAN', label: 'Loan' },
  { value: 'MORTGAGE', label: 'Mortgage' },
  { value: 'RRSP', label: 'RRSP' },
  { value: 'TFSA', label: 'TFSA' },
  { value: 'RESP', label: 'RESP' },
  { value: 'CASH', label: 'Cash' },
  { value: 'LINE_OF_CREDIT', label: 'Line of Credit' },
  { value: 'OTHER', label: 'Other' },
];

export function AccountForm({ account, onSubmit, onCancel }: AccountFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormData>({
    resolver: zodResolver(accountSchema),
    defaultValues: account
      ? {
          name: account.name,
          accountType: account.accountType,
          currencyCode: account.currencyCode,
          openingBalance: account.openingBalance,
          creditLimit: account.creditLimit || undefined,
          interestRate: account.interestRate || undefined,
          description: account.description || undefined,
          accountNumber: account.accountNumber || undefined,
          institution: account.institution || undefined,
        }
      : {
          currencyCode: 'CAD',
          openingBalance: 0,
        },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Account Name"
        error={errors.name?.message}
        {...register('name')}
      />

      <Select
        label="Account Type"
        options={accountTypeOptions}
        error={errors.accountType?.message}
        {...register('accountType')}
      />

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Currency Code"
          placeholder="CAD"
          error={errors.currencyCode?.message}
          {...register('currencyCode')}
        />

        <Input
          label="Opening Balance"
          type="number"
          step="0.01"
          error={errors.openingBalance?.message}
          {...register('openingBalance', { valueAsNumber: true })}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Account Number (optional)"
          error={errors.accountNumber?.message}
          {...register('accountNumber')}
        />

        <Input
          label="Institution (optional)"
          error={errors.institution?.message}
          {...register('institution')}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Input
          label="Credit Limit (optional)"
          type="number"
          step="0.01"
          error={errors.creditLimit?.message}
          {...register('creditLimit', { valueAsNumber: true })}
        />

        <Input
          label="Interest Rate % (optional)"
          type="number"
          step="0.01"
          error={errors.interestRate?.message}
          {...register('interestRate', { valueAsNumber: true })}
        />
      </div>

      <Input
        label="Description (optional)"
        error={errors.description?.message}
        {...register('description')}
      />

      <div className="flex justify-end space-x-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {account ? 'Update Account' : 'Create Account'}
        </Button>
      </div>
    </form>
  );
}
