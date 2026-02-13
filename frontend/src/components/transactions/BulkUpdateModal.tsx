'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { FormActions } from '@/components/ui/FormActions';
import { Combobox } from '@/components/ui/Combobox';
import { Select } from '@/components/ui/Select';
import { TransactionStatus, BulkUpdateData, BulkUpdateResult } from '@/types/transaction';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { buildCategoryTree } from '@/lib/categoryUtils';

interface BulkUpdateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: Partial<Pick<BulkUpdateData, 'payeeId' | 'payeeName' | 'categoryId' | 'description' | 'status'>>) => Promise<BulkUpdateResult>;
  selectionCount: number;
}

interface FieldToggle {
  payee: boolean;
  category: boolean;
  description: boolean;
  status: boolean;
}

export function BulkUpdateModal({
  isOpen,
  onClose,
  onSubmit,
  selectionCount,
}: BulkUpdateModalProps) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Field toggles
  const [enabled, setEnabled] = useState<FieldToggle>({
    payee: false,
    category: false,
    description: false,
    status: false,
  });

  // Field values
  const [selectedPayeeId, setSelectedPayeeId] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TransactionStatus>(TransactionStatus.UNRECONCILED);

  // Load data when modal opens
  useEffect(() => {
    if (isOpen) {
      Promise.all([
        categoriesApi.getAll(),
        payeesApi.getAll(),
      ]).then(([categoriesData, payeesData]) => {
        setCategories(categoriesData);
        setPayees(payeesData);
      });
    }
  }, [isOpen]);

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setEnabled({ payee: false, category: false, description: false, status: false });
      setSelectedPayeeId('');
      setPayeeName('');
      setSelectedCategoryId('');
      setDescription('');
      setStatus(TransactionStatus.UNRECONCILED);
    }
  }, [isOpen]);

  const categoryTree = useMemo(() => buildCategoryTree(categories), [categories]);

  const categoryOptions = useMemo(() =>
    categoryTree.map(({ category }) => {
      const parentCategory = category.parentId
        ? categories.find(c => c.id === category.parentId)
        : null;
      return {
        value: category.id,
        label: parentCategory ? `${parentCategory.name}: ${category.name}` : category.name,
      };
    }), [categoryTree, categories]);

  const payeeOptions = useMemo(() =>
    payees.map(payee => ({
      value: payee.id,
      label: payee.name,
    })), [payees]);

  const statusOptions = [
    { value: TransactionStatus.UNRECONCILED, label: 'Pending' },
    { value: TransactionStatus.CLEARED, label: 'Cleared' },
    { value: TransactionStatus.VOID, label: 'Void' },
  ];

  const toggleField = useCallback((field: keyof FieldToggle) => {
    setEnabled(prev => ({ ...prev, [field]: !prev[field] }));
  }, []);

  const handlePayeeChange = useCallback((payeeId: string, name: string) => {
    setSelectedPayeeId(payeeId);
    setPayeeName(name);
  }, []);

  const handlePayeeCreate = useCallback((name: string) => {
    setSelectedPayeeId('');
    setPayeeName(name);
  }, []);

  const handleCategoryChange = useCallback((categoryId: string, _name: string) => {
    setSelectedCategoryId(categoryId);
  }, []);

  const hasAnyEnabled = Object.values(enabled).some(Boolean);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasAnyEnabled) return;

    const updateData: Partial<Pick<BulkUpdateData, 'payeeId' | 'payeeName' | 'categoryId' | 'description' | 'status'>> = {};

    if (enabled.payee) {
      if (selectedPayeeId) {
        updateData.payeeId = selectedPayeeId;
      } else if (payeeName) {
        updateData.payeeName = payeeName;
      } else {
        // Clear payee
        updateData.payeeId = null;
        updateData.payeeName = null;
      }
    }

    if (enabled.category) {
      updateData.categoryId = selectedCategoryId || null;
    }

    if (enabled.description) {
      updateData.description = description || null;
    }

    if (enabled.status) {
      updateData.status = status;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(updateData);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Info notes about what gets skipped
  const showTransferNote = enabled.payee || enabled.category;
  const showSplitNote = enabled.category;

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="lg" className="p-6">
      <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-1">
        Bulk Update Transactions
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Update {selectionCount} selected transaction{selectionCount !== 1 ? 's' : ''}. Toggle the fields you want to change.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Payee field */}
          <TogglableField
            label="Payee"
            enabled={enabled.payee}
            onToggle={() => toggleField('payee')}
          >
            <Combobox
              placeholder="Select or type payee name..."
              options={payeeOptions}
              value={selectedPayeeId}
              onChange={handlePayeeChange}
              onCreateNew={handlePayeeCreate}
              allowCustomValue
            />
          </TogglableField>

          {/* Category field */}
          <TogglableField
            label="Category"
            enabled={enabled.category}
            onToggle={() => toggleField('category')}
          >
            <Combobox
              placeholder="Select category..."
              options={categoryOptions}
              value={selectedCategoryId}
              onChange={handleCategoryChange}
            />
          </TogglableField>

          {/* Description field */}
          <TogglableField
            label="Description"
            enabled={enabled.description}
            onToggle={() => toggleField('description')}
          >
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Enter description (leave empty to clear)"
              rows={2}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
            />
          </TogglableField>

          {/* Status field */}
          <TogglableField
            label="Status"
            enabled={enabled.status}
            onToggle={() => toggleField('status')}
          >
            <Select
              options={statusOptions}
              value={status}
              onChange={e => setStatus(e.target.value as TransactionStatus)}
            />
          </TogglableField>
        </div>

        {/* Info notes */}
        <div className="mt-4 space-y-1">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Reconciled transactions will be skipped.
          </p>
          {showTransferNote && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Transfer transactions will be skipped for payee/category changes.
            </p>
          )}
          {showSplitNote && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Split transactions will be skipped for category changes.
            </p>
          )}
        </div>

        <FormActions
          onCancel={onClose}
          submitLabel={`Update ${selectionCount} Transaction${selectionCount !== 1 ? 's' : ''}`}
          isSubmitting={isSubmitting}
          className={!hasAnyEnabled ? 'opacity-50 pointer-events-none' : ''}
        />
      </form>
    </Modal>
  );
}

function TogglableField({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border ${enabled ? 'border-blue-300 dark:border-blue-700 bg-blue-50/50 dark:bg-blue-900/10' : 'border-gray-200 dark:border-gray-700'} p-3`}>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 h-4 w-4"
        />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
      </label>
      {enabled && (
        <div className="mt-2">
          {children}
        </div>
      )}
    </div>
  );
}
