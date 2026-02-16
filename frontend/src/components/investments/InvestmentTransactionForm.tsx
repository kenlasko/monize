'use client';

import { useState, useEffect, useMemo, MutableRefObject } from 'react';
import { useForm, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { investmentsApi } from '@/lib/investments';
import { Account } from '@/types/account';
import {
  InvestmentAction,
  InvestmentTransaction,
  Security,
  CreateSecurityData,
} from '@/types/investment';
import { getCurrencySymbol } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const logger = createLogger('InvestmentTxForm');

const investmentTransactionSchema = z.object({
  accountId: z.string().min(1, 'Account is required'),
  action: z.enum(['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'SPLIT', 'TRANSFER_IN', 'TRANSFER_OUT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES']),
  transactionDate: z.string().min(1, 'Date is required'),
  securityId: z.string().optional(),
  fundingAccountId: z.string().optional(),
  quantity: z.coerce.number().min(0).optional(),
  price: z.coerce.number().min(0).optional(),
  commission: z.coerce.number().min(0).optional(),
  description: z.string().optional(),
});

type InvestmentTransactionFormData = z.infer<typeof investmentTransactionSchema>;

interface InvestmentTransactionFormProps {
  accounts: Account[];
  allAccounts?: Account[];  // All accounts for funding dropdown (if not provided, uses accounts)
  transaction?: InvestmentTransaction;
  defaultAccountId?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
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
  ADD_SHARES: 'Add Shares',
  REMOVE_SHARES: 'Remove Shares',
};

// Actions that require a security selection
const securityRequiredActions: InvestmentAction[] = ['BUY', 'SELL', 'DIVIDEND', 'CAPITAL_GAIN', 'SPLIT', 'REINVEST', 'ADD_SHARES', 'REMOVE_SHARES'];

// Actions that require quantity and price
const quantityPriceActions: InvestmentAction[] = ['BUY', 'SELL', 'REINVEST'];

// Actions that only need quantity (no price, no cash effect)
const quantityOnlyActions: InvestmentAction[] = ['ADD_SHARES', 'REMOVE_SHARES'];

// Actions that only need an amount (no quantity/price)
const amountOnlyActions: InvestmentAction[] = ['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'TRANSFER_IN', 'TRANSFER_OUT'];

// Actions that can have an external funding account (where funds come from/go to)
const fundingAccountActions: InvestmentAction[] = ['BUY', 'SELL'];

export function InvestmentTransactionForm({
  accounts,
  allAccounts,
  transaction,
  defaultAccountId,
  onSuccess,
  onCancel,
  onDirtyChange,
  submitRef,
}: InvestmentTransactionFormProps) {
  const { defaultCurrency } = useNumberFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [showNewSecurityForm, setShowNewSecurityForm] = useState(false);
  const [newSecurity, setNewSecurity] = useState<CreateSecurityData>({
    symbol: '',
    name: '',
    securityType: 'STOCK',
    currencyCode: defaultCurrency,
  });

  // Filter to only show brokerage accounts (sorted)
  const brokerageAccounts = useMemo(
    () => accounts
      .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE')
      .sort((a, b) => a.name.localeCompare(b.name)),
    [accounts]
  );

  // All accounts that can be used as funding source/destination (sorted)
  // Excludes investment cash accounts, cash accounts, and asset accounts
  const fundingAccounts = useMemo(
    () => [...(allAccounts || accounts)]
      .filter((a) =>
        a.accountSubType !== 'INVESTMENT_CASH' &&
        a.accountType !== 'CASH' &&
        a.accountType !== 'ASSET'
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
    [allAccounts, accounts]
  );

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<InvestmentTransactionFormData>({
    resolver: zodResolver(investmentTransactionSchema) as Resolver<InvestmentTransactionFormData>,
    defaultValues: transaction
      ? {
          accountId: transaction.accountId,
          action: transaction.action,
          transactionDate: transaction.transactionDate,
          securityId: transaction.securityId || transaction.security?.id || '',
          fundingAccountId: transaction.fundingAccountId || '',
          quantity: transaction.quantity ?? 0,
          // For amount-only actions, use totalAmount as the price field value
          price: amountOnlyActions.includes(transaction.action)
            ? (transaction.totalAmount ?? 0)
            : (transaction.price ?? 0),
          commission: transaction.commission ?? 0,
          description: transaction.description || '',
        }
      : {
          accountId: defaultAccountId || '',
          action: 'BUY',
          transactionDate: new Date().toISOString().split('T')[0],
          fundingAccountId: '',
          quantity: undefined,
          price: undefined,
          commission: undefined,
          description: '',
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const watchedAccountId = watch('accountId');
  const watchedAction = watch('action') as InvestmentAction;
  const watchedQuantity = Number(watch('quantity')) || 0;
  const watchedPrice = Number(watch('price')) || 0;
  const watchedCommission = Number(watch('commission')) || 0;

  // Derive currency from selected account
  const accountCurrency = useMemo(() => {
    if (watchedAccountId) {
      const account = accounts.find(a => a.id === watchedAccountId);
      if (account) return account.currencyCode;
    }
    return defaultCurrency;
  }, [watchedAccountId, accounts, defaultCurrency]);
  const currencySymbol = getCurrencySymbol(accountCurrency);

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
        logger.error('Failed to load securities:', error);
      }
    };
    loadSecurities();
  }, []);

  // Re-sync form values when editing and securities are loaded
  useEffect(() => {
    if (transaction && securities.length > 0) {
      const securityId = transaction.securityId || transaction.security?.id;
      if (securityId) {
        setValue('securityId', securityId);
      }
    }
  }, [transaction, securities, setValue]);

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
        currencyCode: defaultCurrency,
      });
      toast.success('Security created');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create security'));
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
        fundingAccountId: fundingAccountActions.includes(data.action as InvestmentAction) && data.fundingAccountId
          ? data.fundingAccountId
          : undefined,
        quantity: (quantityPriceActions.includes(data.action as InvestmentAction) || quantityOnlyActions.includes(data.action as InvestmentAction))
          ? data.quantity
          : undefined,
        price: quantityOnlyActions.includes(data.action as InvestmentAction)
          ? undefined
          : data.price,
        commission: quantityOnlyActions.includes(data.action as InvestmentAction)
          ? undefined
          : data.commission,
        description: data.description,
      };

      if (transaction) {
        await investmentsApi.updateTransaction(transaction.id, payload);
        toast.success('Transaction updated');
      } else {
        await investmentsApi.createTransaction(payload);
        toast.success('Transaction created');
      }
      onSuccess?.();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save transaction'));
    } finally {
      setIsLoading(false);
    }
  };

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const needsSecurity = securityRequiredActions.includes(watchedAction);
  const needsQuantityPrice = quantityPriceActions.includes(watchedAction);
  const isQuantityOnly = quantityOnlyActions.includes(watchedAction);
  const isAmountOnly = amountOnlyActions.includes(watchedAction);
  const canHaveFundingAccount = fundingAccountActions.includes(watchedAction);

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

      {/* Funding Account - for Buy/Sell to specify where funds come from/go to */}
      {canHaveFundingAccount && (
        <Select
          label={watchedAction === 'BUY' ? 'Funds From (optional)' : 'Funds To (optional)'}
          options={[
            { value: '', label: 'Default cash account' },
            ...fundingAccounts.map((a) => ({
              value: a.id,
              label: a.name,
            })),
          ]}
          {...register('fundingAccountId')}
        />
      )}

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
          <NumericInput
            label="Quantity (Shares)"
            value={watchedQuantity || undefined}
            onChange={(value) => setValue('quantity', value, { shouldValidate: true })}
            decimalPlaces={8}
            min={0}
            error={errors.quantity?.message}
          />
          <NumericInput
            label="Price per Share"
            prefix={currencySymbol}
            value={watchedPrice || undefined}
            onChange={(value) => setValue('price', value, { shouldValidate: true })}
            decimalPlaces={5}
            min={0}
            error={errors.price?.message}
          />
        </div>
      )}

      {/* Quantity only - for add/remove shares (no price, no cost basis impact) */}
      {isQuantityOnly && (
        <NumericInput
          label="Quantity (Shares)"
          value={watchedQuantity || undefined}
          onChange={(value) => setValue('quantity', value, { shouldValidate: true })}
          decimalPlaces={8}
          min={0}
          error={errors.quantity?.message}
        />
      )}

      {/* Amount - for dividend/interest/capital gain/transfers */}
      {isAmountOnly && (
        <CurrencyInput
          label="Amount"
          prefix={currencySymbol}
          value={watchedPrice || undefined}
          onChange={(value) => setValue('price', value, { shouldValidate: true })}
          error={errors.price?.message}
          allowNegative={false}
        />
      )}

      {/* Commission */}
      {(needsQuantityPrice || watchedAction === 'SPLIT') && (
        <CurrencyInput
          label="Commission / Fees"
          prefix={currencySymbol}
          value={watchedCommission || undefined}
          onChange={(value) => setValue('commission', value, { shouldValidate: true })}
          error={errors.commission?.message}
          allowNegative={false}
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
              {currencySymbol}{totalAmount.toFixed(2)}
            </span>
          </div>
          {needsQuantityPrice && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {watchedQuantity} shares @ {currencySymbol}{watchedPrice.toFixed(5)}
              {watchedCommission > 0 && ` ${watchedAction === 'SELL' ? '-' : '+'} ${currencySymbol}${watchedCommission.toFixed(2)} commission`}
            </div>
          )}
        </div>
      )}

      {/* Form Actions */}
      <FormActions onCancel={onCancel} submitLabel={transaction ? 'Update Transaction' : 'Create Transaction'} isSubmitting={isLoading} />
    </form>
  );
}
