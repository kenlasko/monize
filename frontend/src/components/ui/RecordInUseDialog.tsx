'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { RecordInUseNotice } from '@/components/ui/RecordInUseNotice';
import type { RecordInUseEntry } from '@/lib/errors';

interface RecordInUseDialogProps {
  /** The record whose delete was refused; null closes the dialog. */
  inUse: { name: string; entries: RecordInUseEntry[] } | null;
  hrefFor: (entry: RecordInUseEntry) => string | undefined;
  onClose: () => void;
}

/** "Cannot delete X" with what still uses it, for a delete refused with RECORD_IN_USE. */
export function RecordInUseDialog({ inUse, hrefFor, onClose }: RecordInUseDialogProps) {
  const t = useTranslations('common.recordInUse');
  return (
    <Modal
      isOpen={inUse !== null}
      onClose={onClose}
      maxWidth="md"
      padding="md"
      title={t('title', { name: inUse?.name ?? '' })}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      }
    >
      {inUse && <RecordInUseNotice entries={inUse.entries} hrefFor={hrefFor} />}
    </Modal>
  );
}
