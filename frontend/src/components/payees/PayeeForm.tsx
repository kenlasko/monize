'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Payee } from '@/types/payee';
import { Category } from '@/types/category';

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
}

export function PayeeForm({ payee, categories, onSubmit, onCancel }: PayeeFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
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

  const categoryOptions = [
    { value: '', label: 'No default category' },
    ...categories.map((cat) => ({ value: cat.id, label: cat.name })),
  ];

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Input
        label="Payee Name"
        error={errors.name?.message}
        {...register('name')}
      />

      <Select
        label="Default Category"
        options={categoryOptions}
        error={errors.defaultCategoryId?.message}
        {...register('defaultCategoryId')}
      />

      <Input
        label="Notes (optional)"
        error={errors.notes?.message}
        {...register('notes')}
      />

      <div className="flex justify-end space-x-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" isLoading={isSubmitting}>
          {payee ? 'Update Payee' : 'Create Payee'}
        </Button>
      </div>
    </form>
  );
}
