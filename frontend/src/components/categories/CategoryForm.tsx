'use client';

import { useEffect, useMemo, MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useForm, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { IconPicker } from '@/components/ui/IconPicker';
import { Select } from '@/components/ui/Select';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { Category } from '@/types/category';
import { CATEGORY_TYPES, type CategoryType, categoryTypeOf } from '@/lib/category-type';
import { categoryPickerIcon } from '@/components/categories/CategoryPickerIcon';

const buildCategorySchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t('validation.nameRequired')).max(255),
  parentId: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  type: z.enum(CATEGORY_TYPES),
  // null = no explicit choice, inherit the nearest ancestor's (a root behaves as on).
  autoSign: z.boolean().nullable(),
});

type CategoryFormData = z.infer<ReturnType<typeof buildCategorySchema>>;

interface CategoryFormProps {
  category?: Category;
  categories: Category[];
  onSubmit: (data: CategoryFormData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

const colourPalette = [
  { value: '#ef4444', label: 'Red' },
  { value: '#f97316', label: 'Orange' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#22c55e', label: 'Green' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#6b7280', label: 'Grey' },
];

export function CategoryForm({ category, categories, onSubmit, onCancel, onDirtyChange, submitRef }: CategoryFormProps) {
  const t = useTranslations('categories');
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CategoryFormData>({
    resolver: zodResolver(buildCategorySchema(t)),
    defaultValues: category
      ? {
          name: category.name,
          parentId: category.parentId || '',
          description: category.description || '',
          color: category.color || '',
          icon: category.icon || '',
          type: categoryTypeOf(category),
          autoSign: category.autoSign ?? null,
        }
      : {
          parentId: '',
          type: 'expense' as const,
          autoSign: null,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const watchedColor = useWatch({ control, name: 'color' });
  const watchedIcon = useWatch({ control, name: 'icon' });
  const watchedParentId = useWatch({ control, name: 'parentId' });
  const watchedType = useWatch({ control, name: 'type' });
  const watchedAutoSign = useWatch({ control, name: 'autoSign' });

  // When parent category changes, set type to match parent. The automatic
  // sign is deliberately not copied: an inherited value and an explicit one
  // that happens to match are different choices.
  useEffect(() => {
    if (watchedParentId) {
      const parentCategory = categories.find(c => c.id === watchedParentId);
      if (parentCategory) {
        setValue('type', categoryTypeOf(parentCategory));
      }
    }
  }, [watchedParentId, categories, setValue]);

  // Check if a parent is selected (type should be locked)
  const hasParent = !!watchedParentId;
  const parentCategory = hasParent ? categories.find(c => c.id === watchedParentId) : null;

  // Filter out the current category and its children from parent options
  const getAvailableParents = () => {
    // Build set of IDs to exclude (current category and its descendants)
    const excludeIds = new Set<string>();
    if (category) {
      excludeIds.add(category.id);
      const collectChildren = (parentId: string) => {
        categories.forEach((c) => {
          if (c.parentId === parentId) {
            excludeIds.add(c.id);
            collectChildren(c.id);
          }
        });
      };
      collectChildren(category.id);
    }

    // Build hierarchical tree structure
    const buildTree = (parentId: string | null = null, level: number = 0): Array<{ category: Category; level: number }> => {
      return categories
        .filter((c) => c.parentId === parentId && !excludeIds.has(c.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((cat) => [
          { category: cat, level },
          ...buildTree(cat.id, level + 1),
        ]);
    };

    return buildTree();
  };

  const parentOptions = getAvailableParents().map(({ category: cat }) => {
    const parent = cat.parentId ? categories.find(c => c.id === cat.parentId) : null;
    const displayName = parent ? `${parent.name}: ${cat.name}` : cat.name;
    return {
      value: cat.id,
      label: displayName,
      icon: categoryPickerIcon(cat),
    };
  });

  // Sync the parent selection from the searchable combobox back into the form.
  const handleParentChange = (parentId: string) => {
    setValue('parentId', parentId || '', { shouldDirty: true });
  };

  // Resolve the display name for the initially selected parent so the combobox
  // can show it before the matching option is looked up (mirrors PayeeForm).
  const initialParentId = category?.parentId;
  const initialParentName = useMemo(() => {
    if (!initialParentId) return '';
    const cat = categories.find(c => c.id === initialParentId);
    if (!cat) return '';
    const parent = cat.parentId ? categories.find(c => c.id === cat.parentId) : null;
    return parent ? `${parent.name}: ${cat.name}` : cat.name;
  }, [initialParentId, categories]);

  const autoSignOptions = [
    ...(hasParent ? [{ value: '', label: t('form.autoSignInherit') }] : []),
    { value: 'true', label: t('form.autoSignOn') },
    { value: 'false', label: t('form.autoSignOff') },
  ];
  const autoSignValue =
    watchedAutoSign === null || watchedAutoSign === undefined
      ? (hasParent ? '' : 'true')
      : String(watchedAutoSign);

  const typeOptions = [
    { value: 'expense', label: t('form.typeExpense') },
    { value: 'income', label: t('form.typeIncome') },
    { value: 'transfer', label: t('form.typeTransfer') },
  ];

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label={t('form.nameLabel')}
        error={errors.name?.message}
        {...register('name')}
      />

      <Combobox
        label={t('form.parentLabel')}
        placeholder={t('form.noParent')}
        options={parentOptions}
        value={watchedParentId}
        initialDisplayValue={initialParentName}
        onChange={handleParentChange}
        error={errors.parentId?.message}
      />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Select
            label={t('form.typeLabel')}
            options={typeOptions}
            error={errors.type?.message}
            disabled={hasParent}
            value={watchedType}
            onChange={(e) =>
              setValue('type', e.target.value as CategoryType, { shouldDirty: true })
            }
          />
          {hasParent && parentCategory && (
            <p className="mt-1 text-xs text-gray-500">
              {t('form.typeInherited')}
            </p>
          )}
        </div>

        <div>
          <input type="hidden" {...register('color')} />
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('form.colourLabel')}</label>
          {/* Mobile: dropdown select */}
          <div className="md:hidden">
            <div className="flex items-center gap-2">
              <span
                className="w-6 h-6 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0"
                style={
                  watchedColor
                    ? { backgroundColor: watchedColor }
                    : parentCategory?.effectiveColor
                      ? { backgroundColor: parentCategory.effectiveColor, opacity: 0.4 }
                      : { backgroundColor: '#e5e7eb' }
                }
              />
              <select
                value={watchedColor || ''}
                onChange={(e) => setValue('color', e.target.value, { shouldDirty: true })}
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 text-sm"
              >
                <option value="">{hasParent ? t('form.colourInherit') : t('form.colourNone')}</option>
                {colourPalette.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
          {/* Desktop: colour swatches */}
          <div className="hidden md:flex flex-wrap gap-2 items-center">
            <button
              type="button"
              onClick={() => setValue('color', '', { shouldDirty: true })}
              className={`w-8 h-8 rounded-full border-2 flex items-center justify-center transition-all ${
                !watchedColor
                  ? 'border-blue-500 dark:border-blue-400 ring-2 ring-blue-200 dark:ring-blue-800'
                  : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
              title={hasParent ? t('form.colourInherit') : t('form.colourNone')}
              style={
                !watchedColor && parentCategory?.effectiveColor
                  ? { backgroundColor: parentCategory.effectiveColor, opacity: 0.4 }
                  : undefined
              }
            >
              {!watchedColor && !parentCategory?.effectiveColor && (
                <XMarkIcon className="w-4 h-4 text-gray-400 dark:text-gray-500" aria-hidden="true" />
              )}
            </button>
            {colourPalette.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setValue('color', opt.value, { shouldDirty: true })}
                className={`w-8 h-8 rounded-full border-2 transition-all ${
                  watchedColor === opt.value
                    ? 'border-blue-500 dark:border-blue-400 ring-2 ring-blue-200 dark:ring-blue-800 scale-110'
                    : 'border-transparent hover:border-gray-400 dark:hover:border-gray-500 hover:scale-110'
                }`}
                style={{ backgroundColor: opt.value }}
                title={opt.label}
              />
            ))}
          </div>
          {hasParent && !watchedColor && parentCategory?.effectiveColor && (
            <p className="mt-1 text-xs text-gray-500">
              {t('form.colourInheritedFrom', { name: parentCategory.name })}
            </p>
          )}
        </div>
      </div>

      <div>
        <Select
          label={t('form.autoSignLabel')}
          options={autoSignOptions}
          error={errors.autoSign?.message}
          value={autoSignValue}
          onChange={(e) =>
            setValue(
              'autoSign',
              e.target.value === '' ? null : e.target.value === 'true',
              { shouldDirty: true },
            )
          }
        />
        <p className="mt-1 text-xs text-gray-500">{t('form.autoSignHelp')}</p>
        {hasParent && autoSignValue === '' && parentCategory && (
          <p className="mt-1 text-xs text-gray-500">
            {t('form.autoSignInheritedFrom', {
              name: parentCategory.name,
              state: parentCategory.effectiveAutoSign === false
                ? t('form.autoSignOff')
                : t('form.autoSignOn'),
            })}
          </p>
        )}
      </div>

      <div>
        <input type="hidden" {...register('icon')} />
        <IconPicker
          label={t('form.iconLabel')}
          value={watchedIcon || null}
          onChange={(icon) => setValue('icon', icon, { shouldDirty: true })}
          onClear={() => setValue('icon', '', { shouldDirty: true })}
          clearLabel={t('form.iconNone')}
        />
      </div>

      <Input
        label={t('form.descriptionLabel')}
        error={errors.description?.message}
        {...register('description')}
      />

      <FormActions onCancel={onCancel} submitLabel={category ? t('form.submitUpdate') : t('form.submitCreate')} isSubmitting={isSubmitting} />
    </form>
  );
}
