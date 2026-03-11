'use client';

import { useState, useEffect, useCallback } from 'react';
import { PayeeAlias } from '@/types/payee';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';
import { getErrorMessage } from '@/lib/errors';

interface PayeeAliasManagerProps {
  payeeId?: string;
  onPendingAliasesChange?: (aliases: string[]) => void;
}

export function PayeeAliasManager({ payeeId, onPendingAliasesChange }: PayeeAliasManagerProps) {
  const [aliases, setAliases] = useState<PayeeAlias[]>([]);
  const [pendingAliases, setPendingAliases] = useState<string[]>([]);
  const [newAlias, setNewAlias] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const isLocalMode = !payeeId;

  const loadAliases = useCallback(async () => {
    if (isLocalMode) return;
    setIsLoading(true);
    try {
      const data = await payeesApi.getAliases(payeeId);
      setAliases(data);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load aliases'));
    } finally {
      setIsLoading(false);
    }
  }, [payeeId, isLocalMode]);

  useEffect(() => {
    loadAliases();
  }, [loadAliases]);

  const handleAdd = async () => {
    const trimmed = newAlias.trim();
    if (!trimmed) return;

    if (isLocalMode) {
      if (pendingAliases.some(a => a.toLowerCase() === trimmed.toLowerCase())) {
        toast.error(`Alias "${trimmed}" already added`);
        return;
      }
      const updated = [...pendingAliases, trimmed].sort((a, b) => a.localeCompare(b));
      setPendingAliases(updated);
      onPendingAliasesChange?.(updated);
      setNewAlias('');
      return;
    }

    setIsAdding(true);
    try {
      const created = await payeesApi.createAlias({
        payeeId,
        alias: trimmed,
      });
      setAliases((prev) => [...prev, created].sort((a, b) => a.alias.localeCompare(b.alias)));
      setNewAlias('');
      toast.success(`Alias "${trimmed}" added`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to add alias'));
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveLocal = (alias: string) => {
    const updated = pendingAliases.filter(a => a !== alias);
    setPendingAliases(updated);
    onPendingAliasesChange?.(updated);
  };

  const handleRemove = async (alias: PayeeAlias) => {
    try {
      await payeesApi.deleteAlias(alias.id);
      setAliases((prev) => prev.filter((a) => a.id !== alias.id));
      toast.success(`Alias "${alias.alias}" removed`);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to remove alias'));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  const displayAliases = isLocalMode
    ? pendingAliases
    : aliases.map(a => a.alias);

  return (
    <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-4 bg-gray-50/50 dark:bg-gray-800/50 space-y-3">
      <div className="flex items-center gap-2">
        <svg className="h-4 w-4 text-gray-500 dark:text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
        </svg>
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">
          Aliases
        </span>
        {displayAliases.length > 0 && (
          <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded-full font-medium">
            {displayAliases.length}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Aliases map imported payee names to this payee. Use * as wildcard (e.g., &quot;STARBUCKS*&quot;).
        Case-insensitive.
      </p>

      {/* Existing aliases */}
      {!isLocalMode && isLoading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : displayAliases.length > 0 ? (
        <ul className="space-y-1">
          {displayAliases.map((aliasText, index) => (
            <li
              key={isLocalMode ? aliasText : aliases[index]?.id ?? aliasText}
              className="flex items-center justify-between bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-3 py-1.5"
            >
              <span className="text-sm font-mono text-gray-700 dark:text-gray-300">
                {aliasText}
              </span>
              <button
                type="button"
                onClick={() => isLocalMode ? handleRemoveLocal(aliasText) : handleRemove(aliases[index])}
                className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 text-sm"
                title="Remove alias"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          No aliases configured
        </p>
      )}

      {/* Add new alias */}
      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            placeholder="e.g., STARBUCKS #*"
            value={newAlias}
            onChange={(e) => setNewAlias(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleAdd}
          disabled={!newAlias.trim() || isAdding}
        >
          {isAdding ? 'Adding...' : 'Add'}
        </Button>
      </div>
    </div>
  );
}
