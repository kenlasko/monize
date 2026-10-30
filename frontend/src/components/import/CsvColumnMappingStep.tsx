'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { CsvTransferRules } from './CsvTransferRules';
import { ImportStep } from '@/app/import/import-utils';
import {
  CsvColumnMappingConfig,
  CsvTransferRule,
  SavedColumnMapping,
  DATE_FORMAT_OPTIONS,
  detectCsvDateFormat,
  CANONICAL_INVESTMENT_ACTIONS,
  DEFAULT_INVESTMENT_ACTION_KEYWORDS,
  CanonicalInvestmentAction,
  classifyCsvActionValue,
} from '@/lib/import';
import { Account } from '@/types/account';

interface CsvColumnMappingStepProps {
  headers: string[];
  sampleRows: string[][];
  columnMapping: CsvColumnMappingConfig;
  onColumnMappingChange: (mapping: CsvColumnMappingConfig) => void;
  onInvestmentModeChange: (enabled: boolean) => void;
  transferRules: CsvTransferRule[];
  onTransferRulesChange: (rules: CsvTransferRule[]) => void;
  accounts: Account[];
  savedMappings: SavedColumnMapping[];
  onSaveMapping: (name: string) => void;
  onLoadMapping: (mapping: SavedColumnMapping) => void;
  onDeleteMapping: (id: string) => void;
  onDelimiterChange: (delimiter: string) => void;
  onHasHeaderChange: (hasHeader: boolean) => void;
  isLoading: boolean;
  onNext: () => void;
  setStep: (step: ImportStep) => void;
}

const CUSTOM_FORMAT_VALUE = '__custom__';

const DELIMITER_OPTIONS = [
  { value: ',', labelKey: 'csvMapping.delimiters.comma' },
  { value: ';', labelKey: 'csvMapping.delimiters.semicolon' },
  { value: '\t', labelKey: 'csvMapping.delimiters.tab' },
];

type AmountMode = 'single' | 'split';

export function CsvColumnMappingStep({
  headers,
  sampleRows,
  columnMapping,
  onColumnMappingChange,
  onInvestmentModeChange,
  transferRules,
  onTransferRulesChange,
  accounts,
  savedMappings,
  onSaveMapping,
  onLoadMapping,
  onDeleteMapping,
  onDelimiterChange,
  onHasHeaderChange,
  isLoading,
  onNext,
  setStep,
}: CsvColumnMappingStepProps) {
  const t = useTranslations('import');
  const tc = useTranslations('common');
  const [amountMode, setAmountMode] = useState<AmountMode>(
    columnMapping.debit !== undefined || columnMapping.credit !== undefined ? 'split' : 'single'
  );
  const investmentMode = columnMapping.investmentMode === true;
  const [showActionKeywords, setShowActionKeywords] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [saveName, setSaveName] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);
  // Auto-detect date format from sample data on first render
  const [autoDetectedFormat] = useState(() => {
    if (sampleRows.length === 0) return null;
    const dateColIndex = columnMapping.date;
    if (dateColIndex === undefined || dateColIndex < 0) return null;
    const sampleDates = sampleRows.map((row) => row[dateColIndex] || '').filter(Boolean);
    return detectCsvDateFormat(sampleDates);
  });

  const effectiveDateFormat = autoDetectedFormat || columnMapping.dateFormat;
  const [customModeActive, setCustomModeActive] = useState(false);
  const isCustom = customModeActive || (!DATE_FORMAT_OPTIONS.some((o) => o.value === effectiveDateFormat) && effectiveDateFormat !== '');
  const [customFormat, setCustomFormat] = useState(isCustom ? effectiveDateFormat : '');
  const autoDetectedRef = useRef(false);

  // Apply auto-detected format once via parent callback
  useEffect(() => {
    if (autoDetectedRef.current) return;
    if (autoDetectedFormat && autoDetectedFormat !== columnMapping.dateFormat) {
      autoDetectedRef.current = true;
      onColumnMappingChange({ ...columnMapping, dateFormat: autoDetectedFormat });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDetectedFormat]);

  const columnOptions = [
    { value: '', label: t('csvMapping.notMapped') },
    ...headers.map((h, i) => ({
      value: String(i),
      label: columnMapping.hasHeader && h
        ? t('csvMapping.colWithHeader', { header: h, n: i + 1 })
        : t('csvMapping.colLabel', { n: i + 1 }),
    })),
  ];

  const updateMapping = (field: string, value: string) => {
    const numValue = value === '' ? undefined : parseInt(value, 10);
    onColumnMappingChange({ ...columnMapping, [field]: numValue });
  };

  const handleAmountModeChange = (mode: AmountMode) => {
    setAmountMode(mode);
    if (mode === 'single') {
      onColumnMappingChange({ ...columnMapping, debit: undefined, credit: undefined });
    } else {
      onColumnMappingChange({ ...columnMapping, amount: undefined });
    }
  };

  const handleNext = () => {
    if (columnMapping.date === undefined) {
      setValidationError(t('csvMapping.validationDateRequired'));
      return;
    }
    if (amountMode === 'single' && columnMapping.amount === undefined) {
      setValidationError(t('csvMapping.validationAmountRequired'));
      return;
    }
    if (amountMode === 'split' && (columnMapping.debit === undefined || columnMapping.credit === undefined)) {
      setValidationError(t('csvMapping.validationDebitCreditRequired'));
      return;
    }
    if (investmentMode && columnMapping.actionColumn === undefined) {
      setValidationError(t('csvMapping.validationActionRequired'));
      return;
    }
    if (investmentMode && columnMapping.securityColumn === undefined) {
      setValidationError(t('csvMapping.validationSecurityRequired'));
      return;
    }
    setValidationError('');
    onNext();
  };

  const actionColumnValues = investmentMode && columnMapping.actionColumn !== undefined
    ? [...new Set(sampleRows.map((row) => (row[columnMapping.actionColumn!] || '').trim()).filter(Boolean))]
    : [];
  const unmatchedActionValues = actionColumnValues.filter(
    (v) => classifyCsvActionValue(v, columnMapping.actionKeywords) === null,
  );

  const handleActionKeywordsChange = (action: CanonicalInvestmentAction, text: string) => {
    const values = text.split(',').map((v) => v.trim()).filter(Boolean);
    const next = { ...(columnMapping.actionKeywords || {}) };
    if (values.length > 0) {
      next[action] = values;
    } else {
      delete next[action];
    }
    onColumnMappingChange({
      ...columnMapping,
      actionKeywords: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  const handleSave = () => {
    if (saveName.trim()) {
      onSaveMapping(saveName.trim());
      setSaveName('');
      setShowSaveInput(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('csvMapping.heading')}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          {t('csvMapping.description')}
        </p>

        {/* Options Bar */}
        <div className="flex flex-wrap gap-4 mb-6 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={columnMapping.hasHeader}
              onChange={(e) => onHasHeaderChange(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            {t('csvMapping.firstRowIsHeader')}
          </label>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700 dark:text-gray-300">{t('csvMapping.delimiterLabel')}</label>
            <select
              value={columnMapping.delimiter}
              onChange={(e) => onDelimiterChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              {DELIMITER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700 dark:text-gray-300">{t('csvMapping.dateFormatLabel')}</label>
            <select
              value={isCustom ? CUSTOM_FORMAT_VALUE : columnMapping.dateFormat}
              onChange={(e) => {
                const val = e.target.value;
                if (val === CUSTOM_FORMAT_VALUE) {
                  setCustomModeActive(true);
                  if (customFormat) {
                    onColumnMappingChange({ ...columnMapping, dateFormat: customFormat });
                  }
                } else {
                  setCustomModeActive(false);
                  setCustomFormat('');
                  onColumnMappingChange({ ...columnMapping, dateFormat: val });
                }
              }}
              className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              {DATE_FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
              <option value={CUSTOM_FORMAT_VALUE}>{t('csvMapping.customOption')}</option>
            </select>
            {isCustom && (
              <input
                type="text"
                value={customFormat}
                onChange={(e) => {
                  setCustomFormat(e.target.value);
                  if (e.target.value) {
                    onColumnMappingChange({ ...columnMapping, dateFormat: e.target.value });
                  }
                }}
                placeholder={t('csvMapping.customPlaceholder')}
                className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-36"
              />
            )}
          </div>
        </div>

        {/* Data Preview */}
        {sampleRows.length > 0 && (
          <div className="mb-6 overflow-x-auto">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">{t('csvMapping.dataPreview')}</h3>
            <table className="min-w-full text-xs border border-gray-200 dark:border-gray-600">
              <thead>
                <tr className="bg-gray-100 dark:bg-gray-700">
                  {headers.map((h, i) => (
                    <th key={i} className="px-2 py-1 text-left border-r border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300">
                      {columnMapping.hasHeader && h ? h : `Col ${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.slice(0, 5).map((row, ri) => (
                  <tr key={ri} className="border-t border-gray-200 dark:border-gray-600">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-2 py-1 border-r border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-400 max-w-[200px] truncate">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Column Mapping */}
        <div className="mb-6 space-y-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('csvMapping.columnMappingTitle')}</h3>

          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.kindField')}</label>
            <select
              value={investmentMode ? 'investment' : 'banking'}
              onChange={(e) => onInvestmentModeChange(e.target.value === 'investment')}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              <option value="banking">{t('csvMapping.kindBanking')}</option>
              <option value="investment">{t('csvMapping.kindInvestment')}</option>
            </select>
            {investmentMode && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('csvMapping.investmentModeHint')}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.dateField')}</label>
              <select
                value={columnMapping.date !== undefined ? String(columnMapping.date) : ''}
                onChange={(e) => onColumnMappingChange({ ...columnMapping, date: parseInt(e.target.value, 10) })}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                {columnOptions.filter((o) => o.value !== '').map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.amountTypeField')}</label>
              <select
                value={amountMode}
                onChange={(e) => handleAmountModeChange(e.target.value as AmountMode)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                <option value="single">{t('csvMapping.singleAmountOption')}</option>
                <option value="split">{t('csvMapping.splitAmountOption')}</option>
              </select>
            </div>
          </div>

          {amountMode === 'single' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.amountField')}</label>
                <select
                  value={columnMapping.amount !== undefined ? String(columnMapping.amount) : ''}
                  onChange={(e) => updateMapping('amount', e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  {columnOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              {!investmentMode && (
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.signField')}</label>
                <select
                  value={columnMapping.amountTypeColumn !== undefined ? 'type-column' : columnMapping.reverseSign ? 'reverse' : 'normal'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'type-column') {
                      // Clear reverseSign, default to first column
                      const { reverseSign: _, ...rest } = columnMapping;
                      onColumnMappingChange({ ...rest, amountTypeColumn: 0 } as typeof columnMapping);
                    } else if (val === 'reverse') {
                      // Clear all type column fields
                      const { amountTypeColumn: _, incomeValues: _i, expenseValues: _e, transferOutValues: _to, transferInValues: _ti, transferAccountColumn: _ta, ...rest } = columnMapping;
                      onColumnMappingChange({ ...rest, reverseSign: true } as typeof columnMapping);
                    } else {
                      // Normal: clear reverseSign and all type column fields
                      const { reverseSign: _, amountTypeColumn: _a, incomeValues: _i, expenseValues: _e, transferOutValues: _to, transferInValues: _ti, transferAccountColumn: _ta, ...rest } = columnMapping;
                      onColumnMappingChange(rest as typeof columnMapping);
                    }
                  }}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  <option value="normal">{t('csvMapping.signNormal')}</option>
                  <option value="reverse">{t('csvMapping.signReverse')}</option>
                  <option value="type-column">{t('csvMapping.signTypeColumn')}</option>
                </select>
              </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.debitField')}</label>
                <select
                  value={columnMapping.debit !== undefined ? String(columnMapping.debit) : ''}
                  onChange={(e) => updateMapping('debit', e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  {columnOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.creditField')}</label>
                <select
                  value={columnMapping.credit !== undefined ? String(columnMapping.credit) : ''}
                  onChange={(e) => updateMapping('credit', e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  {columnOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Transaction type column settings (shown when Sign = "Use transaction type column") */}
          {columnMapping.amountTypeColumn !== undefined && amountMode === 'single' && (
            <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('csvMapping.typeColumnTitle')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  {t('csvMapping.typeColumnDescription')}
                </p>
                <select
                  value={String(columnMapping.amountTypeColumn)}
                  onChange={(e) => {
                    const val = e.target.value;
                    onColumnMappingChange({ ...columnMapping, amountTypeColumn: parseInt(val, 10) });
                  }}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  {columnOptions.filter((o) => o.value !== '').map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              {(() => {
                const uniqueValues = [...new Set(
                  sampleRows.map((row) => row[columnMapping.amountTypeColumn!] || '').filter(Boolean)
                )];
                return uniqueValues.length > 0 ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t('csvMapping.valuesFound', { values: uniqueValues.join(', ') })}
                  </p>
                ) : null;
              })()}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.incomeKeywords')}</label>
                  <input
                    type="text"
                    value={(columnMapping.incomeValues || []).join(', ')}
                    onChange={(e) => {
                      const values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                      onColumnMappingChange({ ...columnMapping, incomeValues: values.length > 0 ? values : undefined });
                    }}
                    placeholder={t('csvMapping.incomeKeywordsPlaceholder')}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.expenseKeywords')}</label>
                  <input
                    type="text"
                    value={(columnMapping.expenseValues || []).join(', ')}
                    onChange={(e) => {
                      const values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                      onColumnMappingChange({ ...columnMapping, expenseValues: values.length > 0 ? values : undefined });
                    }}
                    placeholder={t('csvMapping.expenseKeywordsPlaceholder')}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.transferOutKeywords')}</label>
                  <input
                    type="text"
                    value={(columnMapping.transferOutValues || []).join(', ')}
                    onChange={(e) => {
                      const values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                      onColumnMappingChange({ ...columnMapping, transferOutValues: values.length > 0 ? values : undefined });
                    }}
                    placeholder={t('csvMapping.transferOutKeywordsPlaceholder')}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.transferInKeywords')}</label>
                  <input
                    type="text"
                    value={(columnMapping.transferInValues || []).join(', ')}
                    onChange={(e) => {
                      const values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                      onColumnMappingChange({ ...columnMapping, transferInValues: values.length > 0 ? values : undefined });
                    }}
                    placeholder={t('csvMapping.transferInKeywordsPlaceholder')}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.transferAccountColumn')}</label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {t('csvMapping.transferAccountColumnDesc')}
                </p>
                <select
                  value={columnMapping.transferAccountColumn !== undefined ? String(columnMapping.transferAccountColumn) : ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') {
                      const { transferAccountColumn: _, ...rest } = columnMapping;
                      onColumnMappingChange(rest as typeof columnMapping);
                    } else {
                      onColumnMappingChange({ ...columnMapping, transferAccountColumn: parseInt(val, 10) });
                    }
                  }}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  {columnOptions.map((o) => (
                    <option key={o.value} value={o.value}>{o.value === '' ? t('csvMapping.useCategoryColumn') : o.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {investmentMode && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.actionField')}</label>
                  <select
                    value={columnMapping.actionColumn !== undefined ? String(columnMapping.actionColumn) : ''}
                    onChange={(e) => updateMapping('actionColumn', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    {columnOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.securityField')}</label>
                  <select
                    value={columnMapping.securityColumn !== undefined ? String(columnMapping.securityColumn) : ''}
                    onChange={(e) => updateMapping('securityColumn', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    {columnOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.quantityField')}</label>
                  <select
                    value={columnMapping.quantityColumn !== undefined ? String(columnMapping.quantityColumn) : ''}
                    onChange={(e) => updateMapping('quantityColumn', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    {columnOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.priceField')}</label>
                  <select
                    value={columnMapping.priceColumn !== undefined ? String(columnMapping.priceColumn) : ''}
                    onChange={(e) => updateMapping('priceColumn', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    {columnOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.commissionField')}</label>
                  <select
                    value={columnMapping.commissionColumn !== undefined ? String(columnMapping.commissionColumn) : ''}
                    onChange={(e) => updateMapping('commissionColumn', e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  >
                    {columnOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {actionColumnValues.length > 0 && (
                <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                  <p>{t('csvMapping.actionValuesFound', { values: actionColumnValues.join(', ') })}</p>
                  {unmatchedActionValues.length > 0 && (
                    <p className="text-amber-600 dark:text-amber-400">
                      {t('csvMapping.actionValuesUnmatched', { values: unmatchedActionValues.join(', ') })}
                    </p>
                  )}
                </div>
              )}

              <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg space-y-3">
                <button
                  type="button"
                  onClick={() => setShowActionKeywords((prev) => !prev)}
                  className="text-xs font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
                >
                  {showActionKeywords ? t('csvMapping.actionKeywordsHide') : t('csvMapping.actionKeywordsShow')}
                </button>
                {showActionKeywords && (
                  <>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t('csvMapping.actionKeywordsDescription')}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      {CANONICAL_INVESTMENT_ACTIONS.map((action) => (
                        <div key={action}>
                          <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                            {t(`csvMapping.actionNames.${action}` as Parameters<typeof t>[0])}
                          </label>
                          <input
                            type="text"
                            value={(columnMapping.actionKeywords?.[action] || []).join(', ')}
                            onChange={(e) => handleActionKeywordsChange(action, e.target.value)}
                            placeholder={DEFAULT_INVESTMENT_ACTION_KEYWORDS[action].join(', ')}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                          />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.payeeField')}</label>
            <select
              value={columnMapping.payee !== undefined ? String(columnMapping.payee) : ''}
              onChange={(e) => updateMapping('payee', e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              {columnOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {!investmentMode && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.categoryField')}</label>
              <select
                value={columnMapping.category !== undefined ? String(columnMapping.category) : ''}
                onChange={(e) => updateMapping('category', e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                {columnOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.subcategoryField')}</label>
              <select
                value={columnMapping.subcategory !== undefined ? String(columnMapping.subcategory) : ''}
                onChange={(e) => updateMapping('subcategory', e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                {columnOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.memoField')}</label>
              <select
                value={columnMapping.memo !== undefined ? String(columnMapping.memo) : ''}
                onChange={(e) => updateMapping('memo', e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                {columnOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.referenceNumberField')}</label>
              <select
                value={columnMapping.referenceNumber !== undefined ? String(columnMapping.referenceNumber) : ''}
                onChange={(e) => updateMapping('referenceNumber', e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                {columnOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.tagsField')}</label>
              <select
                value={columnMapping.tags !== undefined ? String(columnMapping.tags) : ''}
                onChange={(e) => updateMapping('tags', e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                {columnOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('csvMapping.tagsHelp')}
              </p>
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">{t('csvMapping.reconciliationStatusField')}</label>
              <select
                value={columnMapping.reconciliationStatus !== undefined ? String(columnMapping.reconciliationStatus) : ''}
                onChange={(e) => updateMapping('reconciliationStatus', e.target.value)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                {columnOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('csvMapping.reconciliationStatusHelp')}
              </p>
            </div>
          </div>
        </div>

        {/* Transfer Rules (inert in investment mode: rows classify by action) */}
        {!investmentMode && (
          <div className="mb-6">
            <CsvTransferRules rules={transferRules} onChange={onTransferRulesChange} accounts={accounts} />
          </div>
        )}

        {/* Save/Load Mappings */}
        <div className="mb-6 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg space-y-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('csvMapping.savedMappingsTitle')}</h3>
          <div className="flex items-center gap-2">
            {savedMappings.length > 0 ? (
              <select
                onChange={(e) => {
                  const mapping = savedMappings.find((m) => m.id === e.target.value);
                  if (mapping) onLoadMapping(mapping);
                }}
                defaultValue=""
                className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                <option value="" disabled>{t('csvMapping.loadMappingPlaceholder')}</option>
                {savedMappings.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            ) : (
              <span className="flex-1 text-sm text-gray-400 dark:text-gray-500 italic">{t('csvMapping.noSavedMappings')}</span>
            )}
            {!showSaveInput && (
              <Button variant="outline" size="sm" onClick={() => setShowSaveInput(true)}>
                {t('csvMapping.saveCurrent')}
              </Button>
            )}
          </div>
          {showSaveInput && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setSaveName(''); setShowSaveInput(false); } }}
                placeholder={t('csvMapping.saveMappingPlaceholder')}
                autoFocus
                className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
              {savedMappings.some((m) => m.name === saveName.trim()) && saveName.trim() && (
                <span className="text-xs text-amber-600 dark:text-amber-400 whitespace-nowrap">{t('csvMapping.willOverwrite')}</span>
              )}
              <Button variant="primary" size="sm" onClick={handleSave} disabled={!saveName.trim()}>
                {t('csvMapping.save')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setSaveName(''); setShowSaveInput(false); }}>
                {tc('cancel')}
              </Button>
            </div>
          )}
          {savedMappings.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {savedMappings.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1 text-xs bg-gray-200 dark:bg-gray-600 rounded px-2 py-0.5">
                  {m.name}
                  <button
                    onClick={() => onDeleteMapping(m.id)}
                    className="text-red-500 hover:text-red-700 ml-1"
                    title={tc('delete')}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Validation Error */}
        {validationError && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-300">{validationError}</p>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between">
          <Button variant="outline" onClick={() => setStep('upload')}>
            {t('navigation.back')}
          </Button>
          <Button onClick={handleNext} isLoading={isLoading}>
            {t('navigation.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}
