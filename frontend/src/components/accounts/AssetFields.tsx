'use client';

import { UseFormRegister, UseFormSetValue, FieldErrors } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { DateInput } from '@/components/ui/DateInput';
import { Combobox } from '@/components/ui/Combobox';
import { Category } from '@/types/category';
import { categoryPickerIcon } from '@/components/categories/CategoryPickerIcon';
import { categoriesForHolder } from '@/lib/category-type';

interface AssetFieldsProps {
  categories: Category[];
  selectedAssetCategoryId: string;
  assetCategoryName: string;
  accountAssetCategoryId: string | null | undefined;
  handleAssetCategoryChange: (categoryId: string, name: string) => void;
  handleAssetCategoryCreate: (name: string) => Promise<void>;
  register: UseFormRegister<any>;
  setValue: UseFormSetValue<any>;
  errors: FieldErrors<any>;
  watchedDateAcquired: string | undefined;
}

export function AssetFields({
  categories,
  selectedAssetCategoryId,
  assetCategoryName,
  accountAssetCategoryId,
  handleAssetCategoryChange,
  handleAssetCategoryCreate,
  register,
  setValue,
  errors,
  watchedDateAcquired: _watchedDateAcquired,
}: AssetFieldsProps) {
  const t = useTranslations('accounts');
  return (
    <div className="space-y-4 p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {t('assetFields.title')}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('assetFields.description')}
      </p>
      <Combobox
        label={t('assetFields.valueChangeCategory')}
        placeholder={t('assetFields.selectOrCreateCategory')}
        // An asset's value changes are category rows: Income and Expense only
        // (INV-CATEGORY-001).
        options={categoriesForHolder(categories, 'category').map(c => ({
          value: c.id,
          label: c.parentId
            ? `${categories.find(p => p.id === c.parentId)?.name || ''}: ${c.name}`
            : c.name,
          icon: categoryPickerIcon(c),
        })).sort((a, b) => a.label.localeCompare(b.label))}
        value={selectedAssetCategoryId}
        initialDisplayValue={assetCategoryName || accountAssetCategoryId ? categories.find(c => c.id === (selectedAssetCategoryId || accountAssetCategoryId))?.name : ''}
        onChange={handleAssetCategoryChange}
        onCreateNew={handleAssetCategoryCreate}
        allowCustomValue={true}
        valueIsId
      />
      <DateInput
        label={t('assetFields.dateAcquired')}
        error={errors.dateAcquired?.message as string | undefined}
        onDateChange={(date) => setValue('dateAcquired', date, { shouldDirty: true, shouldValidate: true })}
        {...register('dateAcquired')}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('assetFields.dateAcquiredNote')}
      </p>
    </div>
  );
}
