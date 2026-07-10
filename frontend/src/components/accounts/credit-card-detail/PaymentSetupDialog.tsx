'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { accountsApi } from '@/lib/accounts';
import { transactionsApi } from '@/lib/transactions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { createLogger } from '@/lib/logger';
import type { Account } from '@/types/account';
import type { StatementCycle } from '@/types/credit-card-detail';

const logger = createLogger('PaymentSetupDialog');

const FUNDING_ACCOUNT_TYPES = ['CHEQUING', 'SAVINGS', 'CASH'];

type AmountType = 'statement' | 'full' | 'custom';
type PaymentMode = 'now' | 'schedule';

interface PaymentSetupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  account: Account;
  cycle: StatementCycle | null;
  /** Called after a payment is recorded or scheduled so the page can refresh. */
  onComplete?: () => void;
}

/**
 * Records or schedules a credit-card payment as a transfer from a chosen
 * funding account (statement balance / full balance / custom amount). "Record
 * now" creates a one-time transfer; "Schedule monthly" creates a recurring
 * scheduled transfer. Funding accounts are restricted to the card's currency
 * to keep the amount unambiguous.
 */
export function PaymentSetupDialog({
  isOpen,
  onClose,
  account,
  cycle,
  onComplete,
}: PaymentSetupDialogProps) {
  const t = useTranslations('accountDetail-creditCard');
  const { formatCurrency } = useNumberFormat();
  const currency = account.currencyCode;

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [fundingAccountId, setFundingAccountId] = useState('');
  const [amountType, setAmountType] = useState<AmountType>('full');
  const [customAmount, setCustomAmount] = useState<number>(0);
  const [paymentDate, setPaymentDate] = useState('');
  const [mode, setMode] = useState<PaymentMode>('now');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const statementAmount =
    cycle && Math.abs(cycle.statementBalance) > 0 ? Math.abs(cycle.statementBalance) : null;
  const fullAmount = Math.abs(Number(account.currentBalance) || 0);

  const fundingOptions = buildAccountDropdownOptions(
    accounts,
    (a) =>
      a.id !== account.id &&
      !a.isClosed &&
      a.currencyCode === currency &&
      FUNDING_ACCOUNT_TYPES.includes(a.accountType),
    (a) => a.name,
  );

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      try {
        const all = await accountsApi.getAll();
        setAccounts(all);
        const options = buildAccountDropdownOptions(
          all,
          (a) =>
            a.id !== account.id &&
            !a.isClosed &&
            a.currencyCode === currency &&
            FUNDING_ACCOUNT_TYPES.includes(a.accountType),
          (a) => a.name,
        );
        setFundingAccountId(options[0]?.value ?? '');
      } catch (error) {
        logger.error('Failed to load funding accounts:', error);
        setAccounts([]);
        setFundingAccountId('');
      }
      setAmountType(statementAmount != null ? 'statement' : 'full');
      setCustomAmount(fullAmount);
      setPaymentDate(format(new Date(), 'yyyy-MM-dd'));
      setMode('now');
    };
    load();
  }, [isOpen, account.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const amount =
    amountType === 'statement'
      ? statementAmount ?? 0
      : amountType === 'full'
        ? fullAmount
        : customAmount;

  const canSubmit = amount > 0 && !!fundingAccountId && !!paymentDate && !isSubmitting;

  const handleSubmit = async () => {
    if (amount <= 0 || !fundingAccountId || !paymentDate) {
      toast.error(t('payment.fillRequired'));
      return;
    }
    const funding = accounts.find((a) => a.id === fundingAccountId);
    const fromCurrencyCode = funding?.currencyCode ?? currency;

    setIsSubmitting(true);
    try {
      if (mode === 'now') {
        await transactionsApi.createTransfer({
          fromAccountId: fundingAccountId,
          toAccountId: account.id,
          transactionDate: paymentDate,
          amount,
          fromCurrencyCode,
        });
        toast.success(t('payment.toastRecorded'));
      } else {
        await scheduledTransactionsApi.create({
          accountId: fundingAccountId,
          name: t('payment.recordName', { name: account.name }),
          amount: -Math.abs(amount),
          currencyCode: fromCurrencyCode,
          frequency: 'MONTHLY',
          nextDueDate: paymentDate,
          isTransfer: true,
          transferAccountId: account.id,
        });
        toast.success(t('payment.toastScheduled'));
      }
      onComplete?.();
      onClose();
    } catch (error: unknown) {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('payment.toastFailed');
      toast.error(message);
      logger.error('Failed to submit payment:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const amountOptions: { value: AmountType; label: string; disabled?: boolean }[] = [
    ...(statementAmount != null
      ? [
          {
            value: 'statement' as const,
            label: `${t('payment.statementBalance')} (${formatCurrency(statementAmount, currency)})`,
          },
        ]
      : []),
    { value: 'full', label: `${t('payment.fullBalance')} (${formatCurrency(fullAmount, currency)})` },
    { value: 'custom', label: t('payment.custom') },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="md">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {t('payment.title')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{account.name}</p>

        {fundingOptions.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('payment.noFundingAccounts')}
          </p>
        ) : (
          <div className="space-y-4">
            <fieldset>
              <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('payment.amountType')}
              </legend>
              <div className="space-y-2">
                {amountOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="cc-amount-type"
                      value={opt.value}
                      checked={amountType === opt.value}
                      onChange={() => setAmountType(opt.value)}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-gray-700 dark:text-gray-300">{opt.label}</span>
                  </label>
                ))}
              </div>
              {amountType === 'custom' && (
                <div className="mt-2">
                  <CurrencyInput
                    label={t('payment.custom')}
                    value={customAmount || undefined}
                    onChange={(val) => setCustomAmount(val ?? 0)}
                    prefix={getCurrencySymbol(currency)}
                  />
                </div>
              )}
            </fieldset>

            <Select
              label={t('payment.fromAccount')}
              value={fundingAccountId}
              onChange={(e) => setFundingAccountId(e.target.value)}
              options={[{ value: '', label: t('payment.selectAccount') }, ...fundingOptions]}
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('payment.date')}
              </label>
              <DateInput value={paymentDate} onDateChange={setPaymentDate} onChange={() => {}} />
            </div>

            <fieldset>
              <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('payment.mode')}
              </legend>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="cc-payment-mode"
                    checked={mode === 'now'}
                    onChange={() => setMode('now')}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-gray-700 dark:text-gray-300">{t('payment.recordNow')}</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="cc-payment-mode"
                    checked={mode === 'schedule'}
                    onChange={() => setMode('schedule')}
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-gray-700 dark:text-gray-300">
                    {t('payment.scheduleMonthly')}
                  </span>
                </label>
              </div>
            </fieldset>

            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
                {t('payment.cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {isSubmitting
                  ? t('payment.submitting')
                  : mode === 'now'
                    ? t('payment.submitRecord')
                    : t('payment.submitSchedule')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
