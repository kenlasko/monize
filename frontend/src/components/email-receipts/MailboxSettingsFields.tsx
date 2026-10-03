'use client';

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { EMAIL_RECEIPT_AI_MODES, type EmailReceiptAiMode } from '@/types/email-receipts';

/** The four settings every mailbox has, whichever way it logs in. */
export interface MailboxSettingsValues {
  folder: string;
  enabled: boolean;
  aiMode: EmailReceiptAiMode;
  autoApply: boolean;
}

interface MailboxSettingsFieldsProps {
  /** Distinguishes the ids when two instances are on one page. */
  idPrefix: string;
  values: MailboxSettingsValues;
  onChange: (next: MailboxSettingsValues) => void;
  disabled?: boolean;
}

/**
 * Folder, polling switch, AI mode and auto-apply. Shared by the password form
 * (saved with the whole configuration) and the OAuth panel (saved through
 * `PATCH /settings`), so the two cannot word the auto-apply gate differently:
 * it is the one switch that lets a proposal reach the ledger unasked.
 */
export function MailboxSettingsFields({ idPrefix, values, onChange, disabled }: MailboxSettingsFieldsProps) {
  const t = useTranslations('emailReceipts.mailbox.settings');

  const aiModeOptions = EMAIL_RECEIPT_AI_MODES.map((mode) => ({ value: mode, label: t(`aiModes.${mode}`) }));

  return (
    <div className="space-y-4">
      <div>
        <Input
          id={`${idPrefix}-folder`}
          label={t('folderLabel')}
          value={values.folder}
          maxLength={255}
          disabled={disabled}
          placeholder="INBOX"
          onChange={(e) => onChange({ ...values, folder: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('folderHelp')}</p>
      </div>

      <div className="flex items-center gap-3">
        <ToggleSwitch
          checked={values.enabled}
          disabled={disabled}
          label={t('enabledLabel')}
          onChange={(enabled) => onChange({ ...values, enabled })}
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">{t('enabledLabel')}</span>
        <InfoTooltip text={t('enabledHelp')} placement="top" usePortal />
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <label htmlFor={`${idPrefix}-ai-mode`} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('aiModeLabel')}
          </label>
          <InfoTooltip text={t('aiModeHelp')} placement="top" usePortal />
        </div>
        <Select
          id={`${idPrefix}-ai-mode`}
          value={values.aiMode}
          options={aiModeOptions}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, aiMode: e.target.value as EmailReceiptAiMode })}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t(`aiModeDescriptions.${values.aiMode}`)}</p>
      </div>

      <div className="flex items-center gap-3">
        <ToggleSwitch
          checked={values.autoApply}
          disabled={disabled}
          label={t('autoApplyLabel')}
          onChange={(autoApply) => onChange({ ...values, autoApply })}
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">{t('autoApplyLabel')}</span>
        <InfoTooltip text={t('autoApplyHelp')} placement="top" usePortal />
      </div>
    </div>
  );
}
