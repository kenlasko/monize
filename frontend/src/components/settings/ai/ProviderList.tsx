'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ProviderTestButton } from './ProviderTestButton';
import { ProviderConfigForm } from './ProviderConfigForm';
import { useRelayStatus } from '@/components/ai/useRelayStatus';
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

const RELAY_DOT_CLASS = {
  listening: 'bg-green-500 animate-pulse',
  busy: 'bg-amber-500',
  idle: 'bg-amber-400 dark:bg-amber-500',
  offline: 'bg-gray-400 dark:bg-gray-600',
} as const;

/** Live connection state for an MCP Relay provider row. */
function RelayProviderStatusLine() {
  const t = useTranslations('ai');
  const state = useRelayStatus(true);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-2 w-2 rounded-full ${RELAY_DOT_CLASS[state]}`}
        aria-hidden="true"
      />
      <span>{t(`relay.status.${state}`)}</span>
    </span>
  );
}

export function ProviderList({ configs, encryptionAvailable, onConfigsChanged, hasSystemDefault, systemDefaultProvider, systemDefaultModel, disabled }: ProviderListProps) {
  const t = useTranslations('settings.aiProviders');
  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<AiProviderConfig | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const runPostSaveTest = async (configId: string) => {
    // Fire-and-forget background check so the form can close immediately
    // even when the test takes a few seconds (a 1-token inference can
    // be slow on Ollama / CPU-only backends).
    try {
      const result = await aiApi.testConnection(configId);
      if (!result.available) {
        toast.error(result.error || t('toasts.notReachable'), { duration: 7000 });
      } else if (result.modelAvailable === false) {
        toast.error(
          result.modelError || t('toasts.modelUnavailable', { model: result.model ?? 'unknown' }),
          { duration: 7000 },
        );
      } else if (result.modelAvailable) {
        toast.success(t('toasts.modelReady', { model: result.model ?? '' }));
      }
    } catch {
      // Non-fatal: the save itself already succeeded. Skip the noise.
    }
  };

  const handleCreate = async (data: CreateAiProviderConfig | UpdateAiProviderConfig) => {
    const created = await aiApi.createConfig(data as CreateAiProviderConfig);
    toast.success(t('toasts.added'));
    onConfigsChanged();
    void runPostSaveTest(created.id);
  };

  const handleUpdate = async (data: CreateAiProviderConfig | UpdateAiProviderConfig) => {
    if (!editingConfig) return;
    const updated = await aiApi.updateConfig(editingConfig.id, data as UpdateAiProviderConfig);
    toast.success(t('toasts.updated'));
    setEditingConfig(null);
    onConfigsChanged();
    void runPostSaveTest(updated.id);
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await aiApi.deleteConfig(id);
      toast.success(t('toasts.removed'));
      onConfigsChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.deleteFailed')));
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleActive = async (config: AiProviderConfig) => {
    try {
      await aiApi.updateConfig(config.id, { isActive: !config.isActive });
      onConfigsChanged();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.updateFailed')));
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-4 sm:p-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('heading')}</h2>
        <Button size="sm" onClick={() => setShowForm(true)} disabled={disabled}>
          {t('addButton')}
        </Button>
      </div>

      {!encryptionAvailable && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 mb-4">
          <p className="text-sm text-amber-700 dark:text-amber-300">
            {t('encryptionWarning')}
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
              <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200">{t('systemDefault.heading')}</h3>
              <p className="mt-1 text-sm text-blue-700 dark:text-blue-300">
                {t('systemDefault.description')}
                {systemDefaultProvider && (
                  <span> ({AI_PROVIDER_LABELS[systemDefaultProvider as AiProviderType] || systemDefaultProvider}{systemDefaultModel ? `, ${systemDefaultModel}` : ''})</span>
                )}.
                {' '}{configs.length === 0
                  ? t('systemDefault.usedAutomatically')
                  : t('systemDefault.personalPriority')}
              </p>
            </div>
          </div>
        </div>
      )}

      {configs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {hasSystemDefault
            ? t('noProviders.withSystemDefault')
            : t('noProviders.withoutSystemDefault')}
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
                      {config.isActive ? t('providerCard.activeBadge') : t('providerCard.inactiveBadge')}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {t('providerCard.priorityLabel', { n: config.priority })}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                    {config.provider === 'mcp_relay' && <RelayProviderStatusLine />}
                    {config.model && <span>{t('providerCard.modelLabel', { model: config.model })}</span>}
                    {config.apiKeyMasked && <span>{t('providerCard.keyLabel', { key: config.apiKeyMasked })}</span>}
                    {config.baseUrl && <span className="truncate max-w-xs">{t('providerCard.urlLabel', { url: config.baseUrl })}</span>}
                    {(config.inputCostPer1M != null || config.outputCostPer1M != null) && (
                      <span>
                        {t('providerCard.costLabel', { currency: config.costCurrency ?? '', input: config.inputCostPer1M ?? 0, output: config.outputCostPer1M ?? 0 })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {config.provider !== 'mcp_relay' && (
                    <ProviderTestButton configId={config.id} disabled={disabled} />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggleActive(config)}
                    disabled={disabled}
                  >
                    {config.isActive ? t('providerCard.disableButton') : t('providerCard.enableButton')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingConfig(config)}
                    disabled={disabled}
                  >
                    {t('providerCard.editButton')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(config.id)}
                    isLoading={deletingId === config.id}
                    disabled={disabled}
                  >
                    {t('providerCard.deleteButton')}
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
