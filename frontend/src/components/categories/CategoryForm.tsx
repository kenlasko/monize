'use client';

import { useEffect, MutableRefObject } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { Category } from '@/types/category';

const categorySchema = z.object({
  name: z.string().min(1, 'Category name is required').max(255),
  parentId: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  isIncome: z.boolean(),
});

type CategoryFormData = z.infer<typeof categorySchema>;

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
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CategoryFormData>({
    resolver: zodResolver(categorySchema),
    defaultValues: category
      ? {
          name: category.name,
          parentId: category.parentId || '',
          description: category.description || '',
          icon: category.icon || '',
          color: category.color || '',
          isIncome: category.isIncome,
        }
      : {
          parentId: '',
          isIncome: false,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const watchedColor = useWatch({ control, name: 'color' });
  const watchedParentId = useWatch({ control, name: 'parentId' });
  const watchedIsIncome = useWatch({ control, name: 'isIncome' });

  // When parent category changes, set type to match parent
  useEffect(() => {
    if (watchedParentId) {
      const parentCategory = categories.find(c => c.id === watchedParentId);
      if (parentCategory) {
        setValue('isIncome', parentCategory.isIncome);
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

  const parentOptions = [
    { value: '', label: 'No parent (top-level)' },
    ...getAvailableParents().map(({ category: cat }) => {
      const parent = cat.parentId ? categories.find(c => c.id === cat.parentId) : null;
      const displayName = parent ? `${parent.name}: ${cat.name}` : cat.name;
      return {
        value: cat.id,
        label: displayName,
      };
    }),
  ];

  const typeOptions = [
    { value: 'false', label: 'Expense' },
    { value: 'true', label: 'Income' },
  ];

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Category Name"
        error={errors.name?.message}
        {...register('name')}
      />

      <Select
        label="Parent Category"
        options={parentOptions}
        error={errors.parentId?.message}
        {...register('parentId')}
      />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Select
            label="Type"
            options={typeOptions}
            error={errors.isIncome?.message}
            disabled={hasParent}
            value={watchedIsIncome ? 'true' : 'false'}
            onChange={(e) => setValue('isIncome', e.target.value === 'true', { shouldDirty: true })}
          />
          {hasParent && parentCategory && (
            <p className="mt-1 text-xs text-gray-500">
              Type inherited from parent
            </p>
          )}
        </div>

        <div>
          <input type="hidden" {...register('color')} />
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Colour</label>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              onClick={() => setValue('color', '', { shouldDirty: true })}
              className={`w-8 h-8 rounded-full border-2 flex items-center justify-center transition-all ${
                !watchedColor
                  ? 'border-blue-500 dark:border-blue-400 ring-2 ring-blue-200 dark:ring-blue-800'
                  : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
              title={hasParent ? 'Inherit from parent' : 'No colour'}
              style={
                !watchedColor && parentCategory?.effectiveColor
                  ? { backgroundColor: parentCategory.effectiveColor, opacity: 0.4 }
                  : undefined
              }
            >
              {!watchedColor && !parentCategory?.effectiveColor && (
                <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
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
              Colour inherited from parent ({parentCategory.name})
            </p>
          )}
        </div>
      </div>

      <Input
        label="Icon (optional)"
        placeholder="e.g., shopping-cart"
        error={errors.icon?.message}
        {...register('icon')}
      />

      <Input
        label="Description (optional)"
        error={errors.description?.message}
        {...register('description')}
      />

      <FormActions onCancel={onCancel} submitLabel={category ? 'Update Category' : 'Create Category'} isSubmitting={isSubmitting} />
    </form>
  );
}
