'use client';

import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
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
  isFavourite: z.boolean().optional(),
  createInvestmentPair: z.boolean().optional(),
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
  { value: 'LINE_OF_CREDIT', label: 'Line of Credit' },
  { value: 'MORTGAGE', label: 'Mortgage' },
  { value: 'CASH', label: 'Cash' },
  { value: 'OTHER', label: 'Other' },
];

const currencySymbols: Record<string, string> = {
  CAD: '$',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

export function AccountForm({ account, onSubmit, onCancel }: AccountFormProps) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormData>({
    resolver: zodResolver(accountSchema),
    defaultValues: account
      ? {
          name: account.name,
          accountType: account.accountType,
          currencyCode: account.currencyCode,
          openingBalance: account.openingBalance !== undefined
            ? Math.round(Number(account.openingBalance) * 100) / 100
            : undefined,
          creditLimit: account.creditLimit
            ? Math.round(Number(account.creditLimit) * 100) / 100
            : undefined,
          interestRate: account.interestRate || undefined,
          description: account.description || undefined,
          accountNumber: account.accountNumber || undefined,
          institution: account.institution || undefined,
          isFavourite: account.isFavourite || false,
        }
      : {
          currencyCode: 'CAD',
          openingBalance: 0,
          isFavourite: false,
        },
  });

  const watchedCurrency = watch('currencyCode');
  const watchedIsFavourite = watch('isFavourite');
  const watchedAccountType = watch('accountType');
  const watchedCreateInvestmentPair = watch('createInvestmentPair');
  const currencySymbol = currencySymbols[watchedCurrency] || '$';

  // Show investment pair checkbox only when creating a new INVESTMENT account
  const showInvestmentPairOption = !account && watchedAccountType === 'INVESTMENT';

  const toggleFavourite = () => {
    setValue('isFavourite', !watchedIsFavourite, { shouldDirty: true });
  };

  const handleImportQif = () => {
    if (account) {
      router.push(`/import?accountId=${account.id}`);
    }
  };

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

      {/* Investment account pair option */}
      {showInvestmentPairOption && (
        <div className="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
          <input
            type="checkbox"
            id="createInvestmentPair"
            className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            {...register('createInvestmentPair')}
          />
          <label htmlFor="createInvestmentPair" className="flex-1">
            <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Create as Cash + Brokerage pair (recommended)
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
              Creates two linked accounts: a Cash account for transfers in/out and a
              Brokerage account for investment transactions. This is the recommended
              structure for tracking investments.
            </span>
          </label>
        </div>
      )}

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
          prefix={currencySymbol}
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
          prefix={currencySymbol}
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

      {/* Favourite star toggle */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={toggleFavourite}
          className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          title={watchedIsFavourite ? 'Remove from favourites' : 'Add to favourites'}
        >
          <svg
            className={`w-5 h-5 transition-colors ${
              watchedIsFavourite
                ? 'text-yellow-500 fill-current'
                : 'text-gray-400 dark:text-gray-500'
            }`}
            fill={watchedIsFavourite ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {watchedIsFavourite ? 'Favourite' : 'Add to favourites'}
          </span>
        </button>
        {/* Hidden input for form registration */}
        <input type="hidden" {...register('isFavourite')} />

        {/* Import QIF button - only shown when editing */}
        {account && (
          <button
            type="button"
            onClick={handleImportQif}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            title="Import transactions from QIF file"
          >
            <svg
              className="w-5 h-5 text-gray-500 dark:text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            <span className="text-sm text-gray-700 dark:text-gray-300">Import QIF</span>
          </button>
        )}
      </div>

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
