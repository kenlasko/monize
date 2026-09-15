'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import {
  SEGMENTED_GROUP_CLASS,
  segmentClass,
} from '@/components/ui/segmented-control';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useDemoMode } from '@/hooks/useDemoMode';
import {
  backupApi,
  BackupOffsiteS3Mode,
  BackupOffsiteSettingsView,
  UpdateBackupOffsiteSettingsData,
} from '@/lib/backupApi';
import { getErrorMessage } from '@/lib/errors';

/** The three modes, in the order the control offers them. */
const S3_MODES: readonly BackupOffsiteS3Mode[] = ['off', 'deployment', 'own'];

const MODE_LABEL_KEYS: Record<BackupOffsiteS3Mode, string> = {
  off: 's3.modeOff',
  deployment: 's3.modeDeployment',
  own: 's3.modeOwn',
};

/** A text field's stored counterpart: a blank box and an unset column agree. */
function storedText(value: string | null): string {
  return value ?? '';
}

/**
 * The user's own off-machine destinations, folded under the Automatic Backups
 * sub-section rather than shown as a section of its own.
 *
 * Not admin-only, and that is the point: the schedule and the folder are an
 * operator's decision about the server's disk, but a destination is this user's
 * decision about their own data leaving the machine -- their bucket, their
 * credentials, their address. The backend controller draws the same line.
 *
 * **A stored credential is never rendered back.** The server reports only
 * whether each one is set, so both boxes are empty on every load and carry a
 * placeholder saying one is stored. A blank box therefore means "leave it
 * alone", never "forget it"; forgetting is its own confirmed action, because a
 * save that wiped a working destination as a side effect of an unrelated edit
 * would be discovered only when a backup failed to leave the machine.
 *
 * **The save sends what moved.** Every field is compared against the row the
 * server last returned, so a resend of the whole form cannot re-write a column
 * the user never touched, and a credential is sent only when the user actually
 * typed one.
 */
export function OffsiteDestinationsForm() {
  const t = useTranslations('settings.backupRestore.storedBackups.offsite');
  const isDemoMode = useDemoMode();

  const [view, setView] = useState<BackupOffsiteSettingsView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // A failed read is not "no destinations configured": rendering it as an empty
  // form would invite the reader to re-enter a bucket they already have.
  const [loadError, setLoadError] = useState<string | null>(null);

  const [s3Mode, setS3Mode] = useState<BackupOffsiteS3Mode>('off');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [prefix, setPrefix] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailTo, setEmailTo] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  // The server refuses a destination it could not use and names what to change;
  // that message belongs beside the form, not in a toast that is gone in five
  // seconds while the fields it describes are still on screen.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  /**
   * Adopt a row the server returned as the form's new baseline.
   *
   * The credential boxes are emptied rather than filled: what came back says
   * only that a secret is stored, and leaving what the user typed in the box
   * would make the next save resend it.
   */
  const applyView = useCallback((next: BackupOffsiteSettingsView) => {
    setView(next);
    setS3Mode(next.s3Mode);
    setBucket(storedText(next.s3Bucket));
    setRegion(storedText(next.s3Region));
    setPrefix(storedText(next.s3Prefix));
    setEndpoint(storedText(next.s3Endpoint));
    setForcePathStyle(next.s3ForcePathStyle);
    setAccessKeyId('');
    setSecretAccessKey('');
    setEmailEnabled(next.emailEnabled);
    setEmailTo(storedText(next.emailTo));
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      applyView(await backupApi.getOffsiteSettings());
    } catch (error) {
      setView(null);
      setLoadError(getErrorMessage(error, t('loadFailed')));
    } finally {
      setIsLoading(false);
    }
  }, [applyView, t]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The fields whose value differs from the row on the server.
   *
   * A form resends every field it holds, so presence is not change: comparing
   * against the loaded row is what keeps an unrelated save from re-writing a
   * column, and what keeps an untouched credential box out of the payload
   * entirely (a blank string would read as a field the user cleared).
   */
  const buildChanges = (): UpdateBackupOffsiteSettingsData => {
    if (!view) return {};
    const changes: UpdateBackupOffsiteSettingsData = {};
    if (s3Mode !== view.s3Mode) changes.s3Mode = s3Mode;
    if (bucket.trim() !== storedText(view.s3Bucket)) {
      changes.s3Bucket = bucket.trim() || null;
    }
    if (region.trim() !== storedText(view.s3Region)) {
      changes.s3Region = region.trim() || null;
    }
    if (prefix.trim() !== storedText(view.s3Prefix)) {
      changes.s3Prefix = prefix.trim() || null;
    }
    if (endpoint.trim() !== storedText(view.s3Endpoint)) {
      changes.s3Endpoint = endpoint.trim() || null;
    }
    if (forcePathStyle !== view.s3ForcePathStyle) {
      changes.s3ForcePathStyle = forcePathStyle;
    }
    if (accessKeyId) changes.s3AccessKeyId = accessKeyId;
    if (secretAccessKey) changes.s3SecretAccessKey = secretAccessKey;
    if (emailEnabled !== view.emailEnabled) changes.emailEnabled = emailEnabled;
    if (emailTo.trim() !== storedText(view.emailTo)) {
      changes.emailTo = emailTo.trim() || null;
    }
    return changes;
  };

  const changes = buildChanges();
  const isDirty = Object.keys(changes).length > 0;

  const patch = async (
    data: UpdateBackupOffsiteSettingsData,
    successMessage: string,
    failureMessage: string,
  ) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      applyView(await backupApi.updateOffsiteSettings(data));
      toast.success(successMessage);
    } catch (error) {
      setSaveError(getErrorMessage(error, failureMessage));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = () => patch(changes, t('saved'), t('saveFailed'));

  const handleClearCredentials = async () => {
    setConfirmClear(false);
    await patch(
      { clearS3Credentials: true },
      t('s3.credentialsCleared'),
      t('s3.clearFailed'),
    );
  };

  const hasStoredCredentials =
    view !== null && (view.s3AccessKeyIdSet || view.s3SecretAccessKeySet);

  return (
    <div className="mt-3">
      {isLoading && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loading')}
        </p>
      )}

      {!isLoading && loadError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
          <Button variant="outline" size="sm" onClick={load}>
            {t('retryButton')}
          </Button>
        </div>
      )}

      {!isLoading && view && (
        <>
          {/* A server with no key cannot store a credential at all, and the
              refusal would otherwise arrive only after the user had typed one
              in. The other two destinations still work, so this says which. */}
          {!view.encryptionConfigured && (
            <p
              role="status"
              className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
            >
              {t('encryptionUnavailable')}
            </p>
          )}

          {isDemoMode && (
            <p
              role="note"
              className="mt-4 text-sm text-amber-700 dark:text-amber-300"
            >
              {t('demoNote')}
            </p>
          )}

          <div className="mt-4">
            <h5 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('s3.heading')}
            </h5>
            <p
              id="offsite-s3-mode-label"
              className="mt-1 mb-2 text-sm text-gray-600 dark:text-gray-400"
            >
              {t('s3.modeLabel')}
            </p>
            <div
              role="group"
              aria-labelledby="offsite-s3-mode-label"
              className={SEGMENTED_GROUP_CLASS}
            >
              {S3_MODES.map((mode) => {
                // The deployment's bucket is offered as a disabled option
                // rather than withheld: a control that vanishes says nothing
                // about why, and the hint below names what an administrator
                // would have to do.
                const unavailable =
                  mode === 'deployment' && !view.deploymentS3Available;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={s3Mode === mode}
                    disabled={unavailable || isDemoMode}
                    onClick={() => setS3Mode(mode)}
                    className={`${segmentClass(s3Mode === mode)} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {t(MODE_LABEL_KEYS[mode])}
                  </button>
                );
              })}
            </div>
            {!view.deploymentS3Available && (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                {t('s3.deploymentUnavailable')}
              </p>
            )}

            {s3Mode === 'own' && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    id="offsite-s3-bucket"
                    label={t('s3.bucketLabel')}
                    value={bucket}
                    disabled={isDemoMode}
                    onChange={(e) => setBucket(e.target.value)}
                  />
                  <div>
                    <Input
                      id="offsite-s3-region"
                      label={t('s3.regionLabel')}
                      value={region}
                      disabled={isDemoMode}
                      onChange={(e) => setRegion(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('s3.regionHelp')}
                    </p>
                  </div>
                  <div>
                    <Input
                      id="offsite-s3-prefix"
                      label={t('s3.prefixLabel')}
                      value={prefix}
                      disabled={isDemoMode}
                      onChange={(e) => setPrefix(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('s3.prefixHelp')}
                    </p>
                  </div>
                  <div>
                    <Input
                      id="offsite-s3-endpoint"
                      label={t('s3.endpointLabel')}
                      value={endpoint}
                      disabled={isDemoMode}
                      onChange={(e) => setEndpoint(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('s3.endpointHelp')}
                    </p>
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={forcePathStyle}
                      disabled={isDemoMode}
                      onChange={(e) => setForcePathStyle(e.target.checked)}
                      className="rounded border-gray-300 dark:border-gray-600"
                    />
                    {t('s3.forcePathStyleLabel')}
                  </label>
                  <p className="mt-1 ml-6 text-xs text-gray-500 dark:text-gray-400">
                    {t('s3.forcePathStyleHelp')}
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    id="offsite-s3-access-key-id"
                    label={t('s3.accessKeyIdLabel')}
                    type="password"
                    // Not a credential of this site: an autofilled site password
                    // here would be stored as somebody's S3 key and every copy
                    // would fail with a credential nobody chose.
                    autoComplete="off"
                    value={accessKeyId}
                    disabled={isDemoMode}
                    placeholder={
                      view.s3AccessKeyIdSet
                        ? t('s3.storedPlaceholder')
                        : undefined
                    }
                    onChange={(e) => setAccessKeyId(e.target.value)}
                  />
                  <Input
                    id="offsite-s3-secret-access-key"
                    label={t('s3.secretAccessKeyLabel')}
                    type="password"
                    autoComplete="off"
                    value={secretAccessKey}
                    disabled={isDemoMode}
                    placeholder={
                      view.s3SecretAccessKeySet
                        ? t('s3.storedPlaceholder')
                        : undefined
                    }
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                  />
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('s3.credentialsHelp')}
                </p>

                {hasStoredCredentials && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isSaving || isDemoMode}
                    onClick={() => setConfirmClear(true)}
                  >
                    {t('s3.clearCredentialsButton')}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="mt-6">
            <h5 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {t('email.heading')}
            </h5>
            <label className="flex items-center gap-3 cursor-pointer">
              <ToggleSwitch
                checked={emailEnabled}
                disabled={isDemoMode}
                onChange={setEmailEnabled}
                label={t('email.toggleLabel')}
              />
              <span className="text-sm text-gray-900 dark:text-gray-100">
                {t('email.toggleLabel')}
              </span>
            </label>
            <div className="mt-3 sm:max-w-sm">
              <Input
                id="offsite-email-to"
                label={t('email.addressLabel')}
                type="email"
                autoComplete="email"
                value={emailTo}
                disabled={isDemoMode}
                placeholder={t('email.addressPlaceholder')}
                onChange={(e) => setEmailTo(e.target.value)}
              />
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('email.sizeNote')}
            </p>
          </div>

          {saveError && (
            <p
              role="alert"
              className="mt-4 text-sm text-red-600 dark:text-red-400"
            >
              {saveError}
            </p>
          )}

          <div className="mt-4">
            <Button
              onClick={handleSave}
              disabled={isSaving || !isDirty || isDemoMode}
            >
              {isSaving ? t('savingButton') : t('saveButton')}
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        isOpen={confirmClear}
        title={t('s3.clearConfirmTitle')}
        message={t('s3.clearConfirmMessage')}
        confirmLabel={t('s3.clearCredentialsButton')}
        onConfirm={handleClearCredentials}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
