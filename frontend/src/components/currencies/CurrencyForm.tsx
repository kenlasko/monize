'use client';

import { useState, useCallback, MutableRefObject } from 'react';
import { useForm, useWatch, Controller, Resolver } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { CurrencyInfo, CreateCurrencyData } from '@/lib/exchange-rates';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { createLogger } from '@/lib/logger';
import { getErrorCode, getErrorMessage } from '@/lib/errors';
import { useTranslations } from 'next-intl';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { docsUrl } from '@/lib/docs-links';
import { isKnownIsoCurrency } from '@/lib/iso-currency';
import { RateHistoryCoverage } from './RateHistoryCoverage';

const logger = createLogger('CurrencyForm');

const buildCurrencySchema = (t: (key: string) => string) => z.object({
  code: z.string().length(3, t('validation.codeLength')),
  name: z.string().min(1, t('validation.nameRequired')).max(100, t('validation.nameMax')),
  symbol: z.string().min(1, t('validation.symbolRequired')).max(10, t('validation.symbolMax')),
  decimalPlaces: z.coerce.number().int().min(0).max(4).default(2),
});

type CurrencyFormData = z.infer<ReturnType<typeof buildCurrencySchema>>;

interface CurrencyFormProps {
  currency?: CurrencyInfo;
  onSubmit: (data: CreateCurrencyData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
  /**
   * When provided, a create that fails because the currency already exists but
   * is inactive is caught here: an inline note is shown and this callback is
   * invoked (with the currency code) when the user chooses to reactivate it.
   * Without it, the inactive error propagates to the caller like any other.
   */
  onReactivate?: (code: string) => Promise<void>;
}

export function CurrencyForm({ currency, onSubmit, onCancel, onDirtyChange, submitRef, onReactivate }: CurrencyFormProps) {
  const t = useTranslations('currencies');
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);
  // Set to the currency code when a create is blocked because that currency is
  // already in the user's list but inactive; drives the reactivation note.
  const [inactiveCode, setInactiveCode] = useState<string | null>(null);
  const [isReactivating, setIsReactivating] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    reset,
    control,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CurrencyFormData>({
    resolver: zodResolver(buildCurrencySchema(t)) as Resolver<CurrencyFormData>,
    defaultValues: {
      code: currency?.code || '',
      name: currency?.name || '',
      symbol: currency?.symbol || '',
      decimalPlaces: currency?.decimalPlaces ?? 2,
    },
  });

  // A complete three-letter code that is no ISO currency is most likely a coin;
  // tell the user where coins go, without blocking the save.
  const watchedCode = useWatch({ control, name: 'code' });
  const typedCode = (watchedCode ?? '').trim().toUpperCase();
  const showCryptoNotice =
    !currency && /^[A-Z]{3}$/.test(typedCode) && !isKnownIsoCurrency(typedCode);

  const handleLookup = useCallback(async () => {
    const { code, name } = getValues();
    // Use code if provided, otherwise fall back to name field (for country/currency name search)
    const codeQuery = code?.trim() || '';
    const nameQuery = name?.trim() || '';
    const query = codeQuery.length >= 2 ? codeQuery : nameQuery;

    if (query.length < 2) {
      toast.error(t('form.toasts.lookupTooShort'));
      return;
    }

    setIsLookingUp(true);
    try {
      const result = await exchangeRatesApi.lookupCurrency(query);
      if (result) {
        setValue('code', result.code);
        setValue('name', result.name);
        setValue('symbol', result.symbol);
        setValue('decimalPlaces', result.decimalPlaces);
        setHasLookupResult(true);

        const details = [`Code: ${result.code}`, `Name: ${result.name}`, `Symbol: ${result.symbol}`];
        toast.success(t('form.toasts.found', { details: details.join(', ') }));
      } else {
        toast.error(t('form.toasts.notFound', { query }));
      }
    } catch (error) {
      logger.error('Currency lookup failed:', error);
      toast.error(t('form.toasts.lookupFailed'));
    } finally {
      setIsLookingUp(false);
    }
  }, [getValues, setValue, t]);

  const handleClear = useCallback(() => {
    reset({
      code: '',
      name: '',
      symbol: '',
      decimalPlaces: 2,
    });
    setHasLookupResult(false);
  }, [reset]);

  const onFormSubmit = async (data: CurrencyFormData) => {
    const cleanedData: CreateCurrencyData = {
      code: data.code.toUpperCase().trim(),
      name: data.name.trim(),
      symbol: data.symbol.trim(),
      decimalPlaces: data.decimalPlaces,
    };
    setInactiveCode(null);
    try {
      await onSubmit(cleanedData);
    } catch (error) {
      // The currency exists but is inactive: surface the reactivation note
      // instead of a dead-end failure.
      if (onReactivate && getErrorCode(error) === 'CURRENCY_INACTIVE') {
        setInactiveCode(cleanedData.code);
        return;
      }
      // Other failures are reported by the caller (which toasts before
      // rethrowing); swallow here so a rejected submit does not surface as an
      // unhandled promise rejection.
      logger.error('Currency save failed:', error);
    }
  };

  const handleReactivate = useCallback(async () => {
    if (!inactiveCode || !onReactivate) return;
    setIsReactivating(true);
    try {
      await onReactivate(inactiveCode);
    } catch (error) {
      logger.error('Currency reactivation failed:', error);
      toast.error(getErrorMessage(error, t('form.toasts.reactivateFailed')));
    } finally {
      setIsReactivating(false);
    }
  }, [inactiveCode, onReactivate, t]);

  // Editing the code invalidates a pending reactivation note.
  const codeField = register('code');

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);

  return (
    <div className="space-y-4">
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      {/* Code + Lookup / Clear buttons */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Input
            label={t('form.codeLabel')}
            {...codeField}
            onChange={(e) => {
              setInactiveCode(null);
              return codeField.onChange(e);
            }}
            error={errors.code?.message}
            placeholder={t('form.codePlaceholder')}
            className="uppercase"
            disabled={!!currency}
          />
        </div>
        {!currency && (
          <div className="flex gap-1.5">
            <Button
              type="button"
              variant="outline"
              onClick={handleLookup}
              disabled={isLookingUp}
              className="mb-[1px]"
            >
              {isLookingUp ? t('form.lookingUp') : t('form.lookupButton')}
            </Button>
            {hasLookupResult && (
              <Button
                type="button"
                variant="ghost"
                onClick={handleClear}
                className="mb-[1px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                title={t('form.clearTitle')}
              >
                {t('form.clearButton')}
              </Button>
            )}
          </div>
        )}
      </div>

      <Input
        label={t('form.nameLabel')}
        {...register('name')}
        error={errors.name?.message}
        placeholder={currency ? t('form.namePlaceholderEdit') : t('form.namePlaceholderCreate')}
      />

      <Input
        label={t('form.symbolLabel')}
        {...register('symbol')}
        error={errors.symbol?.message}
        placeholder={t('form.symbolPlaceholder')}
      />

      <Controller
        name="decimalPlaces"
        control={control}
        render={({ field }) => (
          <NumericInput
            label={t('form.decimalPlacesLabel')}
            decimalPlaces={0}
            min={0}
            max={4}
            error={errors.decimalPlaces?.message}
            value={field.value}
            onChange={field.onChange}
            name={field.name}
            onBlur={field.onBlur}
            ref={field.ref}
          />
        )}
      />

      {showCryptoNotice && (
        <div
          role="note"
          className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3"
        >
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {t.rich('form.cryptoNotice', {
              code: typedCode,
              guide: (chunks) => (
                <a
                  href={docsUrl('cryptocurrency')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline hover:text-blue-900 dark:hover:text-blue-100"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>
        </div>
      )}

      {inactiveCode && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {t('form.inactiveNotice', { code: inactiveCode })}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={handleReactivate}
            disabled={isReactivating}
          >
            {isReactivating ? t('form.reactivating') : t('form.reactivateButton', { code: inactiveCode })}
          </Button>
        </div>
      )}

      <FormActions onCancel={onCancel} submitLabel={currency ? t('form.submitUpdate') : t('form.submitCreate')} isSubmitting={isSubmitting} />
    </form>
    {/*
      Outside the `<form>` on purpose: extending the stored rate history saves
      nothing of the user's, so it must not mark the form dirty or be reachable
      by the form's submit. Only for a currency that already exists -- a
      currency being created has no pair to have history for yet.
    */}
    {currency && <RateHistoryCoverage code={currency.code} />}
    </div>
  );
}
