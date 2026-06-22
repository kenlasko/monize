'use client';

import { useState, useEffect, useCallback, useMemo, MutableRefObject } from 'react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Combobox } from '@/components/ui/Combobox';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SecurityLookupPicker, LookupCandidate } from './SecurityLookupPicker';
import { AllocationEditor, AllocationRow } from './AllocationEditor';
import { TagForm } from '@/components/tags/TagForm';
import { Security, CreateSecurityData } from '@/types/investment';
import { Tag } from '@/types/tag';
import { tagsApi } from '@/lib/tags';
import { investmentsApi } from '@/lib/investments';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';
import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { EXCHANGE_OPTIONS, COUNTRY_OPTIONS } from '@/lib/constants';

// Map stored country weightings (decimal 0-1) to editor rows (percentage strings).
const toCountryRows = (
  weightings: { name: string; weight: number }[] | null | undefined,
): AllocationRow[] =>
  (weightings ?? [])
    // A provider "Other" bucket isn't a country: don't surface it as a row --
    // it's folded into the editor's computed (100 - total) "Other" remainder.
    .filter((w) => (w.name ?? '').trim().toLowerCase() !== 'other')
    .map((w) => ({
      name: w.name,
      weight: String(Math.round(w.weight * 1000000) / 10000),
    }));

const logger = createLogger('SecurityForm');

const buildSecuritySchema = (t: (key: string) => string) => z.object({
  symbol: z.string().min(1, t('validation.symbolRequired')).max(20, t('validation.symbolMax')),
  name: z.string().min(1, t('validation.nameRequired')).max(255, t('validation.nameMax')),
  securityType: z.string().optional(),
  exchange: z.string().optional(),
  currencyCode: z.string().min(1, t('validation.currencyRequired')),
  description: z.string().max(5000, t('validation.descriptionMax')).optional(),
  quoteProvider: z.enum(['', 'yahoo', 'msn']).optional(),
  msnInstrumentId: z.string().max(50).optional(),
  isFavourite: z.boolean().optional(),
});

type SecurityFormData = z.infer<ReturnType<typeof buildSecuritySchema>>;

const quoteProviderOverrideOptions = [
  { value: '', label: 'Use default' },
  { value: 'yahoo', label: 'Yahoo Finance' },
  { value: 'msn', label: 'MSN Money' },
];

const lookupProviderOptions = [
  { value: 'auto', labelKey: 'form.providers.auto' },
  { value: 'yahoo', labelKey: 'form.providers.yahoo' },
  { value: 'msn', labelKey: 'form.providers.msn' },
];

interface SecurityFormProps {
  security?: Security;
  onSubmit: (data: CreateSecurityData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

const securityTypeOptions = [
  { value: '', labelKey: 'form.types.select' },
  { value: 'STOCK', labelKey: 'form.types.stock' },
  { value: 'ETF', labelKey: 'form.types.etf' },
  { value: 'MUTUAL_FUND', labelKey: 'form.types.mutualFund' },
  { value: 'BOND', labelKey: 'form.types.bond' },
  { value: 'OPTION', labelKey: 'form.types.option' },
  { value: 'CRYPTO', labelKey: 'form.types.crypto' },
  { value: 'OTHER', labelKey: 'form.types.other' },
];

export function SecurityForm({ security, onSubmit, onCancel, onDirtyChange, submitRef }: SecurityFormProps) {
  const t = useTranslations('securities');
  const { defaultCurrency } = useNumberFormat();
  const rawPreferredExchanges = usePreferencesStore((s) => s.preferences?.preferredExchanges);
  const preferredExchanges = useMemo(() => rawPreferredExchanges || [], [rawPreferredExchanges]);
  const userDefaultProvider = usePreferencesStore((s) => s.preferences?.defaultQuoteProvider) ?? 'yahoo';
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [lookupProvider, setLookupProvider] = useState<'auto' | 'yahoo' | 'msn'>('auto');
  const [pickerQuery, setPickerQuery] = useState<string>('');
  const [pickerCandidates, setPickerCandidates] = useState<LookupCandidate[]>([]);
  const [msnReady, setMsnReady] = useState<boolean | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    security?.tags?.map((tag) => tag.id) || [],
  );
  const [countryRows, setCountryRows] = useState<AllocationRow[]>(
    toCountryRows(security?.countryWeightings),
  );
  const [showTagForm, setShowTagForm] = useState(false);

  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setCurrencies).catch(() => {});
  }, []);

  useEffect(() => {
    tagsApi.getAll().then(setTags).catch(() => {});
  }, []);

  const tagOptions = useMemo(
    () =>
      [...tags]
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        )
        .map((tag) => ({ value: tag.id, label: tag.name })),
    [tags],
  );

  useEffect(() => {
    investmentsApi
      .getProviderStatus()
      .then((status) => setMsnReady(status.msn.ready))
      .catch(() => setMsnReady(null));
  }, []);

  const currencyOptions = useMemo(() => {
    const sorted = [...currencies].sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
    return sorted.map((c) => ({
      value: c.code,
      label: `${c.code} - ${c.name} (${c.symbol})`,
    }));
  }, [currencies, defaultCurrency]);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    watch,
    reset,
    formState: { errors, isSubmitting, isDirty, defaultValues },
  } = useForm<SecurityFormData>({
    resolver: zodResolver(buildSecuritySchema(t)),
    defaultValues: {
      symbol: security?.symbol || '',
      name: security?.name || '',
      securityType: security?.securityType || '',
      exchange: security?.exchange || '',
      currencyCode: security?.currencyCode || defaultCurrency,
      description: security?.description || '',
      quoteProvider: security?.quoteProvider || '',
      msnInstrumentId: security?.msnInstrumentId || '',
      isFavourite: security?.isFavourite || false,
    },
  });

  const isFavourite = watch('isFavourite') ?? false;
  const toggleFavourite = () =>
    setValue('isFavourite', !isFavourite, { shouldDirty: true });

  const applyLookupResult = useCallback(
    (result: LookupCandidate) => {
      const setOpts = { shouldDirty: true, shouldTouch: true, shouldValidate: true };

      setValue('symbol', result.symbol, setOpts);
      setValue('name', result.name, setOpts);
      if (result.exchange) setValue('exchange', result.exchange, setOpts);
      if (result.securityType) setValue('securityType', result.securityType, setOpts);
      if (result.currencyCode) setValue('currencyCode', result.currencyCode, setOpts);

      if (result.provider) {
        const explicit = lookupProvider !== 'auto';
        const differsFromDefault = result.provider !== userDefaultProvider;
        if (explicit || differsFromDefault) {
          setValue('quoteProvider', result.provider, setOpts);
        }
      }

      if (result.msnInstrumentId) {
        setValue('msnInstrumentId', result.msnInstrumentId, setOpts);
      }

      setHasLookupResult(true);

      // Pull the description from the provider as part of the lookup, just like
      // the other fields. Best-effort and still editable: only overwrite when
      // the provider actually returns something so a manual edit isn't wiped.
      investmentsApi
        .getSuggestedDescription(result.symbol, result.exchange || undefined)
        .then(({ description }) => {
          if (description) {
            setValue('description', description, { shouldDirty: true });
          }
        })
        .catch((error) => logger.error('Description fetch failed:', error));

      const details = [`Symbol: ${result.symbol}`, `Name: ${result.name}`];
      if (result.exchange) details.push(`Exchange: ${result.exchange}`);
      if (result.securityType) details.push(`Type: ${result.securityType}`);
      if (result.currencyCode) details.push(`Currency: ${result.currencyCode}`);
      if (result.provider) details.push(`Provider: ${result.provider === 'msn' ? 'MSN' : 'Yahoo'}`);
      toast.success(t('form.toasts.found', { details: details.join(', ') }));
    },
    [setValue, lookupProvider, userDefaultProvider, t],
  );

  const handleLookup = useCallback(async () => {
    const { symbol, name, exchange: currentExchange } = getValues();
    const query = (symbol?.trim() || name?.trim() || '');
    if (query.length < 2) {
      toast.error(t('form.toasts.lookupTooShort'));
      return;
    }

    const exchanges = currentExchange
      ? [currentExchange, ...preferredExchanges.filter((e) => e !== currentExchange)]
      : preferredExchanges.length > 0
        ? preferredExchanges
        : undefined;

    setIsLookingUp(true);
    try {
      const candidates = await investmentsApi.lookupSecurityCandidates(
        query,
        exchanges,
        lookupProvider,
      );
      if (candidates.length === 0) {
        toast.error(t('form.toasts.notFound', { query }));
      } else if (candidates.length === 1) {
        applyLookupResult(candidates[0]);
      } else {
        setPickerQuery(query);
        setPickerCandidates(candidates);
      }
    } catch (error) {
      logger.error('Security lookup failed:', error);
      toast.error(t('form.toasts.lookupFailed'));
    } finally {
      setIsLookingUp(false);
    }
  }, [getValues, preferredExchanges, lookupProvider, applyLookupResult, t]);

  // In edit mode, revert to the original security values. In create mode,
  // blank everything out (keeping the user's default currency).
  const handleClear = useCallback(() => {
    if (security) {
      reset();
      setSelectedTagIds(security.tags?.map((tag) => tag.id) || []);
      setCountryRows(toCountryRows(security.countryWeightings));
    } else {
      reset({
        symbol: '',
        name: '',
        securityType: '',
        exchange: '',
        currencyCode: defaultValues?.currencyCode || defaultCurrency,
        description: '',
        quoteProvider: '',
        msnInstrumentId: '',
        isFavourite: false,
      });
      setSelectedTagIds([]);
      setCountryRows([]);
    }
    setHasLookupResult(false);
  }, [reset, defaultValues, defaultCurrency, security]);

  // Pre-fill the description from the Yahoo provider profile. Best-effort and
  // always editable; replaces whatever is in the field so the user can review.
  const handleTagCreate = async (data: { name: string; color?: string; icon?: string }) => {
    const cleanedData = {
      ...data,
      color: data.color || undefined,
      icon: data.icon || undefined,
    };
    const newTag = await tagsApi.create(cleanedData);
    setTags((prev) => [...prev, newTag]);
    setSelectedTagIds((prev) => [...prev, newTag.id]);
    toast.success(t('form.toasts.tagCreated', { name: newTag.name }));
    setShowTagForm(false);
  };

  const isFundType =
    watch('securityType') === 'ETF' || watch('securityType') === 'MUTUAL_FUND';

  const onFormSubmit = async (data: SecurityFormData) => {
    const isFund =
      data.securityType === 'ETF' || data.securityType === 'MUTUAL_FUND';

    // Editor weights are percentages; persist as decimal 0-1. Drop blank rows.
    const countrySlices = countryRows
      .map((row) => ({
        name: row.name.trim(),
        weight: parseFloat(row.weight),
      }))
      .filter((row) => row.name !== '' && Number.isFinite(row.weight) && row.weight > 0);

    const countryTotal = countrySlices.reduce((sum, row) => sum + row.weight, 0);
    if (isFund && countryTotal > 100.0001) {
      toast.error(t('form.allocation.overError'));
      return;
    }

    const cleanedData: CreateSecurityData = {
      symbol: data.symbol.toUpperCase().trim(),
      name: data.name.trim(),
      securityType: data.securityType || undefined,
      exchange: data.exchange?.trim() || undefined,
      currencyCode: data.currencyCode,
      description: data.description?.trim() || undefined,
      tagIds: selectedTagIds,
      // Send null (not undefined) when the user picks "Use Default" so the
      // backend clears any existing override. Undefined would be stripped by
      // axios and treated as "no change", leaving the previous override in place.
      quoteProvider: data.quoteProvider === '' ? null : data.quoteProvider,
      msnInstrumentId: data.msnInstrumentId?.trim() || undefined,
      isFavourite: data.isFavourite ?? false,
      // Only ETFs/funds carry a manual country breakdown; send [] to clear it.
      ...(isFund
        ? {
            countryWeightings: countrySlices.map((row) => ({
              name: row.name,
              weight: row.weight / 100,
            })),
          }
        : {}),
    };
    await onSubmit(cleanedData);
  };

  useFormDirtyNotify(isDirty, onDirtyChange);

  useFormSubmitRef(submitRef, handleSubmit, onFormSubmit);

  return (
    <>
    <SecurityLookupPicker
      isOpen={pickerCandidates.length > 0}
      query={pickerQuery}
      candidates={pickerCandidates}
      onPick={(c) => {
        applyLookupResult(c);
        setPickerCandidates([]);
        setPickerQuery('');
      }}
      onCancel={() => {
        setPickerCandidates([]);
        setPickerQuery('');
      }}
    />
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-4">
      {/* Symbol + Lookup / Clear buttons */}
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <Input
            label={t('form.symbolLabel')}
            {...register('symbol')}
            error={errors.symbol?.message}
            placeholder={t('form.symbolPlaceholder')}
            className="uppercase"
          />
        </div>
        <div className="flex gap-1.5">
          <Select
            aria-label={t('form.lookupProviderAriaLabel')}
            options={lookupProviderOptions.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            value={lookupProvider}
            onChange={(e) =>
              setLookupProvider(e.target.value as 'auto' | 'yahoo' | 'msn')
            }
            className="mb-[1px] w-24"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleLookup}
            disabled={isLookingUp}
            className="mb-[1px] relative"
          >
            <span className={isLookingUp ? 'invisible' : ''}>{t('form.lookupButton')}</span>
            {isLookingUp && (
              <span className="absolute inset-0 flex items-center justify-center">
                <LoadingSpinner size="sm" fullContainer={false} />
              </span>
            )}
          </Button>
          {hasLookupResult && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleClear}
              className="mb-[1px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              title={security ? t('form.revertTitle') : t('form.clearTitle')}
            >
              {security ? t('form.revertButton') : t('form.clearButton')}
            </Button>
          )}
        </div>
      </div>

      <Input
        label={t('form.nameLabel')}
        {...register('name')}
        error={errors.name?.message}
        placeholder={t('form.namePlaceholder')}
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Select
          label={t('form.typeLabel')}
          options={securityTypeOptions.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          value={watch('securityType') || ''}
          onChange={(e) => setValue('securityType', e.target.value, { shouldDirty: true })}
          error={errors.securityType?.message}
        />

        <Combobox
          label={t('form.exchangeLabel')}
          options={EXCHANGE_OPTIONS}
          value={watch('exchange') || ''}
          onChange={(value, label) => setValue('exchange', value || label, { shouldDirty: true })}
          error={errors.exchange?.message}
          placeholder={t('form.exchangeSearchPlaceholder')}
          allowCustomValue
          usePortal
          alwaysShowSubtitle
          priorityValues={preferredExchanges}
        />

        <Select
          label={t('form.currencyLabel')}
          options={currencyOptions}
          value={watch('currencyCode') || ''}
          onChange={(e) =>
            setValue('currencyCode', e.target.value, { shouldDirty: true })
          }
          error={errors.currencyCode?.message}
        />
      </div>

      <div>
        <Select
          label={t('form.quoteProviderLabel')}
          options={[
            { value: '', label: t('form.quoteProviderUseDefault', { provider: userDefaultProvider === 'msn' ? 'MSN Money' : 'Yahoo Finance' }) },
            ...quoteProviderOverrideOptions.slice(1),
          ]}
          value={watch('quoteProvider') || ''}
          onChange={(e) =>
            setValue('quoteProvider', (e.target.value as 'yahoo' | 'msn' | ''), {
              shouldDirty: true,
            })
          }
          error={errors.quoteProvider?.message}
        />
        {watch('quoteProvider') === 'msn' && msnReady === false && (
          <p
            role="alert"
            className="text-sm text-red-600 dark:text-red-400 mt-2"
            data-testid="msn-not-configured-error"
          >
            {t('form.msnNotConfigured')}
          </p>
        )}
      </div>

      {watch('quoteProvider') === 'msn' && (
        <Input
          label={t('form.msnIdLabel')}
          {...register('msnInstrumentId')}
          error={errors.msnInstrumentId?.message}
          placeholder={t('form.exchangePlaceholder')}
        />
      )}

      {/* Favourite star toggle */}
      <button
        type="button"
        onClick={toggleFavourite}
        className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        title={isFavourite ? t('form.removeFromFavourites') : t('form.addToFavourites')}
        aria-pressed={isFavourite}
      >
        <svg
          className={`w-5 h-5 transition-colors ${
            isFavourite ? 'text-yellow-500 fill-current' : 'text-gray-400 dark:text-gray-500'
          }`}
          fill={isFavourite ? 'currentColor' : 'none'}
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
          />
        </svg>
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {isFavourite ? t('form.favouriteLabel') : t('form.addToFavourites')}
        </span>
      </button>

      {/* Description -- populated from the provider during Lookup, editable. */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('form.descriptionLabel')}
        </label>
        <textarea
          rows={4}
          className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          placeholder={t('form.descriptionPlaceholder')}
          {...register('description')}
        />
        {errors.description && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">
            {errors.description.message}
          </p>
        )}
      </div>

      {/* Tags */}
      <MultiSelect
        label={t('form.tagsLabel')}
        options={tagOptions}
        value={selectedTagIds}
        onChange={setSelectedTagIds}
        placeholder={t('form.tagsPlaceholder')}
        onCreateNew={() => setShowTagForm(true)}
        createNewLabel={t('form.createNewTag')}
      />

      {/* Manual country allocation (ETFs/funds only -- providers don't supply it) */}
      {isFundType && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('form.allocation.sectionTitle')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('form.allocation.help')}
          </p>
          <AllocationEditor
            value={countryRows}
            onChange={setCountryRows}
            options={COUNTRY_OPTIONS}
            namePlaceholder={t('form.allocation.countryPlaceholder')}
          />
        </div>
      )}

      {/* Tag creation modal */}
      <Modal isOpen={showTagForm} onClose={() => setShowTagForm(false)} maxWidth="lg" allowOverflow pushHistory className="p-6">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {t('form.newTagTitle')}
        </h2>
        <TagForm onSubmit={handleTagCreate} onCancel={() => setShowTagForm(false)} />
      </Modal>

      <FormActions onCancel={onCancel} submitLabel={security ? t('form.submitUpdate') : t('form.submitCreate')} isSubmitting={isSubmitting} />
    </form>
    </>
  );
}
