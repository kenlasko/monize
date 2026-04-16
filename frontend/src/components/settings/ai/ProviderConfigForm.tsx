'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'react-hot-toast';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import type { AiProviderConfig, AiProviderType, CreateAiProviderConfig, UpdateAiProviderConfig } from '@/types/ai';
import { AI_PROVIDER_LABELS, AI_PROVIDER_DEFAULT_MODELS } from '@/types/ai';
import { aiApi } from '@/lib/ai';
import { getErrorMessage } from '@/lib/errors';

const AI_PROVIDER_TYPES = ['anthropic', 'openai', 'ollama', 'ollama-cloud', 'openai-compatible'] as const;

const costField = z
  .string()
  .regex(/^(\d+(\.\d{0,4})?)?$/, 'Must be a number with up to 4 decimal places')
  .optional()
  .or(z.literal(''));

// Common billing currencies for AI providers. USD covers Anthropic/OpenAI;
// the others are included to let users align with locally-billed providers.
const COST_CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
  { value: 'CAD', label: 'CAD - Canadian Dollar' },
  { value: 'AUD', label: 'AUD - Australian Dollar' },
  { value: 'JPY', label: 'JPY - Japanese Yen' },
  { value: 'CNY', label: 'CNY - Chinese Yuan' },
  { value: 'INR', label: 'INR - Indian Rupee' },
];

const providerConfigSchema = z.object({
  provider: z.enum(AI_PROVIDER_TYPES),
  displayName: z.string().max(100, 'Display name must be 100 characters or less').optional().or(z.literal('')),
  model: z.string().max(200).optional().or(z.literal('')),
  apiKey: z.string().max(500).optional().or(z.literal('')),
  baseUrl: z.string().max(500).optional().or(z.literal('')),
  priority: z.string().regex(/^\d*$/, 'Must be a number'),
  inputCostPer1M: costField,
  outputCostPer1M: costField,
  costCurrency: z.string().regex(/^[A-Z]{3}$/, 'Must be a 3-letter currency code'),
});

type ProviderConfigFormData = z.infer<typeof providerConfigSchema>;

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
  const [error, setError] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ProviderConfigFormData>({
    resolver: zodResolver(providerConfigSchema),
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
    },
  });

  const provider = watch('provider');
  const needsBaseUrl =
    provider === 'ollama' ||
    provider === 'ollama-cloud' ||
    provider === 'openai-compatible';
  const needsApiKey = provider !== 'ollama';
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
        toast.error(result.error || 'Could not reach the provider.', { duration: 6000 });
        return;
      }
      if (result.modelAvailable === false) {
        setTestStatus('error');
        toast.error(
          result.modelError ||
            `Model "${result.model ?? 'unknown'}" is not available on this provider.`,
          { duration: 7000 },
        );
        return;
      }
      setTestStatus('success');
      toast.success(
        result.modelAvailable
          ? `Model "${result.model}" is ready.`
          : 'Connection successful.',
      );
    } catch (err) {
      setTestStatus('error');
      toast.error(getErrorMessage(err, 'Model test failed'));
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
        await onSubmit(data);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="lg">
      <form onSubmit={handleSubmit(onFormSubmit)} className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {editConfig ? 'Edit Provider' : 'Add AI Provider'}
        </h2>

        <div className="space-y-4">
          {!editConfig && (
            <Select
              label="Provider"
              {...register('provider')}
              options={PROVIDER_OPTIONS}
              error={errors.provider?.message}
            />
          )}

          <Input
            label="Display Name"
            {...register('displayName')}
            error={errors.displayName?.message}
            placeholder={AI_PROVIDER_LABELS[provider]}
            maxLength={100}
          />

          <div>
            <label
              htmlFor="input-model"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Model
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <Input
                  id="input-model"
                  {...register('model')}
                  error={errors.model?.message}
                  placeholder={modelSuggestions[0] || 'Enter model name'}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestModel}
                disabled={testStatus === 'testing' || isSubmitting}
                aria-label="Test model"
                className={`shrink-0 w-24 justify-center ${
                  testStatus === 'success'
                    ? 'border-green-500 text-green-600 dark:border-green-400 dark:text-green-400'
                    : testStatus === 'error'
                      ? 'border-red-500 text-red-600 dark:border-red-400 dark:text-red-400'
                      : ''
                }`}
              >
                {testStatus === 'testing' ? 'Testing...' : 'Test'}
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
                Model names must include the <code>-cloud</code> suffix (e.g. <code>gpt-oss:20b-cloud</code>).
              </p>
            )}
          </div>

          {needsApiKey && (
            <Input
              label="API Key"
              type="password"
              {...register('apiKey')}
              error={errors.apiKey?.message}
              placeholder={editConfig?.apiKeyMasked || 'Enter API key'}
            />
          )}

          {needsBaseUrl && (
            <div>
              <Input
                label="Base URL"
                {...register('baseUrl')}
                error={errors.baseUrl?.message}
                placeholder={
                  provider === 'ollama'
                    ? 'http://localhost:11434'
                    : provider === 'ollama-cloud'
                      ? 'https://ollama.com'
                      : 'https://api.example.com/v1'
                }
              />
              {provider === 'ollama-cloud' && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Leave blank to use the default <code>https://ollama.com</code> endpoint.
                </p>
              )}
            </div>
          )}

          <Input
            label="Priority"
            type="number"
            {...register('priority')}
            error={errors.priority?.message}
            min={0}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 -mt-3">
            Lower number = higher priority. Used for fallback ordering.
          </p>

          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Cost rates (optional)
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Enter your provider&apos;s published rates per 1,000,000 tokens to see estimated cost on the Usage dashboard. Leave blank to skip cost estimates.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Input cost / 1M tokens"
                type="number"
                step="0.0001"
                min={0}
                {...register('inputCostPer1M')}
                error={errors.inputCostPer1M?.message}
                placeholder="e.g., 3.00"
              />
              <Input
                label="Output cost / 1M tokens"
                type="number"
                step="0.0001"
                min={0}
                {...register('outputCostPer1M')}
                error={errors.outputCostPer1M?.message}
                placeholder="e.g., 15.00"
              />
            </div>
            <div className="mt-3">
              <Select
                label="Rate Currency"
                {...register('costCurrency')}
                options={COST_CURRENCY_OPTIONS}
                error={errors.costCurrency?.message}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                If this differs from your home currency, the Usage dashboard can convert costs using your saved exchange rates.
              </p>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            {editConfig ? 'Save Changes' : 'Add Provider'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
