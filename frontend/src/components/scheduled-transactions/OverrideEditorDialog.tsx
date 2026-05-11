'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Combobox } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import { SplitEditor, SplitRow, createEmptySplits, toSplitRows } from '@/components/transactions/SplitEditor';
import { toOverrideSplits } from './splitSerialization';
import { ScheduledTransaction, ScheduledTransactionOverride } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { investmentsApi } from '@/lib/investments';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { roundToCents, getCurrencySymbol } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('OverrideEditorDialog');
interface OverrideEditorDialogProps {
  isOpen: boolean;
  scheduledTransaction: ScheduledTransaction;
  overrideDate: string;
  categories: Category[];
  accounts: Account[];
  existingOverride?: ScheduledTransactionOverride | null;
  onClose: () => void;
  onSave: () => void;
}

export function OverrideEditorDialog({
  isOpen,
  scheduledTransaction,
  overrideDate,
  categories,
  accounts,
  existingOverride,
  onClose,
  onSave,
}: OverrideEditorDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>(overrideDate);
  const [amount, setAmount] = useState<number>(0);
  const [categoryId, setCategoryId] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isSplit, setIsSplit] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);

  // Investment-mode per-occurrence overrides.
  const [investmentQuantity, setInvestmentQuantity] = useState<number | ''>('');
  const [investmentPrice, setInvestmentPrice] = useState<number | ''>('');
  const [investmentTotalAmount, setInvestmentTotalAmount] = useState<number | ''>('');
  // UI-only computed total for qty+price actions; not persisted directly
  // (the backend derives total from qty * price + commission).
  const [investmentTotalValue, setInvestmentTotalValue] = useState<number | ''>('');
  const [marketPrice, setMarketPrice] = useState<number | null>(null);

  const isInvestmentKind = scheduledTransaction.isInvestment;
  const investmentAction = scheduledTransaction.investmentAction;
  const isInvestmentQuantityPrice =
    isInvestmentKind &&
    (investmentAction === 'BUY' ||
      investmentAction === 'SELL' ||
      investmentAction === 'REINVEST');
  const isInvestmentQuantityOnly =
    isInvestmentKind &&
    (investmentAction === 'ADD_SHARES' ||
      investmentAction === 'REMOVE_SHARES' ||
      investmentAction === 'SPLIT');
  const isInvestmentAmountOnly =
    isInvestmentKind &&
    (investmentAction === 'DIVIDEND' ||
      investmentAction === 'INTEREST' ||
      investmentAction === 'CAPITAL_GAIN');

  // Initialize form with base transaction or existing override values
  useEffect(() => {
    if (isOpen) {
      if (existingOverride) {
        // Use the existing override's date (which may differ from the original calculated date)
        setSelectedDate(existingOverride.overrideDate);
      } else {
        // For new overrides, use the original calculated date
        setSelectedDate(overrideDate);
      }

      if (existingOverride) {
        // Use override values (absolute value for transfers - sign is applied on save)
        const rawAmt = roundToCents(existingOverride.amount ?? scheduledTransaction.amount);
        const amt = scheduledTransaction.isTransfer ? Math.abs(rawAmt) : rawAmt;
        setAmount(amt);
        setCategoryId(existingOverride.categoryId ?? scheduledTransaction.categoryId ?? '');
        setDescription(existingOverride.description ?? scheduledTransaction.description ?? '');
        setIsSplit(existingOverride.isSplit ?? scheduledTransaction.isSplit);
        if (existingOverride.isSplit && existingOverride.splits) {
          setSplits(toSplitRows(existingOverride.splits.map((s, i) => ({
            id: `override-${i}`,
            ...s,
          }))));
        } else if (scheduledTransaction.isSplit && scheduledTransaction.splits) {
          setSplits(toSplitRows(scheduledTransaction.splits));
        } else {
          setSplits(createEmptySplits(amt));
        }
      } else {
        // Use base transaction values (absolute value for transfers - sign is applied on save)
        const rawAmt = roundToCents(scheduledTransaction.amount);
        const amt = scheduledTransaction.isTransfer ? Math.abs(rawAmt) : rawAmt;
        setAmount(amt);
        setCategoryId(scheduledTransaction.categoryId ?? '');
        setDescription(scheduledTransaction.description ?? '');
        setIsSplit(scheduledTransaction.isSplit);
        if (scheduledTransaction.isSplit && scheduledTransaction.splits) {
          setSplits(toSplitRows(scheduledTransaction.splits));
        } else {
          setSplits(createEmptySplits(amt));
        }
      }

      // Investment-mode prefill: existing override values fall back to the
      // base scheduled transaction's saved values.
      const initialQty =
        existingOverride?.investmentQuantity != null
          ? Number(existingOverride.investmentQuantity)
          : scheduledTransaction.investmentQuantity != null
            ? Number(scheduledTransaction.investmentQuantity)
            : '';
      const initialPrice =
        existingOverride?.investmentPrice != null
          ? Number(existingOverride.investmentPrice)
          : scheduledTransaction.investmentPrice != null
            ? Number(scheduledTransaction.investmentPrice)
            : '';
      const initialTotalAmount =
        existingOverride?.investmentTotalAmount != null
          ? Number(existingOverride.investmentTotalAmount)
          : scheduledTransaction.investmentTotalAmount != null
            ? Number(scheduledTransaction.investmentTotalAmount)
            : '';
      setInvestmentQuantity(initialQty);
      setInvestmentPrice(initialPrice);
      setInvestmentTotalAmount(initialTotalAmount);
      if (
        typeof initialQty === 'number' &&
        initialQty > 0 &&
        typeof initialPrice === 'number' &&
        initialPrice > 0
      ) {
        const commission = Number(scheduledTransaction.investmentCommission ?? 0);
        const sign = scheduledTransaction.investmentAction === 'SELL' ? -1 : 1;
        const total = initialQty * initialPrice + sign * commission;
        setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
      } else {
        setInvestmentTotalValue('');
      }
      setMarketPrice(null);
    }
  }, [isOpen, existingOverride, scheduledTransaction, overrideDate]);

  // Fetch the most recent close price for the security so we can auto-fill
  // the Price field (matching the new-scheduled-transaction form behaviour).
  useEffect(() => {
    if (!isOpen || !isInvestmentKind || !isInvestmentQuantityPrice) return;
    const securityId = scheduledTransaction.investmentSecurityId;
    if (!securityId) return;
    let cancelled = false;
    investmentsApi
      .getSecurityPrices(securityId, 1)
      .then((prices) => {
        if (cancelled) return;
        const latest = prices[0];
        setMarketPrice(latest ? Number(latest.closePrice) : null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMarketPrice(null);
        logger.warn?.('Failed to fetch latest price', err);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    isInvestmentKind,
    isInvestmentQuantityPrice,
    scheduledTransaction.investmentSecurityId,
  ]);

  // When the market price arrives, overwrite the Price with the latest value
  // and recompute the total from the existing quantity. Uses the "info from
  // previous render" pattern to avoid violating react-hooks/set-state-in-effect.
  const [lastSeenMarketPrice, setLastSeenMarketPrice] = useState<number | null>(null);
  if (isOpen && marketPrice !== lastSeenMarketPrice) {
    setLastSeenMarketPrice(marketPrice);
    if (isInvestmentQuantityPrice && marketPrice != null && marketPrice > 0) {
      const rounded = Math.round(marketPrice * 1_000_000) / 1_000_000;
      setInvestmentPrice(rounded);
      if (investmentQuantity !== '' && Number(investmentQuantity) > 0) {
        const commission = Number(scheduledTransaction.investmentCommission ?? 0);
        const sign = scheduledTransaction.investmentAction === 'SELL' ? -1 : 1;
        const total = Number(investmentQuantity) * rounded + sign * commission;
        setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
      }
    }
  }

  const investmentSign = scheduledTransaction.investmentAction === 'SELL' ? -1 : 1;
  const investmentCommission = Number(scheduledTransaction.investmentCommission ?? 0);

  const handleInvestmentQuantityChange = (raw: string) => {
    const qty = raw === '' ? '' : Number(raw);
    setInvestmentQuantity(qty);
    if (qty !== '' && investmentPrice !== '' && Number(investmentPrice) > 0) {
      const total = Number(qty) * Number(investmentPrice) + investmentSign * investmentCommission;
      setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
    }
  };

  const handleInvestmentPriceChange = (raw: string) => {
    const price = raw === '' ? '' : Number(raw);
    setInvestmentPrice(price);
    if (price !== '' && Number(price) > 0) {
      if (investmentTotalValue !== '') {
        const cost = Number(investmentTotalValue) - investmentSign * investmentCommission;
        const qty = Math.max(0, cost / Number(price));
        setInvestmentQuantity(Math.round(qty * 100_000_000) / 100_000_000);
      } else if (investmentQuantity !== '') {
        const total = Number(investmentQuantity) * Number(price) + investmentSign * investmentCommission;
        setInvestmentTotalValue(Math.round(total * 10_000) / 10_000);
      }
    }
  };

  const handleInvestmentTotalValueChange = (raw: number | undefined) => {
    if (raw === undefined) {
      setInvestmentTotalValue('');
      return;
    }
    setInvestmentTotalValue(raw);
    if (investmentPrice !== '' && Number(investmentPrice) > 0) {
      const cost = raw - investmentSign * investmentCommission;
      const qty = Math.max(0, cost / Number(investmentPrice));
      setInvestmentQuantity(Math.round(qty * 100_000_000) / 100_000_000);
    }
  };

  const categoryOptions = useMemo(() => {
    return buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    });
  }, [categories]);

  const handleSave = async () => {
    if (isInvestmentKind) {
      if (isInvestmentQuantityPrice || isInvestmentQuantityOnly) {
        if (investmentQuantity === '' || Number(investmentQuantity) <= 0) {
          toast.error('Quantity must be greater than zero');
          return;
        }
      }
      if (isInvestmentQuantityPrice) {
        if (investmentPrice === '' || Number(investmentPrice) <= 0) {
          toast.error('Price must be greater than zero');
          return;
        }
      }
      if (isInvestmentAmountOnly) {
        if (investmentTotalAmount === '') {
          toast.error('Total amount is required');
          return;
        }
      }
    }

    setIsLoading(true);
    try {
      // For transfers, negate the amount (user enters positive, stored as negative)
      const savedAmount = scheduledTransaction.isTransfer ? -Math.abs(amount) : amount;
      const baseData = isInvestmentKind
        ? {
            description: description || null,
            investmentQuantity:
              investmentQuantity === '' ? null : Number(investmentQuantity),
            investmentPrice:
              investmentPrice === '' ? null : Number(investmentPrice),
            investmentTotalAmount:
              investmentTotalAmount === '' ? null : Number(investmentTotalAmount),
          }
        : {
            amount: savedAmount,
            categoryId: isSplit ? null : (categoryId || null),
            description: description || null,
            isSplit,
            splits: isSplit ? toOverrideSplits(splits) : null,
          };

      // originalDate = the calculated occurrence date from the picker (overrideDate prop)
      // selectedDate = the actual date the user wants this occurrence to be (may differ)
      const dateChanged = existingOverride && selectedDate !== existingOverride.overrideDate;

      if (existingOverride && !dateChanged) {
        // Update existing override (date unchanged)
        await scheduledTransactionsApi.updateOverride(
          scheduledTransaction.id,
          existingOverride.id,
          baseData,
        );
        toast.success('Override updated');
      } else if (existingOverride && dateChanged) {
        // Date changed - delete old override and create new one with same originalDate
        await scheduledTransactionsApi.deleteOverride(scheduledTransaction.id, existingOverride.id);
        await scheduledTransactionsApi.createOverride(scheduledTransaction.id, {
          ...baseData,
          originalDate: existingOverride.originalDate,
          overrideDate: selectedDate,
        });
        toast.success('Override moved to new date');
      } else {
        // Create new override
        await scheduledTransactionsApi.createOverride(scheduledTransaction.id, {
          ...baseData,
          originalDate: overrideDate, // The date from the picker is the original calculated date
          overrideDate: selectedDate, // The selected date (may be same or different)
        });
        toast.success('Override created');
      }
      onSave();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save override'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!existingOverride) return;

    setIsLoading(true);
    try {
      await scheduledTransactionsApi.deleteOverride(scheduledTransaction.id, existingOverride.id);
      toast.success('Override deleted - will use base values');
      onSave();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete override'));
    } finally {
      setIsLoading(false);
    }
  };

  // Handler for SplitEditor to update amount
  const handleAmountChange = (newAmount: number) => {
    setAmount(roundToCents(newAmount));
  };

  const currentCategory = categoryId ? categories.find(c => c.id === categoryId) : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="5xl" className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          Edit Occurrence
        </h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {isInvestmentKind ? (
          <>
            Modifying {investmentAction || 'investment'}{' '}
            {scheduledTransaction.investmentSecurity && (
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {scheduledTransaction.investmentSecurity.symbol ||
                  scheduledTransaction.investmentSecurity.name}
              </span>
            )}{' '}
            on {scheduledTransaction.account?.name} for this occurrence only.
          </>
        ) : (
          <>Modifying &quot;{scheduledTransaction.name}&quot; for this occurrence only.</>
        )}
        {existingOverride && (
          <span className="ml-1 text-blue-600 dark:text-blue-400">(Override exists)</span>
        )}
      </div>

      <div className="space-y-4">
        {/* Date */}
        <DateInput
          label="Occurrence Date"
          value={selectedDate}
          onDateChange={(date) => setSelectedDate(date)}
        />

        {/* Investment-kind: quantity / price / total */}
        {isInvestmentKind && (
          <>
            {(isInvestmentQuantityPrice || isInvestmentQuantityOnly) && (
              <Input
                label="Quantity (shares)"
                type="number"
                step="0.00000001"
                min={0}
                value={investmentQuantity}
                onChange={(e) =>
                  isInvestmentQuantityPrice
                    ? handleInvestmentQuantityChange(e.target.value)
                    : setInvestmentQuantity(
                        e.target.value === '' ? '' : Number(e.target.value),
                      )
                }
              />
            )}
            {isInvestmentQuantityPrice && (
              <>
                <Input
                  label="Price per share"
                  type="number"
                  step="0.000001"
                  min={0}
                  placeholder={
                    marketPrice != null ? `Latest: ${marketPrice}` : undefined
                  }
                  value={investmentPrice}
                  onChange={(e) => handleInvestmentPriceChange(e.target.value)}
                />
                <CurrencyInput
                  label="Total Price"
                  prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                  value={
                    typeof investmentTotalValue === 'number'
                      ? investmentTotalValue
                      : undefined
                  }
                  onChange={handleInvestmentTotalValueChange}
                />
                {scheduledTransaction.investmentSecurityId && marketPrice == null && (
                  <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">
                    No price history yet for this security. Enter the price manually.
                  </p>
                )}
              </>
            )}
            {isInvestmentAmountOnly && (
              <CurrencyInput
                label="Total Amount"
                prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
                value={
                  typeof investmentTotalAmount === 'number'
                    ? investmentTotalAmount
                    : undefined
                }
                onChange={(value) => setInvestmentTotalAmount(value ?? '')}
              />
            )}
          </>
        )}

        {/* Amount — non-investment only */}
        {!isInvestmentKind && (
          <CurrencyInput
            label="Amount"
            prefix={getCurrencySymbol(scheduledTransaction.currencyCode)}
            value={amount}
            onChange={(value) => setAmount(value ?? 0)}
          />
        )}

        {/* Transfer indicator - shown instead of category for transfers */}
        {!isInvestmentKind && (
        scheduledTransaction.isTransfer ? (
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg p-4">
            <div className="flex items-center">
              <svg className="h-5 w-5 text-blue-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                Transfer: {scheduledTransaction.account?.name} → {scheduledTransaction.transferAccount?.name}
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* Split toggle */}
            <div className="flex items-center">
              <input
                type="checkbox"
                id="isSplit"
                checked={isSplit}
                onChange={(e) => {
                  setIsSplit(e.target.checked);
                  if (e.target.checked && splits.length < 2) {
                    setSplits(createEmptySplits(amount));
                  }
                }}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="isSplit" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                Split this occurrence
              </label>
            </div>

            {/* Category or Splits */}
            {isSplit ? (
              <SplitEditor
                splits={splits}
                onChange={setSplits}
                categories={categories}
                accounts={accounts}
                sourceAccountId={scheduledTransaction.accountId}
                parentAccountSubType={
                  accounts.find((a) => a.id === scheduledTransaction.accountId)
                    ?.accountSubType ?? null
                }
                transactionAmount={amount}
                onTransactionAmountChange={handleAmountChange}
                currencyCode={scheduledTransaction.currencyCode}
              />
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Category
                </label>
                <Combobox
                  placeholder="Select category..."
                  options={categoryOptions}
                  value={categoryId}
                  initialDisplayValue={currentCategory?.name || ''}
                  onChange={(value) => setCategoryId(value || '')}
                />
              </div>
            )}
          </>
        )
        )}

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Description (optional)
          </label>
          <Input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Override description..."
          />
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 flex justify-between">
        <div>
          {existingOverride && (
            <Button
              variant="outline"
              onClick={handleDelete}
              isLoading={isLoading}
              className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/50"
            >
              Reset to Default
            </Button>
          )}
        </div>
        <div className="flex space-x-3">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={isLoading}>
            {existingOverride ? 'Update Override' : 'Save Override'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
