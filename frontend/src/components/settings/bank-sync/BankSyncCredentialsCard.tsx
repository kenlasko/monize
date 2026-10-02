'use client';

import { useId, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { bankSyncApi } from '@/lib/bank-sync';
import {
  ENABLE_BANKING_API_TERMS_URL,
  ENABLE_BANKING_SITE_URL,
} from '@/lib/bank-sync-links';
import { getErrorMessage } from '@/lib/errors';
import type {
  BankSyncCredentialsTestResult,
  BankSyncStatus,
  SaveBankSyncCredentials,
} from '@/types/bank-sync';
import { BankSyncCopyButton } from './BankSyncCopyButton';
import { BankSyncCredentialsModal } from './BankSyncCredentialsModal';
import { BankSyncExternalLink } from './BankSyncExternalLink';
import { BankSyncRegistrationValues } from './BankSyncRegistrationValues';

const HELP_HEADING_CLASS =
  'mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100';
const HELP_BODY_CLASS = 'text-sm text-gray-600 dark:text-gray-400';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'done'; result: BankSyncCredentialsTestResult }
  | { kind: 'error'; message: string };

interface BankSyncCredentialsCardProps {
  status: BankSyncStatus;
  disabled?: boolean;
  /** The status after a write, so the page holds the server's answer. */
  onStatusChange: (status: BankSyncStatus) => void;
}

/**
 * The user's own Enable Banking application: its ID, whether a private key is
 * stored, and the redirect URL to register at the provider.
 *
 * The key is never shown, and a screen that cannot store one says so up front
 * rather than after the user has pasted it: without an encryption key on the
 * server, saving is disabled.
 *
 * The setup help is open while nothing is stored, because that is when the
 * reader needs it, and folds behind a toggle once credentials exist.
 */
export function BankSyncCredentialsCard({
  status,
  disabled = false,
  onStatusChange,
}: BankSyncCredentialsCardProps) {
  const t = useTranslations('settings.bankSync.credentials');
  const [showModal, setShowModal] = useState(false);
  const [showRemove, setShowRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();

  const credentials = status.credentials;
  const showHelp = !credentials || helpOpen;

  const handleSave = async (data: SaveBankSyncCredentials) => {
    try {
      const saved = await bankSyncApi.saveCredentials(data);
      onStatusChange(saved);
      setTest({ kind: 'idle' });
      setShowModal(false);
      toast.success(t('saved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('saveFailed')));
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await bankSyncApi.deleteCredentials();
      onStatusChange({ ...status, credentials: null });
      setTest({ kind: 'idle' });
      toast.success(t('removed'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('removeFailed')));
    } finally {
      setRemoving(false);
      setShowRemove(false);
    }
  };

  const handleTest = async () => {
    setTest({ kind: 'testing' });
    try {
      const result = await bankSyncApi.testCredentials();
      setTest({ kind: 'done', result });
    } catch (error) {
      setTest({ kind: 'error', message: getErrorMessage(error, t('testError')) });
    }
  };

  // A Production application accepts only an https redirect URL, so an http one
  // can serve a Sandbox application at most.
  const redirectIsHttp = /^http:\/\//i.test(status.redirectUrl);

  // The redirect URL is only known to be unregistered when the provider listed
  // some and ours is not among them. An empty list says nothing.
  const redirectMissing =
    test.kind === 'done' &&
    test.result.ok &&
    test.result.redirectUrls.length > 0 &&
    !test.result.redirectUrls.includes(status.redirectUrl);

  return (
    <>
      <Card padding="md" className="mb-6">
        <h2 className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
        </h2>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          {t('subtitle')}
        </p>

        {!status.encryptionAvailable && (
          <p
            role="alert"
            className="mb-4 text-sm text-amber-700 dark:text-amber-300"
          >
            {t('encryptionUnavailable')}
          </p>
        )}

        {credentials && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mb-3 -ml-3"
            onClick={() => setHelpOpen((open) => !open)}
            aria-expanded={helpOpen}
            // The panel is not in the document while folded, so the button
            // names it only while it exists.
            aria-controls={helpOpen ? helpId : undefined}
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={`mr-1 h-4 w-4 transition-transform motion-reduce:transition-none ${
                helpOpen ? 'rotate-180' : ''
              }`}
            />
            {helpOpen ? t('help.hide') : t('help.show')}
          </Button>
        )}

        {showHelp && (
          <div id={helpId} className="mb-4 space-y-4">
            <section>
              <h3 className={HELP_HEADING_CLASS}>{t('help.whatIsTitle')}</h3>
              <p className={HELP_BODY_CLASS}>{t('help.whatIsBody')}</p>
              <p className={`mt-2 ${HELP_BODY_CLASS}`}>
                {t.rich('help.dataFlow', {
                  terms: (chunks) => (
                    <BankSyncExternalLink href={ENABLE_BANKING_API_TERMS_URL}>
                      {chunks}
                    </BankSyncExternalLink>
                  ),
                })}
              </p>
              <p className={`mt-2 ${HELP_BODY_CLASS}`}>{t('help.whatIsFree')}</p>
            </section>

            <section>
              <h3 className={HELP_HEADING_CLASS}>{t('help.setupTitle')}</h3>
              <ol className={`list-decimal space-y-1 pl-5 ${HELP_BODY_CLASS}`}>
                <li>
                  {t.rich('help.step1', {
                    link: (chunks) => (
                      <BankSyncExternalLink href={ENABLE_BANKING_SITE_URL}>
                        {chunks}
                      </BankSyncExternalLink>
                    ),
                  })}
                </li>
                <li>{t('help.step2')}</li>
                <li>{t('help.step3')}</li>
                <li>
                  {t('help.step4')}
                  <BankSyncRegistrationValues redirectUrl={status.redirectUrl} />
                </li>
                <li>{t('help.step5')}</li>
                <li>{t('help.step6')}</li>
                <li>{t('help.step7')}</li>
              </ol>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t('help.sandboxNote')}
              </p>
            </section>

            <section>
              <h3 className={HELP_HEADING_CLASS}>{t('help.networkTitle')}</h3>
              <p className={HELP_BODY_CLASS}>{t('help.networkBody')}</p>
              <p className={`mt-2 ${HELP_BODY_CLASS}`}>
                {t('help.networkOutbound')}
              </p>
            </section>
          </div>
        )}

        <div className="mb-4">
          <div className="flex items-end gap-2">
            <Input
              label={t('redirectUrlLabel')}
              id="bank-sync-redirect-url"
              value={status.redirectUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <BankSyncCopyButton
              value={status.redirectUrl}
              field={t('redirectUrlLabel')}
              className="shrink-0"
            />
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('redirectUrlHelp')}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('redirectUrlNotPublic')}
          </p>
          {redirectIsHttp && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
              {t('redirectUrlHttpWarning')}
            </p>
          )}
        </div>

        {credentials ? (
          <div className="mb-4 text-sm text-gray-700 dark:text-gray-300">
            <p>
              <span className="font-medium">{t('applicationId')}</span>{' '}
              <span className="font-mono break-all">
                {credentials.applicationId}
              </span>
            </p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">
              {credentials.privateKeySet ? t('keyStored') : t('keyMissing')}
            </p>
          </div>
        ) : (
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            {t('notConfigured')}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={credentials ? 'outline' : 'primary'}
            size="sm"
            onClick={() => setShowModal(true)}
            disabled={disabled || !status.encryptionAvailable}
          >
            {credentials ? t('edit') : t('configure')}
          </Button>
          {credentials && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={disabled || test.kind === 'testing'}
              >
                {test.kind === 'testing' ? t('testing') : t('test')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowRemove(true)}
                disabled={disabled || removing}
              >
                {t('remove')}
              </Button>
            </>
          )}
        </div>

        <div aria-live="polite">
          {test.kind === 'error' && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {test.message}
            </p>
          )}
          {test.kind === 'done' && !test.result.ok && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {t('testFailed')}
            </p>
          )}
          {test.kind === 'done' && test.result.ok && !redirectMissing && (
            <p className="mt-3 text-sm text-green-600 dark:text-green-400">
              {test.result.applicationName
                ? t('testSuccess', { name: test.result.applicationName })
                : t('testSuccessNoName')}
            </p>
          )}
          {redirectMissing && (
            <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
              {t('testRedirectMissing')}
            </p>
          )}
        </div>
      </Card>

      {showModal && (
        <BankSyncCredentialsModal
          isOpen={showModal}
          applicationId={credentials?.applicationId ?? null}
          privateKeySet={credentials?.privateKeySet ?? false}
          onClose={() => setShowModal(false)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        isOpen={showRemove}
        title={t('removeConfirm.title')}
        message={t('removeConfirm.message')}
        confirmLabel={t('removeConfirm.confirm')}
        onConfirm={handleRemove}
        onCancel={() => setShowRemove(false)}
        pushHistory
      />
    </>
  );
}
