'use client';

import { useState, useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { aiApi, ParsedFinancialDataResponse, ParsedAiTransaction } from '@/lib/ai';
import { importApi } from '@/lib/import';
import { exportToCsv } from '@/lib/csv-export';
import { getErrorMessage } from '@/lib/errors';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { usePreferencesStore } from '@/store/preferencesStore';
import { accountsApi } from '@/lib/accounts';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { Account } from '@/types/account';

type ImportStep = 'paste' | 'preview' | 'complete';

const TYPE_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  transfer:  { label: 'Transfer',  bg: 'bg-blue-100 dark:bg-blue-900/40',    text: 'text-blue-800 dark:text-blue-300'    },
  buy:       { label: 'Buy',       bg: 'bg-emerald-100 dark:bg-emerald-900/40', text: 'text-emerald-800 dark:text-emerald-300' },
  sell:      { label: 'Sell',      bg: 'bg-orange-100 dark:bg-orange-900/40', text: 'text-orange-800 dark:text-orange-300' },
  dividend:  { label: 'Dividend',  bg: 'bg-purple-100 dark:bg-purple-900/40', text: 'text-purple-800 dark:text-purple-300' },
  reinvest:  { label: 'Reinvest',  bg: 'bg-teal-100 dark:bg-teal-900/40',    text: 'text-teal-800 dark:text-teal-300'    },
  income:    { label: 'Income',    bg: 'bg-green-100 dark:bg-green-900/40',   text: 'text-green-800 dark:text-green-300'  },
  expense:   { label: 'Expense',   bg: 'bg-red-100 dark:bg-red-900/40',      text: 'text-red-800 dark:text-red-300'      },
  fee:       { label: 'Fee',       bg: 'bg-yellow-100 dark:bg-yellow-900/40', text: 'text-yellow-800 dark:text-yellow-300'},
};

function TypeBadge({ type }: { type: string }) {
  const badge = TYPE_BADGE[type] ?? { label: type, bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-300' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${badge.bg} ${badge.text}`}>
      {badge.label}
    </span>
  );
}

function ConfidenceBanner({ confidence, notes }: { confidence: string; notes: string }) {
  const colors = {
    high:   'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300',
    medium: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300',
    low:    'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300',
  };
  const icons = { high: '✅', medium: '⚠️', low: '❌' };
  const labels = { high: 'High confidence', medium: 'Medium confidence — please review', low: 'Low confidence — review carefully' };
  const key = (confidence as 'high' | 'medium' | 'low') ?? 'medium';
  return (
    <div className={`rounded-lg border p-3 mb-4 ${colors[key]}`}>
      <div className="flex items-center gap-2 font-medium text-sm">
        <span>{icons[key]}</span>
        <span>{labels[key]}</span>
      </div>
      {notes && <p className="mt-1 text-xs opacity-80">{notes}</p>}
    </div>
  );
}

export default function AiImportPage() {
  return (
    <ProtectedRoute>
      <AiImportContent />
    </ProtectedRoute>
  );
}

function AiImportContent() {
  const defaultCurrency = usePreferencesStore(s => s.preferences?.defaultCurrency) ?? 'USD';

  const [step, setStep] = useState<ImportStep>('paste');
  const [rawText, setRawText] = useState('');
  const [hint, setHint] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parsed, setParsed] = useState<ParsedFinancialDataResponse | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Partial<ParsedAiTransaction>>({});
  const [transactions, setTransactions] = useState<ParsedAiTransaction[]>([]);
  const [importResult, setImportResult] = useState<{ imported: number; errors: number } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [currencyOptions, setCurrencyOptions] = useState<{ value: string; label: string }[]>([]);
  const [selectedCurrency, setSelectedCurrency] = useState(defaultCurrency);

  useEffect(() => {
    Promise.all([accountsApi.getAll(), exchangeRatesApi.getCurrencies()]).then(([accs, curs]) => {
      setAccounts(accs);
      setCurrencyOptions(curs.map(c => ({ value: c.code, label: `${c.code} — ${c.name}` })));
    }).catch(() => {});
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (!rawText.trim()) {
      toast.error('Please paste some financial data first.');
      return;
    }
    setIsAnalyzing(true);
    try {
      const result = await aiApi.parseFinancialData(rawText.trim(), hint.trim() || undefined);
      setParsed(result);
      setTransactions(result.transactions);
      setSelectedRows(new Set(result.transactions.map((_, i) => i)));
      setStep('preview');
    } catch (err) {
      toast.error(getErrorMessage(err, 'AI could not parse the data. Please try again.'));
    } finally {
      setIsAnalyzing(false);
    }
  }, [rawText, hint]);

  const toggleRow = (i: number) => {
    setSelectedRows(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedRows.size === transactions.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(transactions.map((_, i) => i)));
    }
  };

  const startEdit = (i: number) => {
    setEditingRow(i);
    setEditValues({ ...transactions[i] });
  };

  const saveEdit = (i: number) => {
    setTransactions(prev => prev.map((t, idx) => idx === i ? { ...t, ...editValues } : t));
    setEditingRow(null);
    setEditValues({});
  };

  const cancelEdit = () => {
    setEditingRow(null);
    setEditValues({});
  };

  const handleDownloadCsv = () => {
    const selected = transactions.filter((_, i) => selectedRows.has(i));
    exportToCsv(
      'ai-import-preview.csv',
      ['Date', 'Payee', 'Amount', 'Type', 'Account', 'Source Account', 'Category', 'Security', 'Shares', 'Price', 'Memo', 'Notes'],
      selected.map(t => [
        t.date, t.payee, t.amount, t.type,
        t.account ?? '', t.sourceAccount ?? '',
        t.category ?? '',
        t.security ?? '', t.shares ?? '', t.price ?? '', t.memo ?? '', t.notes ?? '',
      ]),
    );
    toast.success(`Downloaded ${selected.length} transactions as CSV`);
  };

  const handleCopyTable = () => {
    const selected = transactions.filter((_, i) => selectedRows.has(i));
    const header = 'Date\tPayee\tAmount\tType\tAccount\tCategory\tMemo\tNotes';
    const rows = selected.map(t =>
      `${t.date}\t${t.payee}\t${t.amount}\t${t.type}\t${t.account ?? ''}\t${t.category ?? ''}\t${t.memo ?? ''}\t${t.notes ?? ''}`
    );
    navigator.clipboard.writeText([header, ...rows].join('\n'))
      .then(() => toast.success('Table copied to clipboard'))
      .catch(() => toast.error('Could not copy to clipboard'));
  };

  const handleImport = async () => {
    if (!parsed || selectedRows.size === 0) return;
    
    // Build a minimal QIF multi-account payload from the AI-parsed data
    const selectedTxns = transactions.filter((_, i) => selectedRows.has(i));
    
    // Validate that all selected transactions have a valid date (YYYY-MM-DD)
    const invalidDateTxn = selectedTxns.find(tx => !tx.date || tx.date === 'null' || tx.date === 'undefined' || !/^\d{4}-\d{2}-\d{2}$/.test(tx.date));
    if (invalidDateTxn) {
      toast.error(`Transaction "${invalidDateTxn.payee || 'Without Payee'}" has an invalid or missing date. Please edit it to set a valid date.`);
      return;
    }

    setIsImporting(true);
    try {
      const qifContent = buildQifFromAiTransactions(selectedTxns, parsed.accounts);
      const result = await importApi.importQifMultiAccount({
        content: qifContent,
        currencyCode: selectedCurrency,
      });
      setImportResult({ imported: result.imported, errors: result.errors });
      setStep('complete');
      if (result.errors === 0) {
        toast.success(`✅ Imported ${result.imported} transactions successfully!`);
      } else {
        toast.success(`Imported ${result.imported} transactions (${result.errors} errors)`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, 'Import failed. Please try again.'));
    } finally {
      setIsImporting(false);
    }
  };

  if (step === 'complete') {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader title="AI Smart Import" subtitle="Import complete" />
          <div className="max-w-xl mx-auto mt-8 text-center">
            <div className="text-6xl mb-4">🎉</div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Import Complete</h2>
            {importResult && (
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Successfully imported <strong>{importResult.imported}</strong> transactions
                {importResult.errors > 0 && ` (${importResult.errors} errors)`}.
              </p>
            )}
            <div className="flex gap-3 justify-center">
              <Button onClick={() => { setStep('paste'); setRawText(''); setParsed(null); setImportResult(null); }}>
                Import More
              </Button>
              <Button variant="outline" onClick={() => window.location.href = '/transactions'}>
                View Transactions
              </Button>
            </div>
          </div>
        </main>
      </PageLayout>
    );
  }

  if (step === 'preview' && parsed) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader
            title="AI Smart Import"
            subtitle={`AI found ${transactions.length} transactions across ${parsed.accounts.length} account${parsed.accounts.length !== 1 ? 's' : ''}`}
          />

          <div className="w-full">
            <ConfidenceBanner confidence={parsed.confidence} notes={parsed.notes} />

            {/* Summary pills */}
            <div className="flex flex-wrap gap-2 mb-4">
              {parsed.accounts.map((acc, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                  {acc.name} <span className="opacity-60 text-xs">({acc.type})</span>
                </span>
              ))}
              {parsed.securities.length > 0 && parsed.securities.map((sec, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700">
                  📈 {sec}
                </span>
              ))}
            </div>

            {/* Currency selector */}
            <div className="mb-4 flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">Currency for new accounts:</label>
              <div className="w-48">
                <Select
                  value={selectedCurrency}
                  onChange={e => setSelectedCurrency(e.target.value)}
                  options={currencyOptions.length > 0 ? currencyOptions : [{ value: selectedCurrency, label: selectedCurrency }]}
                />
              </div>
            </div>

            {/* Transaction table */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden mb-6">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-800">
                    <tr>
                      <th className="px-4 py-3 text-left w-10">
                        <input
                          type="checkbox"
                          checked={selectedRows.size === transactions.length && transactions.length > 0}
                          onChange={toggleAll}
                          className="rounded border-gray-300 dark:border-gray-600 text-blue-600 h-4 w-4 cursor-pointer"
                        />
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Date</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Payee / Description</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell">Account</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden lg:table-cell">Security</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Amount</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-16">Edit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    {transactions.map((tx, i) => (
                      <tr
                        key={i}
                        className={`transition-colors ${selectedRows.has(i) ? 'bg-white dark:bg-gray-900' : 'opacity-40 bg-gray-50 dark:bg-gray-800/50'} hover:bg-blue-50/30 dark:hover:bg-blue-900/10`}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedRows.has(i)}
                            onChange={() => toggleRow(i)}
                            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 h-4 w-4 cursor-pointer"
                          />
                        </td>
                        {editingRow === i ? (
                          // Inline edit row
                          <>
                            <td className="px-4 py-2">
                              <input
                                type="date"
                                value={editValues.date ?? tx.date}
                                onChange={e => setEditValues(v => ({ ...v, date: e.target.value }))}
                                className="border border-blue-300 dark:border-blue-600 rounded px-2 py-1 text-sm w-32 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                              />
                            </td>
                            <td className="px-4 py-2">
                              <div className="flex flex-col gap-1 w-full min-w-48">
                                <input
                                  value={editValues.payee ?? tx.payee}
                                  onChange={e => setEditValues(v => ({ ...v, payee: e.target.value }))}
                                  className="border border-blue-300 dark:border-blue-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                  placeholder="Payee"
                                />
                                <input
                                  value={editValues.category ?? tx.category ?? ''}
                                  onChange={e => setEditValues(v => ({ ...v, category: e.target.value }))}
                                  className="border border-blue-300 dark:border-blue-600 rounded px-2 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-emerald-600 dark:text-emerald-400"
                                  placeholder="Category"
                                />
                                <input
                                  value={editValues.memo ?? tx.memo ?? ''}
                                  onChange={e => setEditValues(v => ({ ...v, memo: e.target.value }))}
                                  className="border border-blue-300 dark:border-blue-600 rounded px-2 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                  placeholder="Memo"
                                />
                                <input
                                  value={editValues.notes ?? tx.notes ?? ''}
                                  onChange={e => setEditValues(v => ({ ...v, notes: e.target.value }))}
                                  className="border border-blue-300 dark:border-blue-600 rounded px-2 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-purple-600 dark:text-purple-400"
                                  placeholder="Notes"
                                />
                              </div>
                            </td>
                            <td className="px-4 py-2">
                              <select
                                value={editValues.type ?? tx.type}
                                onChange={e => setEditValues(v => ({ ...v, type: e.target.value as ParsedAiTransaction['type'] }))}
                                className="border border-blue-300 dark:border-blue-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                              >
                                {Object.keys(TYPE_BADGE).map(t => <option key={t} value={t}>{TYPE_BADGE[t].label}</option>)}
                              </select>
                            </td>
                            <td className="px-4 py-2 hidden md:table-cell">
                              <input
                                value={editValues.account ?? tx.account ?? ''}
                                onChange={e => setEditValues(v => ({ ...v, account: e.target.value }))}
                                className="border border-blue-300 dark:border-blue-600 rounded px-2 py-1 text-sm w-36 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                placeholder="Account"
                              />
                            </td>
                            <td className="px-4 py-2 hidden lg:table-cell">
                              <input
                                value={editValues.security ?? tx.security ?? ''}
                                onChange={e => setEditValues(v => ({ ...v, security: e.target.value }))}
                                className="border border-blue-300 dark:border-blue-600 rounded px-2 py-1 text-sm w-36 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                                placeholder="Security"
                              />
                            </td>
                            <td className="px-4 py-2 text-right">
                              <input
                                type="number"
                                step="0.01"
                                value={editValues.amount ?? tx.amount}
                                onChange={e => setEditValues(v => ({ ...v, amount: parseFloat(e.target.value) }))}
                                className="border border-blue-300 dark:border-blue-600 rounded px-2 py-1 text-sm w-24 text-right bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                              />
                            </td>
                            <td className="px-4 py-2 text-center">
                              <div className="flex gap-1 justify-center">
                                <button onClick={() => saveEdit(i)} className="text-xs text-green-600 dark:text-green-400 hover:underline font-medium">Save</button>
                                <button onClick={cancelEdit} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">✕</button>
                              </div>
                            </td>
                          </>
                        ) : (
                          // Normal read row
                          <>
                            <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap font-mono">{tx.date}</td>
                            <td className="px-4 py-3">
                              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate max-w-[200px]" title={tx.payee}>{tx.payee}</div>
                              {tx.sourceAccount && (
                                <div className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">← {tx.sourceAccount}</div>
                              )}
                              {tx.category && (
                                <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">🏷️ {tx.category}</div>
                              )}
                              {tx.memo && (
                                <div className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[200px]" title={tx.memo}>{tx.memo}</div>
                              )}
                              {tx.notes && (
                                <div className="text-xs text-purple-600 dark:text-purple-400 truncate max-w-[200px]" title={tx.notes}>📝 {tx.notes}</div>
                              )}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap"><TypeBadge type={tx.type} /></td>
                            <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell truncate max-w-[140px]">{tx.account ?? '—'}</td>
                            <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 hidden lg:table-cell">
                              {tx.security ? (
                                <div>
                                  <div className="font-medium text-emerald-700 dark:text-emerald-400">{tx.security}</div>
                                  {tx.shares != null && tx.price != null && (
                                    <div className="text-xs text-gray-400">{tx.shares} @ ${tx.price}</div>
                                  )}
                                </div>
                              ) : '—'}
                            </td>
                            <td className={`px-4 py-3 text-sm font-semibold text-right whitespace-nowrap ${tx.amount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                              {tx.amount >= 0 ? '+' : ''}{tx.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button
                                onClick={() => startEdit(i)}
                                className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                                title="Edit this row"
                              >
                                ✏️
                              </button>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Action bar */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 py-4 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <span className="font-medium text-gray-700 dark:text-gray-300">{selectedRows.size} of {transactions.length}</span> transactions selected
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setStep('paste')}>
                  ← Back
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownloadCsv} disabled={selectedRows.size === 0}>
                  📥 Download CSV
                </Button>
                <Button variant="outline" size="sm" onClick={handleCopyTable} disabled={selectedRows.size === 0}>
                  📋 Copy Table
                </Button>
                <Button
                  size="sm"
                  onClick={handleImport}
                  isLoading={isImporting}
                  disabled={selectedRows.size === 0}
                >
                  ✅ Import ({selectedRows.size})
                </Button>
              </div>
            </div>
          </div>
        </main>
      </PageLayout>
    );
  }

  // Step: paste
  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="AI Smart Import"
          subtitle="Paste any financial data and let AI parse it into transactions"
        />

        <div className="w-full">
          {/* How it works */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 mb-6">
            <h3 className="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-1">How it works</h3>
            <ul className="text-sm text-blue-700 dark:text-blue-400 space-y-1 list-disc list-inside">
              <li>Paste any financial data — CSV, spreadsheet copy, bank statement, brokerage export</li>
              <li>AI analyzes the format and extracts transactions automatically</li>
              <li>Preview, edit, and download before importing</li>
            </ul>
          </div>

          {/* Paste area */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 mb-4">
            <label htmlFor="ai-import-data" className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
              Paste your financial data
            </label>
            <textarea
              id="ai-import-data"
              rows={12}
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              placeholder={`Paste any format — for example:\n\nDate,Action,Transaction,Price,Shares,$ Amount,C,Cash Balance,,\n1/7/2026,XIn,Company Direct Dep,,0,939.22,,952.31,,Employee Contribution\n,,[Classic XX1234],,,939.22,,,,\n1/7/2026,Bought,LifePath 2050-510001,46.31171,20.2804,-939.22,c,13.09,,Contribution:LifePath 2050`}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 font-mono px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
            <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
              {rawText.length > 0 ? `${rawText.split('\n').length} lines · ${rawText.length.toLocaleString()} characters` : 'Supports CSV, tab-separated, and most financial export formats'}
            </p>
          </div>

          {/* Optional hint */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-6">
            <label htmlFor="ai-import-hint" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Optional: describe the data source <span className="text-gray-400 font-normal">(helps AI)</span>
            </label>
            <input
              id="ai-import-hint"
              type="text"
              value={hint}
              onChange={e => setHint(e.target.value)}
              placeholder='e.g. "401k brokerage export" or "Scotiabank checking CSV"'
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleAnalyze}
              isLoading={isAnalyzing}
              disabled={!rawText.trim()}
              size="lg"
            >
              {isAnalyzing ? 'Analyzing...' : '✨ Analyze & Preview'}
            </Button>
          </div>

          {isAnalyzing && (
            <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400 animate-pulse">
              AI is reading your data — this usually takes 5–15 seconds...
            </div>
          )}
        </div>
      </main>
    </PageLayout>
  );
}

/**
 * Build a minimal QIF string from AI-parsed transactions so we can reuse
 * the existing importQifMultiAccount pipeline on the backend.
 */
function buildQifFromAiTransactions(
  transactions: ParsedAiTransaction[],
  accounts: { name: string; type: string }[],
): string {
  // Group transactions by account
  const byAccount = new Map<string, ParsedAiTransaction[]>();
  for (const tx of transactions) {
    const acct = tx.account ?? 'Imported Account';
    if (!byAccount.has(acct)) byAccount.set(acct, []);
    byAccount.get(acct)!.push(tx);
  }

  const lines: string[] = [];

  // Write category section header (minimal)
  lines.push('!Type:Cat', '^');

  for (const [accountName, txns] of byAccount) {
    const accountInfo = accounts.find(a => a.name === accountName);
    const accountType = accountInfo?.type ?? 'CHEQUING';
    const qifType = accountType === 'INVESTMENT' ? 'Invst' : 'Bank';

    lines.push('!Account');
    lines.push(`N${accountName}`);
    lines.push(`T${accountType}`);
    lines.push('^');
    lines.push(`!Type:${qifType}`);

    for (const tx of txns) {
      lines.push(`D${tx.date}`);
      lines.push(`T${tx.amount}`);

      if (tx.payee) lines.push(`P${tx.payee}`);
      if (tx.memo) lines.push(`M${tx.memo}`);
      if (tx.notes) lines.push(`X${tx.notes}`);

      if (tx.type === 'transfer' && tx.sourceAccount) {
        lines.push(`L[${tx.sourceAccount}]`);
      } else if (tx.category) {
        lines.push(`L${tx.category}`);
      }

      // Investment fields
      if (tx.type === 'buy' && tx.security) {
        lines.push(`Nbought`);
        lines.push(`Y${tx.security}`);
        if (tx.price != null) lines.push(`I${tx.price}`);
        if (tx.shares != null) lines.push(`Q${tx.shares}`);
      } else if (tx.type === 'sell' && tx.security) {
        lines.push(`Nsold`);
        lines.push(`Y${tx.security}`);
        if (tx.price != null) lines.push(`I${tx.price}`);
        if (tx.shares != null) lines.push(`Q${tx.shares}`);
      } else if (tx.type === 'dividend' && tx.security) {
        lines.push(`NDiv`);
        lines.push(`Y${tx.security}`);
      }

      lines.push('^');
    }
  }

  return lines.join('\n');
}
