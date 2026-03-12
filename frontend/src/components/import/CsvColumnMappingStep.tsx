'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { CsvTransferRules } from './CsvTransferRules';
import { ImportStep } from '@/app/import/import-utils';
import { CsvColumnMappingConfig, CsvTransferRule, SavedColumnMapping, DATE_FORMAT_OPTIONS, detectCsvDateFormat } from '@/lib/import';
import { Account } from '@/types/account';

interface CsvColumnMappingStepProps {
  headers: string[];
  sampleRows: string[][];
  columnMapping: CsvColumnMappingConfig;
  onColumnMappingChange: (mapping: CsvColumnMappingConfig) => void;
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
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
];

type AmountMode = 'single' | 'split';

export function CsvColumnMappingStep({
  headers,
  sampleRows,
  columnMapping,
  onColumnMappingChange,
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
  const [amountMode, setAmountMode] = useState<AmountMode>(
    columnMapping.debit !== undefined || columnMapping.credit !== undefined ? 'split' : 'single'
  );
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
    { value: '', label: 'Not mapped' },
    ...headers.map((h, i) => ({
      value: String(i),
      label: columnMapping.hasHeader && h ? `${h} (Col ${i + 1})` : `Column ${i + 1}`,
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
      setValidationError('Date column is required');
      return;
    }
    if (amountMode === 'single' && columnMapping.amount === undefined) {
      setValidationError('Amount column is required');
      return;
    }
    if (amountMode === 'split' && (columnMapping.debit === undefined || columnMapping.credit === undefined)) {
      setValidationError('Both debit and credit columns are required');
      return;
    }
    setValidationError('');
    onNext();
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
          CSV Column Mapping
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          Map your CSV columns to transaction fields. Preview the data below and configure the mapping.
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
            First row is header
          </label>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700 dark:text-gray-300">Delimiter:</label>
            <select
              value={columnMapping.delimiter}
              onChange={(e) => onDelimiterChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              {DELIMITER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700 dark:text-gray-300">Date format:</label>
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
              <option value={CUSTOM_FORMAT_VALUE}>Custom...</option>
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
                placeholder="e.g. DD.MM.YYYY"
                className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-36"
              />
            )}
          </div>
        </div>

        {/* Data Preview */}
        {sampleRows.length > 0 && (
          <div className="mb-6 overflow-x-auto">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Data Preview</h3>
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
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Column Mapping</h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Date *</label>
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
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Amount type</label>
              <select
                value={amountMode}
                onChange={(e) => handleAmountModeChange(e.target.value as AmountMode)}
                className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                <option value="single">Single amount column</option>
                <option value="split">Separate debit/credit</option>
              </select>
            </div>
          </div>

          {amountMode === 'single' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Amount *</label>
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
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Sign</label>
                <select
                  value={columnMapping.reverseSign ? 'reverse' : 'normal'}
                  onChange={(e) => onColumnMappingChange({ ...columnMapping, reverseSign: e.target.value === 'reverse' })}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  <option value="normal">As-is (positive = deposit)</option>
                  <option value="reverse">Reverse (positive = withdrawal)</option>
                </select>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Debit *</label>
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
                <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Credit *</label>
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

          <div>
            <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Payee</label>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Category</label>
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
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Subcategory</label>
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Memo</label>
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
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Reference Number</label>
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
        </div>

        {/* Save/Load Mappings */}
        <div className="mb-6 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg space-y-3">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Saved Mappings</h3>
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
                <option value="" disabled>Load a saved mapping...</option>
                {savedMappings.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            ) : (
              <span className="flex-1 text-sm text-gray-400 dark:text-gray-500 italic">No saved mappings</span>
            )}
            {!showSaveInput && (
              <Button variant="outline" size="sm" onClick={() => setShowSaveInput(true)}>
                Save Current
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
                placeholder="Enter mapping name..."
                autoFocus
                className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
              {savedMappings.some((m) => m.name === saveName.trim()) && saveName.trim() && (
                <span className="text-xs text-amber-600 dark:text-amber-400 whitespace-nowrap">Will overwrite</span>
              )}
              <Button variant="primary" size="sm" onClick={handleSave} disabled={!saveName.trim()}>
                Save
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setSaveName(''); setShowSaveInput(false); }}>
                Cancel
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
                    title="Delete"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Transfer Rules */}
        <div className="mb-6">
          <CsvTransferRules rules={transferRules} onChange={onTransferRulesChange} accounts={accounts} />
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
            Back
          </Button>
          <Button onClick={handleNext} isLoading={isLoading}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
