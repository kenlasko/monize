'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import type { AiProviderConfig, AiProviderType, CreateAiProviderConfig, UpdateAiProviderConfig } from '@/types/ai';
import { AI_PROVIDER_LABELS, AI_PROVIDER_DEFAULT_MODELS } from '@/types/ai';

const AI_PROVIDER_TYPES = ['anthropic', 'openai', 'ollama', 'openai-compatible'] as const;

const providerConfigSchema = z.object({
  provider: z.enum(AI_PROVIDER_TYPES),
  displayName: z.string().max(100, 'Display name must be 100 characters or less').optional().or(z.literal('')),
  model: z.string().max(200).optional().or(z.literal('')),
  apiKey: z.string().max(500).optional().or(z.literal('')),
  baseUrl: z.string().max(500).optional().or(z.literal('')),
  priority: z.string().regex(/^\d*$/, 'Must be a number'),
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

export function ProviderConfigForm({ isOpen, onClose, onSubmit, editConfig }: ProviderConfigFormProps) {
  const [error, setError] = useState('');

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
    },
  });

  // eslint-disable-next-line react-hooks/incompatible-library
  const provider = watch('provider');
  const needsBaseUrl = provider === 'ollama' || provider === 'openai-compatible';
  const needsApiKey = provider !== 'ollama';
  const modelSuggestions = AI_PROVIDER_DEFAULT_MODELS[provider] || [];

  const onFormSubmit = async (formData: ProviderConfigFormData) => {
    setError('');

    try {
      if (editConfig) {
        const data: UpdateAiProviderConfig = {};
        if (formData.displayName !== (editConfig.displayName || '')) data.displayName = formData.displayName || undefined;
        if (formData.model !== (editConfig.model || '')) data.model = formData.model || undefined;
        if (formData.apiKey) data.apiKey = formData.apiKey;
        if (formData.baseUrl !== (editConfig.baseUrl || '')) data.baseUrl = formData.baseUrl || undefined;
        if (formData.priority !== String(editConfig.priority)) data.priority = parseInt(formData.priority, 10) || 0;
        await onSubmit(data);
      } else {
        const data: CreateAiProviderConfig = {
          provider: formData.provider,
          ...(formData.displayName && { displayName: formData.displayName }),
          ...(formData.model && { model: formData.model }),
          ...(formData.apiKey && { apiKey: formData.apiKey }),
          ...(formData.baseUrl && { baseUrl: formData.baseUrl }),
          priority: parseInt(formData.priority, 10) || 0,
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
            <Input
              label="Model"
              {...register('model')}
              error={errors.model?.message}
              placeholder={modelSuggestions[0] || 'Enter model name'}
            />
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
            <Input
              label="Base URL"
              {...register('baseUrl')}
              error={errors.baseUrl?.message}
              placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com/v1'}
            />
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
