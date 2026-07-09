'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { transactionsApi } from '@/lib/transactions';
import { getCurrencySymbol } from '@/lib/format';
import { createLogger } from '@/lib/logger';
import type { Account } from '@/types/account';

const logger = createLogger('UpdateValueDialog');

interface UpdateValueDialogProps {
  isOpen: boolean;
  onClose: () => void;
  account: Account;
  onComplete?: () => void;
}

/**
 * Records a balance-adjustment transaction to set an asset's value as of a
 * chosen date. The transaction's amount is the delta from the current balance,
 * tagged with the asset's value-tracking category when one is configured.
 */
export function UpdateValueDialog({ isOpen, onClose, account, onComplete }: UpdateValueDialogProps) {
  const t = useTranslations('accountDetail-asset');
  const currentValue = Number(account.currentBalance) || 0;

  const [newValue, setNewValue] = useState<number>(currentValue);
  const [date, setDate] = useState<string>(() => format(new Date(), 'yyyy-MM-dd'));
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Reseed the form each time the dialog opens (info-from-previous-render).
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setNewValue(currentValue);
      setDate(format(new Date(), 'yyyy-MM-dd'));
    }
  }

  const delta = Math.round((newValue - currentValue) * 100) / 100;

  const handleSave = async () => {
    if (!date || Number.isNaN(newValue)) {
      toast.error(t('updateValue.invalid'));
      return;
    }
    setIsSubmitting(true);
    try {
      await transactionsApi.create({
        accountId: account.id,
        transactionDate: date,
        amount: delta,
        currencyCode: account.currencyCode,
        categoryId: account.assetCategoryId ?? undefined,
        description: t('updateValue.memo'),
      });
      toast.success(t('updateValue.saved'));
      onComplete?.();
      onClose();
    } catch (error: unknown) {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('updateValue.failed');
      toast.error(message);
      logger.error('Failed to update asset value:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
          {t('updateValue.title')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{account.name}</p>

        <div className="space-y-4">
          <CurrencyInput
            label={t('updateValue.newValue')}
            value={newValue}
            onChange={(val) => setNewValue(val ?? 0)}
            prefix={getCurrencySymbol(account.currencyCode)}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('updateValue.date')}
            </label>
            <DateInput value={date} onDateChange={setDate} onChange={() => {}} />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('updateValue.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting || delta === 0}>
            {isSubmitting ? t('updateValue.saving') : t('updateValue.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
