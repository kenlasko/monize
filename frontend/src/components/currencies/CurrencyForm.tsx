'use client';

import { useState, useCallback, MutableRefObject } from 'react';
import { useForm, useWatch, Controller, Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { CurrencyInfo, CreateCurrencyData } from '@/lib/exchange-rates';
import { CURRENCY_KINDS, type CurrencyKind } from '@/lib/currency-kind';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { investmentsApi } from '@/lib/investments';
import { quoteSymbolFiat } from '@/lib/crypto-quote-symbol';
import { createLogger } from '@/lib/logger';
import { getErrorCode, getErrorMessage } from '@/lib/errors';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { docsUrl } from '@/lib/docs-links';
import { isKnownIsoCurrency } from '@/lib/iso-currency';
import { RateHistoryCoverage } from './RateHistoryCoverage';
import {
  buildCurrencySchema,
  CRYPTO_DEFAULT_DECIMAL_PLACES,
  MAX_CURRENCY_DECIMAL_PLACES,
  FIAT_DEFAULT_DECIMAL_PLACES,
  type CurrencyFormData,
} from './currency-form-schema';

const logger = createLogger('CurrencyForm');

/** A price symbol the form has checked, or the one the row was saved with. */
interface PricedSymbol {
  symbol: string;
  fiat: string;
}

/** A Verify that refused a symbol, remembered against the symbol it refused. */
interface SymbolRefusal {
  symbol: string;
  message: string;
}

const KIND_OPTION_KEYS: Record<CurrencyKind, string> = {
  FIAT: 'form.kindOptions.fiat',
  CRYPTO: 'form.kindOptions.crypto',
};

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
  /**
   * The edited currency is referenced by an account or a security, so the
   * server refuses a change of kind (`currencies.kindInUse`) and the control is
   * shown disabled. The server is the authority: a code referenced elsewhere is
   * refused on save, and the page shows its message.
   */
  inUse?: boolean;
}

export function CurrencyForm({ currency, onSubmit, onCancel, onDirtyChange, submitRef, onReactivate, inUse = false }: CurrencyFormProps) {
  const t = useTranslations('currencies');
  const { formatNumber } = useNumberFormat();
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);
  // Set to the currency code when a create is blocked because that currency is
  // already in the user's list but inactive; drives the reactivation note.
  const [inactiveCode, setInactiveCode] = useState<string | null>(null);
  const [isReactivating, setIsReactivating] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  // The saved symbol counts as priced; a Verify replaces it with the answer.
  const savedQuoteSymbol = currency?.quoteSymbol?.trim().toUpperCase() || '';
  const savedQuoteFiat = quoteSymbolFiat(savedQuoteSymbol);
  const [pricedSymbol, setPricedSymbol] = useState<PricedSymbol | null>(
    savedQuoteSymbol && savedQuoteFiat ? { symbol: savedQuoteSymbol, fiat: savedQuoteFiat } : null,
  );
  const [symbolRefusal, setSymbolRefusal] = useState<SymbolRefusal | null>(null);
  // Once the reader types a precision, switching the kind leaves it alone.
  const [decimalsTouched, setDecimalsTouched] = useState(false);

  const initialKind: CurrencyKind = currency?.kind ?? 'FIAT';
  const kindLocked = !!currency && inUse;

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
      decimalPlaces: currency?.decimalPlaces ?? FIAT_DEFAULT_DECIMAL_PLACES,
      kind: initialKind,
      quoteSymbol: savedQuoteSymbol,
    },
  });

  const watchedCode = useWatch({ control, name: 'code' });
  const typedCode = (watchedCode ?? '').trim().toUpperCase();
  const kind = useWatch({ control, name: 'kind' }) ?? 'FIAT';
  const watchedQuote = useWatch({ control, name: 'quoteSymbol' });
  const typedQuote = (watchedQuote ?? '').trim().toUpperCase();
  const isCrypto = kind === 'CRYPTO';
  // A complete three-letter code that is no ISO currency may be a coin: say so
  // and offer the Cryptocurrency kind, without blocking a fiat save (a reader
  // may hold a non-ISO fiat code, so nothing infers the kind).
  const showNonIsoNotice =
    !currency && !isCrypto && /^[A-Z]{3}$/.test(typedCode) && !isKnownIsoCurrency(typedCode);
  // What Verify (or the saved row) said about the symbol now in the field;
  // editing the symbol retires both, without an effect.
  const shownPriced = pricedSymbol && pricedSymbol.symbol === typedQuote ? pricedSymbol : null;
  const shownRefusal = symbolRefusal && symbolRefusal.symbol === typedQuote ? symbolRefusal : null;

  const defaultDecimalsFor = useCallback(
    (next: CurrencyKind): number => {
      if (currency && initialKind === next) return currency.decimalPlaces;
      return next === 'CRYPTO' ? CRYPTO_DEFAULT_DECIMAL_PLACES : FIAT_DEFAULT_DECIMAL_PLACES;
    },
    [currency, initialKind],
  );

  const changeKind = useCallback(
    (next: CurrencyKind) => {
      if (kindLocked || next === getValues('kind')) return;
      setValue('kind', next, { shouldDirty: true });
      // A fiat currency carries no price symbol, and the field is hidden.
      if (next === 'FIAT') setValue('quoteSymbol', '', { shouldDirty: true });
      if (!decimalsTouched) {
        setValue('decimalPlaces', defaultDecimalsFor(next), { shouldDirty: true });
      }
    },
    [kindLocked, getValues, setValue, decimalsTouched, defaultDecimalsFor],
  );

  const handleVerify = useCallback(async () => {
    const symbol = (getValues('quoteSymbol') ?? '').trim().toUpperCase();
    if (!symbol) {
      toast.error(t('form.toasts.verifyEmpty'));
      return;
    }
    if (!quoteSymbolFiat(symbol)) {
      setSymbolRefusal({ symbol, message: t('validation.quoteSymbolNotAPair') });
      return;
    }
    setIsVerifying(true);
    try {
      // Yahoo is the source the coin's rate is fetched from, so it is the one
      // asked here.
      const result = await investmentsApi.lookupSecurity(symbol, undefined, 'yahoo');
      if (!result) {
        setSymbolRefusal({ symbol, message: t('form.quoteSymbolNotFound', { symbol }) });
        return;
      }
      if (result.securityType !== 'CRYPTO') {
        setSymbolRefusal({ symbol, message: t('form.quoteSymbolNotCrypto', { symbol }) });
        return;
      }
      const found = result.symbol.trim().toUpperCase();
      const fiat = quoteSymbolFiat(found);
      if (!fiat) {
        setSymbolRefusal({ symbol, message: t('validation.quoteSymbolNotAPair') });
        return;
      }
      setSymbolRefusal(null);
      setPricedSymbol({ symbol: found, fiat });
      if (found !== symbol) setValue('quoteSymbol', found, { shouldDirty: true });
      if (!(getValues('name') ?? '').trim() && result.name) {
        setValue('name', result.name, { shouldDirty: true });
      }
    } catch (error) {
      logger.error('Price symbol verification failed:', error);
      toast.error(t('form.toasts.verifyFailed'));
    } finally {
      setIsVerifying(false);
    }
  }, [getValues, setValue, t]);

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
      decimalPlaces: FIAT_DEFAULT_DECIMAL_PLACES,
      kind: 'FIAT',
      quoteSymbol: '',
    });
    setHasLookupResult(false);
    setDecimalsTouched(false);
    setPricedSymbol(null);
    setSymbolRefusal(null);
  }, [reset]);

  const onFormSubmit = async (data: CurrencyFormData) => {
    const quoteSymbol = (data.quoteSymbol ?? '').trim().toUpperCase();
    const cleanedData: CreateCurrencyData = {
      code: data.code.toUpperCase().trim(),
      name: data.name.trim(),
      symbol: data.symbol.trim(),
      decimalPlaces: data.decimalPlaces,
      kind: data.kind,
      // Null is "no price symbol": always so on a fiat currency, and an
      // unpriced coin when the field is left empty.
      quoteSymbol: data.kind === 'CRYPTO' && quoteSymbol ? quoteSymbol : null,
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
  const quoteField = register('quoteSymbol');

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

      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('form.kindLabel')}
        </legend>
        <div role="group" aria-label={t('form.kindLabel')} className={SEGMENTED_GROUP_CLASS}>
          {CURRENCY_KINDS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              disabled={kindLocked}
              onClick={() => changeKind(option)}
              className={`${segmentClass(kind === option)} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {t(KIND_OPTION_KEYS[option])}
            </button>
          ))}
        </div>
        {kindLocked && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('form.kindLocked', { code: typedCode })}
          </p>
        )}
      </fieldset>

      {isCrypto && (
        <div>
          <div className="flex items-center mb-1">
            <label
              htmlFor="currency-quote-symbol"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('form.quoteSymbolLabel')}
            </label>
            <InfoTooltip text={t('form.quoteSymbolHelp')} placement="bottom" usePortal />
          </div>
          <div className="flex gap-2 items-start">
            <div className="flex-1">
              <Input
                id="currency-quote-symbol"
                {...quoteField}
                error={shownRefusal?.message ?? errors.quoteSymbol?.message}
                placeholder={t('form.quoteSymbolPlaceholder')}
                className="uppercase"
                autoComplete="off"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleVerify}
              isLoading={isVerifying}
              className="mt-[1px]"
            >
              {t('form.verifyButton')}
            </Button>
          </div>
          {shownPriced ? (
            <p className="mt-1 text-sm text-green-700 dark:text-green-400">
              {t('form.quoteSymbolPricedIn', { currency: shownPriced.fiat })}
            </p>
          ) : !typedQuote ? (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('form.quoteSymbolMissing')}
            </p>
          ) : null}
        </div>
      )}

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
            max={MAX_CURRENCY_DECIMAL_PLACES}
            error={errors.decimalPlaces?.message}
            value={field.value}
            onChange={(value) => {
              setDecimalsTouched(true);
              field.onChange(value);
            }}
            name={field.name}
            onBlur={field.onBlur}
            ref={field.ref}
          />
        )}
      />

      {showNonIsoNotice && (
        <div
          role="note"
          className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 space-y-2"
        >
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {t.rich('form.nonIsoNotice', {
              code: typedCode,
              guide: (chunks) => (
                <a
                  href={docsUrl('cryptoCurrencies')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline hover:text-blue-900 dark:hover:text-blue-100"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => changeKind('CRYPTO')}>
            {t('form.switchToCrypto')}
          </Button>
        </div>
      )}

      {isCrypto && (
        <div
          role="note"
          className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3"
        >
          <p className="text-sm text-blue-700 dark:text-blue-300">
            {t.rich('form.cryptoPrecisionNotice', {
              // The smallest amount a coin at the most places can hold.
              smallest: formatNumber(10 ** -MAX_CURRENCY_DECIMAL_PLACES, MAX_CURRENCY_DECIMAL_PLACES),
              guide: (chunks) => (
                <a
                  href={docsUrl('cryptoWallets')}
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
