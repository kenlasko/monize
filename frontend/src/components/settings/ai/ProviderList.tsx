'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ProviderTestButton } from './ProviderTestButton';
import { ProviderConfigForm } from './ProviderConfigForm';
import type { AiProviderConfig, CreateAiProviderConfig, UpdateAiProviderConfig } from '@/types/ai';
import { AI_PROVIDER_LABELS, AiProviderType } from '@/types/ai';
import { aiApi } from '@/lib/ai';
import { getErrorMessage } from '@/lib/errors';
import toast from 'react-hot-toast';

interface ProviderListProps {
  configs: AiProviderConfig[];
  encryptionAvailable: boolean;
  onConfigsChanged: () => void;
  hasSystemDefault?: boolean;
  systemDefaultProvider?: string | null;
  systemDefaultModel?: string | null;
  disabled?: boolean;
}

export function ProviderList({ configs, encryptionAvailable, onConfigsChanged, hasSystemDefault, systemDefaultProvider, systemDefaultModel, disabled }: ProviderListProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<AiProviderConfig | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleCreate = async (data: CreateAiProviderConfig | UpdateAiProviderConfig) => {
    await aiApi.createConfig(data as CreateAiProviderConfig);
    toast.success('Provider added');
    onConfigsChanged();
  };

  const handleUpdate = async (data: CreateAiProviderConfig | UpdateAiProviderConfig) => {
    if (!editingConfig) return;
    await aiApi.updateConfig(editingConfig.id, data as UpdateAiProviderConfig);
    toast.success('Provider updated');
    setEditingConfig(null);
    onConfigsChanged();
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await aiApi.deleteConfig(id);
      toast.success('Provider removed');
      onConfigsChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete provider'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleActive = async (config: AiProviderConfig) => {
    try {
      await aiApi.updateConfig(config.id, { isActive: !config.isActive });
      onConfigsChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update provider'));
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-4 sm:p-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">AI Providers</h2>
        <Button size="sm" onClick={() => setShowForm(true)} disabled={disabled}>
          Add Provider
        </Button>
      </div>

      {!encryptionAvailable && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 mb-4">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            AI_ENCRYPTION_KEY is not configured. You can use Ollama (local, no API key needed) but cloud providers require encryption to store API keys securely.
          </p>
        </div>
      )}

      {hasSystemDefault && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
          <div className="flex items-start gap-3">
            <svg className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200">System Default AI Provider Available</h3>
              <p className="mt-1 text-sm text-blue-700 dark:text-blue-300">
                A central AI provider has been configured by your administrator
                {systemDefaultProvider && (
                  <span> ({AI_PROVIDER_LABELS[systemDefaultProvider as AiProviderType] || systemDefaultProvider}{systemDefaultModel ? `, ${systemDefaultModel}` : ''})</span>
                )}.
                {configs.length === 0
                  ? ' It will be used automatically since you have no personal providers configured.'
                  : ' Your personal providers take priority over the system default.'}
              </p>
            </div>
          </div>
        </div>
      )}

      {configs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {hasSystemDefault
            ? 'No personal AI providers configured. The system default provider will be used.'
            : 'No AI providers configured. Add a provider to enable AI features.'}
        </p>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => (
            <div
              key={config.id}
              className={`border rounded-lg p-3 sm:p-4 ${
                config.isActive
                  ? 'border-gray-200 dark:border-gray-700'
                  : 'border-gray-100 dark:border-gray-800 opacity-60'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      {config.displayName || AI_PROVIDER_LABELS[config.provider as AiProviderType] || config.provider}
                    </h3>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      config.isActive
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}>
                      {config.isActive ? 'Active' : 'Inactive'}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      Priority: {config.priority}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                    {config.model && <span>Model: {config.model}</span>}
                    {config.apiKeyMasked && <span>Key: {config.apiKeyMasked}</span>}
                    {config.baseUrl && <span className="truncate max-w-xs">URL: {config.baseUrl}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <ProviderTestButton configId={config.id} disabled={disabled} />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggleActive(config)}
                    disabled={disabled}
                  >
                    {config.isActive ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingConfig(config)}
                    disabled={disabled}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(config.id)}
                    isLoading={deletingId === config.id}
                    disabled={disabled}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ProviderConfigForm
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        onSubmit={handleCreate}
      />

      {editingConfig && (
        <ProviderConfigForm
          isOpen={true}
          onClose={() => setEditingConfig(null)}
          onSubmit={handleUpdate}
          editConfig={editingConfig}
        />
      )}
    </div>
  );
}
