'use client';

import { MutableRefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Combobox } from '@/components/ui/Combobox';
import { FormActions } from '@/components/ui/FormActions';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { CurrencyPickerButton } from '@/components/transactions/CurrencyPickerButton';
import { AttachmentsSection } from '@/components/transactions/AttachmentsSection';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { payeesApi } from '@/lib/payees';
import { attachmentsApi } from '@/lib/attachments';
import { getCurrencySymbol } from '@/lib/format';
import { isCalendarDate } from '@/lib/calendar-month';
import { createLogger } from '@/lib/logger';
import { textOrNull } from '@/lib/form-text';
import { expiresBeforePurchase, warrantyTermEndDate } from '@/lib/warranties';
import type { Payee } from '@/types/payee';
import type { StagedAttachment } from '@/types/attachment';
import { formatNameList } from '@/lib/helpers/format-name-list';
import {
  WARRANTY_KINDS,
  WARRANTY_MAX_SERIAL_NUMBERS,
  WARRANTY_SERIAL_NUMBER_MAX_LENGTH,
  type CreateWarrantyData,
  type Warranty,
  type WarrantyKind,
} from '@/types/warranty';
import { payeeOptionIcon } from '@/components/payees/withPayeeIcons';

const logger = createLogger('WarrantyForm');

/** How the form says when coverage ends; only a date or lifetime is submitted. */
export type WarrantyExpiryMode = 'date' | 'duration' | 'lifetime';
const EXPIRY_MODES: readonly WarrantyExpiryMode[] = ['date', 'duration', 'lifetime'];

/** An http or https address, the only schemes the server accepts. */
function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const buildWarrantySchema = (t: (key: string) => string) =>
  z
    .object({
      name: z.string().trim().min(1, t('validation.nameRequired')).max(200, t('validation.nameTooLong')),
      vendorName: z.string().max(200, t('validation.vendorTooLong')),
      payeeId: z.string(),
      modelNumber: z.string().max(100, t('validation.modelTooLong')),
      serialNumbers: z
        .array(
          z.object({
            value: z.string().max(WARRANTY_SERIAL_NUMBER_MAX_LENGTH, t('validation.serialTooLong')),
          }),
        )
        .max(WARRANTY_MAX_SERIAL_NUMBERS, t('validation.serialsTooMany')),
      warrantyKind: z.enum(WARRANTY_KINDS as [WarrantyKind, ...WarrantyKind[]]),
      purchaseDate: z
        .string()
        .refine((value) => isCalendarDate(value), t('validation.purchaseDateRequired')),
      expiryMode: z.enum(EXPIRY_MODES as [WarrantyExpiryMode, ...WarrantyExpiryMode[]]),
      expiresOn: z.string(),
      termYears: z.number().optional(),
      termMonths: z.number().optional(),
      termDays: z.number().optional(),
      purchasePrice: z.number().min(0, t('validation.priceNegative')).optional(),
      currencyCode: z.string(),
      productUrl: z
        .string()
        .max(500, t('validation.urlTooLong'))
        .refine((value) => value.trim() === '' || isWebAddress(value.trim()), t('validation.urlInvalid')),
      notes: z.string().max(2000, t('validation.notesTooLong')),
    })
    .superRefine((data, ctx) => {
      // The DTO's "exactly one of expiresOn, term or isLifetime" and
      // "expiresOn on or after purchaseDate", stated where the reader can
      // fix them. The duration helper submits the date it works out.
      if (data.expiryMode === 'date') {
        if (!isCalendarDate(data.expiresOn)) {
          ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: t('validation.expiresOnRequired') });
        } else if (expiresBeforePurchase(data.expiresOn, data.purchaseDate)) {
          ctx.addIssue({ code: 'custom', path: ['expiresOn'], message: t('validation.expiresBeforePurchase') });
        }
      }
      if (data.expiryMode === 'duration' && isCalendarDate(data.purchaseDate)) {
        const end = warrantyTermEndDate(data.purchaseDate, {
          years: data.termYears,
          months: data.termMonths,
          days: data.termDays,
        });
        if (end === null) {
          ctx.addIssue({ code: 'custom', path: ['termYears'], message: t('validation.durationRequired') });
        }
      }
      if (data.purchasePrice !== undefined && data.currencyCode.trim() === '') {
        ctx.addIssue({ code: 'custom', path: ['purchasePrice'], message: t('validation.priceNeedsCurrency') });
      }
    });

export type WarrantyFormData = z.infer<ReturnType<typeof buildWarrantySchema>>;

/**
 * The request body for the form's values: one expiry source (a date or
 * lifetime -- the duration is turned into its date here), the price with its
 * currency or neither, and blank text as `null` so an update clears a field.
 */
export function toWarrantyPayload(values: WarrantyFormData, transactionId?: string | null): CreateWarrantyData {
  const expiry: Pick<CreateWarrantyData, 'expiresOn' | 'isLifetime'> =
    values.expiryMode === 'lifetime'
      ? { isLifetime: true }
      : {
          expiresOn:
            values.expiryMode === 'duration'
              ? warrantyTermEndDate(values.purchaseDate, {
                  years: values.termYears,
                  months: values.termMonths,
                  days: values.termDays,
                })
              : values.expiresOn,
        };
  const hasPrice = values.purchasePrice !== undefined;
  return {
    name: values.name.trim(),
    vendorName: textOrNull(values.vendorName),
    payeeId: values.payeeId === '' ? null : values.payeeId,
    ...(transactionId !== undefined ? { transactionId } : {}),
    modelNumber: textOrNull(values.modelNumber),
    serialNumbers: values.serialNumbers.map((s) => s.value.trim()).filter((s) => s !== ''),
    warrantyKind: values.warrantyKind,
    purchaseDate: values.purchaseDate,
    ...expiry,
    purchasePrice: hasPrice ? values.purchasePrice : null,
    currencyCode: hasPrice ? values.currencyCode : null,
    productUrl: textOrNull(values.productUrl),
    notes: textOrNull(values.notes),
  };
}

/** What a new warranty starts with when it comes from a register row. */
export type WarrantyPrefill = Partial<
  Pick<
    CreateWarrantyData,
    'name' | 'vendorName' | 'payeeId' | 'transactionId' | 'purchaseDate' | 'purchasePrice' | 'currencyCode'
  >
>;

interface WarrantyFormProps {
  warranty?: Warranty;
  /** Starting values for a new warranty (ignored when editing). */
  prefill?: WarrantyPrefill;
  /**
   * Save the warranty and resolve with the saved row; reject to keep the form
   * open. A new warranty's staged documents are uploaded to the row it
   * resolves with, so the host closes the form in `onSuccess`, not here.
   */
  onSubmit: (data: CreateWarrantyData) => Promise<Warranty>;
  /** The save and any staged uploads are done: close the form and reload. */
  onSuccess: () => void;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

function initialValues(
  warranty: Warranty | undefined,
  prefill: WarrantyPrefill | undefined,
  defaultCurrency: string,
): WarrantyFormData {
  if (warranty) {
    return {
      name: warranty.name,
      vendorName: warranty.vendorName ?? '',
      payeeId: warranty.payeeId ?? '',
      modelNumber: warranty.modelNumber ?? '',
      serialNumbers: warranty.serialNumbers.map((value) => ({ value })),
      warrantyKind: warranty.warrantyKind,
      purchaseDate: warranty.purchaseDate,
      expiryMode: warranty.isLifetime ? 'lifetime' : 'date',
      expiresOn: warranty.expiresOn ?? '',
      termYears: undefined,
      termMonths: undefined,
      termDays: undefined,
      purchasePrice: warranty.purchasePrice ?? undefined,
      currencyCode: warranty.currencyCode ?? defaultCurrency,
      productUrl: warranty.productUrl ?? '',
      notes: warranty.notes ?? '',
    };
  }
  return {
    name: prefill?.name ?? '',
    vendorName: prefill?.vendorName ?? '',
    payeeId: prefill?.payeeId ?? '',
    modelNumber: '',
    serialNumbers: [],
    warrantyKind: 'manufacturer',
    purchaseDate: prefill?.purchaseDate ?? '',
    expiryMode: 'duration',
    expiresOn: '',
    termYears: 1,
    termMonths: undefined,
    termDays: undefined,
    purchasePrice: prefill?.purchasePrice ?? undefined,
    currencyCode: prefill?.currencyCode ?? defaultCurrency,
    productUrl: '',
    notes: '',
  };
}

/** Join file names in the reader's locale, so no separator is written here. */

/**
 * Create or edit a warranty. The duration helper works out `expiresOn` from
 * the purchase date as a convenience and the form submits that date; the
 * DTO's `term` is for the importer and the API.
 *
 * A new warranty can carry documents: they are staged here and uploaded to
 * the warranty once it exists, as the New Transaction window does. An
 * existing warranty's documents are managed on its detail page.
 */
export function WarrantyForm({
  warranty,
  prefill,
  onSubmit,
  onSuccess,
  onCancel,
  onDirtyChange,
  submitRef,
}: WarrantyFormProps) {
  const t = useTranslations('warranties');
  const locale = useLocale();
  const { defaultCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [payees, setPayees] = useState<Payee[]>([]);
  const [stagedDocuments, setStagedDocuments] = useState<StagedAttachment[]>([]);

  // The vendor picker offers the payee list; a failed load leaves it a plain
  // text field, which is still a vendor the server accepts.
  useEffect(() => {
    let cancelled = false;
    payeesApi
      .getAll()
      .then((rows) => {
        if (!cancelled) setPayees(rows);
      })
      .catch((error) => logger.warn('Failed to load payees', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    register,
    control,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<WarrantyFormData>({
    resolver: zodResolver(buildWarrantySchema(t)),
    defaultValues: initialValues(warranty, prefill, defaultCurrency),
  });

  const { fields: serialFields, append: appendSerial, remove: removeSerial } = useFieldArray({
    control,
    name: 'serialNumbers',
  });

  const transactionId = warranty ? undefined : (prefill?.transactionId ?? undefined);

  // Upload the documents staged in the New Warranty window to the warranty
  // just created. The warranty already exists at this point, so a failed
  // upload is reported by name but never undoes the save.
  const uploadStagedDocuments = useCallback(
    async (warrantyId: string) => {
      const failed: string[] = [];
      for (const { file, original } of stagedDocuments) {
        try {
          // A scan pair goes in ONE request, which is what makes it a pair.
          await attachmentsApi.upload({ warrantyId }, file, original);
        } catch (error) {
          failed.push(file.name);
          logger.error('Failed to upload a staged document:', error);
        }
      }
      if (failed.length > 0) {
        toast.error(
          t('documents.uploadFailedAfterCreate', {
            count: failed.length,
            names: formatNameList(locale, failed),
          }),
        );
      }
    },
    [stagedDocuments, t, locale],
  );

  const handleValid = useCallback(
    async (data: WarrantyFormData) => {
      const saved = await onSubmit(toWarrantyPayload(data, transactionId));
      if (!warranty) await uploadStagedDocuments(saved.id);
      onSuccess();
    },
    [onSubmit, onSuccess, transactionId, warranty, uploadStagedDocuments],
  );

  // A staged document is an unsaved change: closing the window drops it.
  useFormDirtyNotify(isDirty || stagedDocuments.length > 0, onDirtyChange);
  useFormSubmitRef(submitRef, handleSubmit, handleValid);

  const expiryMode = useWatch({ control, name: 'expiryMode' });
  const purchaseDate = useWatch({ control, name: 'purchaseDate' });
  const expiresOn = useWatch({ control, name: 'expiresOn' });
  const termYears = useWatch({ control, name: 'termYears' });
  const termMonths = useWatch({ control, name: 'termMonths' });
  const termDays = useWatch({ control, name: 'termDays' });
  const currencyCode = useWatch({ control, name: 'currencyCode' });
  const payeeId = useWatch({ control, name: 'payeeId' });

  const computedEnd = useMemo(
    () => warrantyTermEndDate(purchaseDate, { years: termYears, months: termMonths, days: termDays }),
    [purchaseDate, termYears, termMonths, termDays],
  );

  const changeExpiryMode = (mode: WarrantyExpiryMode) => {
    if (mode === expiryMode) return;
    // Moving from the duration helper to a date carries its answer across.
    if (mode === 'date' && expiresOn === '' && computedEnd !== null) {
      setValue('expiresOn', computedEnd, { shouldDirty: true });
    }
    // Lifetime has no end date: the date is cleared, not merely hidden.
    if (mode === 'lifetime') {
      setValue('expiresOn', '', { shouldDirty: true });
    }
    setValue('expiryMode', mode, { shouldDirty: true, shouldValidate: false });
  };

  const payeeOptions = useMemo(
    () =>
      payees.map((payee) => ({
        value: payee.id,
        label: payee.name,
        icon: payeeOptionIcon(payee),
      })),
    [payees],
  );

  const onFormSubmit = (e?: React.BaseSyntheticEvent) => {
    handleSubmit(handleValid)(e);
  };

  const termError = errors.termYears?.message;

  return (
    <form onSubmit={onFormSubmit} className="space-y-4">
      <Input
        label={t('form.nameLabel')}
        placeholder={t('form.namePlaceholder')}
        maxLength={200}
        error={errors.name?.message}
        {...register('name')}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Combobox
          label={t('form.vendorLabel')}
          placeholder={t('form.vendorPlaceholder')}
          options={payeeOptions}
          value={payeeId}
          initialDisplayValue={warranty?.vendorName ?? prefill?.vendorName ?? ''}
          onChange={(id, label) => {
            // A picked payee sets both; typed text is a vendor with no payee.
            setValue('payeeId', id, { shouldDirty: true });
            setValue('vendorName', label, { shouldDirty: true, shouldValidate: true });
          }}
          allowCustomValue
          valueIsId
          usePortal
          error={errors.vendorName?.message}
        />
        <Select
          label={t('form.kindLabel')}
          options={WARRANTY_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))}
          error={errors.warrantyKind?.message}
          {...register('warrantyKind')}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label={t('form.modelLabel')}
          maxLength={100}
          error={errors.modelNumber?.message}
          {...register('modelNumber')}
        />
        <DateInput
          label={t('form.purchaseDateLabel')}
          value={purchaseDate}
          onDateChange={(date) => setValue('purchaseDate', date, { shouldDirty: true, shouldValidate: true })}
          error={errors.purchaseDate?.message}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('form.serialsLabel')}
        </legend>
        {serialFields.map((field, index) => (
          <div key={field.id} className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <Input
                id={`warranty-serial-${field.id}`}
                aria-label={t('form.serialLabel', { index: index + 1 })}
                maxLength={WARRANTY_SERIAL_NUMBER_MAX_LENGTH}
                error={errors.serialNumbers?.[index]?.value?.message}
                {...register(`serialNumbers.${index}.value` as const)}
              />
            </div>
            <button
              type="button"
              onClick={() => removeSerial(index)}
              aria-label={t('form.removeSerial', { index: index + 1 })}
              className="mt-1 rounded px-2 py-1.5 text-sm text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 focus-visible:outline-2 focus-visible:outline-blue-500"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => appendSerial({ value: '' })}
            disabled={serialFields.length >= WARRANTY_MAX_SERIAL_NUMBERS}
            className="text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-blue-500 rounded"
          >
            {t('form.addSerial')}
          </button>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('form.serialsLimit', { max: WARRANTY_MAX_SERIAL_NUMBERS })}
          </span>
        </div>
        {errors.serialNumbers?.message && (
          <p className="text-sm text-red-600 dark:text-red-400">{errors.serialNumbers.message}</p>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('form.expiry.label')}
        </legend>
        <div role="group" aria-label={t('form.expiry.label')} className={`${SEGMENTED_GROUP_CLASS} max-w-full flex-wrap`}>
          {EXPIRY_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={expiryMode === mode}
              onClick={() => changeExpiryMode(mode)}
              className={segmentClass(expiryMode === mode)}
            >
              {t(`form.expiry.${mode}`)}
            </button>
          ))}
        </div>

        {expiryMode === 'date' && (
          <DateInput
            label={t('form.expiry.expiresOnLabel')}
            value={expiresOn}
            onDateChange={(date) => setValue('expiresOn', date, { shouldDirty: true, shouldValidate: true })}
            error={errors.expiresOn?.message}
          />
        )}

        {expiryMode === 'duration' && (
          <div className="space-y-1">
            <div className="grid grid-cols-3 gap-3">
              <Controller
                control={control}
                name="termYears"
                render={({ field }) => (
                  <NumericInput
                    id="warranty-term-years"
                    label={t('form.expiry.years')}
                    decimalPlaces={0}
                    max={100}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                )}
              />
              <Controller
                control={control}
                name="termMonths"
                render={({ field }) => (
                  <NumericInput
                    id="warranty-term-months"
                    label={t('form.expiry.months')}
                    decimalPlaces={0}
                    max={1200}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                )}
              />
              <Controller
                control={control}
                name="termDays"
                render={({ field }) => (
                  <NumericInput
                    id="warranty-term-days"
                    label={t('form.expiry.days')}
                    decimalPlaces={0}
                    max={36500}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                )}
              />
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
              {computedEnd !== null
                ? t('form.expiry.computed', { date: formatDate(computedEnd) })
                : isCalendarDate(purchaseDate)
                  ? null
                  : t('form.expiry.needsPurchaseDate')}
            </p>
            {termError && <p className="text-sm text-red-600 dark:text-red-400">{termError}</p>}
          </div>
        )}

        {expiryMode === 'lifetime' && (
          <p className="text-sm text-gray-600 dark:text-gray-400">{t('form.expiry.lifetimeHint')}</p>
        )}
      </fieldset>

      <div className="flex items-stretch space-x-2">
        <CurrencyPickerButton
          value={currencyCode === defaultCurrency ? '' : currencyCode}
          accountCurrencyCode={defaultCurrency}
          onChange={(code) => setValue('currencyCode', code || defaultCurrency, { shouldDirty: true })}
        />
        <div className="flex-1 min-w-0">
          <Controller
            control={control}
            name="purchasePrice"
            render={({ field }) => (
              <CurrencyInput
                id="warranty-purchase-price"
                label={t('form.priceLabel')}
                prefix={getCurrencySymbol(currencyCode || defaultCurrency)}
                allowNegative={false}
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                name={field.name}
                ref={field.ref}
                error={errors.purchasePrice?.message}
              />
            )}
          />
        </div>
      </div>

      <Input
        label={t('form.productUrlLabel')}
        placeholder={t('form.productUrlPlaceholder')}
        type="url"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={500}
        error={errors.productUrl?.message}
        {...register('productUrl')}
      />

      <div>
        <label htmlFor="warranty-notes" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('form.notesLabel')}
        </label>
        <textarea
          id="warranty-notes"
          rows={3}
          maxLength={2000}
          className="block w-full rounded-md border-gray-300 shadow-sm focus:outline-none focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus-visible:border-blue-400 dark:focus-visible:ring-blue-400"
          {...register('notes')}
        />
        {errors.notes && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{errors.notes.message}</p>}
      </div>

      {/* A new warranty's documents are staged and uploaded once it has been
          created; an existing warranty's are managed on its detail page. */}
      {!warranty && (
        <AttachmentsSection
          stagedFiles={stagedDocuments}
          onStagedFilesChange={setStagedDocuments}
          stagedFor="warranty"
        />
      )}

      <FormActions
        onCancel={onCancel}
        submitLabel={warranty ? t('form.submitUpdate') : t('form.submitCreate')}
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
