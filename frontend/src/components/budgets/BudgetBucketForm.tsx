'use client';

import { MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { useForm, Controller, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { FormActions } from '@/components/ui/FormActions';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { entryDecimalPlaces, getCurrencySymbol, roundToDecimals } from '@/lib/format';
import type { BudgetBucketTargetType } from '@/types/budget';
import type { BudgetBucketDraft } from './utils/budget-bucket-presets';

/** Design decision 10: a name is 1 to 50 characters. */
export const BUDGET_BUCKET_NAME_MAX = 50;
const TARGET_TYPES = ['PERCENT', 'AMOUNT'] as const;

/** The duplicate rule of decision 10: case and surrounding space do not count. */
export function normalizeBudgetBucketName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Mirrors the server's refusals (design 6.4) so most of them are caught before
 * a request; the server stays the authority and its message is shown when it
 * refuses anyway.
 */
export const buildBudgetBucketFormSchema = (
  t: (key: string, values?: Record<string, string | number>) => string,
  otherNames: readonly string[],
) => {
  const taken = new Set(otherNames.map(normalizeBudgetBucketName));
  return z
    .object({
      name: z
        .string()
        .trim()
        .min(1, t('bucketEditor.validation.nameRequired'))
        .max(BUDGET_BUCKET_NAME_MAX, t('bucketEditor.validation.nameMax', { max: BUDGET_BUCKET_NAME_MAX }))
        .refine((name) => !taken.has(normalizeBudgetBucketName(name)), t('bucketEditor.validation.nameDuplicate')),
      targetType: z.enum(TARGET_TYPES),
      targetValue: z.number().optional(),
      carryOver: z.boolean(),
      carryCap: z.number().optional(),
    })
    .superRefine((data, ctx) => {
      const value = data.targetValue;
      if (value === undefined) {
        ctx.addIssue({ code: 'custom', path: ['targetValue'], message: t('bucketEditor.validation.targetRequired') });
      } else if (data.targetType === 'PERCENT') {
        if (!(value > 0) || value > 100) {
          ctx.addIssue({ code: 'custom', path: ['targetValue'], message: t('bucketEditor.validation.percentRange') });
        } else if (roundToDecimals(value, 2) !== value) {
          ctx.addIssue({ code: 'custom', path: ['targetValue'], message: t('bucketEditor.validation.percentDecimals') });
        }
      } else if (!(value > 0)) {
        ctx.addIssue({ code: 'custom', path: ['targetValue'], message: t('bucketEditor.validation.amountPositive') });
      }
      if (data.carryCap !== undefined) {
        if (!data.carryOver) {
          ctx.addIssue({ code: 'custom', path: ['carryCap'], message: t('bucketEditor.validation.capNeedsCarryOver') });
        } else if (!(data.carryCap > 0)) {
          ctx.addIssue({ code: 'custom', path: ['carryCap'], message: t('bucketEditor.validation.capPositive') });
        }
      }
    });
};

export type BudgetBucketFormData = z.infer<ReturnType<typeof buildBudgetBucketFormSchema>>;

/** The form's values as a draft; only called on values the schema accepted. */
export function toBudgetBucketDraft(data: BudgetBucketFormData): BudgetBucketDraft {
  return {
    name: data.name.trim(),
    targetType: data.targetType,
    targetValue: data.targetValue as number,
    carryOver: data.carryOver,
    carryCap: data.carryOver && data.carryCap !== undefined ? data.carryCap : null,
  };
}

interface BudgetBucketFormProps {
  /** The bucket being edited; omitted for a new one. */
  bucket?: BudgetBucketDraft;
  /** The budget's currency: an amount target and the cap are in it. */
  currencyCode: string;
  /** Names of the other buckets in the list, for the duplicate check. */
  otherNames: readonly string[];
  onSubmit: (draft: BudgetBucketDraft) => Promise<void> | void;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function BudgetBucketForm({
  bucket,
  currencyCode,
  otherNames,
  onSubmit,
  onCancel,
  onDirtyChange,
  submitRef,
}: BudgetBucketFormProps) {
  const t = useTranslations('budgets');
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<BudgetBucketFormData>({
    resolver: zodResolver(buildBudgetBucketFormSchema(t, otherNames)),
    defaultValues: {
      name: bucket?.name ?? '',
      targetType: bucket?.targetType ?? 'PERCENT',
      targetValue: bucket?.targetValue,
      carryOver: bucket?.carryOver ?? false,
      carryCap: bucket?.carryCap ?? undefined,
    },
  });

  const submit = async (data: BudgetBucketFormData) => {
    await onSubmit(toBudgetBucketDraft(data));
  };

  useFormDirtyNotify(isDirty, onDirtyChange);
  useFormSubmitRef(submitRef, handleSubmit, submit);

  const targetType = useWatch({ control, name: 'targetType' });
  const carryOver = useWatch({ control, name: 'carryOver' });
  const symbol = getCurrencySymbol(currencyCode);
  const decimals = entryDecimalPlaces(currencyCode);

  const chooseTargetType = (next: BudgetBucketTargetType) => {
    if (next === targetType) return;
    setValue('targetType', next, { shouldDirty: true });
    // A percent and an amount are different quantities: never carry one over as the other.
    setValue('targetValue', undefined, { shouldDirty: true });
  };

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
      <Input
        label={t('bucketEditor.form.name')}
        {...register('name')}
        error={errors.name?.message}
        maxLength={BUDGET_BUCKET_NAME_MAX}
        placeholder={t('bucketEditor.form.namePlaceholder')}
      />

      <div>
        <div className="flex items-center mb-1">
          <span id="bucket-target-type-label" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('bucketEditor.form.targetType')}
          </span>
          <InfoTooltip text={t('bucketEditor.form.targetTypeTooltip')} placement="top" usePortal />
        </div>
        <div role="group" aria-labelledby="bucket-target-type-label" className={SEGMENTED_GROUP_CLASS}>
          {TARGET_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={targetType === type}
              className={segmentClass(targetType === type)}
              onClick={() => chooseTargetType(type)}
            >
              {t(`bucketEditor.targetTypes.${type}`)}
            </button>
          ))}
        </div>
      </div>

      <Controller
        name="targetValue"
        control={control}
        render={({ field }) =>
          targetType === 'PERCENT' ? (
            <NumericInput
              id="bucket-target-percent"
              label={t('bucketEditor.form.targetPercent')}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              name={field.name}
              decimalPlaces={2}
              suffix="%"
              error={errors.targetValue?.message}
            />
          ) : (
            <CurrencyInput
              id="bucket-target-amount"
              label={t('bucketEditor.form.targetAmount')}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              name={field.name}
              allowNegative={false}
              decimalPlaces={decimals}
              prefix={symbol}
              error={errors.targetValue?.message}
            />
          )
        }
      />

      <div className="flex items-center gap-3">
        <Controller
          name="carryOver"
          control={control}
          render={({ field }) => (
            <ToggleSwitch
              checked={field.value}
              label={t('bucketEditor.form.carryOver')}
              onChange={(next) => {
                field.onChange(next);
                // A cap means nothing without carry-over (the server refuses one).
                if (!next) setValue('carryCap', undefined, { shouldDirty: true });
              }}
            />
          )}
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">{t('bucketEditor.form.carryOver')}</span>
        <InfoTooltip text={t('bucketEditor.form.carryOverTooltip')} placement="top" usePortal />
      </div>

      {carryOver && (
        <Controller
          name="carryCap"
          control={control}
          render={({ field }) => (
            <CurrencyInput
              id="bucket-carry-cap"
              label={t('bucketEditor.form.carryCap')}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              name={field.name}
              allowNegative={false}
              decimalPlaces={decimals}
              prefix={symbol}
              placeholder={t('bucketEditor.form.carryCapPlaceholder')}
              error={errors.carryCap?.message}
            />
          )}
        />
      )}

      <FormActions
        onCancel={onCancel}
        submitLabel={bucket ? t('bucketEditor.form.saveChanges') : t('bucketEditor.form.save')}
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
