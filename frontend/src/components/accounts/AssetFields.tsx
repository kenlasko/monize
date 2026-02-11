'use client';

import { UseFormRegister, FieldErrors } from 'react-hook-form';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { Category } from '@/types/category';

interface AssetFieldsProps {
  categories: Category[];
  selectedAssetCategoryId: string;
  assetCategoryName: string;
  accountAssetCategoryId: string | null | undefined;
  handleAssetCategoryChange: (categoryId: string, name: string) => void;
  handleAssetCategoryCreate: (name: string) => Promise<void>;
  register: UseFormRegister<any>;
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
  errors,
  watchedDateAcquired,
}: AssetFieldsProps) {
  return (
    <div className="space-y-4 p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
      <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
        Asset Value Change Settings
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Select a category that will be used to track value changes for this asset (e.g., "Home Value Change", "Vehicle Depreciation").
      </p>
      <Combobox
        label="Value Change Category"
        placeholder="Select or create category..."
        options={categories.map(c => ({
          value: c.id,
          label: c.parentId
            ? `${categories.find(p => p.id === c.parentId)?.name || ''}: ${c.name}`
            : c.name,
        })).sort((a, b) => a.label.localeCompare(b.label))}
        value={selectedAssetCategoryId}
        initialDisplayValue={assetCategoryName || accountAssetCategoryId ? categories.find(c => c.id === (selectedAssetCategoryId || accountAssetCategoryId))?.name : ''}
        onChange={handleAssetCategoryChange}
        onCreateNew={handleAssetCategoryCreate}
        allowCustomValue={true}
      />
      <Input
        label="Date Acquired"
        type="date"
        className={watchedDateAcquired ? '' : 'date-empty'}
        error={errors.dateAcquired?.message as string | undefined}
        {...register('dateAcquired')}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400">
        The asset will be excluded from net worth calculations before this date.
      </p>
    </div>
  );
}
