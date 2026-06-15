'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations, useMessages } from 'next-intl';
import { Security } from '@/types/investment';
import { DensityLevel, nextDensity } from '@/hooks/useTableDensity';
import { SortIcon } from '@/components/ui/SortIcon';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatShareQuantity } from '@/lib/format';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

interface SecurityActionLabels {
  history: string;
  prices: string;
  edit: string;
  activate: string;
  deactivate: string;
  delete: string;
}

interface SecurityActionHandlers {
  onViewHistory?: (security: Security) => void;
  onViewPrices?: (security: Security) => void;
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  onDelete?: (security: Security) => void;
}

/**
 * Builds the standard row actions for a security. Shared by the desktop
 * `RowActions` cell and the mobile `RowActionSheet`.
 */
function buildSecurityActions(
  security: Security,
  hasHoldings: boolean,
  hasTransactions: boolean,
  labels: SecurityActionLabels,
  handlers: SecurityActionHandlers,
): RowAction[] {
  const canDelete = !hasHoldings && !hasTransactions;
  return [
    {
      key: 'history',
      label: labels.history,
      icon: 'history',
      tone: 'neutral',
      onClick: () => handlers.onViewHistory?.(security),
      hidden: !handlers.onViewHistory,
    },
    {
      key: 'prices',
      label: labels.prices,
      icon: 'prices',
      tone: 'neutral',
      onClick: () => handlers.onViewPrices?.(security),
      hidden: !handlers.onViewPrices,
    },
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

export type SecuritySortField = 'symbol' | 'name' | 'type' | 'shares' | 'exchange' | 'currency' | 'provider' | 'source';

/** Format a security_prices.source value into a short human label. */
function formatPriceSource(source: string | null | undefined): string {
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

function priceSourceBadgeClass(source: string | null | undefined): string {
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
export type SortDirection = 'asc' | 'desc';

// Map of securityId -> total quantity across all accounts
export type SecurityHoldings = Record<string, number>;

// Set of securityIds that have investment transactions
export type SecurityTransactions = Set<string>;

interface SecurityListProps {
  securities: Security[];
  holdings?: SecurityHoldings;
  transactionSecurityIds?: SecurityTransactions;
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  onToggleFavourite?: (security: Security) => void;
  onDelete?: (security: Security) => void;
  onViewPrices?: (security: Security) => void;
  onViewHistory?: (security: Security) => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  sortField?: SecuritySortField;
  sortDirection?: SortDirection;
  onSort?: (field: SecuritySortField) => void;
}

interface SecurityRowProps {
  security: Security;
  hasHoldings: boolean;
  hasTransactions: boolean;
  shares: number;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  onToggleFavourite?: (security: Security) => void;
  onDelete?: (security: Security) => void;
  onViewPrices?: (security: Security) => void;
  onViewHistory?: (security: Security) => void;
  getRowHandlers: (security: Security) => LongPressRowHandlers;
  index: number;
  defaultQuoteProvider: 'yahoo' | 'msn';
}

const SecurityRow = memo(function SecurityRow({
  security,
  hasHoldings,
  hasTransactions,
  shares,
  density,
  cellPadding,
  onEdit,
  onToggleActive,
  onToggleFavourite,
  onDelete,
  onViewPrices,
  onViewHistory,
  getRowHandlers,
  index,
  defaultQuoteProvider,
}: SecurityRowProps) {
  const t = useTranslations('securities');
  const tc = useTranslations('common');
  const messages = useMessages();
  const typeLabelsMap = ((messages as any)?.securities?.typeLabels ?? {}) as Record<string, string>;
  const getTypeLabel = (type: string, short: boolean): string => {
    const key = short ? `${type}_short` : type;
    return typeLabelsMap[key] ?? type;
  };

  const handleToggleFavourite = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFavourite?.(security);
    },
    [onToggleFavourite, security],
  );

  const actions = buildSecurityActions(
    security,
    hasHoldings,
    hasTransactions,
    {
      history: t('list.actions.history'),
      prices: t('list.actions.prices'),
      edit: tc('actions.edit'),
      activate: t('list.actions.activate'),
      deactivate: t('list.actions.deactivate'),
      delete: tc('actions.delete'),
    },
    { onViewHistory, onViewPrices, onEdit, onToggleActive, onDelete },
  );

  return (
    <tr
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 select-none ${
        !security.isActive ? 'opacity-60' : ''
      } ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'}`}
      {...getRowHandlers(security)}
    >
      <td className={`${cellPadding} whitespace-nowrap text-center`}>
        <button
          type="button"
          onClick={handleToggleFavourite}
          onMouseDown={(e) => e.stopPropagation()}
          className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title={security.isFavourite ? t('list.favouriteButton.remove') : t('list.favouriteButton.add')}
          aria-label={security.isFavourite ? t('list.favouriteButton.remove') : t('list.favouriteButton.add')}
          aria-pressed={security.isFavourite}
        >
          <svg
            className={`w-4 h-4 ${security.isFavourite ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-500'}`}
            fill={security.isFavourite ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 20 20"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        </button>
      </td>
      <td className={`${cellPadding} whitespace-nowrap`}>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {security.symbol}
        </span>
      </td>
      <td className={`${cellPadding}`}>
        <span className="text-sm text-gray-900 dark:text-gray-100">
          {security.name}
        </span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap`}>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {security.securityType
            ? getTypeLabel(security.securityType, density === 'dense')
            : '-'}
        </span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right`}>
        <span
          className="text-sm text-gray-900 dark:text-gray-100"
          title={t('list.columnTitles.shares')}
        >
          {formatShareQuantity(shares)}
        </span>
      </td>
      {density === 'normal' && (
        <>
          <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {security.exchange || '-'}
            </span>
          </td>
          <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {security.currencyCode}
            </span>
          </td>
          <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell`}>
            {(() => {
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
                  title={
                    isOverride
                      ? t('list.providerTitle.override')
                      : t('list.providerTitle.inherited')
                  }
                >
                  {effective === 'msn' ? 'MSN' : 'Yahoo'}
                </span>
              );
            })()}
          </td>
          <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell`}>
            {security.lastPriceSource ? (
              <span
                className={`inline-flex items-center rounded text-xs font-medium px-2 py-0.5 ${priceSourceBadgeClass(security.lastPriceSource)}`}
                title={security.lastPriceSource}
              >
                {formatPriceSource(security.lastPriceSource)}
              </span>
            ) : (
              <span className="text-sm text-gray-400 dark:text-gray-500">-</span>
            )}
          </td>
        </>
      )}
      {/* Status - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        {security.isActive ? (
          <span className={`inline-flex items-center rounded-full text-xs font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2.5 py-0.5'}`}>
            {density === 'dense' ? t('list.statusBadge.activeShort') : t('list.statusBadge.active')}
          </span>
        ) : (
          <span className={`inline-flex items-center rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2.5 py-0.5'}`}>
            {density === 'dense' ? t('list.statusBadge.inactiveShort') : t('list.statusBadge.inactive')}
          </span>
        )}
      </td>
      {/* Actions - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden sm:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

export function SecurityList({
  securities,
  holdings = {},
  transactionSecurityIds = new Set(),
  onEdit,
  onToggleActive,
  onToggleFavourite,
  onDelete,
  onViewPrices,
  onViewHistory,
  density: propDensity,
  onDensityChange,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
}: SecurityListProps) {
  const t = useTranslations('securities');
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [localSortField, setLocalSortField] = useState<SecuritySortField>('symbol');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  const defaultQuoteProvider =
    usePreferencesStore((s) => s.preferences?.defaultQuoteProvider) ?? 'yahoo';

  // Use prop sort state if provided (controlled), otherwise use local state
  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;

  // Use prop density if provided, otherwise use local state
  const density = propDensity ?? localDensity;

  const handleSort = useCallback((field: SecuritySortField) => {
    if (onSort) {
      onSort(field);
    } else {
      if (localSortField === field) {
        setLocalSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setLocalSortField(field);
        setLocalSortDirection('asc');
      }
    }
  }, [onSort, localSortField]);

  // Long-press opens a per-row action sheet on mobile (and via right-click).
  const [contextSecurity, setContextSecurity] = useState<Security | null>(null);

  const { getRowHandlers } = useLongPress<Security>({
    onLongPress: setContextSecurity,
  });

  // Memoize padding classes based on density
  const cellPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-1';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-4';
    }
  }, [density]);

  const headerPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-2';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-3';
    }
  }, [density]);

  const cycleDensity = useCallback(() => {
    const next = nextDensity(density);
    if (onDensityChange) {
      onDensityChange(next);
    } else {
      setLocalDensity(next);
    }
  }, [density, onDensityChange]);

  if (securities.length === 0) {
    return (
      <div className="p-12 text-center">
        <svg
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('list.empty.title')}
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('list.empty.subtitle')}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Density toggle */}
      <div className="flex justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <button
          onClick={cycleDensity}
          className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          title={t('list.density.toggle')}
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? t('list.density.normal') : density === 'compact' ? t('list.density.compact') : t('list.density.dense')}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                <span className="sr-only">{t('list.columns.favourite')}</span>
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('symbol')}
              >
                {t('list.columns.symbol')}<SortIcon field="symbol" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('name')}
              >
                {t('list.columns.name')}<SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('type')}
              >
                {t('list.columns.type')}<SortIcon field="type" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('shares')}
              >
                {t('list.columns.shares')}<SortIcon field="shares" sortField={sortField} sortDirection={sortDirection} />
              </th>
              {density === 'normal' && (
                <>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                    onClick={() => handleSort('exchange')}
                  >
                    {t('list.columns.exchange')}<SortIcon field="exchange" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                    onClick={() => handleSort('currency')}
                  >
                    {t('list.columns.currency')}<SortIcon field="currency" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                    onClick={() => handleSort('provider')}
                    title={t('list.columnTitles.source')}
                  >
                    {t('list.columns.provider')}<SortIcon field="provider" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                  <th
                    className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                    onClick={() => handleSort('source')}
                    title={t('list.columnTitles.source')}
                  >
                    {t('list.columns.source')}<SortIcon field="source" sortField={sortField} sortDirection={sortDirection} />
                  </th>
                </>
              )}
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                {t('list.columns.status')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.columns.actions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {securities.map((security, index) => (
              <SecurityRow
                key={security.id}
                security={security}
                hasHoldings={(holdings[security.id] || 0) > 0}
                hasTransactions={transactionSecurityIds.has(security.id)}
                shares={holdings[security.id] || 0}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onToggleActive={onToggleActive}
                onToggleFavourite={onToggleFavourite}
                onDelete={onDelete}
                onViewPrices={onViewPrices}
                onViewHistory={onViewHistory}
                getRowHandlers={getRowHandlers}
                index={index}
                defaultQuoteProvider={defaultQuoteProvider}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Long-press action sheet */}
      <RowActionSheet
        isOpen={!!contextSecurity}
        title={contextSecurity?.symbol ?? ''}
        subtitle={contextSecurity?.name}
        actions={contextSecurity
          ? buildSecurityActions(
              contextSecurity,
              (holdings[contextSecurity.id] || 0) > 0,
              transactionSecurityIds.has(contextSecurity.id),
              {
                history: t('list.contextMenu.transactionHistory'),
                prices: t('list.contextMenu.viewPrices'),
                edit: t('list.contextMenu.editSecurity'),
                activate: t('list.contextMenu.activate'),
                deactivate: t('list.contextMenu.deactivate'),
                delete: t('list.contextMenu.delete'),
              },
              { onViewHistory, onViewPrices, onEdit, onToggleActive, onDelete },
            )
          : []}
        onClose={() => setContextSecurity(null)}
      />
    </div>
  );
}
