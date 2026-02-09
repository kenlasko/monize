'use client';

import { useState, useRef, useEffect } from 'react';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { CategoryMapping } from '@/lib/import';
import { Account } from '@/types/account';

interface CategoryMappingRowProps {
  mapping: CategoryMapping;
  categoryOptions: Array<{ value: string; label: string }>;
  parentCategoryOptions: Array<{ value: string; label: string }>;
  loanAccounts: Account[];
  onMappingChange: (update: Partial<CategoryMapping>) => void;
  formatCategoryPath: (path: string) => string;
  isHighlighted?: boolean;
}

export function CategoryMappingRow({
  mapping,
  categoryOptions,
  parentCategoryOptions,
  loanAccounts,
  onMappingChange,
  formatCategoryPath,
  isHighlighted = false,
}: CategoryMappingRowProps) {
  // Local state for inputs - only syncs on blur
  const [localCreateNew, setLocalCreateNew] = useState(mapping.createNew || '');
  const [localNewLoanName, setLocalNewLoanName] = useState(mapping.createNewLoan || '');
  const [localNewLoanAmount, setLocalNewLoanAmount] = useState(
    mapping.newLoanAmount?.toString() || ''
  );
  const [localNewLoanInstitution, setLocalNewLoanInstitution] = useState(
    mapping.newLoanInstitution || ''
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync from parent if mapping changes externally (e.g., reset)
  useEffect(() => {
    if (mapping.createNew !== undefined && mapping.createNew !== localCreateNew) {
      setLocalCreateNew(mapping.createNew || '');
    }
  }, [mapping.createNew]);

  useEffect(() => {
    if (mapping.createNewLoan !== undefined && mapping.createNewLoan !== localNewLoanName) {
      setLocalNewLoanName(mapping.createNewLoan || '');
    }
  }, [mapping.createNewLoan]);

  useEffect(() => {
    const mappingAmountStr = mapping.newLoanAmount?.toString() || '';
    if (mappingAmountStr !== localNewLoanAmount) {
      setLocalNewLoanAmount(mappingAmountStr);
    }
  }, [mapping.newLoanAmount]);

  useEffect(() => {
    if (mapping.newLoanInstitution !== undefined && mapping.newLoanInstitution !== localNewLoanInstitution) {
      setLocalNewLoanInstitution(mapping.newLoanInstitution || '');
    }
  }, [mapping.newLoanInstitution]);

  const handleCategorySelect = (categoryId: string) => {
    onMappingChange({
      categoryId: categoryId || undefined,
      createNew: undefined,
      parentCategoryId: undefined,
      isLoanCategory: false,
      loanAccountId: undefined,
      createNewLoan: undefined,
      newLoanAmount: undefined,
      newLoanInstitution: undefined,
    });
    setLocalCreateNew('');
    setLocalNewLoanName('');
    setLocalNewLoanAmount('');
    setLocalNewLoanInstitution('');
  };

  const handleCreateNewBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = (e.target.value ?? localCreateNew).trim();
    setLocalCreateNew(value);
    if (value !== (mapping.createNew || '')) {
      onMappingChange({
        categoryId: undefined,
        createNew: value || undefined,
        isLoanCategory: false,
        loanAccountId: undefined,
        createNewLoan: undefined,
        newLoanAmount: undefined,
        newLoanInstitution: undefined,
      });
    }
  };

  const handleParentCategorySelect = (parentCategoryId: string) => {
    onMappingChange({
      parentCategoryId: parentCategoryId || undefined,
    });
  };

  const handleIsLoanChange = (checked: boolean) => {
    // Use the category name (last segment if nested) as default loan name
    const parts = mapping.originalName.split(':');
    const suggestedName = parts[parts.length - 1].trim();
    onMappingChange({
      isLoanCategory: checked,
      // Clear category fields when switching to loan
      categoryId: checked ? undefined : mapping.categoryId,
      createNew: checked ? undefined : mapping.createNew,
      parentCategoryId: checked ? undefined : mapping.parentCategoryId,
      // Pre-fill or clear loan fields
      loanAccountId: undefined,
      createNewLoan: checked ? suggestedName : undefined,
      newLoanAmount: undefined,
      newLoanInstitution: undefined,
    });
    if (checked) {
      setLocalCreateNew('');
      setLocalNewLoanName(suggestedName);
    } else {
      setLocalNewLoanName('');
      setLocalNewLoanAmount('');
      setLocalNewLoanInstitution('');
    }
  };

  const handleLoanAccountSelect = (accountId: string) => {
    onMappingChange({
      loanAccountId: accountId || undefined,
      createNewLoan: undefined,
      newLoanAmount: undefined,
      newLoanInstitution: undefined,
    });
    setLocalNewLoanName('');
    setLocalNewLoanAmount('');
    setLocalNewLoanInstitution('');
  };

  const handleNewLoanNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = (e.target.value ?? localNewLoanName).trim();
    setLocalNewLoanName(value);
    if (value !== (mapping.createNewLoan || '')) {
      onMappingChange({
        loanAccountId: undefined,
        createNewLoan: value || undefined,
      });
    }
  };

  const handleNewLoanAmountBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const raw = (e.target.value ?? localNewLoanAmount).trim();
    // Strip currency symbols, commas, and whitespace so pasted values like "$25,000" work
    const cleaned = raw.replace(/[$€£¥,\s]/g, '');
    setLocalNewLoanAmount(cleaned);
    const numValue = cleaned ? parseFloat(cleaned) : undefined;
    if (numValue !== mapping.newLoanAmount) {
      onMappingChange({
        newLoanAmount: numValue,
      });
    }
  };

  const handleNewLoanInstitutionBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = (e.target.value ?? localNewLoanInstitution).trim();
    setLocalNewLoanInstitution(value);
    if (value !== (mapping.newLoanInstitution || '')) {
      onMappingChange({
        newLoanInstitution: value || undefined,
      });
    }
  };

  // Show parent selector if local input has content (immediate feedback)
  const showParentSelector = localCreateNew.trim().length > 0;

  // Build loan account options
  const loanAccountOptions = [
    { value: '', label: 'Select existing loan...' },
    ...loanAccounts.map((account) => ({
      value: account.id,
      label: `${account.name}${account.institution ? ` (${account.institution})` : ''}`,
    })),
  ];

  // Get display name for matched loan
  const getMatchedLoanName = () => {
    if (mapping.loanAccountId) {
      const account = loanAccounts.find(a => a.id === mapping.loanAccountId);
      return account?.name || 'Unknown';
    }
    if (mapping.createNewLoan) {
      return `${mapping.createNewLoan} (new)`;
    }
    return 'Unknown';
  };

  return (
    <div
      className={
        isHighlighted
          ? 'border-2 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-4'
          : 'border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded-lg p-3'
      }
    >
      {isHighlighted ? (
        <>
          <div className="flex items-center justify-between mb-2">
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {formatCategoryPath(mapping.originalName)}
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={mapping.isLoanCategory || false}
                onChange={(e) => handleIsLoanChange(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              This is a loan payment
            </label>
          </div>

          {mapping.isLoanCategory ? (
            // Loan mapping UI
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Transactions with this category will be transferred to the selected loan account.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Select
                  label="Select existing loan"
                  options={loanAccountOptions}
                  value={mapping.loanAccountId || ''}
                  onChange={(e) => handleLoanAccountSelect(e.target.value)}
                />
                {!mapping.loanAccountId && (
                  <div className="space-y-2">
                    <Input
                      label="Or create new loan"
                      placeholder="Loan account name"
                      value={localNewLoanName}
                      onChange={(e) => setLocalNewLoanName(e.target.value)}
                      onBlur={handleNewLoanNameBlur}
                    />
                    <Input
                      label="Institution"
                      placeholder="e.g., TD Bank, RBC"
                      value={localNewLoanInstitution}
                      onChange={(e) => setLocalNewLoanInstitution(e.target.value)}
                      onBlur={handleNewLoanInstitutionBlur}
                    />
                    <Input
                      label="Initial loan amount"
                      inputMode="decimal"
                      placeholder="e.g., 25000"
                      value={localNewLoanAmount}
                      onChange={(e) => setLocalNewLoanAmount(e.target.value)}
                      onBlur={handleNewLoanAmountBlur}
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Enter the original loan principal amount
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Standard category mapping UI
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select
                label="Map to existing"
                options={categoryOptions}
                value={mapping.categoryId || ''}
                onChange={(e) => handleCategorySelect(e.target.value)}
              />
              <div>
                <Input
                  ref={inputRef}
                  label="Or create new"
                  placeholder="New category name"
                  value={localCreateNew}
                  onChange={(e) => setLocalCreateNew(e.target.value)}
                  onBlur={handleCreateNewBlur}
                />
                {showParentSelector && (
                  <div className="mt-2">
                    <Select
                      label="Parent category"
                      options={parentCategoryOptions}
                      value={mapping.parentCategoryId || ''}
                      onChange={(e) => handleParentCategorySelect(e.target.value)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        // Compact view for auto-matched categories
        <div className="flex items-center gap-3">
          <span className="font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap min-w-[200px]">
            {formatCategoryPath(mapping.originalName)}
          </span>
          <span className="text-gray-400">→</span>
          {mapping.isLoanCategory ? (
            <span className="text-blue-600 dark:text-blue-400 flex-1">
              Loan: {getMatchedLoanName()}
            </span>
          ) : (
            <Select
              options={categoryOptions}
              value={mapping.categoryId || ''}
              onChange={(e) => handleCategorySelect(e.target.value)}
              className="flex-1"
            />
          )}
        </div>
      )}
    </div>
  );
}
