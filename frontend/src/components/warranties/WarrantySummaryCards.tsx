'use client';

import { useTranslations } from 'next-intl';
import { SummaryCardGrid, summaryGridClass, type SummaryCardItem } from '@/components/accounts/shared/SummaryCardGrid';
import { useWarrantyDaysLeftText } from '@/components/warranties/WarrantyStatusBadge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { withCurrencyCode } from '@/lib/format';
import type { Warranty } from '@/types/warranty';

/**
 * The detail page's top row: when the coverage ends and how long is left, when
 * and for how much the item was bought, and how many claims are still open.
 * Status and days left are the server's (WTY-002); the price is informational
 * and in its own currency (design decision 6). The record's other fields are
 * the Details card's.
 */
export function WarrantySummaryCards({ warranty }: { warranty: Warranty }) {
  const t = useTranslations('warranties');
  const { formatDate } = useDateFormat();
  const { formatCurrency, formatNumber, defaultCurrency } = useNumberFormat();
  const daysLeftText = useWarrantyDaysLeftText();

  const expires =
    warranty.isLifetime || warranty.expiresOn === null ? t('detail.card.lifetime') : formatDate(warranty.expiresOn);
  const price =
    warranty.purchasePrice !== null && warranty.currencyCode !== null
      ? withCurrencyCode(formatCurrency(warranty.purchasePrice, warranty.currencyCode), warranty.currencyCode, defaultCurrency)
      : t('detail.card.none');

  const cards: SummaryCardItem[] = [
    { lead: true, label: t('detail.summary.expires'), value: expires, note: daysLeftText(warranty) },
    { label: t('detail.summary.purchased'), value: formatDate(warranty.purchaseDate) },
    { label: t('detail.summary.price'), value: price },
    { label: t('detail.summary.openClaims'), value: formatNumber(warranty.openClaimCount, 0) },
  ];

  return <SummaryCardGrid cards={cards} className={summaryGridClass(cards.length)} />;
}
