'use client';

import { useState, useMemo, MutableRefObject } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Combobox } from '@/components/ui/Combobox';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';
import { buildCategoryTree } from '@/lib/categoryUtils';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const payeeSchema = z.object({
  name: z.string().min(1, 'Payee name is required').max(255),
  defaultCategoryId: z.string().optional(),
  notes: z.string().optional(),
});

type PayeeFormData = z.infer<typeof payeeSchema>;

interface PayeeFormProps {
  payee?: Payee;
  categories: Category[];
  onSubmit: (data: PayeeFormData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function PayeeForm({ payee, categories, onSubmit, onCancel, onDirtyChange, submitRef }: PayeeFormProps) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(payee?.defaultCategoryId || '');

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<PayeeFormData>({
    resolver: zodResolver(payeeSchema),
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

  useFormSubmitRef(submitRef, handleSubmit, onSubmit);

  const categoryOptions = useMemo(() =>
    buildCategoryTree(categories).map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    }),
  [categories]);

  const handleCategoryChange = (categoryId: string) => {
    setSelectedCategoryId(categoryId);
    setValue('defaultCategoryId', categoryId || '', { shouldDirty: true });
  };

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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Payee Name"
        error={errors.name?.message}
        {...register('name')}
      />

      <Combobox
        label="Default Category"
        placeholder="Select category..."
        options={categoryOptions}
        value={selectedCategoryId}
        initialDisplayValue={initialCategoryName}
        onChange={handleCategoryChange}
        error={errors.defaultCategoryId?.message}
      />

      <Input
        label="Notes (optional)"
        error={errors.notes?.message}
        {...register('notes')}
      />

      <FormActions onCancel={onCancel} submitLabel={payee ? 'Update Payee' : 'Create Payee'} isSubmitting={isSubmitting} />
    </form>
  );
}
