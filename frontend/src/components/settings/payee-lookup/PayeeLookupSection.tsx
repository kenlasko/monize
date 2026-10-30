'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useContactLookupAvailable } from '@/hooks/useContactLookupAvailable';
import { getErrorMessage } from '@/lib/errors';
import { payeeLookupApi } from '@/lib/payee-lookup';
import type {
  PayeeLookupPreferredSource,
  PayeeLookupSettings,
  UpdatePayeeLookupSettings,
} from '@/types/payee-lookup';
import { Select } from '@/components/ui/Select';
import { aiApi } from '@/lib/ai';
import type { AiProviderConfig } from '@/types/ai';
import { GooglePlacesConfigModal } from './GooglePlacesConfigModal';
import { LookupSourceOrder } from './LookupSourceOrder';
import { PayeeContactLookupToggle } from './PayeeContactLookupToggle';
import { docsUrl } from '@/lib/docs-links';

/**
 * Where the documentation explains getting a Google Places key.
 *
 * Worth a link rather than more copy on the card: the setup is a Google Cloud
 * errand (create a project, enable Places API (New), restrict the key BY IP
 * because Monize calls Google from the server, not by HTTP referrer) and none
 * of it fits beside a switch.
 */
const GOOGLE_PLACES_SETUP_URL = docsUrl('googlePlacesSetup');

/**
 * How a provider is named in the picker.
 *
 * The model matters as much as the vendor -- two Anthropic rows differing only
 * by model are otherwise indistinguishable -- and `displayName` is the name the
 * user gave it, so it wins where they set one.
 */
function providerLabel(provider: AiProviderConfig): string {
  const name = provider.displayName || provider.provider;
  return provider.model ? `${name} (${provider.model})` : name;
}

interface PayeeLookupSectionProps {
  disabled?: boolean;
  /**
   * Outer spacing, so a host can place the section. The Settings page stacks
   * sections and wants the bottom margin; a modal supplies its own padding and
   * does not.
   */
  className?: string;
}

/**
 * Where a payee's website, address, email and phone come from.
 *
 * Its own settings section rather than a corner of AI Settings, because Google
 * Places is not an AI provider: a user who configures Places and no AI would
 * otherwise have to go to a screen about models to set up a business
 * directory, and the automatic-lookup switch below it would sit under a
 * heading that no longer describes what answers the lookup.
 *
 * Two save contracts on one screen, deliberately. The on/off switch and the
 * automatic-lookup toggle save as they change (the section's contract). The
 * key and the cap are edited in a modal with an explicit Save, because a key
 * is invalid until it is complete -- saving it per keystroke would store a
 * dozen broken credentials and test none of them.
 */
export function PayeeLookupSection({
  disabled = false,
  className = 'mb-6',
}: PayeeLookupSectionProps) {
  const t = useTranslations('settings.payeeLookup');
  const [settings, setSettings] = useState<PayeeLookupSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  // Only the ACTIVE providers: an inactive one cannot answer a lookup, so
  // offering it would let the user pin a source that reports no_provider.
  const [aiProviders, setAiProviders] = useState<AiProviderConfig[]>([]);
  // Whether ANY source can answer -- Places within its cap and with a readable
  // key, or an AI provider that is switched on. The automatic-lookup toggle is
  // about a lookup that runs by itself, so it is live only when something could
  // actually run. This card is the one surface that CHANGES that answer, so it
  // re-reads the status after every save rather than re-deriving it here: the
  // server's answer already folds in the spent cap and an unreadable key.
  const {
    available: lookupAvailable,
    resolved: availabilityResolved,
    failed: availabilityFailed,
    aiConfigured,
    refresh: refreshAvailability,
  } = useContactLookupAvailable();

  useEffect(() => {
    let active = true;
    // Best-effort: the order list still works without it, offering no model
    // choice rather than a broken one.
    aiApi
      .getConfigs()
      .then((configs) => {
        if (active) setAiProviders(configs.filter((c) => c.isActive));
      })
      .catch(() => {
        if (active) setAiProviders([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    payeeLookupApi
      .getSettings()
      .then((data) => {
        if (active) setSettings(data);
      })
      .catch(() => {
        // A failed read is not "nothing configured": rendering the empty state
        // would invite the user to enter a key they may already have stored.
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(
    async (update: UpdatePayeeLookupSettings) => {
      setSaving(true);
      try {
        const saved = await payeeLookupApi.updateSettings(update);
        setSettings(saved);
        // Awaited inside the save, so the card is still in its saving state
        // while the status catches up -- the automatic-lookup toggle never
        // renders live against a source that was just switched off.
        await refreshAvailability();
        toast.success(t('saved'));
        return saved;
      } finally {
        setSaving(false);
      }
    },
    [refreshAvailability, t],
  );

  const handleToggle = async (next: boolean) => {
    if (!settings || saving) return;
    const previous = settings;
    setSettings({ ...settings, enabled: next });
    try {
      await save({ enabled: next });
    } catch (error) {
      // Revert to the value THIS change replaced, so two changes in flight
      // cannot restore each other's.
      setSettings(previous);
      toast.error(getErrorMessage(error, t('saveFailed')));
    }
  };

  const handleSaveConfig = async (update: UpdatePayeeLookupSettings) => {
    try {
      await save(update);
      setShowConfig(false);
    } catch (error) {
      toast.error(getErrorMessage(error, t('saveFailed')));
    }
  };

  const handlePreferredSource = async (next: PayeeLookupPreferredSource) => {
    if (!settings || saving || settings.preferredSource === next) return;
    const previous = settings;
    setSettings({ ...settings, preferredSource: next });
    try {
      await save({ preferredSource: next });
    } catch (error) {
      setSettings(previous);
      toast.error(getErrorMessage(error, t('saveFailed')));
    }
  };

  const handleAiToggle = async (next: boolean) => {
    if (!settings || saving) return;
    const previous = settings;
    setSettings({ ...settings, aiEnabled: next });
    try {
      await save({ aiEnabled: next });
    } catch (error) {
      setSettings(previous);
      toast.error(getErrorMessage(error, t('saveFailed')));
    }
  };

  const handleAiProvider = async (configId: string | null) => {
    if (!settings || saving || settings.aiProviderConfigId === configId) return;
    const previous = settings;
    setSettings({ ...settings, aiProviderConfigId: configId });
    try {
      await save({ aiProviderConfigId: configId });
    } catch (error) {
      setSettings(previous);
      toast.error(getErrorMessage(error, t('saveFailed')));
    }
  };

  const handleRemoveKey = async () => {
    try {
      await save({ apiKey: '' });
    } catch (error) {
      toast.error(getErrorMessage(error, t('saveFailed')));
    }
  };

  if (loadFailed) {
    return (
      <Card padding="md" className={className}>
        <h2 className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
        </h2>
        <p className="text-sm text-red-600 dark:text-red-400">{t('loadFailed')}</p>
      </Card>
    );
  }

  if (!settings) return null;

  const operatorManaged = settings.mode === 'operator';

  return (
    <>
      <Card padding="md" className={className}>
        <h2 className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
        </h2>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          {t('subtitle')}
        </p>

        {/* One list, and each source carries its own configuration: the
            Google Places key and switch, the AI provider picker. Splitting the
            two into "settings" above and "order" below asked the reader to
            hold one feature in two places and made the order look like a
            footnote to the key rather than the thing being configured. */}
        <LookupSourceOrder
          settings={settings}
          disabled={disabled || saving}
          // Ordering means nothing until both sources can answer, but the rows
          // are still where Places is set up -- so they render either way and
          // only the moving is withheld.
          reorderable={aiConfigured && settings.configured}
          // With no AI provider there is nothing to switch on or to order, so
          // the row is not drawn at all rather than drawn inert.
          hidden={aiConfigured ? [] : ['ai']}
          onReorder={handlePreferredSource}
          // The switches sit beside the name they apply to: a source's on/off
          // state is what the row IS, not one of the settings under it.
          rowAside={{
            'google-places': (
              <ToggleSwitch
                checked={settings.enabled}
                onChange={handleToggle}
                disabled={disabled || saving}
                label={t('googlePlaces.toggleLabel')}
              />
            ),
            ai: (
              // Symmetric with Google Places: off means this source is not
              // reached at all, so the user can stop paying for it without
              // deleting a provider the assistant still uses.
              <ToggleSwitch
                checked={settings.aiEnabled}
                onChange={handleAiToggle}
                disabled={disabled || saving}
                label={t('order.aiToggleLabel')}
              />
            ),
          }}
          rowControls={{
            'google-places': (
              <div className="mt-3 space-y-3">
                {/* A line here only where it says something the row does not.
                    An operator's key is a fact about the deployment, and no
                    key yet is a call to action; a key that is set up needs no
                    sentence -- the buttons and the usage count below already
                    say so. */}
                {(operatorManaged || !settings.configured) && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {operatorManaged
                      ? t('googlePlaces.operatorManaged')
                      : t('googlePlaces.notConfigured')}
                  </p>
                )}

                {/* A key that cannot be decrypted is not the same as no key:
                    say so, because the repair is to enter it again rather than
                    for the first time. */}
                {!settings.apiKeyReadable && (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    {t('googlePlaces.keyUnreadable')}
                  </p>
                )}

                {!operatorManaged && !settings.encryptionAvailable && (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    {t('googlePlaces.encryptionUnavailable')}
                  </p>
                )}

                {settings.configured && settings.enabled && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {settings.capEnabled
                      ? t('googlePlaces.usage', {
                          used: settings.usedThisMonth,
                          cap: settings.monthlyCap,
                        })
                      : t('googlePlaces.usageNoCap', {
                          used: settings.usedThisMonth,
                        })}
                  </p>
                )}

                {!operatorManaged && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowConfig(true)}
                      disabled={disabled || !settings.encryptionAvailable}
                    >
                      {settings.configured
                        ? t('googlePlaces.edit')
                        : t('googlePlaces.configure')}
                    </Button>
                    {settings.configured && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleRemoveKey}
                        disabled={disabled || saving}
                      >
                        {t('googlePlaces.removeKey')}
                      </Button>
                    )}
                    {/* Only before there is a key: getting one is a Google
                        Cloud errand with a step that is easy to get wrong
                        (restrict by IP, not by HTTP referrer -- this is a
                        server-side call). Once it works the link is clutter. */}
                    {!settings.configured && (
                      <a
                        href={GOOGLE_PLACES_SETUP_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {t('googlePlaces.setupInstructions')}
                      </a>
                    )}
                  </div>
                )}
              </div>
            ),
            // Which model answers, offered only where there is a choice to
            // make: with one provider the select would carry a single option,
            // and with none it would name nothing. Nothing else is left under
            // this row, so with one provider it renders no block at all.
            ai:
              aiProviders.length > 1 ? (
                <div className="mt-3">
                  <Select
                    label={t('order.aiProviderLabel')}
                    value={settings.aiProviderConfigId ?? ''}
                    disabled={disabled || saving || !settings.aiEnabled}
                    onChange={(e) => handleAiProvider(e.target.value || null)}
                    options={[
                      { value: '', label: t('order.aiProviderAny') },
                      ...aiProviders.map((provider) => ({
                        value: provider.id,
                        label: providerLabel(provider),
                      })),
                    ]}
                  />
                </div>
              ) : null,
          }}
        />

        {/* An automatic lookup with every source switched off would do
            nothing, so the toggle shows off and disabled rather than claiming
            a behaviour that cannot happen. The status is re-read after every
            save above, so this is the server's own answer and not a stale one
            -- and `undefined` while it is unsettled or after it failed, because
            the copy under `false` tells the reader to switch on a source, which
            is the wrong instruction when the sources are on and it was the
            status read that did not land. */}
        <PayeeContactLookupToggle
          disabled={disabled}
          lookupAvailable={
            availabilityResolved && !availabilityFailed
              ? lookupAvailable
              : undefined
          }
        />
      </Card>

      {showConfig && (
        <GooglePlacesConfigModal
          isOpen={showConfig}
          settings={settings}
          onClose={() => setShowConfig(false)}
          onSave={handleSaveConfig}
          onTest={payeeLookupApi.testKey}
        />
      )}
    </>
  );
}
