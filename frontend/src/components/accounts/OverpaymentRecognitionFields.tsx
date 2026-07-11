'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UseFormRegister, FieldErrors } from 'react-hook-form';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { Select } from '@/components/ui/Select';
import { LoanBookingHelp } from './LoanBookingHelp';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { InterestBookingMode, INTEREST_BOOKING_MODES } from '@/types/account';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { payeesApi } from '@/lib/payees';
import { createLogger } from '@/lib/logger';

const logger = createLogger('OverpaymentRecognitionFields');

interface OverpaymentRecognitionFieldsProps {
  categories: Category[];
  /** Where this loan's interest is booked, so the schedule/detection find it. */
  selectedInterestCategoryId: string;
  onInterestCategoryChange: (categoryId: string) => void;
  /** How this loan records interest, so rate detection reads it correctly. */
  interestBookingMode: InterestBookingMode;
  onInterestBookingModeChange: (mode: InterestBookingMode) => void;
  selectedOverpaymentCategoryId: string;
  onOverpaymentCategoryChange: (categoryId: string) => void;
  selectedOverpaymentPayeeId: string;
  onOverpaymentPayeeChange: (payeeId: string) => void;
  // The overpayment memo is a plain form field, registered by the parent form.
  register: UseFormRegister<any>;
  errors: FieldErrors<any>;
}

/**
 * The per-loan payment-recognition settings shared by the loan and mortgage
 * forms (create and edit): the interest category, plus the category / payee /
 * memo that mark a payment as a standalone overpayment (100% principal). Any
 * single overpayment match is sufficient. These only feed the derived views
 * (schedule split, past impact, projection, rate detection) -- never the
 * account balance.
 */
export function OverpaymentRecognitionFields({
  categories,
  selectedInterestCategoryId,
  onInterestCategoryChange,
  interestBookingMode,
  onInterestBookingModeChange,
  selectedOverpaymentCategoryId,
  onOverpaymentCategoryChange,
  selectedOverpaymentPayeeId,
  onOverpaymentPayeeChange,
  register,
  errors,
}: OverpaymentRecognitionFieldsProps) {
  const t = useTranslations('accounts');

  const [payees, setPayees] = useState<Payee[]>([]);
  useEffect(() => {
    let cancelled = false;
    payeesApi
      .getAll()
      .then((all) => {
        if (!cancelled) setPayees(all);
      })
      .catch((error) => logger.debug('Payees unavailable:', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const categoryOptions = useMemo(
    () =>
      buildCategoryTree(categories).map(({ category }) => {
        const parent = category.parentId
          ? categories.find((c) => c.id === category.parentId)
          : null;
        return {
          value: category.id,
          label: parent ? `${parent.name}: ${category.name}` : category.name,
        };
      }),
    [categories],
  );
  const payeeOptions = useMemo(
    () =>
      [...payees]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({ value: p.id, label: p.name })),
    [payees],
  );
  const initialCategoryName = useMemo(() => {
    if (!selectedOverpaymentCategoryId) return '';
    const cat = categories.find((c) => c.id === selectedOverpaymentCategoryId);
    if (!cat) return '';
    const parent = cat.parentId ? categories.find((c) => c.id === cat.parentId) : null;
    return parent ? `${parent.name}: ${cat.name}` : cat.name;
  }, [selectedOverpaymentCategoryId, categories]);
  const initialPayeeName = useMemo(
    () => payees.find((p) => p.id === selectedOverpaymentPayeeId)?.name ?? '',
    [payees, selectedOverpaymentPayeeId],
  );
  const initialInterestCategoryName = useMemo(() => {
    if (!selectedInterestCategoryId) return '';
    const cat = categories.find((c) => c.id === selectedInterestCategoryId);
    if (!cat) return '';
    const parent = cat.parentId ? categories.find((c) => c.id === cat.parentId) : null;
    return parent ? `${parent.name}: ${cat.name}` : cat.name;
  }, [selectedInterestCategoryId, categories]);

  return (
    <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
      <LoanBookingHelp />

      <Combobox
        label={t('mortgageFields.interestCategory')}
        placeholder={t('mortgageFields.selectCategory')}
        options={categoryOptions}
        value={selectedInterestCategoryId}
        initialDisplayValue={initialInterestCategoryName}
        onChange={onInterestCategoryChange}
        error={errors.interestCategoryId?.message as string | undefined}
      />

      <div className="mt-3">
        <Select
          label={t('mortgageFields.interestBookingMode.label')}
          value={interestBookingMode}
          onChange={(e) =>
            onInterestBookingModeChange(e.target.value as InterestBookingMode)
          }
          options={INTEREST_BOOKING_MODES.map((mode) => ({
            value: mode,
            label: t(`mortgageFields.interestBookingMode.${mode}` as string),
          }))}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('mortgageFields.interestBookingMode.help')}
        </p>
      </div>

      <h4 className="mt-4 text-sm font-medium text-gray-800 dark:text-gray-200">
        {t('mortgageFields.overpaymentRecognition.title')}
      </h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-3">
        {t('mortgageFields.overpaymentRecognition.description')}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Combobox
          label={t('mortgageFields.overpaymentRecognition.categoryLabel')}
          placeholder={t('mortgageFields.selectCategory')}
          options={categoryOptions}
          value={selectedOverpaymentCategoryId}
          initialDisplayValue={initialCategoryName}
          onChange={onOverpaymentCategoryChange}
          error={errors.overpaymentCategoryId?.message as string | undefined}
        />
        <Combobox
          label={t('mortgageFields.overpaymentRecognition.payeeLabel')}
          placeholder={t('mortgageFields.overpaymentRecognition.payeePlaceholder')}
          options={payeeOptions}
          value={selectedOverpaymentPayeeId}
          initialDisplayValue={initialPayeeName}
          onChange={onOverpaymentPayeeChange}
          error={errors.overpaymentPayeeId?.message as string | undefined}
        />
      </div>
      <div className="mt-3">
        <Input
          label={t('mortgageFields.overpaymentRecognition.memoLabel')}
          placeholder={t('mortgageFields.overpaymentRecognition.memoPlaceholder')}
          maxLength={255}
          error={errors.overpaymentMemo?.message as string | undefined}
          {...register('overpaymentMemo')}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('mortgageFields.overpaymentRecognition.memoHelp')}
        </p>
      </div>
    </div>
  );
}
