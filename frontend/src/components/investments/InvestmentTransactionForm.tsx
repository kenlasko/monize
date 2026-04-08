'use client';

import { useState, useEffect, useMemo, MutableRefObject } from 'react';
import { useForm, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { SecurityForm } from '@/components/securities/SecurityForm';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import { Account } from '@/types/account';
import {
  InvestmentAction,
  InvestmentTransaction,
  Security,
  CreateSecurityData,
} from '@/types/investment';
import { getCurrencySymbol, roundToDecimals } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
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
  exchangeRate: z.coerce.number().gt(0).optional(),
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

// Actions that post a cash transaction against the cash/funding account.
// Only these need exchange rate handling when security and cash currencies differ.
const cashPostingActions: InvestmentAction[] = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'CAPITAL_GAIN',
];

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
  const { defaultCurrency, formatCurrency } = useNumberFormat();
  const [isLoading, setIsLoading] = useState(false);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [showSecurityModal, setShowSecurityModal] = useState(false);

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
          exchangeRate: transaction.exchangeRate ?? 1,
          description: transaction.description || '',
        }
      : {
          accountId: defaultAccountId || '',
          action: 'BUY',
          transactionDate: getLocalDateString(),
          fundingAccountId: '',
          quantity: undefined,
          price: undefined,
          commission: undefined,
          exchangeRate: undefined,
          description: '',
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const watchedAccountId = watch('accountId');
  const watchedAction = watch('action') as InvestmentAction;
  const watchedSecurityId = watch('securityId');
  const watchedFundingAccountId = watch('fundingAccountId');
  const watchedQuantity = Number(watch('quantity')) || 0;
  const watchedPrice = Number(watch('price')) || 0;
  const watchedCommission = Number(watch('commission')) || 0;
  const watchedExchangeRate = Number(watch('exchangeRate')) || 0;

  const allAccountsSource = allAccounts || accounts;
  const { getRate: getMarketRate } = useExchangeRates();

  // Derive currency from selected account
  const accountCurrency = useMemo(() => {
    if (watchedAccountId) {
      const account = accounts.find(a => a.id === watchedAccountId);
      if (account) return account.currencyCode;
    }
    return defaultCurrency;
  }, [watchedAccountId, accounts, defaultCurrency]);

  // Resolve the cash account that will actually receive/provide the funds.
  // For BUY/SELL with a funding account override, that's the chosen account;
  // otherwise it's the brokerage's linked investment cash account.
  const cashAccount = useMemo(() => {
    if (
      fundingAccountActions.includes(watchedAction) &&
      watchedFundingAccountId
    ) {
      return allAccountsSource.find((a) => a.id === watchedFundingAccountId) ?? null;
    }
    if (watchedAccountId) {
      const brokerage = allAccountsSource.find((a) => a.id === watchedAccountId);
      if (brokerage?.linkedAccountId) {
        return (
          allAccountsSource.find((a) => a.id === brokerage.linkedAccountId) ?? null
        );
      }
      return brokerage ?? null;
    }
    return null;
  }, [watchedAccountId, watchedFundingAccountId, watchedAction, allAccountsSource]);

  const cashCurrency = cashAccount?.currencyCode ?? accountCurrency;

  // Use security currency when a security is selected, otherwise fall back to account currency
  const transactionCurrency = useMemo(() => {
    if (watchedSecurityId) {
      const security = securities.find(s => s.id === watchedSecurityId);
      if (security) return security.currencyCode;
    }
    return accountCurrency;
  }, [watchedSecurityId, securities, accountCurrency]);
  const currencySymbol = getCurrencySymbol(transactionCurrency);
  const cashCurrencySymbol = getCurrencySymbol(cashCurrency);

  const needsConversion =
    cashPostingActions.includes(watchedAction) &&
    !!transactionCurrency &&
    !!cashCurrency &&
    transactionCurrency !== cashCurrency;

  // Calculate total amount
  const totalAmount = useMemo(() => {
    if (quantityPriceActions.includes(watchedAction)) {
      const subtotal = roundToDecimals(watchedQuantity * watchedPrice, 4);
      if (watchedAction === 'BUY' || watchedAction === 'REINVEST') {
        return roundToDecimals(subtotal + watchedCommission, 4);
      } else {
        return roundToDecimals(subtotal - watchedCommission, 4);
      }
    }
    return watchedPrice; // For amount-only actions, price is used as the amount
  }, [watchedAction, watchedQuantity, watchedPrice, watchedCommission]);

  // Auto-fill the exchange rate with the latest market rate whenever the
  // currency pair changes, unless the user is editing an existing transaction
  // (in which case we keep the stored rate) or has manually edited the field.
  useEffect(() => {
    if (!needsConversion) {
      // When no conversion is needed, keep the rate at 1 implicitly so the
      // backend falls back cleanly.
      if (watchedExchangeRate !== 1) {
        setValue('exchangeRate', 1, { shouldDirty: false });
      }
      return;
    }
    // If form already has a non-default rate (either from editing or user
    // input), don't clobber it.
    if (watchedExchangeRate && watchedExchangeRate !== 1) {
      return;
    }
    const marketRate = getMarketRate(transactionCurrency, cashCurrency);
    if (marketRate && marketRate !== 1) {
      setValue('exchangeRate', roundToDecimals(marketRate, 6), {
        shouldDirty: false,
      });
    }
  }, [
    needsConversion,
    transactionCurrency,
    cashCurrency,
    getMarketRate,
    setValue,
    watchedExchangeRate,
  ]);

  const convertedAmount = useMemo(() => {
    if (!needsConversion) return totalAmount;
    const rate = watchedExchangeRate || 1;
    return roundToDecimals(totalAmount * rate, 4);
  }, [needsConversion, totalAmount, watchedExchangeRate]);

  const handleConvertedAmountChange = (value: number | undefined) => {
    if (!needsConversion || totalAmount === 0) return;
    if (value === undefined || value === null) return;
    const newRate = roundToDecimals(value / totalAmount, 10);
    setValue('exchangeRate', newRate, { shouldDirty: true, shouldValidate: true });
  };

  // Load securities — ensure the transaction's security is included even if inactive
  useEffect(() => {
    const loadSecurities = async () => {
      try {
        const data = await investmentsApi.getSecurities();
        if (transaction?.security && !data.some((s) => s.id === transaction.security!.id)) {
          data.push(transaction.security);
        }
        setSecurities(data);
      } catch (error) {
        logger.error('Failed to load securities:', error);
      }
    };
    loadSecurities();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-sync form values when editing and securities are loaded
  useEffect(() => {
    if (transaction && securities.length > 0) {
      const securityId = transaction.securityId || transaction.security?.id;
      if (securityId) {
        setValue('securityId', securityId);
      }
    }
  }, [transaction, securities, setValue]);

  const handleSecurityCreated = async (data: CreateSecurityData) => {
    try {
      const created = await investmentsApi.createSecurity(data);
      setSecurities((prev) => [...prev, created]);
      setValue('securityId', created.id);
      setShowSecurityModal(false);
      toast.success('Security created');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create security'));
      throw error;
    }
  };

  const onSubmit = async (data: InvestmentTransactionFormData) => {
    setIsLoading(true);
    try {
      const action = data.action as InvestmentAction;
      const postsCash = cashPostingActions.includes(action);
      const payload = {
        accountId: data.accountId,
        action,
        transactionDate: data.transactionDate,
        securityId: securityRequiredActions.includes(action)
          ? data.securityId
          : undefined,
        fundingAccountId: fundingAccountActions.includes(action) && data.fundingAccountId
          ? data.fundingAccountId
          : undefined,
        quantity: (quantityPriceActions.includes(action) || quantityOnlyActions.includes(action))
          ? data.quantity
          : undefined,
        price: quantityOnlyActions.includes(action)
          ? undefined
          : data.price,
        commission: quantityOnlyActions.includes(action)
          ? undefined
          : data.commission,
        // Only send the exchange rate for actions that post a cash transaction.
        exchangeRate:
          postsCash && data.exchangeRate && data.exchangeRate > 0
            ? data.exchangeRate
            : undefined,
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
    <>
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Account Selection */}
      <Select
        label="Brokerage Account"
        error={errors.accountId?.message}
        options={[
          { value: '', label: 'Select account...' },
          ...brokerageAccounts.map((a) => ({
            value: a.id,
            label: `${a.name} (${a.currencyCode})`,
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
      <DateInput
        label="Date"
        error={errors.transactionDate?.message}
        onDateChange={(date) => setValue('transactionDate', date, { shouldDirty: true, shouldValidate: true })}
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
                label: `${s.symbol} - ${s.name} (${s.currencyCode})`,
              })),
            ]}
            {...register('securityId')}
          />
          <button
            type="button"
            onClick={() => setShowSecurityModal(true)}
            className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            + Add new security
          </button>
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
            label={`Price per Share (${transactionCurrency})`}
            prefix={currencySymbol}
            value={watchedPrice || undefined}
            onChange={(value) => setValue('price', value, { shouldValidate: true })}
            decimalPlaces={6}
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
          label={`Amount (${transactionCurrency})`}
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
          label={`Commission / Fees (${transactionCurrency})`}
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

      {/* Currency Conversion - when security currency differs from cash account currency */}
      {needsConversion && (needsQuantityPrice || isAmountOnly) && (
        <div className="space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Currency conversion ({transactionCurrency} &rarr; {cashCurrency})
          </div>
          <div className="grid grid-cols-2 gap-4">
            <NumericInput
              label={`Exchange rate (1 ${transactionCurrency} =)`}
              suffix={cashCurrency}
              value={watchedExchangeRate || undefined}
              onChange={(value) =>
                setValue('exchangeRate', value ?? 0, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
              decimalPlaces={6}
              min={0}
              error={errors.exchangeRate?.message}
            />
            <NumericInput
              label={`Converted total (${cashCurrency})`}
              prefix={cashCurrencySymbol}
              value={convertedAmount || undefined}
              onChange={handleConvertedAmountChange}
              decimalPlaces={4}
              min={0}
            />
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Adjust the rate or the converted total to match the amount actually posted to your cash account.
          </div>
        </div>
      )}

      {/* Total Amount Display */}
      {(needsQuantityPrice || isAmountOnly) && (
        <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Total Amount ({transactionCurrency})
            </span>
            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {formatCurrency(totalAmount, transactionCurrency)}
            </span>
          </div>
          {needsQuantityPrice && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {watchedQuantity} shares @ {currencySymbol}{watchedPrice.toFixed(6)}
              {watchedCommission > 0 && ` ${watchedAction === 'SELL' ? '-' : '+'} ${formatCurrency(watchedCommission, transactionCurrency)} commission`}
            </div>
          )}
          {needsConversion && (
            <div className="mt-2 flex justify-between items-center border-t border-gray-200 pt-2 dark:border-gray-600">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Posts to cash account ({cashCurrency})
              </span>
              <span className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(convertedAmount, cashCurrency)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Form Actions */}
      <FormActions onCancel={onCancel} submitLabel={transaction ? 'Update Transaction' : 'Create Transaction'} isSubmitting={isLoading} />
    </form>

    <Modal isOpen={showSecurityModal} onClose={() => setShowSecurityModal(false)} maxWidth="lg" className="p-6">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
        New Security
      </h2>
      <SecurityForm
        onSubmit={handleSecurityCreated}
        onCancel={() => setShowSecurityModal(false)}
      />
    </Modal>
    </>
  );
}
