'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useForm, Controller } from 'react-hook-form';
import { toast } from 'react-hot-toast';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import type {
  AiProviderConfig,
  AiProviderQueryBudgets,
  AiProviderType,
  CreateAiProviderConfig,
  UpdateAiProviderConfig,
} from '@/types/ai';
import { AI_PROVIDER_LABELS, AI_PROVIDER_DEFAULT_MODELS } from '@/types/ai';
import { AI_QUERY_BUDGETS, AI_QUERY_BUDGET_FIELDS } from '@/lib/ai-query-budgets';
import { aiApi } from '@/lib/ai';
import { getErrorMessage } from '@/lib/errors';
import { RelayConnectInstructions } from '@/components/ai/RelayConnectInstructions';
import { useRelayStatus } from '@/components/ai/useRelayStatus';

const AI_PROVIDER_TYPES = ['anthropic', 'openai', 'ollama', 'ollama-cloud', 'openai-compatible', 'mcp_relay'] as const;

const RELAY_DOT_CLASS = {
  listening: 'bg-green-500 animate-pulse',
  busy: 'bg-amber-500',
  idle: 'bg-amber-400 dark:bg-amber-500',
  offline: 'bg-gray-400 dark:bg-gray-600',
} as const;

const costField = z
  .string()
  .regex(/^(\d+(\.\d{0,4})?)?$/, 'Must be a number with up to 4 decimal places')
  .optional()
  .or(z.literal(''));

// Common billing currencies for AI providers. USD covers Anthropic/OpenAI;
// the others are included to let users align with locally-billed providers.
const COST_CURRENCY_OPTIONS = [
  { value: 'USD', labelKey: 'costCurrencies.USD' },
  { value: 'EUR', labelKey: 'costCurrencies.EUR' },
  { value: 'GBP', labelKey: 'costCurrencies.GBP' },
  { value: 'CAD', labelKey: 'costCurrencies.CAD' },
  { value: 'AUD', labelKey: 'costCurrencies.AUD' },
  { value: 'JPY', labelKey: 'costCurrencies.JPY' },
  { value: 'CNY', labelKey: 'costCurrencies.CNY' },
  { value: 'INR', labelKey: 'costCurrencies.INR' },
];

/**
 * A per-query budget: blank means "use the default", anything else must be a
 * whole number inside the range the server accepts. Held as a string like the
 * other numeric fields on this form, so a cleared field is distinguishable
 * from a zero.
 */
const budgetField = (
  t: (key: string, values?: Record<string, string | number>) => string,
  { min, max }: { min: number; max: number },
) =>
  z
    .string()
    .regex(/^\d*$/, t('validation.mustBeNumber'))
    .refine(
      (value) => value === '' || (Number(value) >= min && Number(value) <= max),
      { message: t('validation.budgetRange', { min, max }) },
    );

const buildProviderConfigSchema = (
  t: (key: string, values?: Record<string, string | number>) => string,
) => z.object({
  provider: z.enum(AI_PROVIDER_TYPES),
  displayName: z.string().max(100, t('validation.displayNameMax')).optional().or(z.literal('')),
  model: z.string().max(200).optional().or(z.literal('')),
  apiKey: z.string().max(500).optional().or(z.literal('')),
  baseUrl: z.string().max(500).optional().or(z.literal('')),
  priority: z.string().regex(/^\d*$/, t('validation.mustBeNumber')),
  inputCostPer1M: costField,
  outputCostPer1M: costField,
  costCurrency: z.string().regex(/^[A-Z]{3}$/, t('validation.currencyCode')),
  queryMaxIterations: budgetField(t, AI_QUERY_BUDGETS.queryMaxIterations),
  queryMaxToolCalls: budgetField(t, AI_QUERY_BUDGETS.queryMaxToolCalls),
  queryTimeoutMinutes: budgetField(t, AI_QUERY_BUDGETS.queryTimeoutMinutes),
  queryMaxInputTokens: budgetField(t, AI_QUERY_BUDGETS.queryMaxInputTokens),
  queryMaxToolResultChars: budgetField(
    t,
    AI_QUERY_BUDGETS.queryMaxToolResultChars,
  ),
});

type ProviderConfigFormData = z.infer<ReturnType<typeof buildProviderConfigSchema>>;

/** A stored budget as form text; blank when the provider runs on the default. */
const budgetDefaultValue = (
  config: AiProviderConfig | null | undefined,
  name: keyof AiProviderQueryBudgets,
): string => {
  const stored = config?.[name];
  return stored == null ? '' : String(stored);
};

/** Form text back to a stored budget: blank clears it back to the default. */
const parseBudget = (value: string | undefined): number | null => {
  if (value === undefined || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

interface ProviderConfigFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: CreateAiProviderConfig | UpdateAiProviderConfig) => Promise<void>;
  editConfig?: AiProviderConfig | null;
}

const PROVIDER_OPTIONS = (Object.entries(AI_PROVIDER_LABELS) as [AiProviderType, string][]).map(
  ([value, label]) => ({ value, label })
);

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

export function ProviderConfigForm({ isOpen, onClose, onSubmit, editConfig }: ProviderConfigFormProps) {
  const t = useTranslations('settings.aiProviders.configForm');
  const tc = useTranslations('common');
  const tRelay = useTranslations('ai');
  const tMcp = useTranslations('settings.aiSettings.mcpRelay');
  const [error, setError] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ProviderConfigFormData>({
    resolver: zodResolver(buildProviderConfigSchema(t)),
    defaultValues: {
      provider: editConfig?.provider || 'anthropic',
      displayName: editConfig?.displayName || '',
      model: editConfig?.model || '',
      apiKey: '',
      baseUrl: editConfig?.baseUrl || '',
      priority: String(editConfig?.priority ?? 0),
      inputCostPer1M: editConfig?.inputCostPer1M != null ? String(editConfig.inputCostPer1M) : '',
      outputCostPer1M: editConfig?.outputCostPer1M != null ? String(editConfig.outputCostPer1M) : '',
      costCurrency: editConfig?.costCurrency || 'USD',
      queryMaxIterations: budgetDefaultValue(editConfig, 'queryMaxIterations'),
      queryMaxToolCalls: budgetDefaultValue(editConfig, 'queryMaxToolCalls'),
      queryTimeoutMinutes: budgetDefaultValue(editConfig, 'queryTimeoutMinutes'),
      queryMaxInputTokens: budgetDefaultValue(editConfig, 'queryMaxInputTokens'),
      queryMaxToolResultChars: budgetDefaultValue(editConfig, 'queryMaxToolResultChars'),
    },
  });

  const provider = watch('provider');
  // The MCP relay is not a callable LLM -- it has no key/model/base URL/cost.
  // The modal instead explains how to connect the user's own agent and shows
  // the live connection state.
  const isRelay = provider === 'mcp_relay';
  const relayState = useRelayStatus(isRelay);
  // Ollama Cloud intentionally has no Base URL field: the backend pins it
  // to https://ollama.com to close an SSRF vector, so exposing the input
  // would just confuse the user (the value would be silently dropped).
  const needsBaseUrl =
    provider === 'ollama' || provider === 'openai-compatible';
  const needsApiKey = provider !== 'ollama' && !isRelay;
  const modelSuggestions = AI_PROVIDER_DEFAULT_MODELS[provider] || [];

  const parseCost = (value: string | undefined): number | null => {
    if (value === undefined || value === '') return null;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const handleTestModel = async () => {
    setTestStatus('testing');
    setError('');
    try {
      // Probe against the in-progress form values without saving. When
      // editing and the user hasn't typed a new API key, pass configId
      // so the server falls back to the stored (encrypted) key.
      // eslint-disable-next-line react-hooks/incompatible-library
      const currentValues = watch();
      const result = await aiApi.testDraft({
        provider: currentValues.provider,
        ...(currentValues.model && { model: currentValues.model }),
        ...(currentValues.apiKey && { apiKey: currentValues.apiKey }),
        ...(currentValues.baseUrl && { baseUrl: currentValues.baseUrl }),
        ...(editConfig && !currentValues.apiKey && { configId: editConfig.id }),
      });

      if (!result.available) {
        setTestStatus('error');
        toast.error(result.error || t('toasts.notReachable'), { duration: 6000 });
        return;
      }
      if (result.modelAvailable === false) {
        setTestStatus('error');
        toast.error(
          result.modelError || t('toasts.modelUnavailable', { model: result.model ?? 'unknown' }),
          { duration: 7000 },
        );
        return;
      }
      setTestStatus('success');
      toast.success(
        result.modelAvailable
          ? t('toasts.modelReady', { model: result.model ?? '' })
          : t('toasts.success'),
      );
    } catch (err) {
      setTestStatus('error');
      toast.error(getErrorMessage(err, t('toasts.testFailed')));
    }
  };

  const onFormSubmit = async (formData: ProviderConfigFormData) => {
    setError('');

    try {
      const newInputCost = parseCost(formData.inputCostPer1M);
      const newOutputCost = parseCost(formData.outputCostPer1M);

      if (editConfig) {
        const data: UpdateAiProviderConfig = {};
        if (formData.displayName !== (editConfig.displayName || '')) data.displayName = formData.displayName || undefined;
        if (formData.model !== (editConfig.model || '')) data.model = formData.model || undefined;
        if (formData.apiKey) data.apiKey = formData.apiKey;
        if (formData.baseUrl !== (editConfig.baseUrl || '')) data.baseUrl = formData.baseUrl || undefined;
        if (formData.priority !== String(editConfig.priority)) data.priority = parseInt(formData.priority, 10) || 0;
        if (newInputCost !== editConfig.inputCostPer1M) data.inputCostPer1M = newInputCost;
        if (newOutputCost !== editConfig.outputCostPer1M) data.outputCostPer1M = newOutputCost;
        if (formData.costCurrency !== editConfig.costCurrency) data.costCurrency = formData.costCurrency;
        // A cleared budget is sent as null -- "put this back on the default" --
        // which an omitted field would not say.
        for (const field of AI_QUERY_BUDGET_FIELDS) {
          const next = parseBudget(formData[field.name]);
          if (next !== editConfig[field.name]) data[field.name] = next;
        }
        await onSubmit(data);
      } else {
        const data: CreateAiProviderConfig = {
          provider: formData.provider,
          ...(formData.displayName && { displayName: formData.displayName }),
          ...(formData.model && { model: formData.model }),
          ...(formData.apiKey && { apiKey: formData.apiKey }),
          ...(formData.baseUrl && { baseUrl: formData.baseUrl }),
          priority: parseInt(formData.priority, 10) || 0,
          ...(newInputCost !== null && { inputCostPer1M: newInputCost }),
          ...(newOutputCost !== null && { outputCostPer1M: newOutputCost }),
          costCurrency: formData.costCurrency,
        };
        for (const field of AI_QUERY_BUDGET_FIELDS) {
          const value = parseBudget(formData[field.name]);
          if (value !== null) data[field.name] = value;
        }
        await onSubmit(data);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="4xl">
      <form onSubmit={handleSubmit(onFormSubmit)} className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {editConfig ? t('editTitle') : t('addTitle')}
        </h2>

        <div className="space-y-4">
          {!editConfig && (
            <Select
              label={t('providerLabel')}
              {...register('provider')}
              options={PROVIDER_OPTIONS}
              error={errors.provider?.message}
            />
          )}

          <Input
            label={t('displayNameLabel')}
            {...register('displayName')}
            error={errors.displayName?.message}
            placeholder={AI_PROVIDER_LABELS[provider]}
            maxLength={100}
          />

          {isRelay && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3 space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {tMcp('subtitle')}
              </p>
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${RELAY_DOT_CLASS[relayState]}`}
                  aria-hidden="true"
                />
                <span>{tRelay(`relay.status.${relayState}`)}</span>
              </div>
              <RelayConnectInstructions />
            </div>
          )}

          {!isRelay && (
          <div>
            <label
              htmlFor="input-model"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('modelLabel')}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <Input
                  id="input-model"
                  {...register('model')}
                  error={errors.model?.message}
                  placeholder={modelSuggestions[0] || t('modelPlaceholder')}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestModel}
                disabled={testStatus === 'testing' || isSubmitting}
                aria-label={t('testModelAria')}
                className={`shrink-0 w-24 justify-center ${
                  testStatus === 'success'
                    ? 'border-green-500 text-green-600 dark:border-green-400 dark:text-green-400'
                    : testStatus === 'error'
                      ? 'border-red-500 text-red-600 dark:border-red-400 dark:text-red-400'
                      : ''
                }`}
              >
                {testStatus === 'testing' ? t('testingButton') : t('testButton')}
              </Button>
            </div>
            {modelSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {modelSuggestions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setValue('model', m)}
                    className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            {provider === 'ollama-cloud' && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('ollamaCloudNote')}
              </p>
            )}
          </div>
          )}

          {needsApiKey && (
            <Input
              label={t('apiKeyLabel')}
              type="password"
              // Not a credential of ours: a password manager offering the
              // account password here silently overwrites the stored provider
              // key on save, because a non-empty value is sent as `apiKey`.
              autoComplete="off"
              {...register('apiKey')}
              error={errors.apiKey?.message}
              placeholder={editConfig?.apiKeyMasked || t('apiKeyPlaceholder')}
            />
          )}

          {needsBaseUrl && (
            <Input
              label={t('baseUrlLabel')}
              {...register('baseUrl')}
              error={errors.baseUrl?.message}
              placeholder={
                provider === 'ollama'
                  ? 'http://localhost:11434'
                  : 'https://api.example.com/v1'
              }
            />
          )}

          <Controller
            name="priority"
            control={control}
            render={({ field }) => (
              <NumericInput
                label={t('priorityLabel')}
                decimalPlaces={0}
                min={0}
                error={errors.priority?.message}
                value={field.value === '' ? undefined : Number(field.value)}
                onChange={(value) => field.onChange(value === undefined ? '' : String(value))}
                name={field.name}
                onBlur={field.onBlur}
              />
            )}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 -mt-3">
            {t('priorityHelp')}
          </p>

          {!isRelay && (
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('costRatesHeading')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              {t('costRatesHelp')}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Controller
                name="inputCostPer1M"
                control={control}
                render={({ field }) => (
                  <NumericInput
                    label={t('inputCostLabel')}
                    decimalPlaces={4}
                    min={0}
                    error={errors.inputCostPer1M?.message}
                    placeholder={t('inputCostPlaceholder')}
                    value={field.value === '' ? undefined : Number(field.value)}
                    onChange={(value) => field.onChange(value === undefined ? '' : String(value))}
                    name={field.name}
                    onBlur={field.onBlur}
                  />
                )}
              />
              <Controller
                name="outputCostPer1M"
                control={control}
                render={({ field }) => (
                  <NumericInput
                    label={t('outputCostLabel')}
                    decimalPlaces={4}
                    min={0}
                    error={errors.outputCostPer1M?.message}
                    placeholder={t('outputCostPlaceholder')}
                    value={field.value === '' ? undefined : Number(field.value)}
                    onChange={(value) => field.onChange(value === undefined ? '' : String(value))}
                    name={field.name}
                    onBlur={field.onBlur}
                  />
                )}
              />
            </div>
            <div className="mt-3">
              <Select
                label={t('rateCurrencyLabel')}
                {...register('costCurrency')}
                options={COST_CURRENCY_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                error={errors.costCurrency?.message}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('rateCurrencyHelp')}
              </p>
            </div>
          </div>
          )}

          {/*
            Per-query budgets. These belong to this provider: a hosted frontier
            model plans several lookups per turn and finishes inside the
            defaults, while a small local model spends one analysis step per
            lookup and runs out mid-investigation. Blank keeps the default.
          */}
          {!isRelay && (
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('queryBudgets.heading')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              {t('queryBudgets.help')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {AI_QUERY_BUDGET_FIELDS.map((budget) => (
                <div key={budget.name}>
                  <Controller
                    name={budget.name}
                    control={control}
                    render={({ field }) => (
                      <NumericInput
                        id={`input-${budget.name}`}
                        label={t(`queryBudgets.${budget.labelKey}Label`)}
                        decimalPlaces={0}
                        max={budget.max}
                        error={errors[budget.name]?.message}
                        placeholder={t('queryBudgets.defaultPlaceholder', {
                          value: budget.default,
                        })}
                        value={field.value === '' ? undefined : Number(field.value)}
                        onChange={(value) => field.onChange(value === undefined ? '' : String(value))}
                        name={field.name}
                        onBlur={field.onBlur}
                      />
                    )}
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t(`queryBudgets.${budget.labelKey}Help`)}
                  </p>
                </div>
              ))}
            </div>
          </div>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            {editConfig ? t('saveButton') : t('addProviderButton')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
