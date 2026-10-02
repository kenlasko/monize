'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import '@/lib/zodConfig';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import { isUuid } from '@/lib/uuid';
import type { SaveBankSyncCredentials } from '@/types/bank-sync';
import { EnableBankingControlPanelLink } from './EnableBankingControlPanelLink';

const APPLICATION_ID_MAX = 200;
const PRIVATE_KEY_MAX = 20000;
/** A PEM private key is about 2 KB; anything past this is not the key file. */
const KEY_FILE_MAX_BYTES = 16 * 1024;
const KEY_FILE_ACCEPT = '.pem,.key,application/x-pem-file,text/plain';

type Translate = (key: string) => string;

/**
 * Built from `t` so the messages are localized, and from `keyStored` because
 * what the key field owes depends on it: with no key stored it is required,
 * with one stored an empty field means "keep it".
 *
 * The format check is a sanity check on what was pasted (a PEM block naming a
 * private key), not a parse. The server parses it as an RSA key and answers 400
 * with its own reason when it is not one.
 */
function buildSchema(t: Translate, keyStored: boolean) {
  return z.object({
    applicationId: z
      .string()
      .trim()
      .min(1, t('applicationIdRequired'))
      .max(APPLICATION_ID_MAX, t('applicationIdTooLong')),
    privateKey: z
      .string()
      .max(PRIVATE_KEY_MAX, t('privateKeyTooLong'))
      .superRefine((value, ctx) => {
        const key = value.trim();
        if (key === '') {
          if (!keyStored) {
            ctx.addIssue({ code: 'custom', message: t('privateKeyRequired') });
          }
          return;
        }
        if (!key.includes('-----BEGIN') || !key.includes('PRIVATE KEY-----')) {
          ctx.addIssue({ code: 'custom', message: t('privateKeyInvalid') });
        }
      }),
  });
}

type FormData = z.infer<ReturnType<typeof buildSchema>>;

interface BankSyncCredentialsModalProps {
  isOpen: boolean;
  /** The application ID stored now, or null when nothing is stored. */
  applicationId: string | null;
  /** A key is stored. The key itself is never sent to the browser. */
  privateKeySet: boolean;
  onClose: () => void;
  onSave: (data: SaveBankSyncCredentials) => Promise<void>;
}

/**
 * The application ID and private key of the user's Enable Banking application.
 *
 * The key field is never prefilled: the server does not send it, and a stored
 * key is signalled by the placeholder. An untouched field means "keep the
 * stored key", so it is left out of the request rather than sent empty -- the
 * user cannot see the key to retype it, and an empty value could read as a
 * request to clear it.
 */
export function BankSyncCredentialsModal({
  isOpen,
  applicationId,
  privateKeySet,
  onClose,
  onSave,
}: BankSyncCredentialsModalProps) {
  const t = useTranslations('settings.bankSync.credentialsModal');
  // modalSource lives beside the card's help copy, under `credentials`.
  const tCredentials = useTranslations('settings.bankSync.credentials');

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(buildSchema(t, privateKeySet)),
    defaultValues: { applicationId: applicationId ?? '', privateKey: '' },
  });

  const keyFileInputRef = useRef<HTMLInputElement>(null);
  // Set by the file loader, not by the schema: it describes the file, not the
  // field's content, so it clears on the next file rather than on validation.
  const [keyFileError, setKeyFileError] = useState<string | null>(null);

  /**
   * Fills the key field from the file the user picked. The content is never
   * logged. The input is reset afterwards so choosing the same file again
   * fires another change event.
   */
  const handleKeyFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (file.size > KEY_FILE_MAX_BYTES) {
      setKeyFileError(t('keyFileTooLarge'));
      return;
    }

    let content: string;
    try {
      content = await file.text();
    } catch {
      setKeyFileError(t('keyFileReadFailed'));
      return;
    }

    setKeyFileError(null);
    setValue('privateKey', content, { shouldDirty: true, shouldValidate: true });

    // A convenience only: Enable Banking names the downloaded key file
    // <application-id>.pem (confirmed against the control panel), so an empty
    // ID field is filled from the file name. The user can edit it, and an ID
    // they already typed is never overwritten.
    const idFromName = file.name.replace(/\.[^.]*$/, '');
    if (getValues('applicationId').trim() === '' && isUuid(idFromName)) {
      setValue('applicationId', idFromName, { shouldDirty: true, shouldValidate: true });
    }
  };

  const submit = handleSubmit(async (data) => {
    const update: SaveBankSyncCredentials = { applicationId: data.applicationId };
    const key = data.privateKey.trim();
    if (key !== '') update.privateKey = key;
    await onSave(update);
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      description={t('subtitle')}
      padding="md"
      maxWidth="lg"
      pushHistory
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        {tCredentials.rich('modalSource', {
          link: (chunks) => (
            <EnableBankingControlPanelLink>{chunks}</EnableBankingControlPanelLink>
          ),
        })}
      </p>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input
          label={t('applicationIdLabel')}
          id="bank-sync-application-id"
          autoComplete="off"
          spellCheck={false}
          {...register('applicationId')}
          error={errors.applicationId?.message}
          placeholder={t('applicationIdPlaceholder')}
        />

        <div>
          <label
            htmlFor="bank-sync-private-key"
            className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('privateKeyLabel')}
          </label>
          <textarea
            id="bank-sync-private-key"
            rows={6}
            // Not a credential of this site: a password manager must not fill
            // the account password into the provider's key.
            autoComplete="off"
            spellCheck={false}
            className={cn(
              inputBaseClasses,
              'border px-3 py-2 font-mono text-xs',
              errors.privateKey && inputErrorClasses,
            )}
            placeholder={
              privateKeySet
                ? t('privateKeyStoredPlaceholder')
                : t('privateKeyPlaceholder')
            }
            {...register('privateKey')}
          />
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => keyFileInputRef.current?.click()}
            >
              {t('loadKeyFile')}
            </Button>
            <input
              ref={keyFileInputRef}
              type="file"
              accept={KEY_FILE_ACCEPT}
              className="hidden"
              aria-label={t('loadKeyFile')}
              onChange={handleKeyFile}
            />
          </div>
          {keyFileError || errors.privateKey?.message ? (
            <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
              {keyFileError ?? errors.privateKey?.message}
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('privateKeyHelp')}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
