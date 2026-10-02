'use client';

import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button, type ButtonSize } from '@/components/ui/Button';

interface BankSyncCopyButtonProps {
  /** The exact text put on the clipboard. */
  value: string;
  /** What is being copied, named for the screen reader: "Copy {field}". */
  field: string;
  size?: ButtonSize;
  className?: string;
}

/**
 * Copies one value to the clipboard and says whether it worked. The visible
 * word is "Copy"; the accessible name carries the field, so a list of these
 * is not a list of identical buttons.
 */
export function BankSyncCopyButton({
  value,
  field,
  size,
  className,
}: BankSyncCopyButtonProps) {
  const t = useTranslations('settings.bankSync.credentials');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={handleCopy}
      aria-label={t('help.copyField', { field })}
      className={className}
    >
      {t('copy')}
    </Button>
  );
}
