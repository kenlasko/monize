'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/Modal';
import { Combobox } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Institution } from '@/types/institution';
import { Account } from '@/types/account';
import { institutionsApi } from '@/lib/institutions';
import { accountsApi } from '@/lib/accounts';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { isInvestmentCashHalf, getMainAccountName } from '@/lib/account-utils';
import { InstitutionLogo } from './InstitutionLogo';

const logger = createLogger('InstitutionAccountsManager');

interface InstitutionAccountsManagerProps {
  institution: Institution | null;
  isOpen: boolean;
  onClose: () => void;
  /** Notified after an account is added or removed so counts can refresh. */
  onChanged?: () => void;
}

export function InstitutionAccountsManager({
  institution,
  isOpen,
  onClose,
  onChanged,
}: InstitutionAccountsManagerProps) {
  const t = useTranslations('institutions');
  const router = useRouter();
  const [assigned, setAssigned] = useState<Account[]>([]);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [filterStatus, setFilterStatus] = useState<'active' | 'closed' | ''>('');

  const load = useCallback(async () => {
    if (!institution) return;
    setIsLoading(true);
    try {
      const [assignedData, all] = await Promise.all([
        institutionsApi.getAccounts(institution.id),
        accountsApi.getAll(true),
      ]);
      setAssigned(assignedData);
      setAllAccounts(all);
    } catch (error) {
      toast.error(getErrorMessage(error, t('accountsManager.loadFailed')));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [institution, t]);

  useEffect(() => {
    if (isOpen && institution) {
      load();
    }
  }, [isOpen, institution, load]);

  const assignedIds = useMemo(
    () => new Set(assigned.map((a) => a.id)),
    [assigned],
  );

  // Collapse a linked brokerage/cash investment pair into a single entity by
  // dropping the cash half; assigning or removing the brokerage carries its
  // partner along, so only the main account is shown.
  const assignedMain = useMemo(
    () => assigned.filter((a) => !isInvestmentCashHalf(a)),
    [assigned],
  );

  // Apply the active/closed status filter to the collapsed account list.
  const visibleAccounts = useMemo(() => {
    if (!filterStatus) return assignedMain;
    return assignedMain.filter((a) =>
      filterStatus === 'active' ? !a.isClosed : a.isClosed,
    );
  }, [assignedMain, filterStatus]);

  const availableOptions = useMemo(
    () =>
      allAccounts
        .filter((a) => !assignedIds.has(a.id) && !isInvestmentCashHalf(a))
        .map((a) => ({ value: a.id, label: getMainAccountName(a.name) })),
    [allAccounts, assignedIds],
  );

  // Close the modal and jump to the Transactions page filtered to the account.
  const handleViewTransactions = (accountId: string) => {
    onClose();
    router.push(`/transactions?accountId=${accountId}`);
  };

  const handleAdd = async (accountId: string) => {
    if (!institution || !accountId) return;
    setBusyId(accountId);
    try {
      await institutionsApi.assignAccount(institution.id, accountId);
      setSelectedAccountId('');
      await load();
      onChanged?.();
      toast.success(t('accountsManager.added'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('accountsManager.addFailed')));
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (accountId: string) => {
    if (!institution) return;
    setBusyId(accountId);
    try {
      await institutionsApi.unassignAccount(institution.id, accountId);
      await load();
      onChanged?.();
      toast.success(t('accountsManager.removed'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('accountsManager.removeFailed')));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="lg" className="p-6">
      <div className="flex items-center gap-3 mb-4">
        <InstitutionLogo institution={institution ?? undefined} size={32} fallbackGlyph="$" />
        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 truncate">
          {institution
            ? t('accountsManager.title', { name: institution.name })
            : ''}
        </h2>
      </div>

      {isLoading ? (
        <LoadingSpinner text={t('accountsManager.loading')} />
      ) : assignedMain.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
          {t('accountsManager.empty')}
        </p>
      ) : (
        <>
          {/* Active/Closed status filter */}
          <div className="mb-3 inline-flex rounded-md shadow-sm">
            <button
              type="button"
              onClick={() => setFilterStatus('')}
              className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                filterStatus === ''
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('accountsManager.filter.all')}
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('active')}
              className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                filterStatus === 'active'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('accountsManager.filter.active')}
            </button>
            <button
              type="button"
              onClick={() => setFilterStatus('closed')}
              className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                filterStatus === 'closed'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
              }`}
            >
              {t('accountsManager.filter.closed')}
            </button>
          </div>

          {visibleAccounts.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
              {t('accountsManager.noneMatch')}
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-md">
              {visibleAccounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between px-3 py-2 gap-3"
                >
                  <button
                    type="button"
                    onClick={() => handleViewTransactions(account.id)}
                    title={t('accountsManager.viewTransactions')}
                    className="text-sm text-left text-blue-600 dark:text-blue-400 hover:underline truncate"
                  >
                    {getMainAccountName(account.name)}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === account.id}
                    onClick={() => handleRemove(account.id)}
                  >
                    {t('accountsManager.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
        <Combobox
          label={t('accountsManager.addLabel')}
          placeholder={t('accountsManager.addPlaceholder')}
          options={availableOptions}
          value={selectedAccountId}
          usePortal
          openOnFocus={false}
          onChange={(value) => {
            if (value) handleAdd(value);
          }}
        />
        {availableOptions.length === 0 && !isLoading && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t('accountsManager.noneToAdd')}
          </p>
        )}
      </div>

      <div className="mt-6 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          {t('accountsManager.done')}
        </Button>
      </div>
    </Modal>
  );
}
