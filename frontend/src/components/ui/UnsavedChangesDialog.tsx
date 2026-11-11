'use client';

import { useTranslations } from 'next-intl';
import { ExclamationCircleIcon } from '@heroicons/react/24/outline';
import { Button } from './Button';
import { Modal } from './Modal';

interface UnsavedChangesDialogProps {
  isOpen: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  /** When set, Save is disabled and this says why; Discard and Cancel still work. */
  saveDisabledReason?: string;
}

export function UnsavedChangesDialog({
  isOpen,
  onSave,
  onDiscard,
  onCancel,
  saveDisabledReason,
}: UnsavedChangesDialogProps) {
  const t = useTranslations('common');
  return (
    <Modal isOpen={isOpen} onClose={onCancel} maxWidth="md" className="p-6">
      <div className="flex items-start">
        <div className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900">
          <ExclamationCircleIcon className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="ml-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {t('unsavedChanges.title')}
          </h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t('unsavedChanges.message')}
          </p>
          {saveDisabledReason && (
            <p
              data-testid="unsaved-changes-save-blocked"
              className="mt-2 text-sm text-amber-700 dark:text-amber-400"
            >
              {saveDisabledReason}
            </p>
          )}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button variant="outline" onClick={onDiscard}>
          {t('unsavedChanges.discard')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button variant="primary" onClick={onSave} disabled={!!saveDisabledReason}>
          {t('save')}
        </Button>
      </div>
    </Modal>
  );
}
