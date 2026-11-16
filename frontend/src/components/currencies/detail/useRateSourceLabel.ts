'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { rateSourceLabelKey } from '@/lib/currency-detail';

/**
 * The reader's name for a rate's source slug. A slug this client has no label
 * for still shows, as the server's own token, rather than as "Unknown".
 */
export function useRateSourceLabel(): (source: string | null) => string {
  const t = useTranslations('currencyDetail');
  return useCallback(
    (source: string | null) => {
      const key = rateSourceLabelKey(source);
      if (key === 'unknown' && source) return source;
      return t(`sources.${key}`);
    },
    [t],
  );
}
