'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { CategoryMapping } from '@/lib/import';
import { parseLocaleNumber } from '@/lib/number-parse';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { Account } from '@/types/account';
import { accountSelectOption } from '@/lib/account-utils';
import { AccountSelect } from '@/components/accounts/shared/AccountSelect';

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
  const t = useTranslations('import');
  const { numberSeparators } = useNumberFormat();
  // Local state for inputs - only syncs on blur
  const [localCreateNew, setLocalCreateNew] = useState(mapping.createNew || '');
  const [localNewLoanName, setLocalNewLoanName] = useState(mapping.createNewLoan || '');
  const [localNewLoanAmount, setLocalNewLoanAmount] = useState(
    mapping.newLoanAmount?.toString() || ''
  );
  const [localNewLoanInstitution, setLocalNewLoanInstitution] = useState(
    mapping.newLoanInstitution || ''
  );
  const [localNewParentName, setLocalNewParentName] = useState(
    mapping.createNewParentCategoryName || ''
  );
  const [isCreatingNewParent, setIsCreatingNewParent] = useState(
    !!mapping.createNewParentCategoryName
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync from parent if mapping changes externally (e.g., reset)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from parent props
  useEffect(() => { setLocalCreateNew(mapping.createNew || ''); }, [mapping.createNew]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from parent props
  useEffect(() => { setLocalNewLoanName(mapping.createNewLoan || ''); }, [mapping.createNewLoan]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from parent props
  useEffect(() => { setLocalNewLoanAmount(mapping.newLoanAmount?.toString() || ''); }, [mapping.newLoanAmount]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from parent props
  useEffect(() => { setLocalNewLoanInstitution(mapping.newLoanInstitution || ''); }, [mapping.newLoanInstitution]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from parent props
  useEffect(() => { setLocalNewParentName(mapping.createNewParentCategoryName || ''); }, [mapping.createNewParentCategoryName]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from parent props
  useEffect(() => { setIsCreatingNewParent(!!mapping.createNewParentCategoryName); }, [mapping.createNewParentCategoryName]);

  const handleCategorySelect = (categoryId: string) => {
    onMappingChange({
      categoryId: categoryId || undefined,
      createNew: undefined,
      parentCategoryId: undefined,
      createNewParentCategoryName: undefined,
      isLoanCategory: false,
      loanAccountId: undefined,
      createNewLoan: undefined,
      newLoanType: undefined,
      newLoanAmount: undefined,
      newLoanInstitution: undefined,
    });
    setLocalCreateNew('');
    setLocalNewLoanName('');
    setLocalNewLoanAmount('');
    setLocalNewLoanInstitution('');
    setLocalNewParentName('');
    setIsCreatingNewParent(false);
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
        newLoanType: undefined,
        newLoanAmount: undefined,
        newLoanInstitution: undefined,
      });
    }
  };

  const handleParentCategorySelect = (value: string) => {
    if (value === '__create_new__') {
      setIsCreatingNewParent(true);
      onMappingChange({
        parentCategoryId: undefined,
        createNewParentCategoryName: localNewParentName || undefined,
      });
    } else {
      setIsCreatingNewParent(false);
      setLocalNewParentName('');
      onMappingChange({
        parentCategoryId: value || undefined,
        createNewParentCategoryName: undefined,
      });
    }
  };

  const handleNewParentNameBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = (e.target.value ?? localNewParentName).trim();
    setLocalNewParentName(value);
    if (value !== (mapping.createNewParentCategoryName || '')) {
      onMappingChange({
        parentCategoryId: undefined,
        createNewParentCategoryName: value || undefined,
      });
    }
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
      newLoanType: checked ? 'LOAN' : undefined,
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
      newLoanType: undefined,
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
    // parseLocaleNumber drops currency symbols and grouping, so "$25,000" and "25.000,00" (de) both work
    const numValue = parseLocaleNumber(raw, numberSeparators);
    setLocalNewLoanAmount(
      numValue === undefined ? '' : String(numValue).replace('.', numberSeparators.decimal),
    );
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
    { value: '', label: t('mapCategories.selectExistingLoanPlaceholder') },
    ...loanAccounts.map((account) =>
      accountSelectOption(
        account,
        `${account.name}${account.institution ? ` (${account.institution})` : ''}`,
      ),
    ),
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
              {t('mapCategories.isLoanPayment')}
            </label>
          </div>

          {mapping.isLoanCategory ? (
            // Loan mapping UI
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t('mapCategories.loanTransferNotice')}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <AccountSelect
                  label={t('mapCategories.selectExistingLoan')}
                  options={loanAccountOptions}
                  value={mapping.loanAccountId || ''}
                  onChange={(e) => handleLoanAccountSelect(e.target.value)}
                />
                {!mapping.loanAccountId && (
                  <div className="space-y-2">
                    <Input
                      label={t('mapCategories.orCreateNewLoan')}
                      placeholder={t('mapCategories.loanAccountNamePlaceholder')}
                      value={localNewLoanName}
                      onChange={(e) => setLocalNewLoanName(e.target.value)}
                      onBlur={handleNewLoanNameBlur}
                    />
                    <Select
                      label={t('mapCategories.loanType')}
                      value={mapping.newLoanType || 'LOAN'}
                      onChange={(e) =>
                        onMappingChange({
                          newLoanType: e.target.value as 'LOAN' | 'MORTGAGE',
                        })
                      }
                      options={[
                        { value: 'LOAN', label: t('mapCategories.loanTypeLoan') },
                        { value: 'MORTGAGE', label: t('mapCategories.loanTypeMortgage') },
                      ]}
                    />
                    <Input
                      label={t('mapCategories.institution')}
                      placeholder={t('mapCategories.institutionPlaceholder')}
                      value={localNewLoanInstitution}
                      onChange={(e) => setLocalNewLoanInstitution(e.target.value)}
                      onBlur={handleNewLoanInstitutionBlur}
                    />
                    <Input
                      label={t('mapCategories.initialLoanAmount')}
                      inputMode="decimal"
                      placeholder={t('mapCategories.initialLoanAmountPlaceholder')}
                      value={localNewLoanAmount}
                      onChange={(e) => setLocalNewLoanAmount(e.target.value)}
                      onBlur={handleNewLoanAmountBlur}
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t('mapCategories.originalLoanPrincipalHelp')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Standard category mapping UI
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select
                label={t('mapCategories.mapToExisting')}
                options={categoryOptions}
                value={mapping.categoryId || ''}
                onChange={(e) => handleCategorySelect(e.target.value)}
              />
              <div>
                <Input
                  ref={inputRef}
                  label={t('mapCategories.orCreateNew')}
                  placeholder={t('mapCategories.newCategoryNamePlaceholder')}
                  value={localCreateNew}
                  onChange={(e) => setLocalCreateNew(e.target.value)}
                  onBlur={handleCreateNewBlur}
                />
                {showParentSelector && (
                  <div className="mt-2">
                    <Select
                      label={t('mapCategories.parentCategory')}
                      options={[
                        ...parentCategoryOptions,
                        { value: '__create_new__', label: t('mapCategories.createNewParent') },
                      ]}
                      value={isCreatingNewParent ? '__create_new__' : (mapping.parentCategoryId || '')}
                      onChange={(e) => handleParentCategorySelect(e.target.value)}
                    />
                    {isCreatingNewParent && (
                      <div className="mt-2">
                        <Input
                          label={t('mapCategories.newParentCategoryName')}
                          placeholder={t('mapCategories.newParentCategoryPlaceholder')}
                          value={localNewParentName}
                          onChange={(e) => setLocalNewParentName(e.target.value)}
                          onBlur={handleNewParentNameBlur}
                        />
                      </div>
                    )}
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
          <span className="text-gray-400">{t('mapCategories.arrow')}</span>
          {mapping.isLoanCategory ? (
            <span className="text-blue-600 dark:text-blue-400 flex-1">
              {t('mapCategories.loanPrefix')} {getMatchedLoanName()}
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
