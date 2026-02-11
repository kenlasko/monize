'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { Security } from '@/types/investment';
import { Button } from '@/components/ui/Button';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

interface SecurityListProps {
  securities: Security[];
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
}

interface SecurityRowProps {
  security: Security;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (security: Security) => void;
  onToggleActive: (security: Security) => void;
  index: number;
}

const formatSecurityType = (type: string | null, dense: boolean = false): string => {
  if (!type) return '-';
  const labels: Record<string, { full: string; short: string }> = {
    STOCK: { full: 'Stock', short: 'Stk' },
    ETF: { full: 'ETF', short: 'ETF' },
    MUTUAL_FUND: { full: 'Mutual Fund', short: 'MF' },
    BOND: { full: 'Bond', short: 'Bnd' },
    OPTION: { full: 'Option', short: 'Opt' },
    CRYPTO: { full: 'Crypto', short: 'Cry' },
    OTHER: { full: 'Other', short: 'Oth' },
  };
  const label = labels[type];
  if (!label) return type;
  return dense ? label.short : label.full;
};

const SecurityRow = memo(function SecurityRow({
  security,
  density,
  cellPadding,
  onEdit,
  onToggleActive,
  index,
}: SecurityRowProps) {
  const handleEdit = useCallback(() => {
    onEdit(security);
  }, [onEdit, security]);

  const handleToggleActive = useCallback(() => {
    onToggleActive(security);
  }, [onToggleActive, security]);

  return (
    <tr
      className={`hover:bg-gray-50 dark:hover:bg-gray-700 ${
        !security.isActive ? 'opacity-60' : ''
      } ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''}`}
    >
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
          {formatSecurityType(security.securityType, density === 'dense')}
        </span>
      </td>
      {density === 'normal' && (
        <>
          <td className={`${cellPadding} whitespace-nowrap`}>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {security.exchange || '-'}
            </span>
          </td>
          <td className={`${cellPadding} whitespace-nowrap`}>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {security.currencyCode}
            </span>
          </td>
        </>
      )}
      <td className={`${cellPadding} whitespace-nowrap`}>
        {security.isActive ? (
          <span className={`inline-flex items-center rounded-full text-xs font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2.5 py-0.5'}`}>
            {density === 'dense' ? 'Act' : 'Active'}
          </span>
        ) : (
          <span className={`inline-flex items-center rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300 ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2.5 py-0.5'}`}>
            {density === 'dense' ? 'Ina' : 'Inactive'}
          </span>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium`}>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleEdit}
          >
            {density === 'dense' ? '✎' : 'Edit'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleActive}
          >
            {density === 'dense'
              ? (security.isActive ? '⊘' : '✓')
              : (security.isActive ? 'Deactivate' : 'Activate')}
          </Button>
        </div>
      </td>
    </tr>
  );
});

export function SecurityList({
  securities,
  onEdit,
  onToggleActive,
  density: propDensity,
  onDensityChange,
}: SecurityListProps) {
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');

  // Use prop density if provided, otherwise use local state
  const density = propDensity ?? localDensity;

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
    const nextDensity = density === 'normal' ? 'compact' : density === 'compact' ? 'dense' : 'normal';
    if (onDensityChange) {
      onDensityChange(nextDensity);
    } else {
      setLocalDensity(nextDensity);
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
          No securities
        </h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Get started by adding your first security.
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
          <thead className="bg-gray-50 dark:bg-gray-900">
            <tr>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Symbol
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Name
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Type
              </th>
              {density === 'normal' && (
                <>
                  <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                    Exchange
                  </th>
                  <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                    Currency
                  </th>
                </>
              )}
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Status
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {securities.map((security, index) => (
              <SecurityRow
                key={security.id}
                security={security}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onToggleActive={onToggleActive}
                index={index}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
