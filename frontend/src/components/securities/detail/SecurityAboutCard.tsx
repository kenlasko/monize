'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { useTranslations } from 'next-intl';
import { KeyValueList, type KeyValueRow } from '@/components/ui/KeyValueList';
import { externalUrlLabel, toSafeExternalUrl } from '@/lib/external-url';
import type { Security } from '@/types/investment';

interface SecurityAboutCardProps {
  security: Security;
}

/**
 * What the instrument is, in prose plus the classification fields.
 *
 * Website and IR website are real fields now (migration 120). Yahoo fills the
 * first one in for shares; nobody publishes an investor-relations address, so
 * that one is typed by hand. Either way an unset field drops its row rather than
 * showing a placeholder.
 */
export function SecurityAboutCard({ security }: SecurityAboutCardProps) {
  const t = useTranslations('securityDetail');

  const countries = security.countryWeightings
    ?.map((entry) => entry.name)
    .filter(Boolean)
    .join(', ');

  /**
   * An address as a link, or null so `KeyValueList` drops the row. The stored
   * value is always absolute http(s) -- the backend normalises it -- so this
   * does not have to guess a scheme, and it still checks: the row is data, and a
   * link built from an unchecked string is a link that can run something.
   */
  const link = (raw: string | null) => {
    const url = toSafeExternalUrl(raw);
    if (!url) return null;
    const label = externalUrlLabel(url);
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        {label}
      </a>
    );
  };

  const rows: KeyValueRow[] = [
    { key: 'sector', label: t('about.sector'), value: security.sector },
    { key: 'industry', label: t('about.industry'), value: security.industry },
    { key: 'country', label: t('about.country'), value: countries || null },
    { key: 'website', label: t('about.website'), value: link(security.website) },
    {
      key: 'irWebsite',
      label: t('about.irWebsite'),
      value: link(security.irWebsite),
    },
    {
      key: 'tags',
      label: t('about.tags'),
      value:
        security.tags && security.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {security.tags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium"
                style={{
                  backgroundColor: tag.color ? `${tag.color}20` : '#9ca3af20',
                  color: tag.color || '#6b7280',
                }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        ) : null,
    },
  ];

  return (
    <div className={`${CARD_CLASS} flex h-full flex-col p-4`}>
      <h3 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('about.title')}
      </h3>
      <p
        className={`text-sm ${
          security.description
            ? 'text-gray-700 dark:text-gray-300'
            : 'text-gray-500 dark:text-gray-400'
        }`}
      >
        {security.description || t('about.noDescription')}
      </p>
      <KeyValueList rows={rows} variant="pairs" className="mt-4" />
    </div>
  );
}
