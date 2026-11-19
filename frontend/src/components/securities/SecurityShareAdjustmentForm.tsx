'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { NumericInput } from '@/components/ui/NumericInput';
import { DateInput } from '@/components/ui/DateInput';
import { Input } from '@/components/ui/Input';
import { investmentsApi } from '@/lib/investments';
import { getLocalDateString } from '@/lib/utils';
import { getErrorMessage } from '@/lib/errors';
import type { InvestmentAction, SecurityHistoryAccount } from '@/types/investment';
import { historyAccountOption } from './history-account-option';
import type { Account } from '@/types/account';
import { AccountSelect } from '@/components/accounts/shared/AccountSelect';

interface SecurityShareAdjustmentFormProps {
  securityId: string;
  /** Accounts the security has been used in (including closed ones). */
  accounts: SecurityHistoryAccount[];
  /** The full account rows, for each option's institution logo and type icon. */
  accountDetails?: readonly Account[];
  defaultAccountId?: string;
  onSubmitted: () => void;
  onCancel: () => void;
}

// Quantity-only adjustments that change the share count without any cash
// impact -- exactly what's needed to clean up errant/residual share balances.
const ADJUSTMENT_ACTION_VALUES: InvestmentAction[] = ['REMOVE_SHARES', 'ADD_SHARES'];

/**
 * Compact form for posting an ADD_SHARES / REMOVE_SHARES adjustment against a
 * security in a chosen account. Works for closed accounts and inactive
 * securities (the backend looks them up by id, not by active status), so it
 * can be used to zero out residual share balances anywhere they linger.
 */
export function SecurityShareAdjustmentForm({
  securityId,
  accounts,
  accountDetails = [],
  defaultAccountId,
  onSubmitted,
  onCancel,
}: SecurityShareAdjustmentFormProps) {
  const [accountId, setAccountId] = useState(
    defaultAccountId || accounts[0]?.accountId || '',
  );
  const [action, setAction] = useState<InvestmentAction>('REMOVE_SHARES');
  const [quantity, setQuantity] = useState<number | undefined>(undefined);
  const [transactionDate, setTransactionDate] = useState(getLocalDateString());
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const t = useTranslations('securities');
  const tc = useTranslations('common');

  const adjustmentActions = ADJUSTMENT_ACTION_VALUES.map((value) => ({
    value,
    label: t(`shareAdjustment.adjustmentActions.${value}` as Parameters<typeof t>[0]),
  }));

  const handleSubmit = async () => {
    if (!accountId) {
      toast.error(t('shareAdjustment.toasts.selectAccount'));
      return;
    }
    if (!quantity || quantity <= 0) {
      toast.error(t('shareAdjustment.toasts.quantityRequired'));
      return;
    }
    setIsSaving(true);
    try {
      await investmentsApi.createTransaction({
        accountId,
        securityId,
        action,
        transactionDate,
        quantity,
        description: description || undefined,
      });
      toast.success(t('shareAdjustment.toasts.recorded'));
      onSubmitted();
    } catch (error) {
      toast.error(getErrorMessage(error, t('shareAdjustment.toasts.failed')));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/40">
      <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('shareAdjustment.heading')}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <AccountSelect
          label={t('shareAdjustment.accountLabel')}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          options={[
            { value: '', label: t('shareAdjustment.accountPlaceholder') },
            ...accounts.map((a) =>
              historyAccountOption(
                a,
                a.isClosed ? t('shareAdjustment.accountClosed', { name: a.accountName }) : a.accountName,
                accountDetails,
              ),
            ),
          ]}
        />
        <Select
          label={t('shareAdjustment.actionLabel')}
          value={action}
          onChange={(e) => setAction(e.target.value as InvestmentAction)}
          options={adjustmentActions}
        />
        <NumericInput
          label={t('shareAdjustment.quantityLabel')}
          value={quantity}
          onChange={setQuantity}
          decimalPlaces={8}
          min={0}
        />
        <DateInput
          label={t('shareAdjustment.dateLabel')}
          value={transactionDate}
          onDateChange={setTransactionDate}
        />
      </div>
      <Input
        label={t('shareAdjustment.descriptionLabel')}
        placeholder={t('shareAdjustment.descriptionPlaceholder')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
          {tc('cancel')}
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={isSaving}>
          {isSaving ? t('shareAdjustment.saving') : t('shareAdjustment.submitButton')}
        </Button>
      </div>
    </div>
  );
}
