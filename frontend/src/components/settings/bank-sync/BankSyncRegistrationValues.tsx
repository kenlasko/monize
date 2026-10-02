'use client';

import { useTranslations } from 'next-intl';
import {
  BANK_SYNC_PRIVACY_TEMPLATE_URL,
  BANK_SYNC_TERMS_TEMPLATE_URL,
  ENABLE_BANKING_FORM_LABELS,
  ENABLE_BANKING_REGISTRATION,
} from '@/lib/bank-sync-links';
import { useAuthStore } from '@/store/authStore';
import { BankSyncCopyButton } from './BankSyncCopyButton';

interface RegistrationRow {
  label: string;
  /** Null when the value is not known; the row then shows a placeholder. */
  value: string | null;
  /** A radio choice in the form is selected, not pasted. */
  copyable: boolean;
}

interface BankSyncRegistrationValuesProps {
  /** The redirect URL the card shows, so the two cannot disagree. */
  redirectUrl: string;
}

/**
 * The values to enter in the Enable Banking "Add a new application" form, in
 * the form's own order and under its own (English) labels, each with a button
 * that copies it. The rows are not interactive; only the buttons are.
 */
export function BankSyncRegistrationValues({
  redirectUrl,
}: BankSyncRegistrationValuesProps) {
  const t = useTranslations('settings.bankSync.credentials.help');
  const email = useAuthStore((s) => s.user?.email)?.trim() || null;

  const rows: RegistrationRow[] = [
    {
      label: ENABLE_BANKING_FORM_LABELS.environment,
      value: ENABLE_BANKING_REGISTRATION.environment,
      copyable: false,
    },
    {
      label: ENABLE_BANKING_FORM_LABELS.keyOption,
      value: ENABLE_BANKING_REGISTRATION.keyOption,
      copyable: false,
    },
    {
      label: ENABLE_BANKING_FORM_LABELS.applicationName,
      value: ENABLE_BANKING_REGISTRATION.applicationName,
      copyable: true,
    },
    {
      label: ENABLE_BANKING_FORM_LABELS.redirectUrls,
      value: redirectUrl,
      copyable: true,
    },
    {
      label: ENABLE_BANKING_FORM_LABELS.description,
      value: ENABLE_BANKING_REGISTRATION.description,
      copyable: true,
    },
    { label: ENABLE_BANKING_FORM_LABELS.email, value: email, copyable: true },
    {
      label: ENABLE_BANKING_FORM_LABELS.privacyUrl,
      value: BANK_SYNC_PRIVACY_TEMPLATE_URL,
      copyable: true,
    },
    {
      label: ENABLE_BANKING_FORM_LABELS.termsUrl,
      value: BANK_SYNC_TERMS_TEMPLATE_URL,
      copyable: true,
    },
  ];

  return (
    <div className="mt-2">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('registrationValuesTitle')}
      </h4>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        {t('registrationValuesNote')}
      </p>
      <dl className="mt-2 divide-y divide-gray-200 rounded-md border border-gray-200 text-sm dark:divide-gray-700 dark:border-gray-700">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:gap-4"
          >
            <dt className="text-gray-500 dark:text-gray-400 sm:w-56 sm:shrink-0">
              {row.label}
            </dt>
            <dd className="flex min-w-0 flex-1 items-start justify-between gap-2">
              {row.value === null ? (
                <span className="italic text-gray-500 dark:text-gray-400">
                  {t('emailPlaceholder')}
                </span>
              ) : (
                <span className="min-w-0 break-all font-mono text-xs text-gray-900 dark:text-gray-100">
                  {row.value}
                </span>
              )}
              {row.copyable && row.value !== null && (
                <BankSyncCopyButton
                  value={row.value}
                  field={row.label}
                  size="sm"
                  className="shrink-0 px-2 py-1 text-xs"
                />
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        {t('registrationTemplatesNote')}
      </p>
    </div>
  );
}
