'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { RecordInUseEntry } from '@/lib/errors';

interface RecordInUseNoticeProps {
  /** `getRecordInUseEntries(error)` of a refused delete. */
  entries: RecordInUseEntry[];
  /** Where the user can see the items of one kind; no link when it returns undefined. */
  hrefFor: (entry: RecordInUseEntry) => string | undefined;
}

/** The list of what still uses a record, each kind linked to where its items are. */
export function RecordInUseNotice({ entries, hrefFor }: RecordInUseNoticeProps) {
  const t = useTranslations('common.recordInUse');
  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300">{t('intro')}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {entries.map((entry) => {
          const href = hrefFor(entry);
          const label = t(`kinds.${entry.kind}`, { count: entry.count });
          return (
            <li key={entry.kind}>
              {href ? (
                <Link href={href} className="text-blue-600 hover:underline dark:text-blue-400">
                  {label}
                </Link>
              ) : (
                label
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
