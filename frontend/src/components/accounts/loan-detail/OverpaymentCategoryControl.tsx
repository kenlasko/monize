'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { Combobox } from '@/components/ui/Combobox';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { Category } from '@/types/category';
import { createLogger } from '@/lib/logger';

const logger = createLogger('OverpaymentCategoryControl');

interface OverpaymentCategoryControlProps {
  accountId: string;
  value: string | null;
  /** Called with the newly selected category id (or null) after a successful save */
  onChange: (categoryId: string | null) => void;
}

/**
 * Gear-menu setting for the per-loan overpayment category. Tagging standalone
 * overpayments with the chosen category lets the schedule recognize them as
 * 100% principal (interest 0) and flag them, instead of treating them as a
 * regular installment. Uses the same category Combobox as the transaction form.
 */
export function OverpaymentCategoryControl({
  accountId,
  value,
  onChange,
}: OverpaymentCategoryControlProps) {
  const t = useTranslations('accounts');
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [saving, setSaving] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useClickOutside(wrapperRef, () => setOpen(false), {
    enabled: open,
    onEscape: () => setOpen(false),
  });

  useEffect(() => {
    let cancelled = false;
    categoriesApi
      .getAll()
      .then((all) => {
        if (!cancelled) {
          // Overpayments are expense-side; offer expense categories only.
          setCategories(all.filter((category) => !category.isIncome));
        }
      })
      .catch((error) => {
        logger.debug('Categories unavailable:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hierarchical "Parent: Child" labels, matching the transaction form's picker.
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

  const currentLabel =
    categoryOptions.find((option) => option.value === value)?.label ?? '';

  const handleChange = async (categoryId: string) => {
    const nextId = categoryId || null;
    if (nextId === value) return;
    setSaving(true);
    try {
      await accountsApi.update(accountId, { overpaymentCategoryId: nextId });
      onChange(nextId);
    } catch (error) {
      logger.error('Failed to save overpayment category:', error);
      toast.error(t('loanDetail.overpaymentCategory.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={t('loanDetail.overpaymentCategory.title')}
        aria-expanded={open}
        className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <Cog6ToothIcon className="h-5 w-5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-72 z-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg dark:shadow-gray-700/50 p-4">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('loanDetail.overpaymentCategory.title')}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-3">
            {t('loanDetail.overpaymentCategory.description')}
          </p>
          <Combobox
            label={t('loanDetail.overpaymentCategory.label')}
            placeholder={t('loanDetail.overpaymentCategory.placeholder')}
            options={categoryOptions}
            value={value ?? ''}
            initialDisplayValue={currentLabel}
            onChange={handleChange}
            disabled={saving}
          />
        </div>
      )}
    </div>
  );
}
