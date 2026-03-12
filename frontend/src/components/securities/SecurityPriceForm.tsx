'use client';

import { MutableRefObject } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { SecurityPrice, CreateSecurityPriceData } from '@/types/investment';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const priceSchema = z.object({
  priceDate: z.string().min(1, 'Date is required'),
  closePrice: z.string().min(1, 'Price is required').refine(
    (val) => !isNaN(Number(val)) && Number(val) >= 0,
    'Price must be a non-negative number',
  ),
  openPrice: z.string().optional(),
  highPrice: z.string().optional(),
  lowPrice: z.string().optional(),
  volume: z.string().optional(),
});

type PriceFormData = z.infer<typeof priceSchema>;

interface SecurityPriceFormProps {
  price?: SecurityPrice;
  onSubmit: (data: CreateSecurityPriceData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function SecurityPriceForm({ price, onSubmit, onCancel, onDirtyChange, submitRef }: SecurityPriceFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<PriceFormData>({
    resolver: zodResolver(priceSchema),
    defaultValues: {
      priceDate: price?.priceDate || new Date().toISOString().substring(0, 10),
      closePrice: price?.closePrice != null ? String(price.closePrice) : '',
      openPrice: price?.openPrice != null ? String(price.openPrice) : '',
      highPrice: price?.highPrice != null ? String(price.highPrice) : '',
      lowPrice: price?.lowPrice != null ? String(price.lowPrice) : '',
      volume: price?.volume != null ? String(price.volume) : '',
    },
  });

  const onFormSubmit = async (data: PriceFormData) => {
    const cleanedData: CreateSecurityPriceData = {
      priceDate: data.priceDate,
      closePrice: Number(data.closePrice),
      ...(data.openPrice && { openPrice: Number(data.openPrice) }),
      ...(data.highPrice && { highPrice: Number(data.highPrice) }),
      ...(data.lowPrice && { lowPrice: Number(data.lowPrice) }),
      ...(data.volume && { volume: Number(data.volume) }),
    };
    await onSubmit(cleanedData);
  };

  useFormDirtyNotify(isDirty, onDirtyChange);
  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      <Input
        label="Date"
        type="date"
        {...register('priceDate')}
        error={errors.priceDate?.message}
      />

      <Input
        label="Close Price"
        type="number"
        step="any"
        {...register('closePrice')}
        error={errors.closePrice?.message}
        placeholder="0.00"
      />

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Open Price"
          type="number"
          step="any"
          {...register('openPrice')}
          error={errors.openPrice?.message}
          placeholder="Optional"
        />
        <Input
          label="High Price"
          type="number"
          step="any"
          {...register('highPrice')}
          error={errors.highPrice?.message}
          placeholder="Optional"
        />
        <Input
          label="Low Price"
          type="number"
          step="any"
          {...register('lowPrice')}
          error={errors.lowPrice?.message}
          placeholder="Optional"
        />
        <Input
          label="Volume"
          type="number"
          step="1"
          {...register('volume')}
          error={errors.volume?.message}
          placeholder="Optional"
        />
      </div>

      <FormActions
        onCancel={onCancel}
        submitLabel={price ? 'Update Price' : 'Add Price'}
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
