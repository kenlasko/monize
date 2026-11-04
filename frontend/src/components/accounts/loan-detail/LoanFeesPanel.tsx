'use client';

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { LoanFeesEditor } from '@/components/accounts/LoanFeesEditor';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { categoriesApi } from '@/lib/categories';
import { buildCategoryLabelMap } from '@/lib/categoryUtils';
import { createCategoryFromInput } from '@/lib/category-create';
import { getErrorMessage } from '@/lib/errors';
import {
  LOAN_FEE_CALCULATION_KEYS,
  loanFeeDraftErrors,
  loanFeeDraftsToInputs,
  loanFeeToDraft,
  loanFeesApi,
  type LoanFeeDraft,
  type LoanFeeDraftErrors,
} from '@/lib/loan-fees';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { LoanFee } from '@/types/loan-fee';

interface LoanFeesPanelProps {
  account: Account;
  /** Reloads the loan after the fees (and so its scheduled payment) changed. */
  onChanged?: () => void | Promise<void>;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; fees: LoanFee[]; categories: Category[] };

/**
 * Loan Details' "Fees" panel for a mortgage (docs/specs/mortgage-fees.md
 * section 7): the fees its scheduled payment collects, and a dialog that
 * replaces them. The server reprices the payment's lines on save.
 */
export function LoanFeesPanel({ account, onChanged }: LoanFeesPanelProps) {
  const t = useTranslations('accounts');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; loaded: Loaded } | null>(null);
  const [drafts, setDrafts] = useState<LoanFeeDraft[] | null>(null);
  const [errors, setErrors] = useState<LoanFeeDraftErrors[] | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestKey = `${account.id}:${attempt}`;

  useEffect(() => {
    let cancelled = false;
    Promise.all([loanFeesApi.list(account.id), categoriesApi.getAll()]).then(
      ([fees, categories]) => {
        if (!cancelled) setAnswer({ key: requestKey, loaded: { status: 'ready', fees, categories } });
      },
      () => {
        if (!cancelled) setAnswer({ key: requestKey, loaded: { status: 'error' } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [account.id, requestKey]);

  const loaded: Loaded = answer && answer.key === requestKey ? answer.loaded : { status: 'loading' };
  const labels = useMemo(
    () =>
      answer?.loaded.status === 'ready'
        ? buildCategoryLabelMap(answer.loaded.categories)
        : new Map<string, string>(),
    [answer],
  );

  // A category typed into a fee's picker, through the one helper every
  // picker creates with; added to this panel's list so the editor can show
  // and select it.
  const createCategory = async (name: string): Promise<Category | null> => {
    if (answer?.loaded.status !== 'ready') return null;
    try {
      const result = await createCategoryFromInput(name, answer.loaded.categories, { isIncome: false });
      if (!result) return null;
      setAnswer((prev) =>
        prev && prev.loaded.status === 'ready'
          ? {
              ...prev,
              loaded: { ...prev.loaded, categories: [...prev.loaded.categories, ...result.created] },
            }
          : prev,
      );
      toast.success(
        result.parentName
          ? t('toasts.categoryCreatedNested', { parent: result.parentName, name: result.category.name })
          : t('toasts.categoryCreated', { name: result.category.name }),
      );
      return result.category;
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.categoryCreateFailed')));
      return null;
    }
  };

  const open = () => {
    if (loaded.status !== 'ready') return;
    setDrafts(loaded.fees.map(loanFeeToDraft));
    setErrors(undefined);
    setFailure(null);
  };
  const close = () => {
    if (!saving) setDrafts(null);
  };

  const save = async () => {
    if (!drafts) return;
    const found = loanFeeDraftErrors(drafts, account.interestCategoryId);
    setErrors(found);
    if (found.some((e) => Object.keys(e).length > 0)) return;
    setSaving(true);
    setFailure(null);
    try {
      await loanFeesApi.replace(account.id, loanFeeDraftsToInputs(drafts));
      toast.success(t('loanFees.saved'));
      setDrafts(null);
      setAttempt((n) => n + 1);
      await onChanged?.();
    } catch (error) {
      setFailure(getErrorMessage(error, t('loanFees.saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const describe = (fee: LoanFee): string => {
    const stored = fee.calculation === 'FIXED' ? fee.amount : fee.rate;
    const value =
      stored === null
        ? t('loanFees.unknownValue')
        : fee.calculation === 'FIXED'
          ? formatCurrency(stored, account.currencyCode)
          : formatPercentTrimmed(stored, 6);
    return t(fee.basis === 'ANNUAL' ? 'loanFees.summaryAnnual' : 'loanFees.summaryPerPayment', {
      value,
      calculation: t(`loanFees.calculations.${LOAN_FEE_CALCULATION_KEYS[fee.calculation]}`),
    });
  };

  let body;
  if (loaded.status === 'loading') {
    body = <LoadingSpinner text={t('loanFees.loading')} />;
  } else if (loaded.status === 'error') {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('loanFees.loadFailed')}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          {t('loanFees.retry')}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        {loaded.fees.length === 0 ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('loanFees.none')}</p>
        ) : (
          <ul className={TABLE_BODY_CLASS}>
            {loaded.fees.map((fee) => (
              <li key={fee.id} className="py-2 text-sm">
                <div className="font-medium text-gray-900 dark:text-gray-100">{fee.name}</div>
                <div className="text-gray-500 dark:text-gray-400">
                  {labels.get(fee.categoryId) ?? t('loanFees.unknownCategory')}
                  {' · '}
                  {describe(fee)}
                </div>
              </li>
            ))}
          </ul>
        )}
        {account.paymentMatchingRuleId && (
          <p className="text-xs text-amber-700 dark:text-amber-400">{t('loanFees.paymentMatchingNote')}</p>
        )}
        <Button size="sm" variant="outline" onClick={open}>
          {t('loanFees.edit')}
        </Button>
      </div>
    );
  }

  return (
    <Card padding="md">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('loanFees.title')}</h3>
      <p className="mb-4 mt-1 text-sm text-gray-500 dark:text-gray-400">{t('loanFees.panelDescription')}</p>
      {body}
      {drafts && loaded.status === 'ready' && (
        <Modal isOpen onClose={saving ? undefined : close} title={t('loanFees.editTitle')} padding="md" maxWidth="2xl">
          <div className="space-y-4">
            <LoanFeesEditor
              fees={drafts}
              onChange={setDrafts}
              categories={loaded.categories}
              currencyCode={account.currencyCode}
              errors={errors}
              usePortal
              onCreateCategory={createCategory}
            />
            {failure && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {failure}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-3">
              <Button type="button" variant="outline" onClick={close} disabled={saving}>
                {t('loanFees.cancel')}
              </Button>
              <Button type="button" onClick={() => void save()} isLoading={saving} disabled={saving}>
                {t('loanFees.save')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
