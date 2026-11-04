'use client';

import { useState, useEffect, useCallback, useMemo, MutableRefObject } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Combobox } from '@/components/ui/Combobox';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SecurityLookupPicker, LookupCandidate } from './SecurityLookupPicker';
import { AllocationEditor, AllocationRow } from './AllocationEditor';
import { BondProgramSelect, bondCountryName, useBondProgramPicker } from './BondProgramSelect';
import { programLabel } from './detail/bond-labels';
import {
  LookupProviderSelect,
  MsnInstrumentIdInput,
  QuoteProviderSelect,
  type LookupProviderValue,
} from './QuoteProviderControls';
import { QuoteTableUrlField } from './QuoteTableUrlField';
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
import {
  buildSecuritySchema,
  valuesToValidate,
  toAllocationRows,
  toAllocationSlices,
  type SecurityFormData,
} from './securityFormModel';

const logger = createLogger('SecurityForm');

interface SecurityFormProps {
  security?: Security;
  /**
   * Starting values for a *new* security, so a caller that already knows which
   * fund is wanted can open the form filled in. Ignored in edit mode, where
   * `security` supplies the values. Every prefilled field stays editable: a
   * suggested listing names one exchange and currency, and the investor's
   * broker may trade a different one.
   */
  defaults?: Partial<CreateSecurityData>;
  onSubmit: (data: CreateSecurityData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

/** The Country choice for a bond no program supports: it works as a plain security. */
const BOND_COUNTRY_OTHER = 'OTHER';
const BOND_REQUEST_URL = 'https://github.com/kenlasko/monize/discussions';

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

export function SecurityForm({ security, defaults, onSubmit, onCancel, onDirtyChange, submitRef }: SecurityFormProps) {
  const t = useTranslations('securities');
  const tDetail = useTranslations('securityDetail');
  const locale = useLocale();
  const { defaultCurrency } = useNumberFormat();
  const rawPreferredExchanges = usePreferencesStore((s) => s.preferences?.preferredExchanges);
  const preferredExchanges = useMemo(() => rawPreferredExchanges || [], [rawPreferredExchanges]);
  const userDefaultProvider = usePreferencesStore((s) => s.preferences?.defaultQuoteProvider) ?? 'yahoo';
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [hasLookupResult, setHasLookupResult] = useState(false);
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [lookupProvider, setLookupProvider] = useState<LookupProviderValue>('auto');
  const [pickerQuery, setPickerQuery] = useState<string>('');
  const [pickerCandidates, setPickerCandidates] = useState<LookupCandidate[]>([]);
  // Bumped by Clear/Revert to remount the exchange combobox, whose internal
  // display text does not follow a programmatic reset of a custom value.
  const [resetNonce, setResetNonce] = useState(0);
  const [msnReady, setMsnReady] = useState<boolean | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    security?.tags?.map((tag) => tag.id) || [],
  );
  const [countryRows, setCountryRows] = useState<AllocationRow[]>(
    toAllocationRows(security?.countryWeightings),
  );
  // Canonical countries plus the user's custom ones, base-currency country
  // first. Seeded with the static list so the picker works before the fetch.
  const [countryNames, setCountryNames] = useState<string[]>(
    COUNTRY_OPTIONS.map((o) => o.value),
  );
  const [assetRows, setAssetRows] = useState<AllocationRow[]>(
    toAllocationRows(security?.assetWeightings),
  );
  // Asset classes are free text with no canonical list: the picker offers only
  // what this user has already saved, so it starts from the security's own rows
  // until the fetch lands.
  const [assetNames, setAssetNames] = useState<string[]>(() =>
    toAllocationRows(security?.assetWeightings).map((row) => row.name),
  );
  // Asset class the user asked to delete from the list, pending confirmation.
  const [assetToDelete, setAssetToDelete] = useState<string | null>(null);
  const [showTagForm, setShowTagForm] = useState(false);
  // The country the reader picked for a bond; null until they pick one, when it
  // follows the linked program (or is "Other" for an unlinked bond).
  const [bondCountryChoice, setBondCountryChoice] = useState<string | null>(null);

  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setCurrencies).catch(() => {});
  }, []);

  useEffect(() => {
    investmentsApi
      .getCountryOptions()
      .then(setCountryNames)
      .catch(() => {});
  }, []);

  useEffect(() => {
    investmentsApi
      .getAssetOptions()
      .then(setAssetNames)
      .catch(() => {});
  }, []);

  const countryOptions = useMemo(
    () => countryNames.map((name) => ({ value: name, label: name })),
    [countryNames],
  );

  // The names on this security's own rows may not be saved yet, so merge them
  // into the fetched list (case-insensitively) rather than losing them.
  const assetOptions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const name of [...assetNames, ...assetRows.map((row) => row.name)]) {
      const trimmed = name.trim();
      if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
      seen.add(trimmed.toLowerCase());
      names.push(trimmed);
    }
    return names
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }));
  }, [assetNames, assetRows]);

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


  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    control,
    reset,
    clearErrors,
    formState: { errors, isSubmitting, isDirty, defaultValues },
  } = useForm<SecurityFormData>({
    // The schema plus what it cannot see: the country is not a form value, so a
    // listed country without a bond kind is refused here, as a required field,
    // and a listed bond's hidden provider (and so its hidden page address) is
    // not validated: the engine prices it, and a rule on a field nobody can see
    // would block the save with no reason on screen.
    resolver: async (values, context, options) => {
      const result = await zodResolver(buildSecuritySchema(t))(
        valuesToValidate(values, !hideExchange),
        context,
        options,
      );
      if (!bondKindMissing) return result;
      return {
        values: {},
        errors: {
          ...result.errors,
          bondProgramId: { type: 'required', message: t('validation.bondProgramRequired') },
        },
      };
    },
    defaultValues: {
      symbol: security?.symbol || defaults?.symbol || '',
      name: security?.name || defaults?.name || '',
      securityType: security?.securityType || defaults?.securityType || '',
      exchange: security?.exchange || defaults?.exchange || '',
      currencyCode: security?.currencyCode || defaults?.currencyCode || defaultCurrency,
      description: security?.description || '',
      website: security?.website || '',
      irWebsite: security?.irWebsite || '',
      quoteProvider: security?.quoteProvider || '',
      msnInstrumentId: security?.msnInstrumentId || '',
      quoteUrl: security?.quoteUrl || '',
      bondProgramId: security?.bondProgramId || defaults?.bondProgramId || '',
      bondAutoFetch: security?.bondAutoFetch ?? defaults?.bondAutoFetch ?? false,
      isFavourite: security?.isFavourite || false,
      priceChartEnabled: security?.priceChartEnabled ?? false,
      skipPriceUpdates: security?.skipPriceUpdates ?? false,
      priceAlertPercent: security?.priceAlertPercent == null ? '' : String(security.priceAlertPercent),
    },
  });

  const selectedCurrency = useWatch({ control, name: 'currencyCode' });
  // Set when a crypto lookup came back without a currency; see applyLookupResult.
  const [currencyNotReported, setCurrencyNotReported] = useState(false);

  /**
   * The user's currencies, plus whatever the form currently holds.
   *
   * A lookup fills the currency from the provider, and that currency need not
   * be one the user has configured in Tools. A `<select>` whose value has no
   * matching `<option>` renders blank, so the code the provider returned would
   * silently disappear from the field -- and be lost on save. Keeping it in the
   * list preserves it and says where it came from, the same way a deactivated
   * security stays selectable while it is still assigned.
   */
  const currencyOptions = useMemo(() => {
    const sorted = [...currencies].sort((a, b) => {
      if (a.code === defaultCurrency) return -1;
      if (b.code === defaultCurrency) return 1;
      return a.code.localeCompare(b.code);
    });
    const options = sorted.map((c) => ({
      value: c.code,
      label: `${c.code} - ${c.name} (${c.symbol})`,
    }));
    if (
      selectedCurrency &&
      !currencies.some((c) => c.code === selectedCurrency)
    ) {
      options.push({
        value: selectedCurrency,
        label: t('form.currencyNotConfigured', { code: selectedCurrency }),
      });
    }
    // An emptied field needs an option of its own: with none matching, a
    // <select> shows its first currency while the form holds nothing.
    return selectedCurrency ? options : [{ value: '', label: t('form.currencyPlaceholder') }, ...options];
  }, [currencies, defaultCurrency, selectedCurrency, t]);

  /**
   * Whether the user clicked the "disable price updates" switch. Only then is
   * it sent; left alone, the backend decides, and a newly picked provider or
   * MSN Instrument ID turns updates back on. RHF's dirty state cannot stand in
   * for this: re-ticking a box the effect below unticked is back at its
   * default, so it reads as clean, yet it is the user's explicit choice.
   */
  const [skipSwitchTouched, setSkipSwitchTouched] = useState(false);
  const watchedQuoteProvider = useWatch({ control, name: 'quoteProvider' }) || '';
  const watchedMsnInstrumentId = useWatch({ control, name: 'msnInstrumentId' })?.trim() || '';
  const watchedQuoteUrl = useWatch({ control, name: 'quoteUrl' })?.trim() || '';

  // Show what the save will store: the same rule as `SecuritiesService.update`,
  // a provider or MSN id that differs from the stored one clears the flag.
  useEffect(() => {
    if (skipSwitchTouched || !getValues('skipPriceUpdates')) return;
    const newProvider =
      watchedQuoteProvider !== '' &&
      watchedQuoteProvider !== (defaultValues?.quoteProvider || '');
    const newMsnId =
      watchedMsnInstrumentId !== '' &&
      watchedMsnInstrumentId !== (defaultValues?.msnInstrumentId?.trim() || '');
    const newQuoteUrl =
      watchedQuoteUrl !== '' && watchedQuoteUrl !== (defaultValues?.quoteUrl?.trim() || '');
    if (newProvider || newMsnId || newQuoteUrl) {
      setValue('skipPriceUpdates', false);
    }
  }, [
    watchedQuoteProvider,
    watchedMsnInstrumentId,
    watchedQuoteUrl,
    skipSwitchTouched,
    defaultValues,
    getValues,
    setValue,
  ]);
  const watchedSecurityType = useWatch({ control, name: 'securityType' });
  const watchedExchange = useWatch({ control, name: 'exchange' });
  const watchedSkipPriceUpdates = useWatch({ control, name: 'skipPriceUpdates' });
  const watchedPriceAlertPercent = useWatch({ control, name: 'priceAlertPercent' });
  const watchedPriceChartEnabled = useWatch({ control, name: 'priceChartEnabled' });
  const isBond = watchedSecurityType === 'BOND';
  const selectedBondProgramId = useWatch({ control, name: 'bondProgramId' }) || '';
  const bondAutoFetch = useWatch({ control, name: 'bondAutoFetch' }) ?? false;

  const bondPicker = useBondProgramPicker(isBond, selectedCurrency, selectedBondProgramId);
  const effectiveBondProgramId = bondPicker.effectiveProgramId;

  // Choosing a kind is a person's choice of product, so it fills everything the
  // program determines: symbol (its code), name (its translated name), currency
  // and the issuer's page, and it empties the exchange. Each stays editable.
  // Only a change made here fills; opening a linked security does not.
  const handleBondProgramChange = (programId: string) => {
    // Emptying the kind keeps the country: it follows the link only until chosen.
    if (programId === '' && bondCountry !== '') setBondCountryChoice(bondCountry);
    setValue('bondProgramId', programId, { shouldDirty: true });
    // The resolver still holds the previous render's choice, so the required
    // error is cleared here rather than by revalidating.
    if (programId !== '') clearErrors('bondProgramId');
    const program = bondPicker.programs.find((p) => p.id === programId);
    if (program === undefined) return;
    const fill = { shouldDirty: true, shouldValidate: true };
    setValue('symbol', program.programCode, fill);
    setValue('name', programLabel(tDetail, program.programCode), fill);
    setValue('currencyCode', program.currency, fill);
    setValue('exchange', '', { shouldDirty: true });
    if (program.infoUrl) setValue('website', program.infoUrl, { shouldDirty: true });
  };

  // A linked bond is priced from its terms, never by asking a quote provider,
  // so the controls that configure quote fetching are hidden. Their stored
  // values stay in the form state and are submitted unchanged.
  const isLinkedToBond = isBond && effectiveBondProgramId !== '';

  // '' is a link whose country is not known yet (the catalog has not loaded).
  const bondCountry =
    bondCountryChoice ??
    bondPicker.program?.issuerCountryCode ??
    (effectiveBondProgramId !== '' ? '' : BOND_COUNTRY_OTHER);
  const isOtherBondCountry = isBond && bondCountry === BOND_COUNTRY_OTHER;
  // A bond of a supported country is found by its program, not an exchange.
  const hideExchange = isBond && bondCountry !== BOND_COUNTRY_OTHER;
  // The engine prices a listed country's bond, and its program fixes the
  // currency, so the quote provider and currency controls are not offered. The
  // currency stays visible only when a stored link disagrees with it, which the
  // reader must be able to repair.
  const hideCurrency = hideExchange && bondPicker.mismatchedLinkCurrency === null;
  // A listed country needs a bond kind; the resolver reads this at submit.
  const bondKindMissing = hideExchange && effectiveBondProgramId === '';

  // Type, Country (Bond), Exchange and Currency, less what the country hides.
  const firstRowCount = 1 + (isBond ? 1 : 0) + (hideExchange ? 0 : 1) + (hideCurrency ? 0 : 1);
  const firstRowColumns =
    firstRowCount === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : firstRowCount === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2';

  const bondCountryOptions = useMemo(() => {
    const codes = [...new Set(bondPicker.programs.map((p) => p.issuerCountryCode))];
    const named = codes
      .map((code) => ({ value: code, label: bondCountryName(code, locale) }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
    return [
      ...(bondCountry === '' ? [{ value: '', label: t('form.bondProgramCurrent') }] : []),
      ...named,
      { value: BOND_COUNTRY_OTHER, label: t('form.bondCountryOther') },
    ];
  }, [bondPicker.programs, bondCountry, locale, t]);

  // Changing the country resets the program: it belongs to one country.
  const handleBondCountryChange = (code: string) => {
    if (code === bondCountry) return;
    setBondCountryChoice(code);
    setValue('bondProgramId', '', { shouldDirty: true });
    setValue('bondAutoFetch', false, { shouldDirty: true });
  };

  const isFavourite = useWatch({ control, name: 'isFavourite' }) ?? false;
  const toggleFavourite = () =>
    setValue('isFavourite', !isFavourite, { shouldDirty: true });

  const applyLookupResult = useCallback(
    (result: LookupCandidate) => {
      const setOpts = { shouldDirty: true, shouldTouch: true, shouldValidate: true };

      setValue('symbol', result.symbol, setOpts);
      setValue('name', result.name, setOpts);
      if (result.exchange) setValue('exchange', result.exchange, setOpts);
      if (result.securityType) setValue('securityType', result.securityType, setOpts);
      if (result.currencyCode) {
        setValue('currencyCode', result.currencyCode, setOpts);
        setCurrencyNotReported(false);
      } else if (result.securityType === 'CRYPTO') {
        // A coin priced in a stablecoin pair has no fiat leg, so the provider
        // cannot say what it is quoted in. Keeping the form's default would
        // save the coin in the wrong currency without a word; empty the field
        // so the required-currency rule asks for it, and say why.
        setValue('currencyCode', '', setOpts);
        setCurrencyNotReported(true);
      } else {
        setCurrencyNotReported(false);
      }

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
        .then(({ description, website }) => {
          if (description) {
            setValue('description', description, { shouldDirty: true });
          }
          // Same request, no extra call. Null for a fund, where Yahoo gives a
          // fund family and no URL -- and there is never an IR address to
          // suggest, because no provider publishes one.
          if (website) {
            setValue('website', website, { shouldDirty: true });
          }
        })
        .catch((error) => logger.error('Profile fetch failed:', error));

      const details = [`Symbol: ${result.symbol}`, `Name: ${result.name}`];
      if (result.exchange) details.push(`Exchange: ${result.exchange}`);
      if (result.securityType) details.push(`Type: ${result.securityType}`);
      if (result.currencyCode) details.push(`Currency: ${result.currencyCode}`);
      if (result.provider) details.push(`Provider: ${t(`form.providers.${result.provider}`)}`);
      toast.success(t('form.toasts.found', { details: details.join(', ') }));
    },
    [setValue, lookupProvider, userDefaultProvider, t, setCurrencyNotReported],
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
  // blank everything out (keeping the user's default currency). Only a button's
  // onClick reads it, so it is left to the compiler to memoize.
  const handleClear = () => {
    setSkipSwitchTouched(false);
    if (security) {
      reset();
      setSelectedTagIds(security.tags?.map((tag) => tag.id) || []);
      setCountryRows(toAllocationRows(security.countryWeightings));
      setAssetRows(toAllocationRows(security.assetWeightings));
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
        bondProgramId: '',
        bondAutoFetch: false,
        isFavourite: false,
        priceChartEnabled: false,
        skipPriceUpdates: false,
        priceAlertPercent: '',
      });
      setSelectedTagIds([]);
      setCountryRows([]);
      setAssetRows([]);
    }
    setBondCountryChoice(null);
    setHasLookupResult(false);
    setCurrencyNotReported(false);
    setResetNonce((n) => n + 1);
  };

  // Drop an asset class from the user's list. The backend removes it from every
  // security that used it; nothing is re-apportioned, so the freed percentage
  // simply falls into each security's computed "Other" remainder -- including
  // this form's, once the matching rows are gone.
  const confirmDeleteAsset = useCallback(async () => {
    const name = assetToDelete;
    setAssetToDelete(null);
    if (!name) return;
    try {
      await investmentsApi.deleteAssetOption(name);
      const lower = name.trim().toLowerCase();
      setAssetNames((prev) =>
        prev.filter((option) => option.trim().toLowerCase() !== lower),
      );
      setAssetRows((prev) =>
        prev.filter((row) => row.name.trim().toLowerCase() !== lower),
      );
      toast.success(t('form.assetAllocation.deleteSuccess', { name }));
    } catch (error) {
      logger.error('Asset class delete failed:', error);
      toast.error(t('form.assetAllocation.deleteFailed', { name }));
    }
  }, [assetToDelete, t]);

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
    watchedSecurityType === 'ETF' || watchedSecurityType === 'MUTUAL_FUND';

  const onFormSubmit = async (data: SecurityFormData) => {
    const isFund =
      data.securityType === 'ETF' || data.securityType === 'MUTUAL_FUND';

    // Editor weights are percentages; persist as decimal 0-1. Drop blank rows.
    const countrySlices = toAllocationSlices(countryRows);
    const assetSlices = toAllocationSlices(assetRows);

    const overAllocated = (slices: { weight: number }[]) =>
      slices.reduce((sum, row) => sum + row.weight, 0) > 100.0001;
    if (isFund && (overAllocated(countrySlices) || overAllocated(assetSlices))) {
      toast.error(t('form.allocation.overError'));
      return;
    }

    // A linked security keeps its program's currency: changing it would unlink
    // the security and delete its engine prices, so it is refused here.
    if (isBond && bondPicker.mismatchedLinkCurrency !== null) {
      toast.error(
        t('form.bondCurrencyLocked', {
          linkedCurrency: bondPicker.mismatchedLinkCurrency,
        }),
      );
      return;
    }

    const storedBondProgramId = security?.bondProgramId || null;
    const storedAutoFetch = security?.bondAutoFetch ?? false;
    const cleanedData: CreateSecurityData = {
      symbol: data.symbol.toUpperCase().trim(),
      name: data.name.trim(),
      securityType: data.securityType || undefined,
      // A listed bond has no exchange: null clears a stored one (undefined would
      // be stripped and leave it), and nothing is sent when there is none.
      exchange: hideExchange ? (security?.exchange ? null : undefined) : data.exchange?.trim() || undefined,
      currencyCode: data.currencyCode,
      description: data.description?.trim() || undefined,
      tagIds: selectedTagIds,
      // Send null (not undefined) when the user picks "Use Default" so the
      // backend clears any existing override. Undefined would be stripped by
      // axios and treated as "no change", leaving the previous override in place.
      // A listed bond hides the provider; a web-page provider left behind from
      // before the type changed has no page to read, so it is cleared.
      quoteProvider:
        data.quoteProvider === '' || (hideExchange && data.quoteProvider === 'html_table')
          ? null
          : data.quoteProvider,
      // Empty string rather than undefined, so clearing an address actually
      // clears it: the backend normalises "" to null, where an omitted field
      // would leave the previous value in place.
      website: data.website?.trim() ?? '',
      irWebsite: data.irWebsite?.trim() ?? '',
      msnInstrumentId: data.msnInstrumentId?.trim() || undefined,
      // Sent only when it changed (an empty string clears a stored page), so a
      // save that leaves it alone is accepted by a server that predates the
      // field: during a rolling deploy the old pod rejects an unknown key.
      ...((data.quoteUrl?.trim() ?? '') !== (security?.quoteUrl?.trim() ?? '')
        ? { quoteUrl: data.quoteUrl?.trim() ?? '' }
        : {}),
      // The link is sent only when it changed (null unlinks), so a save that
      // leaves it alone is accepted by a server that predates the field. A type
      // moved away from BOND unlinks a security that was linked.
      ...(data.securityType === 'BOND' && isOtherBondCountry
        ? { bondProgramId: null }
        : data.securityType === 'BOND'
        ? (effectiveBondProgramId || null) !== storedBondProgramId
          ? { bondProgramId: effectiveBondProgramId || null }
          : {}
        : security?.bondProgramId
          ? { bondProgramId: null }
          : {}),
      // The switch belongs to a linked security: sent when it changed, and
      // turned off when the link goes away.
      ...(data.securityType === 'BOND' && isOtherBondCountry
        ? { bondAutoFetch: false }
        : data.securityType === 'BOND' && effectiveBondProgramId !== ''
        ? (data.bondAutoFetch ?? false) !== storedAutoFetch
          ? { bondAutoFetch: data.bondAutoFetch ?? false }
          : {}
        : storedAutoFetch
          ? { bondAutoFetch: false }
          : {}),
      isFavourite: data.isFavourite ?? false,
      priceChartEnabled: data.priceChartEnabled ?? false,
      // Sent only when the user clicked it (see `skipSwitchTouched`).
      ...(skipSwitchTouched
        ? { skipPriceUpdates: data.skipPriceUpdates ?? false }
        : {}),
      priceAlertPercent: data.priceAlertPercent?.trim() ? Number(data.priceAlertPercent) : null,
      // Only ETFs/funds carry the manual breakdowns; send [] to clear them.
      ...(isFund
        ? {
            countryWeightings: countrySlices.map((row) => ({
              name: row.name,
              weight: row.weight / 100,
            })),
            assetWeightings: assetSlices.map((row) => ({
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
      <div className={`grid grid-cols-1 gap-4 ${firstRowColumns}`}>
        <Select
          label={t('form.typeLabel')}
          options={securityTypeOptions.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          value={watchedSecurityType || ''}
          onChange={(e) => setValue('securityType', e.target.value, { shouldDirty: true })}
          error={errors.securityType?.message}
        />

        {isBond && (
          <Select
            label={t('form.bondCountryLabel')}
            options={bondCountryOptions}
            value={bondCountry}
            onChange={(e) => handleBondCountryChange(e.target.value)}
          />
        )}

        {!hideExchange && (
        <Combobox
          key={`exchange-${resetNonce}`}
          label={t('form.exchangeLabel')}
          options={EXCHANGE_OPTIONS}
          value={watchedExchange || ''}
          onChange={(value, label) => setValue('exchange', value || label, { shouldDirty: true })}
          error={errors.exchange?.message}
          placeholder={t('form.exchangeSearchPlaceholder')}
          allowCustomValue
          usePortal
          alwaysShowSubtitle
          priorityValues={preferredExchanges}
        />
        )}

        {!hideCurrency && (
          <Select
            label={t('form.currencyLabel')}
            options={currencyOptions}
            value={selectedCurrency || ''}
            onChange={(e) =>
              setValue('currencyCode', e.target.value, { shouldDirty: true })
            }
            error={errors.currencyCode?.message}
          />
        )}
      </div>

      {currencyNotReported && !selectedCurrency && (
        <p className="-mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t('form.currencyNotReported')}
        </p>
      )}

      {isOtherBondCountry && (
        <p className="-mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t.rich('form.bondCountryOtherInfo', {
            link: (chunks) => (
              <a
                href={BOND_REQUEST_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {chunks}
              </a>
            ),
          })}
        </p>
      )}

      {isBond && !isOtherBondCountry && (
        <BondProgramSelect
          picker={bondPicker}
          onChange={handleBondProgramChange}
          countryCode={bondCountry || undefined}
          error={errors.bondProgramId?.message}
        />
      )}

      {isLinkedToBond && (
        <div>
          <label className="flex w-fit cursor-pointer items-center gap-2">
            <ToggleSwitch
              checked={bondAutoFetch}
              onChange={(next) => setValue('bondAutoFetch', next, { shouldDirty: true })}
              label={t('form.bondAutoFetchLabel')}
            />
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {t('form.bondAutoFetchLabel')}
            </span>
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('form.bondAutoFetchHelp')}
          </p>
        </div>
      )}

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
        {/* A bond of a listed country is filled from its kind, never looked up. */}
        {!hideExchange && (
          <div className="flex gap-1.5">
            <LookupProviderSelect value={lookupProvider} onChange={setLookupProvider} />
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
        )}
      </div>

      <Input
        label={t('form.nameLabel')}
        {...register('name')}
        error={errors.name?.message}
        placeholder={t('form.namePlaceholder')}
      />

      {!hideExchange && (
        <QuoteProviderSelect
          value={watchedQuoteProvider}
          onChange={(value) => setValue('quoteProvider', value, { shouldDirty: true })}
          userDefaultProvider={userDefaultProvider}
          msnReady={msnReady}
          error={errors.quoteProvider?.message}
        />
      )}

      {!hideExchange && watchedQuoteProvider === 'html_table' && (
        <QuoteTableUrlField
          registration={register('quoteUrl')}
          url={watchedQuoteUrl}
          error={errors.quoteUrl?.message}
        />
      )}

      {!hideExchange && watchedQuoteProvider === 'msn' && (
        <MsnInstrumentIdInput
          registration={register('msnInstrumentId')}
          error={errors.msnInstrumentId?.message}
        />
      )}

      {/* A bond of a listed country is priced by the engine, never by a quote
          refresh, so the switch that stops quote refreshes has nothing to stop. */}
      {!hideExchange && (
        <div>
          <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
            <ToggleSwitch
              checked={!!watchedSkipPriceUpdates}
              onChange={(next) => {
                setValue('skipPriceUpdates', next, { shouldDirty: true });
                setSkipSwitchTouched(true);
              }}
              label={t('form.skipPriceUpdatesLabel')}
            />
            {t('form.skipPriceUpdatesLabel')}
          </label>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t('form.skipPriceUpdatesHelp')}
          </p>
        </div>
      )}

      {/*
        A threshold is a number the user types, so it goes through
        `NumericInput` like every other one: a native number input adds spinner
        arrows, changes value on the scroll wheel, and parses what was typed
        against the browser's locale rather than the user's chosen one.

        Shaped after its sibling `PortfolioAlertControl`, which renders the
        portfolio movement threshold: same `decimalPlaces`, same `min`/`max`.
        `min` clamps the value handed back while typing, but not the field's
        own text -- `handleChange` calls `setDisplayValue` before the clamp --
        so typing "0.5" still works, and the transient value converges on the
        next keystroke. The Zod schema keeps the range too, because it owns the
        message the field renders.

        The value is bridged as a canonical string (`String(value)`), never the
        locale text the user sees: `onSubmit` does `Number(...)` on this field,
        and "0,13" would arrive as NaN for a comma-decimal reader.
      */}
      <NumericInput
        label={t('priceAlert.label')}
        value={
          watchedPriceAlertPercent?.trim()
            ? Number(watchedPriceAlertPercent)
            : undefined
        }
        onChange={(value) =>
          setValue(
            'priceAlertPercent',
            value === undefined ? '' : String(value),
            { shouldDirty: true, shouldValidate: true },
          )
        }
        decimalPlaces={4}
        min={0.1}
        max={1000}
        error={errors.priceAlertPercent?.message}
        aria-describedby="price-alert-help"
      />

      <p id="price-alert-help" className="text-sm text-gray-500 dark:text-gray-400">{t('priceAlert.help')}</p>

      <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
        <ToggleSwitch
          checked={!!watchedPriceChartEnabled}
          onChange={(next) => setValue('priceChartEnabled', next, { shouldDirty: true })}
          label={t('priceAlert.chartLabel')}
        />
        {t('priceAlert.chartLabel')}
      </label>

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

      {/* Both are rendered as links on the detail page, so the backend only
          stores an http(s) address and normalises a bare domain to https. There
          is no provider field for an IR page, hence the hint. */}
      <Input
        label={t('form.websiteLabel')}
        placeholder="apple.com"
        error={errors.website?.message}
        {...register('website')}
      />

      <div>
        <Input
          label={t('form.irWebsiteLabel')}
          placeholder="investor.apple.com"
          error={errors.irWebsite?.message}
          {...register('irWebsite')}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('form.irWebsiteHint')}
        </p>
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
            options={countryOptions}
            namePlaceholder={t('form.allocation.countryPlaceholder')}
          />
        </div>
      )}

      {/* Manual asset-class allocation (ETFs/funds only). Free text: the picker
          offers whatever the user has already saved, and entries can be deleted
          from the list straight from the dropdown. */}
      {isFundType && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('form.assetAllocation.sectionTitle')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('form.assetAllocation.help')}
          </p>
          <AllocationEditor
            value={assetRows}
            onChange={setAssetRows}
            options={assetOptions}
            namePlaceholder={t('form.assetAllocation.placeholder')}
            addRowLabel={t('form.assetAllocation.addRow')}
            nameAriaLabel={t('form.assetAllocation.nameAriaLabel')}
            onDeleteOption={setAssetToDelete}
            deleteOptionAriaLabel={t('form.assetAllocation.deleteOption')}
          />
        </div>
      )}

      <ConfirmDialog
        isOpen={assetToDelete !== null}
        title={t('form.assetAllocation.deleteTitle')}
        message={t('form.assetAllocation.deleteMessage', {
          name: assetToDelete ?? '',
        })}
        confirmLabel={t('form.assetAllocation.deleteConfirm')}
        onConfirm={confirmDeleteAsset}
        onCancel={() => setAssetToDelete(null)}
        pushHistory
      />

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
