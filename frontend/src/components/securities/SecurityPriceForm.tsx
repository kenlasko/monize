'use client';

import { MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { useForm, Controller } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { NumericInput } from '@/components/ui/NumericInput';
import { DateInput } from '@/components/ui/DateInput';
import { SecurityPrice, CreateSecurityPriceData } from '@/types/investment';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { BondUnitHint } from '@/components/investments/BondUnitHint';

const buildPriceSchema = (t: (key: string) => string) => z.object({
  priceDate: z.string().min(1, t('priceValidation.dateRequired')),
  closePrice: z
    .number({ error: t('priceValidation.priceRequired') })
    .min(0, t('priceValidation.priceNonNegative')),
  openPrice: z.number().min(0, t('priceValidation.priceNonNegative')).optional(),
  highPrice: z.number().min(0, t('priceValidation.priceNonNegative')).optional(),
  lowPrice: z.number().min(0, t('priceValidation.priceNonNegative')).optional(),
  volume: z.number().min(0, t('priceValidation.priceNonNegative')).optional(),
});

type PriceFormData = z.infer<ReturnType<typeof buildPriceSchema>>;

interface SecurityPriceFormProps {
  price?: SecurityPrice;
  onSubmit: (data: CreateSecurityPriceData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
  /** The security's linked bond program: the form then says what a price of it is. */
  bondProgramId?: string | null;
}

export function SecurityPriceForm({ price, onSubmit, onCancel, onDirtyChange, submitRef, bondProgramId }: SecurityPriceFormProps) {
  const t = useTranslations('securities');
  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<PriceFormData>({
    resolver: zodResolver(buildPriceSchema(t)),
    defaultValues: {
      priceDate: price?.priceDate || new Date().toISOString().substring(0, 10),
      closePrice: price?.closePrice != null ? Number(price.closePrice) : undefined,
      openPrice: price?.openPrice != null ? Number(price.openPrice) : undefined,
      highPrice: price?.highPrice != null ? Number(price.highPrice) : undefined,
      lowPrice: price?.lowPrice != null ? Number(price.lowPrice) : undefined,
      volume: price?.volume != null ? Number(price.volume) : undefined,
    },
  });

  const onFormSubmit = async (data: PriceFormData) => {
    const cleanedData: CreateSecurityPriceData = {
      priceDate: data.priceDate,
      closePrice: data.closePrice,
      ...(data.openPrice !== undefined && { openPrice: data.openPrice }),
      ...(data.highPrice !== undefined && { highPrice: data.highPrice }),
      ...(data.lowPrice !== undefined && { lowPrice: data.lowPrice }),
      ...(data.volume !== undefined && { volume: data.volume }),
    };
    // onSubmit may re-throw after surfacing its own error toast (so the parent
    // keeps the form open). Swallow it here: react-hook-form's handleSubmit
    // would otherwise reject, producing an unhandled promise rejection. The
    // failure is already handled (toast) and the form stays open because the
    // parent does not clear its open state on error.
    try {
      await onSubmit(cleanedData);
    } catch {
      // handled upstream via toast; nothing to do here
    }
  };

  useFormDirtyNotify(isDirty, onDirtyChange);
  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      <DateInput
        label={t('priceForm.dateLabel')}
        error={errors.priceDate?.message}
        onDateChange={(date) => setValue('priceDate', date, { shouldDirty: true, shouldValidate: true })}
        {...register('priceDate')}
      />

      <Controller
        name="closePrice"
        control={control}
        render={({ field }) => (
          <NumericInput
            label={t('priceForm.closePriceLabel')}
            decimalPlaces={6}
            min={0}
            error={errors.closePrice?.message}
            value={field.value}
            onChange={field.onChange}
            name={field.name}
            onBlur={field.onBlur}
            ref={field.ref}
          />
        )}
      />

      <BondUnitHint programId={bondProgramId} showUnit={false} />

      <div className="grid grid-cols-2 gap-3">
        <Controller
          name="openPrice"
          control={control}
          render={({ field }) => (
            <NumericInput
              label={t('priceForm.openPriceLabel')}
              decimalPlaces={6}
              min={0}
              error={errors.openPrice?.message}
              value={field.value}
              onChange={field.onChange}
              name={field.name}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
        <Controller
          name="highPrice"
          control={control}
          render={({ field }) => (
            <NumericInput
              label={t('priceForm.highPriceLabel')}
              decimalPlaces={6}
              min={0}
              error={errors.highPrice?.message}
              value={field.value}
              onChange={field.onChange}
              name={field.name}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
        <Controller
          name="lowPrice"
          control={control}
          render={({ field }) => (
            <NumericInput
              label={t('priceForm.lowPriceLabel')}
              decimalPlaces={6}
              min={0}
              error={errors.lowPrice?.message}
              value={field.value}
              onChange={field.onChange}
              name={field.name}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
        <Controller
          name="volume"
          control={control}
          render={({ field }) => (
            <NumericInput
              label={t('priceForm.volumeLabel')}
              decimalPlaces={0}
              min={0}
              error={errors.volume?.message}
              value={field.value}
              onChange={field.onChange}
              name={field.name}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
      </div>

      <FormActions
        onCancel={onCancel}
        submitLabel={price ? t('priceForm.submitUpdate') : t('priceForm.submitCreate')}
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
