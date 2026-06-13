'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Modal } from '@/components/ui/Modal';

// Predefined option templates
const EARNINGS_TEMPLATES = [
  'Salary',
  'Bonus',
  'Profit sharing',
  'Vacation',
  'Holiday',
  'Sick Pay',
  'Other earning',
];

const PRE_TAX_TEMPLATES = [
  '401(k)/403(b)/457',
  'PERS/SARSEP/SIMPLE',
  'Flex Spending',
  'Dependent Care',
  'Medical Insurance',
  'Dental Insurance',
  'Vision Insurance',
  'HSA',
  'Commuter / Transit Benefits',
  'Other Pre-Tax Deduction',
];

const TAX_TEMPLATES = [
  'Federal Tax',
  'State Tax',
  'Social Security (FICA)',
  'Medicare Tax',
  'Disability (SDI)',
  'Local / City Tax',
  'Paid Family & Medical Leave (PFML/FLI)',
  'State Unemployment Insurance (SUI)',
  'Other Tax',
];

const AFTER_TAX_TEMPLATES = [
  'Stock Purchase (ESPP)',
  '401(k) Loan',
  'Roth 401(k)',
  'Employer Loan Repayment',
  'Roth IRA',
  'Garnishments / Child Support',
  'Union Dues',
  'Charitable Contributions',
  'Life / AD&D / Disability Insurance',
  'Other After-Tax Deduction',
];

interface PaycheckItem {
  id: string;
  name: string;
  categoryId?: string;
  transferAccountId?: string;
  amount: number;
}

interface DepositSplit {
  id: string;
  accountId: string;
  amount?: number;
  percent?: number;
  memo: string;
}

export default function PaycheckWizardPage() {
  return (
    <ProtectedRoute>
      <PaycheckWizardContent />
    </ProtectedRoute>
  );
}

function PaycheckWizardContent() {
  const t = useTranslations('navigation');
  const router = useRouter();

  // Reference lists
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [paycheckTemplates, setPaycheckTemplates] = useState<ScheduledTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Selected template for editing
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('new');

  // Form states matching Quicken screenshot
  const [companyName, setCompanyName] = useState('');
  const [memo, setMemo] = useState('Paycheck');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    return d.toISOString().split('T')[0];
  });
  const [frequency, setFrequency] = useState('BIWEEKLY');
  const [primaryAccountId, setPrimaryAccountId] = useState('');

  // Grouped line items
  const [earnings, setEarnings] = useState<PaycheckItem[]>([]);
  const [preTaxDeductions, setPreTaxDeductions] = useState<PaycheckItem[]>([]);
  const [taxes, setTaxes] = useState<PaycheckItem[]>([]);
  const [afterTaxDeductions, setAfterTaxDeductions] = useState<PaycheckItem[]>([]);
  const [depositAccounts, setDepositAccounts] = useState<DepositSplit[]>([]);

  // Accordion state
  const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({
    earnings: true,
    preTax: true,
    taxes: true,
    afterTax: true,
    deposits: true,
  });

  // Modal State
  const [activeModal, setActiveModal] = useState<'earning' | 'preTax' | 'tax' | 'afterTax' | 'deposit' | null>(null);
  const [editingItemIndex, setEditingItemIndex] = useState<number | null>(null);
  const [modalTemplates, setModalTemplates] = useState<string[]>([]);

  // Modal Form State
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('category'); // 'category' or 'account'
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formAccountId, setFormAccountId] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formPercent, setFormPercent] = useState('');
  const [formMemo, setFormMemo] = useState('');

  // Inline category creation
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryParentId, setNewCategoryParentId] = useState('');

  // Filter and group categories
  const incomeCategories = useMemo(() => {
    return categories.filter(c => c.isIncome);
  }, [categories]);

  const expenseCategories = useMemo(() => {
    return categories.filter(c => !c.isIncome);
  }, [categories]);

  const formatCategoryName = useCallback((cat: Category) => {
    if (cat.parentId) {
      const parent = categories.find(c => c.id === cat.parentId);
      if (parent) {
        return `${parent.name} › ${cat.name}`;
      }
    }
    return cat.name;
  }, [categories]);

  const formattedModalCategories = useMemo(() => {
    const list = activeModal === 'earning' ? incomeCategories : expenseCategories;
    return list
      .map(c => ({
        ...c,
        formattedName: formatCategoryName(c),
      }))
      .sort((a, b) => a.formattedName.localeCompare(b.formattedName));
  }, [activeModal, incomeCategories, expenseCategories, formatCategoryName]);

  // Toggle Accordion Panel
  const togglePanel = (panel: string) => {
    setOpenPanels(prev => ({ ...prev, [panel]: !prev[panel] }));
  };

  // Load backend details
  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [accs, cats, scheds] = await Promise.all([
        accountsApi.getAll(),
        categoriesApi.getAll(),
        scheduledTransactionsApi.getAll(),
      ]);

      // Only active checking/savings accounts
      const activeDepositAccs = accs.filter(a => !a.isClosed && (a.accountType === 'CHEQUING' || a.accountType === 'SAVINGS' || a.accountType === 'HSA' || a.accountType === 'FSA' || a.accountType === 'DCFSA' || a.accountType === '401K' || a.accountType === '403B' || a.accountType === 'TRADITIONAL_IRA' || a.accountType === 'ROTH_IRA'));
      setAccounts(activeDepositAccs);
      setCategories(cats);

      // Find scheduled transactions that are paycheck templates
      const paychecks = scheds.filter(s => s.paycheckMetadata);
      setPaycheckTemplates(paychecks);

      if (activeDepositAccs.length > 0) {
        setPrimaryAccountId(activeDepositAccs[0].id);
      }
    } catch (error) {
      toast.error('Failed to load payroll configuration dependencies.');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle template selection
  const handleTemplateChange = (id: string) => {
    setSelectedTemplateId(id);
    if (id === 'new') {
      setCompanyName('');
      setMemo('Paycheck');
      setEarnings([]);
      setPreTaxDeductions([]);
      setTaxes([]);
      setAfterTaxDeductions([]);
      setDepositAccounts([]);
      if (accounts.length > 0) {
        setPrimaryAccountId(accounts[0].id);
      }
    } else {
      const template = paycheckTemplates.find(t => t.id === id);
      if (template && template.paycheckMetadata) {
        const meta = template.paycheckMetadata;
        setCompanyName(meta.companyName || '');
        setMemo(template.description || 'Paycheck');
        setStartDate(template.startDate || template.nextDueDate);
        setFrequency(template.frequency);
        setPrimaryAccountId(template.accountId);
        setEarnings(meta.earnings || []);
        setPreTaxDeductions(meta.preTaxDeductions || []);
        setTaxes(meta.taxes || []);
        setAfterTaxDeductions(meta.afterTaxDeductions || []);
        setDepositAccounts(meta.depositAccounts || []);
      }
    }
  };

  // Math Calculations
  const calculations = useMemo(() => {
    const gross = earnings.reduce((sum, e) => sum + e.amount, 0);
    const preTaxTotal = preTaxDeductions.reduce((sum, d) => sum + d.amount, 0);
    const taxesTotal = taxes.reduce((sum, t) => sum + t.amount, 0);
    const afterTaxTotal = afterTaxDeductions.reduce((sum, d) => sum + d.amount, 0);

    const netPay = gross - (preTaxTotal + taxesTotal + afterTaxTotal);
    const w2Gross = gross - preTaxTotal;

    const secondaryDeposits = depositAccounts.reduce((sum, dep) => {
      if (dep.amount !== undefined) return sum + dep.amount;
      if (dep.percent !== undefined) return sum + (dep.percent / 100) * netPay;
      return sum;
    }, 0);

    const primaryDeposit = netPay - secondaryDeposits;

    return {
      gross,
      preTaxTotal,
      taxesTotal,
      afterTaxTotal,
      netPay,
      w2Gross,
      secondaryDeposits,
      primaryDeposit,
    };
  }, [earnings, preTaxDeductions, taxes, afterTaxDeductions, depositAccounts]);

  // Open add/edit item modal
  const openItemModal = (
    section: 'earning' | 'preTax' | 'tax' | 'afterTax' | 'deposit',
    index: number | null = null
  ) => {
    setEditingItemIndex(index);
    setFormCategoryId('');
    setFormAccountId('');
    setFormAmount('');
    setFormPercent('');
    setFormMemo('');

    // Reset inline category creation states
    setIsCreatingCategory(false);
    setNewCategoryName('');
    setNewCategoryParentId('');

    if (section === 'deposit') {
      setFormType('account');
      if (accounts.length > 0) setFormAccountId(accounts[0].id);
      if (index !== null) {
        const dep = depositAccounts[index];
        setFormAccountId(dep.accountId);
        if (dep.amount !== undefined) {
          setFormAmount(dep.amount.toString());
          setFormType('amount');
        } else if (dep.percent !== undefined) {
          setFormPercent(dep.percent.toString());
          setFormType('percent');
        }
        setFormMemo(dep.memo);
      } else {
        setFormType('amount');
      }
    } else {
      let templatesList: string[] = [];
      let defaultName = '';
      if (section === 'earning') {
        templatesList = EARNINGS_TEMPLATES;
        defaultName = EARNINGS_TEMPLATES[0];
      } else if (section === 'preTax') {
        templatesList = PRE_TAX_TEMPLATES;
        defaultName = PRE_TAX_TEMPLATES[0];
      } else if (section === 'tax') {
        templatesList = TAX_TEMPLATES;
        defaultName = TAX_TEMPLATES[0];
      } else if (section === 'afterTax') {
        templatesList = AFTER_TAX_TEMPLATES;
        defaultName = AFTER_TAX_TEMPLATES[0];
      }
      setModalTemplates(templatesList);
      setFormName(defaultName);
      setFormType('category');

      if (index !== null) {
        const item =
          section === 'earning' ? earnings[index] :
          section === 'preTax' ? preTaxDeductions[index] :
          section === 'tax' ? taxes[index] : afterTaxDeductions[index];
        
        setFormName(item.name);
        setFormAmount(item.amount.toString());
        if (item.transferAccountId) {
          setFormType('account');
          setFormAccountId(item.transferAccountId);
        } else {
          setFormType('category');
          setFormCategoryId(item.categoryId || '');
        }
      } else {
        const defaultList = section === 'earning' ? categories.filter(c => c.isIncome) : categories.filter(c => !c.isIncome);
        if (defaultList.length > 0) {
          setFormCategoryId(defaultList[0].id);
        } else if (categories.length > 0) {
          setFormCategoryId(categories[0].id);
        }
      }
    }

    setActiveModal(section);
  };

  // Submit Modal Form
  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (activeModal === 'deposit') {
      const newDep: DepositSplit = {
        id: editingItemIndex !== null ? depositAccounts[editingItemIndex].id : Math.random().toString(),
        accountId: formAccountId,
        memo: formMemo || 'Paycheck Deposit',
        amount: formType === 'amount' ? Number(formAmount) : undefined,
        percent: formType === 'percent' ? Number(formPercent) : undefined,
      };

      if (editingItemIndex !== null) {
        setDepositAccounts(prev => {
          const updated = [...prev];
          updated[editingItemIndex] = newDep;
          return updated;
        });
      } else {
        setDepositAccounts(prev => [...prev, newDep]);
      }
    } else {
      let finalCategoryId = formCategoryId;

      if (formType === 'category' && isCreatingCategory) {
        if (!newCategoryName.trim()) {
          toast.error('Category name is required.');
          return;
        }
        try {
          const created = await categoriesApi.create({
            name: newCategoryName.trim(),
            isIncome: activeModal === 'earning',
            parentId: newCategoryParentId || undefined,
          });
          toast.success(`Category "${created.name}" created.`);
          // Add to local categories state
          setCategories(prev => [...prev, created]);
          finalCategoryId = created.id;
        } catch (err) {
          toast.error('Failed to create category.');
          console.error(err);
          return;
        }
      }

      const newItem: PaycheckItem = {
        id: editingItemIndex !== null ?
          (activeModal === 'earning' ? earnings[editingItemIndex].id :
           activeModal === 'preTax' ? preTaxDeductions[editingItemIndex].id :
           activeModal === 'tax' ? taxes[editingItemIndex].id : afterTaxDeductions[editingItemIndex].id)
          : Math.random().toString(),
        name: formName,
        amount: Number(formAmount || 0),
        categoryId: formType === 'category' ? finalCategoryId || undefined : undefined,
        transferAccountId: formType === 'account' ? formAccountId || undefined : undefined,
      };

      const setter =
        activeModal === 'earning' ? setEarnings :
        activeModal === 'preTax' ? setPreTaxDeductions :
        activeModal === 'tax' ? setTaxes : setAfterTaxDeductions;

      if (editingItemIndex !== null) {
        setter(prev => {
          const updated = [...prev];
          updated[editingItemIndex] = newItem;
          return updated;
        });
      } else {
        setter(prev => [...prev, newItem]);
      }
    }

    setActiveModal(null);
  };

  // Delete Item
  const handleDeleteItem = (section: 'earning' | 'preTax' | 'tax' | 'afterTax' | 'deposit', index: number) => {
    if (section === 'earning') setEarnings(prev => prev.filter((_, i) => i !== index));
    if (section === 'preTax') setPreTaxDeductions(prev => prev.filter((_, i) => i !== index));
    if (section === 'tax') setTaxes(prev => prev.filter((_, i) => i !== index));
    if (section === 'afterTax') setAfterTaxDeductions(prev => prev.filter((_, i) => i !== index));
    if (section === 'deposit') setDepositAccounts(prev => prev.filter((_, i) => i !== index));
  };

  // Get name of category/account for display
  const getCategoryName = (item: PaycheckItem) => {
    if (item.transferAccountId) {
      const acc = accounts.find(a => a.id === item.transferAccountId);
      return acc ? `[${acc.name}]` : '[Unknown Account]';
    }
    const cat = categories.find(c => c.id === item.categoryId);
    return cat ? cat.name : 'Uncategorized';
  };

  const getAccountName = (accountId: string) => {
    const acc = accounts.find(a => a.id === accountId);
    return acc ? acc.name : 'Unknown Account';
  };

  // Save/Submit Form to backend API
  const handleSavePaycheck = async () => {
    if (!companyName.trim()) {
      toast.error('Employer/Company Name is required.');
      return;
    }

    if (calculations.gross <= 0) {
      toast.error('Gross earnings must be greater than 0.');
      return;
    }

    if (calculations.primaryDeposit < 0) {
      toast.error('Deductions and splits exceed net pay.');
      return;
    }

    const payload = {
      accountId: primaryAccountId,
      name: `Paycheck: ${companyName}`,
      amount: calculations.primaryDeposit,
      currencyCode: accounts.find(a => a.id === primaryAccountId)?.currencyCode || 'USD',
      description: memo,
      frequency: frequency as any,
      nextDueDate: startDate,
      startDate: startDate,
      isActive: true,
      autoPost: false,
      paycheckMetadata: {
        companyName,
        earnings,
        preTaxDeductions,
        taxes,
        afterTaxDeductions,
        depositAccounts,
      },
    };

    try {
      if (selectedTemplateId === 'new') {
        await scheduledTransactionsApi.create(payload as any);
        toast.success('Paycheck configuration saved successfully!');
      } else {
        await scheduledTransactionsApi.update(selectedTemplateId, payload as any);
        toast.success('Paycheck configuration updated successfully!');
      }
      loadData();
      router.push('/bills');
    } catch (err) {
      toast.error('Failed to save paycheck setup.');
      console.error(err);
    }
  };

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8 text-gray-900 dark:text-gray-100 min-h-screen">
        <PageHeader
          title="Paycheck Wizard"
          subtitle="Model and schedule your recurring paychecks, deductions, taxes, and splits."
          helpUrl="https://github.com/kenlasko/monize/wiki"
        />

        {/* Template Selector */}
        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg mb-6 border border-gray-200 dark:border-gray-700 shadow-sm flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-semibold text-gray-600 dark:text-gray-300">Select Paycheck Setup:</label>
            <select
              value={selectedTemplateId}
              onChange={e => handleTemplateChange(e.target.value)}
              className="bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="new">Add New Paycheck...</option>
              {paycheckTemplates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} (Next: {t.nextDueDate})
                </option>
              ))}
            </select>
          </div>
          {selectedTemplateId !== 'new' && (
            <Button
              variant="outline"
              onClick={async () => {
                if (confirm('Are you sure you want to delete this paycheck template?')) {
                  try {
                    await scheduledTransactionsApi.delete(selectedTemplateId);
                    toast.success('Paycheck deleted.');
                    handleTemplateChange('new');
                    loadData();
                  } catch (err) {
                    toast.error('Failed to delete paycheck.');
                  }
                }
              }}
              className="text-red-600 dark:text-red-400 hover:text-red-500 dark:hover:text-red-300 border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/20"
            >
              Delete Paycheck
            </Button>
          )}
        </div>

        {isLoading ? (
          <LoadingSpinner text="Loading payroll data..." />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Left columns: Form configuration panels */}
            <div className="lg:col-span-2 space-y-6">
              {/* Header details */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 shadow-sm">
                <h3 className="text-lg font-bold mb-4 text-blue-600 dark:text-blue-400 flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                  Paycheck Header Details
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Company / Employer Name</label>
                    <input
                      type="text"
                      value={companyName}
                      onChange={e => setCompanyName(e.target.value)}
                      placeholder="e.g. Acme Corp"
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Memo</label>
                    <input
                      type="text"
                      value={memo}
                      onChange={e => setMemo(e.target.value)}
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">First Paycheck Date</label>
                    <input
                      type="date"
                      value={startDate}
                      onChange={e => setStartDate(e.target.value)}
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Frequency</label>
                    <select
                      value={frequency}
                      onChange={e => setFrequency(e.target.value)}
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="WEEKLY">Weekly</option>
                      <option value="BIWEEKLY">Every 2 Weeks (Biweekly)</option>
                      <option value="SEMIMONTHLY">Twice a Month (Semimonthly)</option>
                      <option value="MONTHLY">Monthly</option>
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Primary Deposit Bank Account</label>
                    <select
                      value={primaryAccountId}
                      onChange={e => setPrimaryAccountId(e.target.value)}
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.currencyCode})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Earnings Panel */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm">
                <button
                  onClick={() => togglePanel('earnings')}
                  className="w-full px-6 py-4 flex items-center justify-between bg-gray-50 dark:bg-gray-850 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors focus:outline-none"
                >
                  <span className="font-bold flex items-center gap-2">
                    <svg className={`w-4 h-4 transition-transform ${openPanels.earnings ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                    </svg>
                    Earnings
                  </span>
                  <span className="text-sm font-semibold text-green-600 dark:text-green-400">+${calculations.gross.toFixed(2)}</span>
                </button>
                {openPanels.earnings && (
                  <div className="p-6 border-t border-gray-200 dark:border-gray-750 space-y-4">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-xs uppercase font-bold">
                          <th className="pb-2">Name</th>
                          <th className="pb-2">Category</th>
                          <th className="pb-2 text-right">Amount</th>
                          <th className="pb-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {earnings.map((item, idx) => (
                          <tr key={item.id} className="border-b border-gray-200 dark:border-gray-750/50 hover:bg-gray-50 dark:hover:bg-gray-750/30">
                            <td className="py-2.5 font-medium">{item.name}</td>
                            <td className="py-2.5 text-gray-700 dark:text-gray-300">{getCategoryName(item)}</td>
                            <td className="py-2.5 text-right font-bold text-green-600 dark:text-green-400">+${item.amount.toFixed(2)}</td>
                            <td className="py-2.5 text-right space-x-2">
                              <button onClick={() => openItemModal('earning', idx)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                              <button onClick={() => handleDeleteItem('earning', idx)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Delete</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      onClick={() => openItemModal('earning')}
                      className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 flex items-center gap-1"
                    >
                      + Add Earning Line
                    </button>
                  </div>
                )}
              </div>

              {/* Pre-Tax Deductions */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm">
                <button
                  onClick={() => togglePanel('preTax')}
                  className="w-full px-6 py-4 flex items-center justify-between bg-gray-50 dark:bg-gray-850 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors focus:outline-none"
                >
                  <span className="font-bold flex items-center gap-2">
                    <svg className={`w-4 h-4 transition-transform ${openPanels.preTax ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                    </svg>
                    Pre-Tax Deductions
                  </span>
                  <span className="text-sm font-semibold text-red-600 dark:text-red-400">-${calculations.preTaxTotal.toFixed(2)}</span>
                </button>
                {openPanels.preTax && (
                  <div className="p-6 border-t border-gray-200 dark:border-gray-750 space-y-4">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-xs uppercase font-bold">
                          <th className="pb-2">Name</th>
                          <th className="pb-2">Category / Account</th>
                          <th className="pb-2 text-right">Amount</th>
                          <th className="pb-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preTaxDeductions.map((item, idx) => (
                          <tr key={item.id} className="border-b border-gray-200 dark:border-gray-750/50 hover:bg-gray-50 dark:hover:bg-gray-750/30">
                            <td className="py-2.5 font-medium">{item.name}</td>
                            <td className="py-2.5 text-gray-700 dark:text-gray-300">{getCategoryName(item)}</td>
                            <td className="py-2.5 text-right font-bold text-red-600 dark:text-red-400">-${item.amount.toFixed(2)}</td>
                            <td className="py-2.5 text-right space-x-2">
                              <button onClick={() => openItemModal('preTax', idx)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                              <button onClick={() => handleDeleteItem('preTax', idx)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Delete</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      onClick={() => openItemModal('preTax')}
                      className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 flex items-center gap-1"
                    >
                      + Add Pre-Tax Deduction
                    </button>
                  </div>
                )}
              </div>

              {/* Taxes */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm">
                <button
                  onClick={() => togglePanel('taxes')}
                  className="w-full px-6 py-4 flex items-center justify-between bg-gray-50 dark:bg-gray-850 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors focus:outline-none"
                >
                  <span className="font-bold flex items-center gap-2">
                    <svg className={`w-4 h-4 transition-transform ${openPanels.taxes ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                    </svg>
                    Taxes
                  </span>
                  <span className="text-sm font-semibold text-red-600 dark:text-red-400">-${calculations.taxesTotal.toFixed(2)}</span>
                </button>
                {openPanels.taxes && (
                  <div className="p-6 border-t border-gray-200 dark:border-gray-750 space-y-4">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-xs uppercase font-bold">
                          <th className="pb-2">Name</th>
                          <th className="pb-2">Category</th>
                          <th className="pb-2 text-right">Amount</th>
                          <th className="pb-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {taxes.map((item, idx) => (
                          <tr key={item.id} className="border-b border-gray-200 dark:border-gray-750/50 hover:bg-gray-50 dark:hover:bg-gray-750/30">
                            <td className="py-2.5 font-medium">{item.name}</td>
                            <td className="py-2.5 text-gray-700 dark:text-gray-300">{getCategoryName(item)}</td>
                            <td className="py-2.5 text-right font-bold text-red-600 dark:text-red-400">-${item.amount.toFixed(2)}</td>
                            <td className="py-2.5 text-right space-x-2">
                              <button onClick={() => openItemModal('tax', idx)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                              <button onClick={() => handleDeleteItem('tax', idx)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Delete</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      onClick={() => openItemModal('tax')}
                      className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 flex items-center gap-1"
                    >
                      + Add Tax Item
                    </button>
                  </div>
                )}
              </div>

              {/* After-Tax Deductions */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm">
                <button
                  onClick={() => togglePanel('afterTax')}
                  className="w-full px-6 py-4 flex items-center justify-between bg-gray-50 dark:bg-gray-850 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors focus:outline-none"
                >
                  <span className="font-bold flex items-center gap-2">
                    <svg className={`w-4 h-4 transition-transform ${openPanels.afterTax ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                    </svg>
                    After-Tax Deductions
                  </span>
                  <span className="text-sm font-semibold text-red-600 dark:text-red-400">-${calculations.afterTaxTotal.toFixed(2)}</span>
                </button>
                {openPanels.afterTax && (
                  <div className="p-6 border-t border-gray-200 dark:border-gray-750 space-y-4">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-xs uppercase font-bold">
                          <th className="pb-2">Name</th>
                          <th className="pb-2">Category / Account</th>
                          <th className="pb-2 text-right">Amount</th>
                          <th className="pb-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {afterTaxDeductions.map((item, idx) => (
                          <tr key={item.id} className="border-b border-gray-200 dark:border-gray-750/50 hover:bg-gray-50 dark:hover:bg-gray-750/30">
                            <td className="py-2.5 font-medium">{item.name}</td>
                            <td className="py-2.5 text-gray-700 dark:text-gray-300">{getCategoryName(item)}</td>
                            <td className="py-2.5 text-right font-bold text-red-600 dark:text-red-400">-${item.amount.toFixed(2)}</td>
                            <td className="py-2.5 text-right space-x-2">
                              <button onClick={() => openItemModal('afterTax', idx)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                              <button onClick={() => handleDeleteItem('afterTax', idx)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Delete</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      onClick={() => openItemModal('afterTax')}
                      className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 flex items-center gap-1"
                    >
                      + Add After-Tax Deduction
                    </button>
                  </div>
                )}
              </div>

              {/* Deposit splits */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm">
                <button
                  onClick={() => togglePanel('deposits')}
                  className="w-full px-6 py-4 flex items-center justify-between bg-gray-50 dark:bg-gray-850 hover:bg-gray-100 dark:hover:bg-gray-750 transition-colors focus:outline-none"
                >
                  <span className="font-bold flex items-center gap-2">
                    <svg className={`w-4 h-4 transition-transform ${openPanels.deposits ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                    </svg>
                    Deposit Accounts Splits
                  </span>
                  <span className="text-sm font-semibold text-gray-550 dark:text-gray-400">Total splits: ${calculations.secondaryDeposits.toFixed(2)}</span>
                </button>
                {openPanels.deposits && (
                  <div className="p-6 border-t border-gray-200 dark:border-gray-750 space-y-4">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 text-xs uppercase font-bold">
                          <th className="pb-2">Account</th>
                          <th className="pb-2">Memo</th>
                          <th className="pb-2 text-right">Split Metric</th>
                          <th className="pb-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {depositAccounts.map((item, idx) => (
                          <tr key={item.id} className="border-b border-gray-200 dark:border-gray-750/50 hover:bg-gray-50 dark:hover:bg-gray-750/30">
                            <td className="py-2.5 font-medium">{getAccountName(item.accountId)}</td>
                            <td className="py-2.5 text-gray-700 dark:text-gray-300">{item.memo}</td>
                            <td className="py-2.5 text-right font-bold">
                              {item.amount !== undefined ? `$${item.amount.toFixed(2)}` : `${item.percent}%`}
                            </td>
                            <td className="py-2.5 text-right space-x-2">
                              <button onClick={() => openItemModal('deposit', idx)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
                              <button onClick={() => handleDeleteItem('deposit', idx)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Delete</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      onClick={() => openItemModal('deposit')}
                      className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 flex items-center gap-1"
                    >
                      + Add Secondary Deposit Account Split
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Right column: live calculation values */}
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 shadow-sm sticky top-20">
                <h3 className="text-lg font-bold mb-4 text-blue-600 dark:text-blue-400 border-b border-gray-200 dark:border-gray-750 pb-2">Gross-to-Net Summary</h3>
                <div className="space-y-3.5 text-sm text-gray-700 dark:text-gray-300">
                  <div className="flex justify-between">
                    <span>Gross Salary</span>
                    <span className="font-semibold text-green-600 dark:text-green-400">+${calculations.gross.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Pre-Tax Deductions</span>
                    <span className="font-semibold text-red-600 dark:text-red-400">-${calculations.preTaxTotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-t border-gray-200 dark:border-gray-700/50 pt-2 font-medium">
                    <span>W-2 Taxable Gross</span>
                    <span className="font-semibold text-gray-900 dark:text-gray-100">${calculations.w2Gross.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Taxes Withheld</span>
                    <span className="font-semibold text-red-600 dark:text-red-400">-${calculations.taxesTotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Post-Tax Deductions</span>
                    <span className="font-semibold text-red-600 dark:text-red-400">-${calculations.afterTaxTotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between border-t border-gray-300 dark:border-gray-700 pt-2 font-bold text-base text-gray-900 dark:text-gray-100">
                    <span>Total Net Pay</span>
                    <span className="text-blue-600 dark:text-blue-400">${calculations.netPay.toFixed(2)}</span>
                  </div>

                  <div className="border-t border-gray-200 dark:border-gray-750 pt-4 space-y-2">
                    <h4 className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400">Split Deposits Distribution</h4>
                    <div className="flex justify-between text-xs text-gray-700 dark:text-gray-300">
                      <span>Primary Deposit ({getAccountName(primaryAccountId)})</span>
                      <span className="font-semibold text-blue-600 dark:text-blue-400">${calculations.primaryDeposit.toFixed(2)}</span>
                    </div>
                    {depositAccounts.map((dep, idx) => (
                      <div key={dep.id} className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                        <span>Split {idx + 1} ({getAccountName(dep.accountId)})</span>
                        <span>
                          ${(dep.amount !== undefined ? dep.amount : (dep.percent || 0) * calculations.netPay / 100).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {calculations.primaryDeposit < 0 && (
                    <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded p-3 text-red-600 dark:text-red-400 text-xs">
                      <strong>Warning:</strong> Deductions exceed earnings. Please adjust payroll configuration.
                    </div>
                  )}

                  <div className="pt-4">
                    <Button
                      onClick={handleSavePaycheck}
                      className="w-full py-2.5 font-bold"
                      disabled={calculations.primaryDeposit < 0 || !companyName}
                    >
                      {selectedTemplateId === 'new' ? 'Save Paycheck Template' : 'Update Paycheck Template'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Modal Overlay Form */}
        {activeModal && (
          <Modal isOpen={activeModal !== null} onClose={() => setActiveModal(null)} maxWidth="md" className="p-6 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg border border-gray-200 dark:border-gray-700 shadow-xl">
            <h2 className="text-xl font-bold mb-4 text-blue-600 dark:text-blue-400">
              {editingItemIndex !== null ? 'Edit' : 'Add'} {activeModal === 'deposit' ? 'Deposit Split' : activeModal === 'earning' ? 'Earning' : activeModal === 'preTax' ? 'Pre-Tax Deduction' : activeModal === 'tax' ? 'Tax Item' : 'After-Tax Deduction'}
            </h2>
            <form onSubmit={handleModalSubmit} className="space-y-4">
              {activeModal !== 'deposit' && (
                <div>
                  <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Item Template / Name</label>
                  <div className="flex gap-2">
                    <select
                      value={formName}
                      onChange={e => setFormName(e.target.value)}
                      className="flex-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {modalTemplates.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={formName}
                      onChange={e => setFormName(e.target.value)}
                      placeholder="Custom label..."
                      className="flex-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              )}

              {activeModal === 'deposit' ? (
                <>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Destination Bank Account</label>
                    <select
                      value={formAccountId}
                      onChange={e => setFormAccountId(e.target.value)}
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Split Type</label>
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="split_type"
                          checked={formType === 'amount'}
                          onChange={() => setFormType('amount')}
                        />
                        Fixed Amount ($)
                      </label>
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="split_type"
                          checked={formType === 'percent'}
                          onChange={() => setFormType('percent')}
                        />
                        Percentage (%)
                      </label>
                    </div>
                  </div>
                  {formType === 'amount' ? (
                    <div>
                      <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Amount ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={formAmount}
                        onChange={e => setFormAmount(e.target.value)}
                        placeholder="0.00"
                        className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        required
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Percent (%)</label>
                      <input
                        type="number"
                        step="1"
                        value={formPercent}
                        onChange={e => setFormPercent(e.target.value)}
                        placeholder="0"
                        className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        required
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Memo</label>
                    <input
                      type="text"
                      value={formMemo}
                      onChange={e => setFormMemo(e.target.value)}
                      placeholder="Primary Account, Savings Split..."
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Destination Mapping</label>
                    <div className="flex gap-4 text-sm mb-2">
                      <label className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="mapping_type"
                          checked={formType === 'category'}
                          onChange={() => setFormType('category')}
                        />
                        Category
                      </label>
                      {(activeModal === 'preTax' || activeModal === 'afterTax') && (
                        <label className="flex items-center gap-1">
                          <input
                            type="radio"
                            name="mapping_type"
                            checked={formType === 'account'}
                            onChange={() => setFormType('account')}
                          />
                          Transfer Account
                        </label>
                      )}
                    </div>
                    {formType === 'category' ? (
                      isCreatingCategory ? (
                        <div className="space-y-3 p-3 bg-gray-50 dark:bg-gray-800/40 rounded border border-gray-200 dark:border-gray-700/60 text-xs">
                          <div className="flex justify-between items-center">
                            <span className="font-semibold text-blue-600 dark:text-blue-400">New Category Details</span>
                            <button
                              type="button"
                              onClick={() => setIsCreatingCategory(false)}
                              className="text-gray-500 dark:text-gray-400 hover:underline"
                            >
                              Cancel
                            </button>
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400 mb-1">Category Name</label>
                            <input
                              type="text"
                              value={newCategoryName}
                              onChange={e => setNewCategoryName(e.target.value)}
                              placeholder="e.g. Health Insurance, HSA Contribution"
                              className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                              required={isCreatingCategory}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] uppercase font-bold text-gray-500 dark:text-gray-400 mb-1">Parent Category (Optional)</label>
                            <select
                              value={newCategoryParentId}
                              onChange={e => setNewCategoryParentId(e.target.value)}
                              className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="">No Parent (Root Category)</option>
                              {formattedModalCategories.filter(c => !c.parentId).map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <select
                            value={formCategoryId}
                            onChange={e => setFormCategoryId(e.target.value)}
                            className="flex-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {formattedModalCategories.map(c => (
                              <option key={c.id} value={c.id}>{c.formattedName}</option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setIsCreatingCategory(true)}
                            className="text-xs px-3 py-1 border-blue-200 dark:border-blue-900 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20"
                          >
                            + New
                          </Button>
                        </div>
                      )
                    ) : (
                      <select
                        value={formAccountId}
                        onChange={e => setFormAccountId(e.target.value)}
                        className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1">Amount ($)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formAmount}
                      onChange={e => setFormAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>
                </>
              )}

              <div className="pt-4 flex justify-end gap-2">
                <Button variant="outline" type="button" onClick={() => setActiveModal(null)}>
                  Cancel
                </Button>
                <Button type="submit">
                  Save Line Item
                </Button>
              </div>
            </form>
          </Modal>
        )}
      </main>
    </PageLayout>
  );
}
