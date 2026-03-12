'use client';

import { MutableRefObject } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { IconPicker } from '@/components/ui/IconPicker';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { Tag } from '@/types/tag';

const tagSchema = z.object({
  name: z.string().min(1, 'Tag name is required').max(100),
  color: z.string().optional(),
  icon: z.string().optional(),
});

type TagFormData = z.infer<typeof tagSchema>;

interface TagFormProps {
  tag?: Tag | null;
  onSubmit: (data: TagFormData) => Promise<void>;
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

export function TagForm({ tag, onSubmit, onCancel, onDirtyChange, submitRef }: TagFormProps) {
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<TagFormData>({
    resolver: zodResolver(tagSchema),
    defaultValues: tag
      ? {
          name: tag.name,
          color: tag.color || '',
          icon: tag.icon || '',
        }
      : {
          name: '',
          color: '',
          icon: 'chart-bar',
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const watchedColor = useWatch({ control, name: 'color' });
  const watchedIcon = useWatch({ control, name: 'icon' });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Tag Name"
        error={errors.name?.message}
        {...register('name')}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <input type="hidden" {...register('color')} />
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Colour</label>
          {/* Mobile: dropdown select */}
          <div className="md:hidden">
            <div className="flex items-center gap-2">
              <span
                className="w-6 h-6 rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0"
                style={
                  watchedColor
                    ? { backgroundColor: watchedColor }
                    : { backgroundColor: '#e5e7eb' }
                }
              />
              <select
                value={watchedColor || ''}
                onChange={(e) => setValue('color', e.target.value, { shouldDirty: true })}
                className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 text-sm"
              >
                <option value="">No colour</option>
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
              title="No colour"
            >
              {!watchedColor && (
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
        </div>

        <div>
          <input type="hidden" {...register('icon')} />
          <IconPicker
            label="Icon"
            value={watchedIcon || null}
            onChange={(icon) => setValue('icon', icon, { shouldDirty: true })}
          />
        </div>
      </div>

      <FormActions onCancel={onCancel} submitLabel={tag ? 'Update Tag' : 'Create Tag'} isSubmitting={isSubmitting} />
    </form>
  );
}
