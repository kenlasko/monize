'use client';

import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Security, SecurityPrice, CreateSecurityPriceData } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { useDateFormat } from '@/hooks/useDateFormat';
import { getErrorMessage } from '@/lib/errors';
import { SecurityPriceForm } from './SecurityPriceForm';

interface SecurityPriceHistoryProps {
  security: Security;
  onClose: () => void;
}

function getSourceLabel(source: string | null): string {
  if (!source) return 'Unknown';
  switch (source) {
    case 'yahoo_finance': return 'Yahoo';
    case 'manual': return 'Manual';
    case 'buy': return 'Buy';
    case 'sell': return 'Sell';
    case 'reinvest': return 'Reinvest';
    case 'transfer_in': return 'Transfer In';
    case 'transfer_out': return 'Transfer Out';
    default: return source;
  }
}

function getSourceColor(source: string | null): string {
  if (!source) return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
  switch (source) {
    case 'yahoo_finance':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
    case 'manual':
      return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
  }
}

function formatPrice(value: number | null): string {
  if (value === null || value === undefined) return '-';
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export function SecurityPriceHistory({ security, onClose }: SecurityPriceHistoryProps) {
  const { formatDate } = useDateFormat();
  const [prices, setPrices] = useState<SecurityPrice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingPrice, setEditingPrice] = useState<SecurityPrice | undefined>();
  const [deletingPrice, setDeletingPrice] = useState<SecurityPrice | undefined>();

  const loadPrices = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await investmentsApi.getSecurityPrices(security.id, 9999);
      setPrices(data);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load price history'));
    } finally {
      setIsLoading(false);
    }
  }, [security.id]);

  useEffect(() => {
    loadPrices();
  }, [loadPrices]);

  const handleAdd = useCallback(async (data: CreateSecurityPriceData) => {
    try {
      await investmentsApi.createSecurityPrice(security.id, data);
      toast.success('Price added');
      setShowAddForm(false);
      loadPrices();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to add price'));
      throw error;
    }
  }, [security.id, loadPrices]);

  const handleEdit = useCallback(async (data: CreateSecurityPriceData) => {
    if (!editingPrice) return;
    try {
      await investmentsApi.updateSecurityPrice(security.id, editingPrice.id, data);
      toast.success('Price updated');
      setEditingPrice(undefined);
      loadPrices();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to update price'));
      throw error;
    }
  }, [security.id, editingPrice, loadPrices]);

  const handleDelete = useCallback(async () => {
    if (!deletingPrice) return;
    try {
      await investmentsApi.deleteSecurityPrice(security.id, deletingPrice.id);
      toast.success('Price deleted');
      setDeletingPrice(undefined);
      loadPrices();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete price'));
    }
  }, [security.id, deletingPrice, loadPrices]);

  const isFormOpen = showAddForm || !!editingPrice;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
          {security.symbol} - Price History
        </h2>
        <div className="flex gap-2">
          {!isFormOpen && (
            <Button onClick={() => setShowAddForm(true)} size="sm">
              + Add Price
            </Button>
          )}
          <Button variant="outline" onClick={onClose} size="sm">
            Close
          </Button>
        </div>
      </div>

      {/* Add/Edit Form */}
      {showAddForm && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Add Price</h3>
          <SecurityPriceForm
            onSubmit={handleAdd}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {editingPrice && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">Edit Price</h3>
          <SecurityPriceForm
            price={editingPrice}
            onSubmit={handleEdit}
            onCancel={() => setEditingPrice(undefined)}
          />
        </div>
      )}

      {/* Price Table */}
      {isLoading ? (
        <LoadingSpinner text="Loading prices..." />
      ) : prices.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          No price history available
        </p>
      ) : (
        <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Close</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden sm:table-cell">Open</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden sm:table-cell">High</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden sm:table-cell">Low</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">Volume</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Source</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {prices.map((price) => (
                <tr key={price.id} className="hover:bg-gray-50 dark:hover:bg-gray-750">
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                    {formatDate(price.priceDate)}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-900 dark:text-gray-100 text-right tabular-nums">
                    {formatPrice(price.closePrice)}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 text-right tabular-nums hidden sm:table-cell">
                    {formatPrice(price.openPrice)}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 text-right tabular-nums hidden sm:table-cell">
                    {formatPrice(price.highPrice)}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 text-right tabular-nums hidden sm:table-cell">
                    {formatPrice(price.lowPrice)}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400 text-right tabular-nums hidden md:table-cell">
                    {price.volume !== null ? Number(price.volume).toLocaleString() : '-'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getSourceColor(price.source)}`}>
                      {getSourceLabel(price.source)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => { setShowAddForm(false); setEditingPrice(price); }}
                        className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-xs"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setDeletingPrice(price)}
                        className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 text-xs"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deletingPrice}
        title="Delete Price"
        message={`Delete price entry for ${deletingPrice ? formatDate(deletingPrice.priceDate) : ''}?`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeletingPrice(undefined)}
      />
    </div>
  );
}
