'use client';

import { useTranslations } from 'next-intl';
import { Payee } from '@/types/payee';
import { Badge } from '@/components/ui/Badge';
import { CategoryPill } from '@/components/transactions/CategoryPill';
import type { DensityLevel } from '@/hooks/useTableDensity';

/**
 * The pieces of a payee row that BOTH of `PayeeList`'s layouts draw -- the tier
 * table's cells and, on a phone at Normal density, the wrapped card.
 *
 * They live here rather than inline in either branch because each is a
 * DECISION rather than a label: whether the "uncategorized" marker appears at
 * all, whether a payee shows a category pill or the muted placeholder, which
 * colour the status pill takes, and what an absent date or an empty note reads
 * as. A layout mode must never re-decide any of those, so there is one
 * implementation and the two branches call it.
 */

/**
 * The payee's name as the control that opens its transactions, in both
 * layouts. The `stopPropagation` is what keeps the row's own click (which opens
 * the payee's detail page) from firing behind it.
 */
export function PayeeNameButton({
  payee,
  onViewTransactions,
  className = '',
}: {
  payee: Payee;
  onViewTransactions: (payee: Payee) => void;
  className?: string;
}) {
  const t = useTranslations('payees');
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onViewTransactions(payee); }}
      className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left${className ? ` ${className}` : ''}`}
      title={t('list.viewTransactionsTitle')}
    >
      {payee.name}
    </button>
  );
}

/**
 * The "N uncategorized" marker beside the name, in both layouts. Whether it
 * appears at all is a decision about the count, not a label, so it lives here
 * rather than at each call site.
 */
export function PayeeUncategorizedBadge({ payee }: { payee: Payee }) {
  const t = useTranslations('payees');
  const count = payee.uncategorizedCount ?? 0;
  if (count <= 0) return null;
  return (
    <Badge variant="amber" title={t('list.uncategorizedTitle', { count })}>
      {t('list.uncategorizedBadge', { count })}
    </Badge>
  );
}

/** The Active/Inactive pill, in both layouts. */
export function PayeeStatusBadge({ payee }: { payee: Payee }) {
  const t = useTranslations('payees');
  return payee.isActive ? (
    <Badge variant="green">{t('list.statusBadge.active')}</Badge>
  ) : (
    <Badge>{t('list.statusBadge.inactive')}</Badge>
  );
}

/**
 * The Default Category cell's content, in both layouts.
 *
 * Three decisions live here rather than at two call sites: a payee with no
 * default category shows the muted "No category" placeholder rather than a
 * blank, and the colour and icon are the INHERITED ones from the maps the page
 * builds (`buildCategoryColorMap` / `buildCategoryIconMap`) -- a joined
 * category row carries no inherited value of its own, so reading
 * `defaultCategory.color` alone would draw a leaf's empty colour.
 */
export function PayeeDefaultCategory({
  payee,
  density,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
  maxWidthClass,
}: {
  payee: Payee;
  density: DensityLevel;
  categoryColorMap?: Map<string, string | null>;
  categoryIconMap?: Map<string, string | null>;
  categoryLabelMap?: Map<string, string>;
  /**
   * How wide the pill may grow. Layout, not meaning, so it is the one thing a
   * caller may vary: the tier cell keeps `CategoryPill`'s own 160px cap (an
   * unbounded pill would push the columns beside it), while the phone card
   * passes `max-w-full` because there its width is decided by a grid track --
   * a 160px pill in a track squeezed narrower by a long caption does not
   * shrink, it overflows into the status pill beside it.
   */
  maxWidthClass?: string;
}) {
  const t = useTranslations('payees');
  const label = payee.defaultCategory
    ? (categoryLabelMap?.get(payee.defaultCategory.id) ?? payee.defaultCategory.name)
    : null;
  if (!payee.defaultCategory || !label) {
    return <span className="text-sm text-gray-400 dark:text-gray-500">{t('list.noCategory')}</span>;
  }
  return (
    <CategoryPill
      name={label}
      color={categoryColorMap?.get(payee.defaultCategory.id) ?? payee.defaultCategory.color}
      icon={categoryIconMap?.get(payee.defaultCategory.id) ?? payee.defaultCategory.icon}
      density={density}
      maxWidthClass={maxWidthClass}
    />
  );
}

/**
 * A payee date column's text: the day part formatted, or the "-" placeholder.
 * Shared so the card and the tier cell cannot disagree about what "never used"
 * looks like.
 */
export function payeeDayText(
  value: string | null | undefined,
  formatDate: (date: string) => string,
): string {
  return value ? formatDate(value.substring(0, 10)) : '-';
}

/** The Notes column's text, with the same "-" placeholder in both layouts. */
export function payeeNotesText(payee: Payee): string {
  return payee.notes || '-';
}
