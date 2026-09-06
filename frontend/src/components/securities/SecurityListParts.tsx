'use client';

import { useTranslations, useMessages } from 'next-intl';
import { Security } from '@/types/investment';
import { DensityLevel } from '@/hooks/useTableDensity';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { withCurrencyCode } from '@/lib/security-detail';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

/**
 * The pieces of a securities row that BOTH layouts draw -- the tier table's
 * cells and, on a phone at Normal density, the wrapped card.
 *
 * They live here rather than being copied into the card branch because each one
 * is a DECISION rather than a label: which of a type's two label lengths a
 * density gets, whether a provider is the user's default or a per-security
 * override, what an unpriced position renders as. A layout mode may not
 * re-decide any of those, so there is one implementation and two callers.
 *
 * What is NOT here is anything carrying a `ui-conventions` shrink-only
 * fingerprint -- the favourite star's hand-written row-hover pair, the status
 * pill's rounded-full trio, the table's divide string. Those baselines are
 * recorded against `SecurityList.tsx`, and moving one into a new file would
 * fail the guard rather than shrink the baseline; they stay put and are shared
 * as components declared there.
 */

interface SecurityActionLabels {
  edit: string;
  activate: string;
  deactivate: string;
  delete: string;
}

interface SecurityActionHandlers {
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  onDelete?: (security: Security) => void;
}

/**
 * Builds the standard row actions for a security. Shared by the desktop
 * `RowActions` cell and the mobile `RowActionSheet`.
 */
export function buildSecurityActions(
  security: Security,
  hasHoldings: boolean,
  hasTransactions: boolean,
  labels: SecurityActionLabels,
  handlers: SecurityActionHandlers,
): RowAction[] {
  const canDelete = !hasHoldings && !hasTransactions;
  return [
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit(security),
    },
    security.isActive
      ? {
          key: 'toggle',
          label: labels.deactivate,
          icon: 'deactivate',
          tone: 'warning',
          onClick: () => handlers.onToggleActive(security),
          hidden: hasHoldings,
        }
      : {
          key: 'toggle',
          label: labels.activate,
          icon: 'activate',
          tone: 'success',
          onClick: () => handlers.onToggleActive(security),
          hidden: hasHoldings,
        },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDelete?.(security),
      hidden: !canDelete || !handlers.onDelete,
    },
  ];
}

export type SecuritySortField =
  | 'symbol'
  | 'name'
  | 'type'
  | 'shares'
  | 'value'
  | 'exchange'
  | 'currency'
  | 'provider'
  | 'source';

/**
 * Every field this list sorts by, with its position in the tier header's own
 * order. The phone's slim control header renders all nine: the chosen field is
 * persisted (`monize-securities-sort-field`, set on the Securities page) and
 * four of the nine columns are invisible at phone width (Exchange and Currency
 * below `sm`, Provider and Source below `md`), so a header offering fewer would
 * strand a phone on a sort order it can neither see nor undo. Favourite, Status
 * and Actions are absent because the tier header offers no sort control for
 * them -- the favourite column's header is an `sr-only` label, not a button.
 *
 * It is a `Record` keyed by the union rather than a hand-written array because
 * the slim `<th>` announces a direction UNCONDITIONALLY, and that is only
 * honest while the buttons name every field the list can be sorted by. Here the
 * compiler holds that: a tenth sort field is a type error until it is given a
 * position, and the derived list cannot omit one. `as const satisfies
 * ReadonlyArray<SecuritySortField>` would have accepted a proper subset --
 * leaving "sorted ascending" announced over nine unsorted glyphs.
 */
export const SORT_FIELD_ORDER: Record<SecuritySortField, number> = {
  symbol: 0,
  name: 1,
  type: 2,
  shares: 3,
  value: 4,
  exchange: 5,
  currency: 6,
  provider: 7,
  source: 8,
};

export const SORT_FIELDS: readonly SecuritySortField[] = (
  Object.keys(SORT_FIELD_ORDER) as SecuritySortField[]
).sort((a, b) => SORT_FIELD_ORDER[a] - SORT_FIELD_ORDER[b]);

/** Format a security_prices.source value into a short human label. */
export function formatPriceSource(source: string | null | undefined): string {
  if (!source) return '';
  switch (source) {
    case 'yahoo_finance': return 'Yahoo';
    case 'msn_finance': return 'MSN';
    case 'manual': return 'Manual';
    case 'buy':
    case 'sell':
    case 'reinvest':
    case 'transfer_in':
    case 'transfer_out': return 'Txn';
    default: return source;
  }
}

export function priceSourceBadgeClass(source: string | null | undefined): string {
  switch (source) {
    case 'yahoo_finance':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
    case 'msn_finance':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300';
    case 'manual':
      return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
    case 'buy':
    case 'sell':
    case 'reinvest':
    case 'transfer_in':
    case 'transfer_out':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
  }
}

/**
 * The Type column's text, in both layouts.
 *
 * The decision it carries is which of the catalog's two label lengths a density
 * gets: a dense row takes the abbreviated form because the full words do not fit
 * that row height. The card only ever renders at Normal, so it takes the long
 * form -- but it asks the same function rather than assuming, so a change to the
 * rule reaches both. A security with no type shows "-", which is an absent
 * classification rather than an unknown figure.
 */
export function SecurityTypeText({
  security,
  density,
}: {
  security: Security;
  density: DensityLevel;
}) {
  const messages = useMessages();
  const typeLabelsMap = ((messages as Record<string, any>)?.securities?.typeLabels ?? {}) as Record<string, string>;
  const getTypeLabel = (type: string, short: boolean): string => {
    const key = short ? `${type}_short` : type;
    return typeLabelsMap[key] ?? type;
  };
  return (
    <span className="text-sm text-gray-500 dark:text-gray-400">
      {security.securityType ? getTypeLabel(security.securityType, density === 'dense') : '-'}
    </span>
  );
}

/**
 * What the position is worth: shares times the latest close, in the security's
 * own currency (never converted, so the code is appended whenever that is not
 * the reader's).
 *
 * The branch is the reason this is shared: a held position with no usable price
 * is UNKNOWN, drawn as `UnknownAmount`, never as a zero and never as a blank --
 * see `securityPositionValue`. Zero shares really is zero and prints as money.
 * Both layouts read this one component, so a card can neither invent a figure
 * the table withholds nor withhold one it shows.
 */
export function SecurityValueFigure({
  value,
  currencyCode,
  defaultCurrency,
  unknownClassName,
}: {
  value: number | null;
  currencyCode: string;
  defaultCurrency: string;
  unknownClassName?: string;
}) {
  const t = useTranslations('securities');
  const { formatCurrency } = useNumberFormat();
  if (value === null) {
    return <UnknownAmount reason="noPrice" className={unknownClassName} />;
  }
  return (
    <span
      className="text-sm text-gray-900 dark:text-gray-100"
      title={t('list.columnTitles.value')}
    >
      {withCurrencyCode(formatCurrency(value, currencyCode), currencyCode, defaultCurrency)}
    </span>
  );
}

/**
 * The quote provider in force for this security, in both layouts.
 *
 * Two facts, not one: which provider will be asked, and whether that is a
 * per-security override or the user's default inherited. The italic, faded
 * treatment and the tooltip are how the second is stated, so they travel with
 * the first.
 */
export function SecurityProviderBadge({
  security,
  defaultQuoteProvider,
}: {
  security: Security;
  defaultQuoteProvider: 'yahoo' | 'msn';
}) {
  const t = useTranslations('securities');
  const effective = security.quoteProvider ?? defaultQuoteProvider;
  const isOverride = !!security.quoteProvider;
  const baseClass =
    effective === 'msn'
      ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300'
      : 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
  return (
    <span
      className={`inline-flex items-center rounded text-xs font-medium px-2 py-0.5 ${baseClass} ${
        isOverride ? '' : 'italic opacity-70'
      }`}
      title={isOverride ? t('list.providerTitle.override') : t('list.providerTitle.inherited')}
    >
      {effective === 'msn' ? 'MSN' : 'Yahoo'}
    </span>
  );
}

/**
 * Where the most recent price came from, in both layouts. A security that has
 * never been priced has no source to state and shows "-".
 */
export function SecurityPriceSourceBadge({ security }: { security: Security }) {
  if (!security.lastPriceSource) {
    return <span className="text-sm text-gray-400 dark:text-gray-500">-</span>;
  }
  return (
    <span
      className={`inline-flex items-center rounded text-xs font-medium px-2 py-0.5 ${priceSourceBadgeClass(security.lastPriceSource)}`}
      title={security.lastPriceSource}
    >
      {formatPriceSource(security.lastPriceSource)}
    </span>
  );
}

/**
 * The tag chips under a security's name, in both layouts. The colour is the
 * user's own choice on the tag, so it is an inline style rather than a theme
 * token -- never theme a user-chosen entity colour.
 */
export function SecurityTagChips({ security }: { security: Security }) {
  if (!security.tags || security.tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {security.tags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium"
          style={{
            backgroundColor: tag.color ? `${tag.color}20` : '#9ca3af20',
            color: tag.color || '#6b7280',
          }}
        >
          {tag.name}
        </span>
      ))}
    </div>
  );
}

/**
 * The security's description under its name. Shown at Normal density only --
 * the card is a Normal-density layout, so it carries it too, from here rather
 * than from a copy that could stop agreeing about when it appears.
 */
export function SecurityDescription({
  security,
  density,
}: {
  security: Security;
  density: DensityLevel;
}) {
  if (density !== 'normal' || !security.description) return null;
  return (
    <p
      className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2 max-w-md"
      title={security.description}
    >
      {security.description}
    </p>
  );
}
