'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import type { AiProviderConfig, AiProviderType, CreateAiProviderConfig, UpdateAiProviderConfig } from '@/types/ai';
import { AI_PROVIDER_LABELS, AI_PROVIDER_DEFAULT_MODELS } from '@/types/ai';

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
  const [provider, setProvider] = useState<AiProviderType>(editConfig?.provider || 'anthropic');
  const [displayName, setDisplayName] = useState(editConfig?.displayName || '');
  const [model, setModel] = useState(editConfig?.model || '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(editConfig?.baseUrl || '');
  const [priority, setPriority] = useState(String(editConfig?.priority ?? 0));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const needsBaseUrl = provider === 'ollama' || provider === 'openai-compatible';
  const needsApiKey = provider !== 'ollama';
  const modelSuggestions = AI_PROVIDER_DEFAULT_MODELS[provider] || [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      if (editConfig) {
        const data: UpdateAiProviderConfig = {};
        if (displayName !== (editConfig.displayName || '')) data.displayName = displayName || undefined;
        if (model !== (editConfig.model || '')) data.model = model || undefined;
        if (apiKey) data.apiKey = apiKey;
        if (baseUrl !== (editConfig.baseUrl || '')) data.baseUrl = baseUrl || undefined;
        if (priority !== String(editConfig.priority)) data.priority = parseInt(priority, 10) || 0;
        await onSubmit(data);
      } else {
        const data: CreateAiProviderConfig = {
          provider,
          ...(displayName && { displayName }),
          ...(model && { model }),
          ...(apiKey && { apiKey }),
          ...(baseUrl && { baseUrl }),
          priority: parseInt(priority, 10) || 0,
        };
        await onSubmit(data);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="lg">
      <form onSubmit={handleSubmit} className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {editConfig ? 'Edit Provider' : 'Add AI Provider'}
        </h2>

        <div className="space-y-4">
          {!editConfig && (
            <Select
              label="Provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as AiProviderType)}
              options={PROVIDER_OPTIONS}
            />
          )}

          <Input
            label="Display Name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={AI_PROVIDER_LABELS[provider]}
            maxLength={100}
          />

          <div>
            <Input
              label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={modelSuggestions[0] || 'Enter model name'}
            />
            {modelSuggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {modelSuggestions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModel(m)}
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
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={editConfig?.apiKeyMasked || 'Enter API key'}
            />
          )}

          {needsBaseUrl && (
            <Input
              label="Base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={provider === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com/v1'}
            />
          )}

          <Input
            label="Priority"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
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
