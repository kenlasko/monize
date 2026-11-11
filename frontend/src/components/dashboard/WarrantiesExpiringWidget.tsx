'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { warrantiesApi } from '@/lib/warranties';
import type { Warranty } from '@/types/warranty';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { WarrantyStatusBadge } from '@/components/warranties/WarrantyStatusBadge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { WidgetHeading } from './widget-meta';
import { CARD_CLASS, HOVER_ROW_ON_CARD } from '@/components/ui/Card';

const MAX_ROWS = 5;

interface WarrantiesExpiringWidgetProps {
  isLoading: boolean;
}

/**
 * The warranties the server calls `expiring`, soonest first. Every figure on a
 * row (`status`, `daysLeft`, `expiresOn`) is the server's; nothing here
 * compares dates (WTY-002).
 */
export function WarrantiesExpiringWidget({ isLoading: parentLoading }: WarrantiesExpiringWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatDate } = useDateFormat();
  const [warranties, setWarranties] = useState<Warranty[] | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (parentLoading) return;
    let cancelled = false;

    const load = async () => {
      try {
        const result = await warrantiesApi.list({ status: 'expiring', limit: MAX_ROWS, sort: 'expiresOn' });
        if (cancelled) return;
        setWarranties(result.data.slice(0, MAX_ROWS));
        setHasError(false);
      } catch {
        if (cancelled) return;
        setHasError(true);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [parentLoading]);

  const heading = (
    <WidgetHeading id="warranties-expiring" href="/warranties" className="mb-4">
      {t('warrantiesExpiring.title')}
    </WidgetHeading>
  );
  const cardClass = `${CARD_CLASS} p-3 sm:p-6`;

  if (parentLoading || (warranties === null && !hasError)) {
    return (
      <div className={cardClass}>
        {heading}
        <div className="animate-pulse skeleton-shimmer space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className={cardClass}>
        {heading}
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('warrantiesExpiring.loadFailed')}
        </p>
      </div>
    );
  }

  if (!warranties || warranties.length === 0) {
    return (
      <div className={cardClass}>
        {heading}
        <p className="text-gray-500 dark:text-gray-400 text-sm">{t('warrantiesExpiring.empty')}</p>
      </div>
    );
  }

  return (
    <div className={cardClass}>
      {heading}
      <ul className="space-y-2 sm:space-y-3">
        {warranties.map((warranty) => (
          <li key={warranty.id}>
            <Link
              href={`/warranties/${warranty.id}`}
              className={`flex items-start justify-between gap-3 rounded-lg p-2 sm:p-3 ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {warranty.name}
                </span>
                {warranty.vendorName && (
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                    <PayeeLogo payee={warranty.payee} name={warranty.vendorName} size={20} />
                    <span className="truncate">{warranty.vendorName}</span>
                  </span>
                )}
              </span>
              <span className="flex flex-shrink-0 flex-col items-end gap-1 text-right">
                <WarrantyStatusBadge warranty={warranty} showDaysLeft />
                {warranty.expiresOn && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {formatDate(warranty.expiresOn)}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
