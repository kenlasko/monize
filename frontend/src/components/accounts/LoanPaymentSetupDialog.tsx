'use client';

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Combobox } from '@/components/ui/Combobox';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Account, DetectedLoanPayment, SetupLoanPaymentsData } from '@/types/account';
import { Category } from '@/types/category';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { getCategorySelectOptions } from '@/lib/categoryUtils';
import { createLogger } from '@/lib/logger';
import toast from 'react-hot-toast';

const logger = createLogger('LoanPaymentSetupDialog');

const paymentFrequencyOptions = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Every 2 Weeks' },
  { value: 'SEMIMONTHLY', label: 'Semi-Monthly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'YEARLY', label: 'Yearly' },
];

interface LoanPaymentSetupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  loanAccount: { accountId: string; accountName: string; accountType: string };
  accounts: Account[];
  onSetupComplete?: () => void;
}

export function LoanPaymentSetupDialog({
  isOpen,
  onClose,
  loanAccount,
  accounts,
  onSetupComplete,
}: LoanPaymentSetupDialogProps) {
  const [isDetecting, setIsDetecting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [detected, setDetected] = useState<DetectedLoanPayment | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  // Form state
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const [paymentFrequency, setPaymentFrequency] = useState('MONTHLY');
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [nextDueDate, setNextDueDate] = useState('');
  const [interestRate, setInterestRate] = useState<number | undefined>(undefined);
  const [interestCategoryId, setInterestCategoryId] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [autoPost, setAutoPost] = useState(false);

  // Mortgage-specific
  const isMortgage = loanAccount.accountType === 'MORTGAGE';
  const [isCanadianMortgage, setIsCanadianMortgage] = useState(false);
  const [isVariableRate, setIsVariableRate] = useState(false);
  const [amortizationMonths, setAmortizationMonths] = useState<number | undefined>(undefined);
  const [termMonths, setTermMonths] = useState<number | undefined>(undefined);

  const sourceAccountOptions = accounts
    .filter(
      (a) =>
        a.id !== loanAccount.accountId &&
        !a.isClosed &&
        ['CHEQUING', 'SAVINGS', 'CASH'].includes(a.accountType),
    )
    .map((a) => ({ value: a.id, label: a.name }));

  const categoryOptions = getCategorySelectOptions(categories);

  // Detect payment pattern on open
  useEffect(() => {
    if (!isOpen) return;

    const detect = async () => {
      setIsDetecting(true);
      try {
        const [result, cats] = await Promise.all([
          accountsApi.detectLoanPayments(loanAccount.accountId),
          categoriesApi.getAll(),
        ]);
        setCategories(cats);

        if (result) {
          setDetected(result);
          setPaymentAmount(result.paymentAmount);
          setPaymentFrequency(result.paymentFrequency);
          setSourceAccountId(result.sourceAccountId || '');
          setNextDueDate(result.suggestedNextDueDate);
          setInterestRate(result.estimatedInterestRate ?? undefined);
          setInterestCategoryId(result.interestCategoryId || '');
        } else {
          setDetected(null);
          // Set defaults
          setPaymentAmount(0);
          setPaymentFrequency('MONTHLY');
          setNextDueDate('');
          setInterestRate(undefined);
          setInterestCategoryId('');
          setSourceAccountId(sourceAccountOptions[0]?.value || '');
        }
      } catch (error) {
        logger.error('Failed to detect payment pattern:', error);
        setDetected(null);
      } finally {
        setIsDetecting(false);
      }
    };

    detect();
  }, [isOpen, loanAccount.accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(async () => {
    if (!paymentAmount || !sourceAccountId || !nextDueDate) {
      toast.error('Please fill in all required fields');
      return;
    }

    setIsSubmitting(true);
    try {
      const data: SetupLoanPaymentsData = {
        paymentAmount,
        paymentFrequency,
        sourceAccountId,
        nextDueDate,
        interestRate,
        interestCategoryId: interestCategoryId || undefined,
        payeeName: payeeName || undefined,
        autoPost,
      };

      if (isMortgage) {
        data.isCanadianMortgage = isCanadianMortgage;
        data.isVariableRate = isVariableRate;
        data.amortizationMonths = amortizationMonths;
        data.termMonths = termMonths;
      }

      await accountsApi.setupLoanPayments(loanAccount.accountId, data);
      toast.success(`Scheduled payments set up for ${loanAccount.accountName}`);
      onSetupComplete?.();
      onClose();
    } catch (error: any) {
      const message = error?.response?.data?.message || 'Failed to set up payments';
      toast.error(message);
      logger.error('Failed to set up loan payments:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    paymentAmount, paymentFrequency, sourceAccountId, nextDueDate,
    interestRate, interestCategoryId, payeeName, autoPost,
    isMortgage, isCanadianMortgage, isVariableRate, amortizationMonths, termMonths,
    loanAccount, onSetupComplete, onClose,
  ]);

  const confidenceLabel = detected
    ? detected.confidence >= 0.7
      ? 'High'
      : detected.confidence >= 0.4
        ? 'Medium'
        : 'Low'
    : null;

  const accountLabel = isMortgage ? 'Mortgage' : 'Loan';

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="lg" allowOverflow>
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          Set Up {accountLabel} Payments
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {loanAccount.accountName}
        </p>

        {isDetecting ? (
          <div className="flex flex-col items-center py-8">
            <LoadingSpinner />
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              Analyzing transaction history...
            </p>
          </div>
        ) : (
          <>
            {detected && detected.paymentCount > 0 && (
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 mb-4">
                <p className="text-sm text-blue-800 dark:text-blue-300">
                  Detected {detected.paymentCount} payments from{' '}
                  {detected.firstPaymentDate} to {detected.lastPaymentDate}.
                  {confidenceLabel && (
                    <span className="ml-1">
                      Confidence: <strong>{confidenceLabel}</strong>
                    </span>
                  )}
                </p>
                <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                  Review and adjust the values below before saving.
                </p>
              </div>
            )}

            <div className="space-y-4">
              {/* Payment Amount */}
              <div>
                <CurrencyInput
                  label="Payment Amount *"
                  value={paymentAmount || undefined}
                  onChange={(val) => setPaymentAmount(val ?? 0)}
                  prefix="$"
                />
              </div>

              {/* Payment Frequency */}
              <div>
                <Select
                  label="Payment Frequency *"
                  value={paymentFrequency}
                  onChange={(e) => setPaymentFrequency(e.target.value)}
                  options={paymentFrequencyOptions}
                />
              </div>

              {/* Source Account */}
              <div>
                <Select
                  label="Payment From Account *"
                  value={sourceAccountId}
                  onChange={(e) => setSourceAccountId(e.target.value)}
                  options={[
                    { value: '', label: 'Select account...' },
                    ...sourceAccountOptions,
                  ]}
                />
              </div>

              {/* Next Due Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Next Payment Date *
                </label>
                <Input
                  type="date"
                  value={nextDueDate}
                  onChange={(e) => setNextDueDate(e.target.value)}
                />
              </div>

              {/* Interest Rate */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Annual Interest Rate (%)
                </label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={interestRate ?? ''}
                  onChange={(e) =>
                    setInterestRate(e.target.value ? Number(e.target.value) : undefined)
                  }
                  placeholder="e.g., 5.5"
                />
                {detected?.estimatedInterestRate && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Estimated from transaction history: {detected.estimatedInterestRate}%
                  </p>
                )}
              </div>

              {/* Interest Category */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Interest Expense Category
                </label>
                <Combobox
                  value={interestCategoryId}
                  onChange={(val) => setInterestCategoryId(val)}
                  options={categoryOptions}
                  placeholder="Select category..."
                />
                {detected?.interestCategoryName && !interestCategoryId && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Detected: {detected.interestCategoryName}
                  </p>
                )}
              </div>

              {/* Payee Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Payee / Lender Name
                </label>
                <Input
                  value={payeeName}
                  onChange={(e) => setPayeeName(e.target.value)}
                  placeholder="e.g., Bank of America"
                  maxLength={255}
                />
              </div>

              {/* Mortgage-specific fields */}
              {isMortgage && (
                <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
                    Mortgage Details
                  </h3>

                  <div className="space-y-3">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isCanadianMortgage}
                        onChange={(e) => setIsCanadianMortgage(e.target.checked)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        Canadian Mortgage (semi-annual compounding)
                      </span>
                    </label>

                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isVariableRate}
                        onChange={(e) => setIsVariableRate(e.target.checked)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        Variable Rate
                      </span>
                    </label>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Amortization (months)
                        </label>
                        <Input
                          type="number"
                          min="1"
                          max="600"
                          value={amortizationMonths ?? ''}
                          onChange={(e) =>
                            setAmortizationMonths(
                              e.target.value ? Number(e.target.value) : undefined,
                            )
                          }
                          placeholder="e.g., 300"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Term (months)
                        </label>
                        <Input
                          type="number"
                          min="1"
                          max="600"
                          value={termMonths ?? ''}
                          onChange={(e) =>
                            setTermMonths(
                              e.target.value ? Number(e.target.value) : undefined,
                            )
                          }
                          placeholder="e.g., 60"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Auto-post */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={autoPost}
                  onChange={(e) => setAutoPost(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Automatically post transactions when due
                </span>
              </label>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
                Skip
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isSubmitting || !paymentAmount || !sourceAccountId || !nextDueDate}
              >
                {isSubmitting ? 'Setting Up...' : 'Set Up Payments'}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
