'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { transactionsApi } from '@/lib/transactions';
import { Account } from '@/types/account';
import { Transaction } from '@/types/transaction';

const valueChangeSchema = z.object({
  transactionDate: z.string().min(1, 'Date is required'),
  amount: z.number({ invalid_type_error: 'Amount is required' }),
  description: z.string().optional(),
});

type ValueChangeFormData = z.infer<typeof valueChangeSchema>;

interface AssetValueChangeFormProps {
  account: Account;
  transaction?: Transaction;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function AssetValueChangeForm({ account, transaction, onSuccess, onCancel }: AssetValueChangeFormProps) {
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<ValueChangeFormData>({
    resolver: zodResolver(valueChangeSchema),
    defaultValues: transaction
      ? {
          transactionDate: transaction.transactionDate?.split('T')[0] || new Date().toISOString().split('T')[0],
          amount: Number(transaction.amount) || 0,
          description: transaction.description || '',
        }
      : {
          transactionDate: new Date().toISOString().split('T')[0],
          amount: 0,
          description: '',
        },
  });

  const watchedAmount = watch('amount');

  const onSubmit = async (data: ValueChangeFormData) => {
    setIsLoading(true);
    try {
      if (transaction) {
        // Update existing transaction
        await transactionsApi.update(transaction.id, {
          transactionDate: data.transactionDate,
          amount: data.amount,
          description: data.description || undefined,
          categoryId: account.assetCategoryId || undefined,
        });
        toast.success('Value change updated');
      } else {
        // Create new transaction
        await transactionsApi.create({
          accountId: account.id,
          transactionDate: data.transactionDate,
          amount: data.amount,
          currencyCode: account.currencyCode,
          description: data.description || undefined,
          categoryId: account.assetCategoryId || undefined,
          payeeName: 'Asset Value Update',
        });
        toast.success('Value change recorded');
      }
      onSuccess?.();
    } catch (error) {
      console.error('Failed to save value change:', error);
      toast.error('Failed to save value change');
    } finally {
      setIsLoading(false);
    }
  };

  const formatCurrency = (value: number) => {
    const absValue = Math.abs(value);
    const formatted = new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: account.currencyCode || 'CAD',
    }).format(absValue);
    return value >= 0 ? `+${formatted}` : `-${formatted}`;
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Current Value</div>
        <div className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          {new Intl.NumberFormat('en-CA', {
            style: 'currency',
            currency: account.currencyCode || 'CAD',
          }).format(Number(account.currentBalance))}
        </div>
      </div>

      <Input
        label="Date"
        type="date"
        error={errors.transactionDate?.message}
        {...register('transactionDate')}
      />

      <div>
        <Input
          label="Value Change"
          type="number"
          step="0.01"
          placeholder="Enter positive to increase, negative to decrease"
          error={errors.amount?.message}
          {...register('amount', { valueAsNumber: true })}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Enter a positive number to increase value, negative to decrease
        </p>
      </div>

      {watchedAmount !== 0 && !isNaN(watchedAmount) && (
        <div className="p-3 bg-gray-100 dark:bg-gray-700 rounded-lg">
          <div className="flex justify-between items-center">
            <span className="text-sm text-gray-600 dark:text-gray-400">New Value:</span>
            <span className={`text-lg font-semibold ${
              watchedAmount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }`}>
              {new Intl.NumberFormat('en-CA', {
                style: 'currency',
                currency: account.currencyCode || 'CAD',
              }).format(Number(account.currentBalance) + watchedAmount)}
            </span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Change: {formatCurrency(watchedAmount)}
          </div>
        </div>
      )}

      <Input
        label="Description (optional)"
        placeholder="e.g., Annual appraisal update"
        error={errors.description?.message}
        {...register('description')}
      />

      <div className="flex justify-end space-x-3 pt-4">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" isLoading={isLoading}>
          {transaction ? 'Update' : 'Record'} Value Change
        </Button>
      </div>
    </form>
  );
}
