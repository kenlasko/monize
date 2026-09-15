'use client';

import { useTranslations } from 'next-intl';
import { CloudArrowUpIcon, EnvelopeIcon } from '@heroicons/react/24/outline';
import { cn } from '@/lib/utils';
import type {
  BackupOffsiteDestination,
  BackupOffsiteUploadStatus,
  StoredBackup,
} from '@/lib/backupApi';

/**
 * The colour each status wears as an icon tint, grouped exactly as the ledger
 * badge was: a verified copy is success, a copy that does not exist is danger,
 * a copy this server deliberately did not make is a warning, and an in-flight
 * one is neutral. Collapsing the warning group into the danger one is how a
 * refused plaintext upload comes to read like a transient outage.
 */
const STATUS_COLOR: Record<BackupOffsiteUploadStatus, string> = {
  uploaded: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  conflict: 'text-red-600 dark:text-red-400',
  'skipped-unencrypted': 'text-amber-600 dark:text-amber-400',
  'skipped-too-large': 'text-amber-600 dark:text-amber-400',
  pending: 'text-gray-400 dark:text-gray-500',
  uploading: 'text-gray-400 dark:text-gray-500',
};

const STATUS_LABEL_KEYS: Record<BackupOffsiteUploadStatus, string> = {
  pending: 'statusPending',
  uploading: 'statusUploading',
  uploaded: 'statusUploaded',
  failed: 'statusFailed',
  conflict: 'statusConflict',
  'skipped-unencrypted': 'statusSkippedUnencrypted',
  'skipped-too-large': 'statusSkippedTooLarge',
};

const DESTINATION_LABEL_KEYS: Record<BackupOffsiteDestination, string> = {
  s3: 'destinationS3',
  email: 'destinationEmail',
};

const DESTINATION_ICON: Record<
  BackupOffsiteDestination,
  typeof CloudArrowUpIcon
> = {
  s3: CloudArrowUpIcon,
  email: EnvelopeIcon,
};

/** The destinations, in the order their icons are drawn. */
const DESTINATIONS: readonly BackupOffsiteDestination[] = ['s3', 'email'];

interface OffsiteStatusIconsProps {
  /** The artifact's per-destination off-site status, or `undefined` when it has
   *  no off-site rows at all -- in which case nothing is drawn. */
  offsite: StoredBackup['offsite'];
  className?: string;
}

/**
 * One small icon per off-site destination that has a status for this artifact.
 *
 * A destination with no status here is a destination that did not try to copy
 * this artifact, so it draws no icon rather than a neutral one -- absence of an
 * icon and an in-flight icon are different facts. An unrecognised status (a
 * newer server naming a state this build does not know) draws in the neutral
 * tint and names itself, never guessed as a success or a failure.
 */
export function OffsiteStatusIcons({
  offsite,
  className,
}: OffsiteStatusIconsProps) {
  const t = useTranslations(
    'settings.backupRestore.storedBackups.offsite.rowStatus',
  );

  if (!offsite) return null;
  const entries = DESTINATIONS.flatMap((destination) => {
    const status = offsite[destination];
    return status ? [{ destination, status }] : [];
  });
  if (entries.length === 0) return null;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {entries.map(({ destination, status }) => {
        const Icon = DESTINATION_ICON[destination];
        const statusLabelKey = STATUS_LABEL_KEYS[status];
        const title = t('iconTitle', {
          destination: t(DESTINATION_LABEL_KEYS[destination]),
          status: statusLabelKey ? t(statusLabelKey) : status,
        });
        return (
          <span
            key={destination}
            role="img"
            aria-label={title}
            title={title}
            className={cn(
              'inline-flex',
              STATUS_COLOR[status] ?? 'text-gray-400 dark:text-gray-500',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        );
      })}
    </span>
  );
}
