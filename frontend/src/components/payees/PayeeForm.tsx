'use client';

import { useState, useRef, useMemo, useCallback, MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { Select } from '@/components/ui/Select';
import { Payee, ApplyCategoryToTransactions } from '@/types/payee';
import { Category } from '@/types/category';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { PayeeAliasManager } from './PayeeAliasManager';

const buildPayeeSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t('validation.nameRequired')).max(255),
  defaultCategoryId: z.string().optional(),
  notes: z.string().optional(),
});

type PayeeFormData = z.infer<ReturnType<typeof buildPayeeSchema>>;

export type PayeeFormSubmitData = PayeeFormData & {
  pendingAliases?: string[];
  applyCategoryToTransactions?: ApplyCategoryToTransactions;
};

interface PayeeFormProps {
  payee?: Payee;
  categories: Category[];
  onSubmit: (data: PayeeFormSubmitData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function PayeeForm({ payee, categories, onSubmit, onCancel, onDirtyChange, submitRef }: PayeeFormProps) {
  const t = useTranslations('payees');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(payee?.defaultCategoryId || '');
  const [applyMode, setApplyMode] = useState<ApplyCategoryToTransactions>('none');
  const pendingAliasesRef = useRef<string[]>([]);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<PayeeFormData>({
    resolver: zodResolver(buildPayeeSchema(t)),
    defaultValues: payee
      ? {
          name: payee.name,
          defaultCategoryId: payee.defaultCategoryId || '',
          notes: payee.notes || '',
        }
      : {
          defaultCategoryId: '',
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const handleFormSubmit = useCallback((data: PayeeFormData) => {
    const submitData: PayeeFormSubmitData = { ...data };
    if (!payee && pendingAliasesRef.current.length > 0) {
      submitData.pendingAliases = pendingAliasesRef.current;
    }
    // Only carry the backfill instruction when editing an existing payee that
    // ends up with a default category and the user opted into applying it.
    if (payee && data.defaultCategoryId && applyMode !== 'none') {
      submitData.applyCategoryToTransactions = applyMode;
    }
    return onSubmit(submitData);
  }, [payee, onSubmit, applyMode]);

  const onFormSubmit = useCallback((e?: React.BaseSyntheticEvent) => {
    handleSubmit(handleFormSubmit)(e);
  }, [handleSubmit, handleFormSubmit]);

  useFormSubmitRef(submitRef, handleSubmit, handleFormSubmit);

  const categoryOptions = useMemo(() => {
    const treeOptions = buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    });
    return treeOptions;
  }, [categories]);

  const handleCategoryChange = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    setValue('defaultCategoryId', categoryId || '', { shouldDirty: true });
    // Clearing the category makes the backfill choice meaningless; reset it.
    if (!categoryId) {
      setApplyMode('none');
    }
  };

  // Counts for the backfill option labels. Transfers and split parents are
  // excluded by the backend, so "all" is an upper bound on what changes.
  const uncategorizedCount = payee?.uncategorizedCount ?? 0;
  const transactionCount = payee?.transactionCount ?? 0;
  const showApplyCategory =
    !!payee && !!selectedCategoryId && transactionCount > 0;
  const applyOptions = useMemo(
    () => [
      { value: 'none', label: t('form.applyCategoryNone') },
      {
        value: 'uncategorized',
        label: t('form.applyCategoryUncategorized', { count: uncategorizedCount }),
      },
      { value: 'all', label: t('form.applyCategoryAll', { count: transactionCount }) },
    ],
    [t, uncategorizedCount, transactionCount],
  );

  // Find display name for the initial category
  const defaultCategoryId = payee?.defaultCategoryId;
  const initialCategoryName = useMemo(() => {
    if (!defaultCategoryId) return '';
    const cat = categories.find(c => c.id === defaultCategoryId);
    if (!cat) return '';
    const parent = cat.parentId ? categories.find(c => c.id === cat.parentId) : null;
    return parent ? `${parent.name}: ${cat.name}` : cat.name;
  }, [defaultCategoryId, categories]);

  return (
    <form onSubmit={onFormSubmit} className="space-y-4">
      <Input
        label={t('form.nameLabel')}
        error={errors.name?.message}
        {...register('name')}
      />

      <Combobox
        label={t('form.categoryLabel')}
        placeholder={t('selectCategoryPlaceholder')}
        options={categoryOptions}
        value={selectedCategoryId}
        initialDisplayValue={initialCategoryName}
        onChange={handleCategoryChange}
        error={errors.defaultCategoryId?.message}
      />

      {showApplyCategory && (
        <div>
          <Select
            label={t('form.applyCategoryLabel')}
            options={applyOptions}
            value={applyMode}
            onChange={(e) => setApplyMode(e.target.value as ApplyCategoryToTransactions)}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('form.applyCategoryHelp')}
          </p>
        </div>
      )}

      <Input
        label={t('form.notesLabel')}
        error={errors.notes?.message}
        {...register('notes')}
      />

      {payee ? (
        <PayeeAliasManager payeeId={payee.id} />
      ) : (
        <PayeeAliasManager onPendingAliasesChange={(aliases) => { pendingAliasesRef.current = aliases; }} />
      )}

      <FormActions onCancel={onCancel} submitLabel={payee ? t('form.submitUpdate') : t('form.submitCreate')} isSubmitting={isSubmitting} />
    </form>
  );
}
