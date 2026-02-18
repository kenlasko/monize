'use client';

import { useState, useMemo, useCallback, useRef, memo } from 'react';
import { CurrencyInfo, CurrencyUsage } from '@/lib/exchange-rates';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/ui/Modal';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('CurrencyList');

export type DensityLevel = 'normal' | 'compact' | 'dense';

interface CurrencyListProps {
  currencies: CurrencyInfo[];
  usage: CurrencyUsage;
  defaultCurrency: string;
  getRate: (fromCurrency: string, toCurrency?: string) => number | null;
  onEdit: (currency: CurrencyInfo) => void;
  onToggleActive: (currency: CurrencyInfo) => void;
  onRefresh: () => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
}

interface CurrencyRowProps {
  currency: CurrencyInfo;
  usage: { accounts: number; securities: number } | undefined;
  defaultCurrency: string;
  exchangeRate: number | null;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (currency: CurrencyInfo) => void;
  onToggleActive: (currency: CurrencyInfo) => void;
  onDelete: (currency: CurrencyInfo) => void;
  onLongPressStart: (currency: CurrencyInfo) => void;
  onLongPressStartTouch: (currency: CurrencyInfo, e: React.TouchEvent) => void;
  onLongPressEnd: () => void;
  onTouchMove: (e: React.TouchEvent) => void;
  index: number;
}

const CurrencyRow = memo(function CurrencyRow({
  currency,
  usage,
  defaultCurrency,
  exchangeRate,
  density,
  cellPadding,
  onEdit,
  onToggleActive,
  onDelete: _onDelete,
  onLongPressStart,
  onLongPressStartTouch,
  onLongPressEnd,
  onTouchMove,
  index,
}: CurrencyRowProps) {
  const handleEdit = useCallback(() => onEdit(currency), [onEdit, currency]);
  const handleToggle = useCallback(() => onToggleActive(currency), [onToggleActive, currency]);

  const totalUsage = (usage?.accounts || 0) + (usage?.securities || 0);
  const isDefault = currency.code === defaultCurrency;

  return (
    <tr
      className={`hover:bg-gray-50 dark:hover:bg-gray-800 select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''}`}
      onMouseDown={() => onLongPressStart(currency)}
      onMouseUp={onLongPressEnd}
      onMouseLeave={onLongPressEnd}
      onTouchStart={(e) => onLongPressStartTouch(currency, e)}
      onTouchMove={onTouchMove}
      onTouchEnd={onLongPressEnd}
      onTouchCancel={onLongPressEnd}
    >
      {/* Code */}
      <td className={`${cellPadding} whitespace-nowrap`}>
        <span className="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
          {currency.code}
        </span>
        {isDefault && (
          <span className="ml-2 inline-flex text-xs leading-5 font-semibold rounded-full px-1.5 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
            Default
          </span>
        )}
      </td>
      {/* Name - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-700 dark:text-gray-300 hidden sm:table-cell`}>
        {currency.name}
      </td>
      {/* Symbol */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-600 dark:text-gray-400 text-center`}>
        {currency.symbol}
      </td>
      {/* Decimals - hidden in compact/dense */}
      {density === 'normal' && (
        <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 text-center hidden lg:table-cell`}>
          {currency.decimalPlaces}
        </td>
      )}
      {/* Usage */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-600 dark:text-gray-400 hidden sm:table-cell`}>
        {totalUsage > 0 ? (
          <span title={`${usage?.accounts || 0} account(s), ${usage?.securities || 0} security/ies`}>
            {usage?.accounts ? `${usage.accounts} acct${usage.accounts !== 1 ? 's' : ''}` : ''}
            {usage?.accounts && usage?.securities ? ', ' : ''}
            {usage?.securities ? `${usage.securities} sec${usage.securities !== 1 ? 's' : ''}` : ''}
          </span>
        ) : (
          <span className="text-gray-400 dark:text-gray-500">-</span>
        )}
      </td>
      {/* Exchange Rate */}
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-600 dark:text-gray-400 text-right`}>
        {isDefault ? (
          <span className="text-gray-400 dark:text-gray-500">-</span>
        ) : exchangeRate ? (
          <span title={`1 ${currency.code} = ${exchangeRate.toFixed(4)} ${defaultCurrency}`}>
            {exchangeRate.toFixed(4)}
          </span>
        ) : (
          <span className="text-gray-400 dark:text-gray-500">N/A</span>
        )}
      </td>
      {/* Status */}
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        <span
          className={`inline-flex text-xs leading-5 font-semibold rounded-full ${
            density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'
          } ${
            currency.isActive
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
          }`}
        >
          {density === 'dense'
            ? currency.isActive ? 'Act' : 'Ina'
            : currency.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      {/* Actions - hidden on mobile */}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden sm:table-cell`}>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleEdit}
          className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-1"
        >
          {density === 'dense' ? '✎' : 'Edit'}
        </Button>
        {!isDefault && totalUsage === 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggle}
            className={`mr-1 ${
              currency.isActive
                ? 'text-yellow-600 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-300'
                : 'text-green-600 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300'
            }`}
          >
            {density === 'dense'
              ? currency.isActive ? '⊘' : '✓'
              : currency.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        )}
      </td>
    </tr>
  );
});

export function CurrencyList({
  currencies,
  usage,
  defaultCurrency,
  getRate,
  onEdit,
  onToggleActive,
  onRefresh,
  density: propDensity,
  onDensityChange,
}: CurrencyListProps) {
  const [deleteCurrency, setDeleteCurrency] = useState<CurrencyInfo | null>(null);
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');

  const density = propDensity ?? localDensity;

  // Long-press handling for context menu on mobile
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const longPressTriggered = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const LONG_PRESS_MOVE_THRESHOLD = 10;
  const [contextCurrency, setContextCurrency] = useState<CurrencyInfo | null>(null);

  const handleLongPressStart = useCallback((currency: CurrencyInfo) => {
    touchStartPos.current = null;
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setContextCurrency(currency);
    }, 750);
  }, []);

  const handleLongPressStartTouch = useCallback((currency: CurrencyInfo, e: React.TouchEvent) => {
    if (e?.touches?.[0]) {
      touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      touchStartPos.current = null;
    }
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setContextCurrency(currency);
    }, 750);
  }, []);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartPos.current && longPressTimer.current && e.touches?.[0]) {
      const deltaX = Math.abs(e.touches[0].clientX - touchStartPos.current.x);
      const deltaY = Math.abs(e.touches[0].clientY - touchStartPos.current.y);
      if (deltaX > LONG_PRESS_MOVE_THRESHOLD || deltaY > LONG_PRESS_MOVE_THRESHOLD) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        touchStartPos.current = null;
      }
    }
  }, []);

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
    const nextDensity = density === 'normal' ? 'compact' : density === 'compact' ? 'dense' : 'normal';
    if (onDensityChange) {
      onDensityChange(nextDensity);
    } else {
      setLocalDensity(nextDensity);
    }
  }, [density, onDensityChange]);

  const handleConfirmDelete = async () => {
    if (!deleteCurrency) return;
    try {
      await exchangeRatesApi.deleteCurrency(deleteCurrency.code);
      toast.success('Currency deleted successfully');
      onRefresh();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete currency. It may be in use.'));
      logger.error(error);
    } finally {
      setDeleteCurrency(null);
    }
  };

  if (currencies.length === 0) {
    return (
      <div className="text-center py-12">
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
            d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No currencies</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Get started by adding a currency.</p>
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
          title="Toggle row density"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? 'Normal' : density === 'compact' ? 'Compact' : 'Dense'}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Code
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                Name
              </th>
              <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Symbol
              </th>
              {density === 'normal' && (
                <th className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden lg:table-cell`}>
                  Decimals
                </th>
              )}
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                Usage
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Rate ({defaultCurrency})
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                Status
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {currencies.map((currency, index) => (
              <CurrencyRow
                key={currency.code}
                currency={currency}
                usage={usage[currency.code]}
                defaultCurrency={defaultCurrency}
                exchangeRate={getRate(currency.code)}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onToggleActive={onToggleActive}
                onDelete={setDeleteCurrency}
                onLongPressStart={handleLongPressStart}
                onLongPressStartTouch={handleLongPressStartTouch}
                onLongPressEnd={handleLongPressEnd}
                onTouchMove={handleTouchMove}
                index={index}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Long-press Context Menu */}
      <Modal isOpen={!!contextCurrency} onClose={() => setContextCurrency(null)} maxWidth="sm" className="p-0">
        {contextCurrency && (() => {
          const contextUsage = usage[contextCurrency.code];
          const contextTotalUsage = (contextUsage?.accounts || 0) + (contextUsage?.securities || 0);
          const isContextDefault = contextCurrency.code === defaultCurrency;
          const canDeactivateOrDelete = !isContextDefault && contextTotalUsage === 0;
          return (
          <div>
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">{contextCurrency.code}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">{contextCurrency.name}</p>
            </div>
            <div className="py-2">
              <button
                onClick={() => { setContextCurrency(null); onEdit(contextCurrency); }}
                className="w-full text-left px-5 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
              >
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit Currency
              </button>
              {canDeactivateOrDelete && (
                <button
                  onClick={() => { setContextCurrency(null); onToggleActive(contextCurrency); }}
                  className={`w-full text-left px-5 py-3 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3 ${
                    contextCurrency.isActive
                      ? 'text-yellow-600 dark:text-yellow-400'
                      : 'text-green-600 dark:text-green-400'
                  }`}
                >
                  {contextCurrency.isActive ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  )}
                  {contextCurrency.isActive ? 'Deactivate' : 'Activate'}
                </button>
              )}
              {canDeactivateOrDelete && (
                <button
                  onClick={() => { setContextCurrency(null); setDeleteCurrency(contextCurrency); }}
                  className="w-full text-left px-5 py-3 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete Currency
                </button>
              )}
            </div>
          </div>
          );
        })()}
      </Modal>

      <ConfirmDialog
        isOpen={deleteCurrency !== null}
        title={`Delete "${deleteCurrency?.code}"?`}
        message="This currency will be permanently deleted. This only works if the currency is not in use by any accounts or securities."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteCurrency(null)}
      />
    </div>
  );
}
