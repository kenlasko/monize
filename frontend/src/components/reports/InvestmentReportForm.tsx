'use client';

import { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import { IconPicker } from '@/components/ui/IconPicker';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { FormActions } from '@/components/ui/FormActions';
import { InvestmentReportColumnChooser } from '@/components/reports/InvestmentReportColumnChooser';
import {
  InvestmentReport,
  CreateInvestmentReportData,
  InvestmentGroupBy,
  InvestmentSortDirection,
  INVESTMENT_COLUMN_MAP,
  GROUP_BY_LABELS,
  SORT_DIRECTION_LABELS,
} from '@/types/investment-report';
import { Account } from '@/types/account';
import { accountsApi } from '@/lib/accounts';
import { createLogger } from '@/lib/logger';

const logger = createLogger('InvestmentReportForm');

const DEFAULT_COLUMNS = [
  'symbol',
  'name',
  'quantity',
  'averageCost',
  'costBasis',
  'lastPrice',
  'marketValue',
  'gain',
  'gainPercent',
];

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().optional(),
  icon: z.string().optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
  groupBy: z.nativeEnum(InvestmentGroupBy),
  sortColumn: z.string().optional(),
  sortDirection: z.nativeEnum(InvestmentSortDirection),
  isFavourite: z.boolean().optional(),
});

type FormData = z.infer<typeof schema>;

interface InvestmentReportFormProps {
  report?: InvestmentReport;
  onSubmit: (data: CreateInvestmentReportData) => Promise<void>;
  onCancel: () => void;
}

export function InvestmentReportForm({
  report,
  onSubmit,
  onCancel,
}: InvestmentReportFormProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [columns, setColumns] = useState<string[]>(
    report?.config.columns?.length ? report.config.columns : DEFAULT_COLUMNS,
  );
  const [accountIds, setAccountIds] = useState<string[]>(
    report?.config.accountIds ?? [],
  );
  const [asOfDate, setAsOfDate] = useState<string>(report?.config.asOfDate ?? '');

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: report
      ? {
          name: report.name,
          description: report.description || '',
          icon: report.icon || 'chart-bar',
          backgroundColor: report.backgroundColor || '#3b82f6',
          groupBy: report.groupBy,
          sortColumn: report.config.sortColumn || '',
          sortDirection: report.config.sortDirection || InvestmentSortDirection.ASC,
          isFavourite: report.isFavourite,
        }
      : {
          name: '',
          description: '',
          icon: 'chart-bar',
          backgroundColor: '#3b82f6',
          groupBy: InvestmentGroupBy.NONE,
          sortColumn: 'marketValue',
          sortDirection: InvestmentSortDirection.DESC,
          isFavourite: false,
        },
  });

  useEffect(() => {
    const loadData = async () => {
      try {
        const all = await accountsApi.getAll();
        setAccounts(
          all.filter(
            (a) =>
              a.accountType === 'INVESTMENT' &&
              a.accountSubType !== 'INVESTMENT_CASH' &&
              !a.isClosed,
          ),
        );
      } catch (error) {
        logger.error('Failed to load accounts:', error);
      } finally {
        setIsLoadingData(false);
      }
    };
    loadData();
  }, []);

  const handleFormSubmit = async (data: FormData) => {
    // A removed column can no longer be the sort column.
    const sortColumn =
      data.sortColumn && columns.includes(data.sortColumn) ? data.sortColumn : null;
    const submitData: CreateInvestmentReportData = {
      name: data.name,
      description: data.description || undefined,
      icon: data.icon || undefined,
      backgroundColor: data.backgroundColor || undefined,
      groupBy: data.groupBy,
      config: {
        columns,
        accountIds,
        sortColumn,
        sortDirection: data.sortDirection,
        asOfDate: asOfDate || null,
      },
      isFavourite: data.isFavourite,
    };
    await onSubmit(submitData);
  };

  const groupByOptions = Object.entries(GROUP_BY_LABELS).map(([value, label]) => ({
    value,
    label,
  }));
  const sortDirectionOptions = Object.entries(SORT_DIRECTION_LABELS).map(
    ([value, label]) => ({ value, label }),
  );
  const sortByOptions = [
    { value: '', label: 'Default (Symbol)' },
    ...columns.map((key) => ({
      value: key,
      label: INVESTMENT_COLUMN_MAP[key]?.label ?? key,
    })),
  ];
  const accountOptions = accounts.map((a) => ({ value: a.id, label: a.name }));
  const watchGroupBy = watch('groupBy');

  if (isLoadingData) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      {/* Basic Information */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Basic Information
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <Input
              label="Report Name"
              {...register('name')}
              error={errors.name?.message}
              placeholder="e.g., Taxable Holdings Overview"
            />
          </div>
          <div className="md:col-span-2">
            <Input
              label="Description (optional)"
              {...register('description')}
              placeholder="Brief description of what this report shows"
            />
          </div>
          <Controller
            name="icon"
            control={control}
            render={({ field }) => (
              <IconPicker label="Icon" value={field.value || null} onChange={field.onChange} />
            )}
          />
          <Controller
            name="backgroundColor"
            control={control}
            render={({ field }) => (
              <ColorPicker
                label="Background Color"
                value={field.value || null}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </div>

      {/* Columns */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
          Columns
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Choose which columns to show and drag the order with the arrows. Symbol is
          always included.
        </p>
        <InvestmentReportColumnChooser value={columns} onChange={setColumns} />
      </div>

      {/* Accounts */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Accounts
        </h3>
        <MultiSelect
          label="Investment accounts to include"
          options={accountOptions}
          value={accountIds}
          onChange={setAccountIds}
          placeholder="All investment accounts"
        />
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Leave empty to include all of your investment accounts.
        </p>
      </div>

      {/* Grouping & Sorting */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Grouping &amp; Sorting
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Select label="Group By" options={groupByOptions} {...register('groupBy')} />
          <Select label="Sort By" options={sortByOptions} {...register('sortColumn')} />
          <Select
            label="Sort Direction"
            options={sortDirectionOptions}
            {...register('sortDirection')}
          />
        </div>
        {watchGroupBy !== InvestmentGroupBy.NONE && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Rows are grouped by {GROUP_BY_LABELS[watchGroupBy].toLowerCase()} and sorted
            within each group.
          </p>
        )}
      </div>

      {/* Report Date */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Report Date
        </h3>
        <div className="max-w-xs">
          <DateInput
            label="As of date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            onDateChange={(date) => setAsOfDate(date)}
          />
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Leave empty to always value the report as of the last day the markets were open.
        </p>
      </div>

      {/* Favourite */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="flex items-center gap-3">
          <Controller
            name="isFavourite"
            control={control}
            render={({ field }) => (
              <ToggleSwitch
                checked={!!field.value}
                onChange={field.onChange}
                label="Add to favourites"
              />
            )}
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            Add to favourites
          </span>
        </div>
      </div>

      <FormActions
        onCancel={onCancel}
        submitLabel={report ? 'Update Report' : 'Create Report'}
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
