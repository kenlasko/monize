'use client';

import { MutableRefObject, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Institution } from '@/types/institution';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';

const buildInstitutionSchema = (t: (key: string) => string) =>
  z.object({
    name: z.string().min(1, t('validation.nameRequired')).max(255),
    website: z
      .string()
      .min(1, t('validation.websiteRequired'))
      .max(2048)
      .refine((value) => {
        const trimmed = value.trim();
        return !/\s/.test(trimmed) && /\.[a-z]{2,}/i.test(trimmed);
      }, t('validation.websiteInvalid')),
    country: z
      .union([
        z.literal(''),
        z.string().regex(/^[A-Za-z]{2}$/, t('validation.countryInvalid')),
      ])
      .optional(),
  });

export type InstitutionFormData = z.infer<
  ReturnType<typeof buildInstitutionSchema>
>;

interface InstitutionFormProps {
  institution?: Institution;
  /** Pre-fill the name field (used when creating from the account form). */
  initialName?: string;
  onSubmit: (data: InstitutionFormData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function InstitutionForm({
  institution,
  initialName,
  onSubmit,
  onCancel,
  onDirtyChange,
  submitRef,
}: InstitutionFormProps) {
  const t = useTranslations('institutions');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<InstitutionFormData>({
    resolver: zodResolver(buildInstitutionSchema(t)),
    defaultValues: institution
      ? {
          name: institution.name,
          website: institution.website,
          country: institution.country || '',
        }
      : { name: initialName || '', website: '', country: '' },
  });

  // Normalise the optional country (empty string -> undefined, upper-cased)
  // before handing the data to the caller so it satisfies the backend's
  // optional 2-letter validation.
  const handleValid = useCallback(
    (data: InstitutionFormData) =>
      onSubmit({
        ...data,
        country: data.country?.trim()
          ? data.country.trim().toUpperCase()
          : undefined,
      }),
    [onSubmit],
  );

  useFormDirtyNotify(isDirty, onDirtyChange);
  useFormSubmitRef(submitRef, handleSubmit, handleValid);

  const onFormSubmit = (e?: React.BaseSyntheticEvent) => {
    handleSubmit(handleValid)(e);
  };

  return (
    <form onSubmit={onFormSubmit} className="space-y-4">
      <Input
        label={t('form.nameLabel')}
        error={errors.name?.message}
        {...register('name')}
      />

      <Input
        label={t('form.websiteLabel')}
        placeholder={t('form.websitePlaceholder')}
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        error={errors.website?.message}
        {...register('website')}
      />

      <Input
        label={t('form.countryLabel')}
        placeholder={t('form.countryPlaceholder')}
        maxLength={2}
        error={errors.country?.message}
        {...register('country')}
      />

      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('form.logoHint')}
      </p>

      <FormActions
        onCancel={onCancel}
        submitLabel={
          institution ? t('form.submitUpdate') : t('form.submitCreate')
        }
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
