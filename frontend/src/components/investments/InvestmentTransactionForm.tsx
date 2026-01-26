'use client';

import { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { investmentsApi } from '@/lib/investments';
import { Account } from '@/types/account';
import {
  InvestmentAction,
  InvestmentTransaction,
  Security,
  CreateSecurityData,
} from '@/types/investment';

const investmentTransactionSchema = z.object({
  accountId: z.string().min(1, 'Account is required'),
  action: z.enum(['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'SPLIT', 'TRANSFER_IN', 'TRANSFER_OUT', 'REINVEST']),
  transactionDate: z.string().min(1, 'Date is required'),
  securityId: z.string().optional(),
  quantity: z.coerce.number().min(0).optional(),
  price: z.coerce.number().min(0).optional(),
  commission: z.coerce.number().min(0).optional(),
  description: z.string().optional(),
});

type InvestmentTransactionFormData = z.infer<typeof investmentTransactionSchema>;

interface InvestmentTransactionFormProps {
  accounts: Account[];
  transaction?: InvestmentTransaction;
  defaultAccountId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
}

const actionLabels: Record<InvestmentAction, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  INTEREST: 'Interest',
  CAPITAL_GAIN: 'Capital Gain',
  SPLIT: 'Stock Split',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  REINVEST: 'Reinvest Dividend',
};

// Actions that require a security selection
const securityRequiredActions: InvestmentAction[] = ['BUY', 'SELL', 'DIVIDEND', 'CAPITAL_GAIN', 'SPLIT', 'REINVEST'];

// Actions that require quantity and price
const quantityPriceActions: InvestmentAction[] = ['BUY', 'SELL', 'REINVEST'];

// Actions that only need an amount (no quantity/price)
const amountOnlyActions: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'TRANSFER_IN', 'TRANSFER_OUT'];

export function InvestmentTransactionForm({
  accounts,
  transaction,
  defaultAccountId,
  onSuccess,
  onCancel,
}: InvestmentTransactionFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [showNewSecurityForm, setShowNewSecurityForm] = useState(false);
  const [newSecurity, setNewSecurity] = useState<CreateSecurityData>({
    symbol: '',
    name: '',
    securityType: 'STOCK',
    currencyCode: 'CAD',
  });

  // Filter to only show brokerage accounts
  const brokerageAccounts = useMemo(
    () => accounts.filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE'),
    [accounts]
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<InvestmentTransactionFormData>({
    resolver: zodResolver(investmentTransactionSchema),
    defaultValues: transaction
      ? {
          accountId: transaction.accountId,
          action: transaction.action,
          transactionDate: transaction.transactionDate,
          securityId: transaction.securityId,
          quantity: transaction.quantity,
          price: transaction.price,
          commission: transaction.commission || 0,
          description: transaction.description || '',
        }
      : {
          accountId: defaultAccountId || '',
          action: 'BUY',
          transactionDate: new Date().toISOString().split('T')[0],
          quantity: 0,
          price: 0,
          commission: 0,
          description: '',
        },
  });

  const watchedAction = watch('action') as InvestmentAction;
  const watchedQuantity = Number(watch('quantity')) || 0;
  const watchedPrice = Number(watch('price')) || 0;
  const watchedCommission = Number(watch('commission')) || 0;

  // Calculate total amount
  const totalAmount = useMemo(() => {
    if (quantityPriceActions.includes(watchedAction)) {
      const subtotal = watchedQuantity * watchedPrice;
      if (watchedAction === 'BUY' || watchedAction === 'REINVEST') {
        return subtotal + watchedCommission;
      } else {
        return subtotal - watchedCommission;
      }
    }
    return watchedPrice; // For amount-only actions, price is used as the amount
  }, [watchedAction, watchedQuantity, watchedPrice, watchedCommission]);

  // Load securities
  useEffect(() => {
    const loadSecurities = async () => {
      try {
        const data = await investmentsApi.getSecurities();
        setSecurities(data);
      } catch (error) {
        console.error('Failed to load securities:', error);
      }
    };
    loadSecurities();
  }, []);

  const handleCreateSecurity = async () => {
    if (!newSecurity.symbol || !newSecurity.name) {
      toast.error('Symbol and name are required');
      return;
    }

    setIsLoading(true);
    try {
      const created = await investmentsApi.createSecurity(newSecurity);
      setSecurities((prev) => [...prev, created]);
      setValue('securityId', created.id);
      setShowNewSecurityForm(false);
      setNewSecurity({
        symbol: '',
        name: '',
        securityType: 'STOCK',
        currencyCode: 'CAD',
      });
      toast.success('Security created');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to create security');
    } finally {
      setIsLoading(false);
    }
  };

  const onSubmit = async (data: InvestmentTransactionFormData) => {
    setIsLoading(true);
    try {
      const payload = {
        accountId: data.accountId,
        action: data.action as InvestmentAction,
        transactionDate: data.transactionDate,
        securityId: securityRequiredActions.includes(data.action as InvestmentAction)
          ? data.securityId
          : undefined,
        quantity: quantityPriceActions.includes(data.action as InvestmentAction)
          ? data.quantity
          : undefined,
        price: data.price,
        commission: data.commission,
        description: data.description,
      };

      if (transaction) {
        // TODO: Add update endpoint when needed
        toast.error('Update not yet implemented');
      } else {
        await investmentsApi.createTransaction(payload);
        toast.success('Transaction created');
      }
      onSuccess?.();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to save transaction');
    } finally {
      setIsLoading(false);
    }
  };

  const needsSecurity = securityRequiredActions.includes(watchedAction);
  const needsQuantityPrice = quantityPriceActions.includes(watchedAction);
  const isAmountOnly = amountOnlyActions.includes(watchedAction);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Account Selection */}
      <Select
        label="Brokerage Account"
        error={errors.accountId?.message}
        options={[
          { value: '', label: 'Select account...' },
          ...brokerageAccounts.map((a) => ({
            value: a.id,
            label: a.name,
          })),
        ]}
        {...register('accountId')}
      />

      {/* Action Type */}
      <Select
        label="Transaction Type"
        error={errors.action?.message}
        options={Object.entries(actionLabels).map(([value, label]) => ({
          value,
          label,
        }))}
        {...register('action')}
      />

      {/* Date */}
      <Input
        label="Date"
        type="date"
        error={errors.transactionDate?.message}
        {...register('transactionDate')}
      />

      {/* Security Selection - only for actions that need it */}
      {needsSecurity && (
        <div className="space-y-2">
          <Select
            label="Security"
            error={errors.securityId?.message}
            options={[
              { value: '', label: 'Select security...' },
              ...securities.map((s) => ({
                value: s.id,
                label: `${s.symbol} - ${s.name}`,
              })),
            ]}
            {...register('securityId')}
          />
          <button
            type="button"
            onClick={() => setShowNewSecurityForm(!showNewSecurityForm)}
            className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {showNewSecurityForm ? 'Cancel' : '+ Add new security'}
          </button>

          {showNewSecurityForm && (
            <div className="border dark:border-gray-700 rounded-lg p-4 space-y-3 bg-gray-50 dark:bg-gray-800">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Symbol"
                  placeholder="e.g., AAPL"
                  value={newSecurity.symbol}
                  onChange={(e) =>
                    setNewSecurity((prev) => ({ ...prev, symbol: e.target.value.toUpperCase() }))
                  }
                />
                <Input
                  label="Name"
                  placeholder="e.g., Apple Inc."
                  value={newSecurity.name}
                  onChange={(e) =>
                    setNewSecurity((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Type"
                  value={newSecurity.securityType}
                  onChange={(e) =>
                    setNewSecurity((prev) => ({ ...prev, securityType: e.target.value }))
                  }
                  options={[
                    { value: 'STOCK', label: 'Stock' },
                    { value: 'ETF', label: 'ETF' },
                    { value: 'MUTUAL_FUND', label: 'Mutual Fund' },
                    { value: 'BOND', label: 'Bond' },
                    { value: 'OPTION', label: 'Option' },
                    { value: 'OTHER', label: 'Other' },
                  ]}
                />
                <Select
                  label="Currency"
                  value={newSecurity.currencyCode}
                  onChange={(e) =>
                    setNewSecurity((prev) => ({ ...prev, currencyCode: e.target.value }))
                  }
                  options={[
                    { value: 'CAD', label: 'CAD' },
                    { value: 'USD', label: 'USD' },
                  ]}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCreateSecurity}
                isLoading={isLoading}
              >
                Create Security
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Quantity and Price - for buy/sell/reinvest */}
      {needsQuantityPrice && (
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Quantity (Shares)"
            type="number"
            step="0.00000001"
            min="0"
            error={errors.quantity?.message}
            {...register('quantity')}
          />
          <Input
            label="Price per Share"
            type="number"
            step="0.0001"
            min="0"
            error={errors.price?.message}
            {...register('price')}
          />
        </div>
      )}

      {/* Amount - for dividend/interest/capital gain/transfers */}
      {isAmountOnly && (
        <Input
          label="Amount"
          type="number"
          step="0.01"
          min="0"
          error={errors.price?.message}
          {...register('price')}
        />
      )}

      {/* Commission */}
      {(needsQuantityPrice || watchedAction === 'SPLIT') && (
        <Input
          label="Commission / Fees"
          type="number"
          step="0.01"
          min="0"
          error={errors.commission?.message}
          {...register('commission')}
        />
      )}

      {/* Description */}
      <Input
        label="Description (optional)"
        placeholder="Optional notes"
        error={errors.description?.message}
        {...register('description')}
      />

      {/* Total Amount Display */}
      {(needsQuantityPrice || isAmountOnly) && (
        <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Total Amount
            </span>
            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              ${totalAmount.toFixed(2)}
            </span>
          </div>
          {needsQuantityPrice && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {watchedQuantity} shares @ ${watchedPrice.toFixed(4)}
              {watchedCommission > 0 && ` ${watchedAction === 'SELL' ? '-' : '+'} $${watchedCommission.toFixed(2)} commission`}
            </div>
          )}
        </div>
      )}

      {/* Form Actions */}
      <div className="flex justify-end space-x-3 pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" isLoading={isLoading}>
          {transaction ? 'Update' : 'Create'} Transaction
        </Button>
      </div>
    </form>
  );
}
