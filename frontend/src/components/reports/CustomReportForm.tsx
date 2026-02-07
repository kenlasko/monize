'use client';

import { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@/lib/zodResolver';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { IconPicker } from '@/components/ui/IconPicker';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { FilterBuilder } from '@/components/reports/FilterBuilder';
import {
  CustomReport,
  CreateCustomReportData,
  ReportViewType,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
  TableColumn,
  SortDirection,
  FilterGroup,
  VIEW_TYPE_LABELS,
  TIMEFRAME_LABELS,
  GROUP_BY_LABELS,
  METRIC_LABELS,
  DIRECTION_LABELS,
  TABLE_COLUMN_LABELS,
  SORT_DIRECTION_LABELS,
} from '@/types/custom-report';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CustomReportForm');

/** Convert legacy flat filters to the new filterGroups format */
function convertLegacyFilters(filters: CustomReport['filters']): FilterGroup[] {
  // If already has filterGroups, use them
  if (filters.filterGroups && filters.filterGroups.length > 0) {
    return filters.filterGroups;
  }

  const groups: FilterGroup[] = [];

  // Each legacy filter type becomes one group with conditions ORed
  const accountConditions = (filters.accountIds || []).map((id) => ({
    field: 'account' as const,
    value: id,
  }));
  if (accountConditions.length > 0) groups.push({ conditions: accountConditions });

  const categoryConditions = (filters.categoryIds || []).map((id) => ({
    field: 'category' as const,
    value: id,
  }));
  if (categoryConditions.length > 0) groups.push({ conditions: categoryConditions });

  const payeeConditions = (filters.payeeIds || []).map((id) => ({
    field: 'payee' as const,
    value: id,
  }));
  if (payeeConditions.length > 0) groups.push({ conditions: payeeConditions });

  if (filters.searchText?.trim()) {
    groups.push({ conditions: [{ field: 'text', value: filters.searchText.trim() }] });
  }

  return groups;
}

const customReportSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().optional(),
  icon: z.string().optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().nullable(),
  viewType: z.nativeEnum(ReportViewType),
  timeframeType: z.nativeEnum(TimeframeType),
  groupBy: z.nativeEnum(GroupByType),
  metric: z.nativeEnum(MetricType),
  direction: z.nativeEnum(DirectionFilter),
  includeTransfers: z.boolean(),
  customStartDate: z.string().optional(),
  customEndDate: z.string().optional(),
  isFavourite: z.boolean().optional(),
  tableColumns: z.array(z.nativeEnum(TableColumn)).optional(),
  sortBy: z.nativeEnum(TableColumn).optional().nullable(),
  sortDirection: z.nativeEnum(SortDirection).optional(),
});

type FormData = z.infer<typeof customReportSchema>;

interface CustomReportFormProps {
  report?: CustomReport;
  onSubmit: (data: CreateCustomReportData) => Promise<void>;
  onCancel: () => void;
}

export function CustomReportForm({ report, onSubmit, onCancel }: CustomReportFormProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [filterGroups, setFilterGroups] = useState<FilterGroup[]>(
    report ? convertLegacyFilters(report.filters) : [],
  );

  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(customReportSchema),
    defaultValues: report
      ? {
          name: report.name,
          description: report.description || '',
          icon: report.icon || 'chart-bar',
          backgroundColor: report.backgroundColor || '#3b82f6',
          viewType: report.viewType,
          timeframeType: report.timeframeType,
          groupBy: report.groupBy,
          metric: report.config.metric,
          direction: report.config.direction,
          includeTransfers: report.config.includeTransfers,
          customStartDate: report.config.customStartDate || '',
          customEndDate: report.config.customEndDate || '',
          isFavourite: report.isFavourite,
          tableColumns: report.config.tableColumns || [TableColumn.LABEL, TableColumn.VALUE, TableColumn.COUNT, TableColumn.PERCENTAGE],
          sortBy: report.config.sortBy || null,
          sortDirection: report.config.sortDirection || SortDirection.DESC,
        }
      : {
          name: '',
          description: '',
          icon: 'chart-bar',
          backgroundColor: '#3b82f6',
          viewType: ReportViewType.BAR_CHART,
          timeframeType: TimeframeType.LAST_3_MONTHS,
          groupBy: GroupByType.NONE,
          metric: MetricType.TOTAL_AMOUNT,
          direction: DirectionFilter.EXPENSES_ONLY,
          includeTransfers: false,
          customStartDate: '',
          customEndDate: '',
          isFavourite: false,
          tableColumns: [TableColumn.LABEL, TableColumn.VALUE, TableColumn.COUNT, TableColumn.PERCENTAGE],
          sortBy: null,
          sortDirection: SortDirection.DESC,
        },
  });

  const watchTimeframeType = watch('timeframeType');
  const watchViewType = watch('viewType');

  useEffect(() => {
    const loadData = async () => {
      try {
        const [accountsData, categoriesData, payeesData] = await Promise.all([
          accountsApi.getAll(),
          categoriesApi.getAll(),
          payeesApi.getAll(),
        ]);
        setAccounts(accountsData.filter((a) => !a.isClosed));
        setCategories(categoriesData);
        setPayees(payeesData);
      } catch (error) {
        logger.error('Failed to load data:', error);
      } finally {
        setIsLoadingData(false);
      }
    };
    loadData();
  }, []);

  const handleFormSubmit = async (data: FormData) => {
    const submitData: CreateCustomReportData = {
      name: data.name,
      description: data.description || undefined,
      icon: data.icon || undefined,
      backgroundColor: data.backgroundColor || undefined,
      viewType: data.viewType,
      timeframeType: data.timeframeType,
      groupBy: data.groupBy,
      filters: {
        filterGroups: filterGroups.filter((g) => g.conditions.length > 0 && g.conditions.every((c) => c.value)),
      },
      config: {
        metric: data.metric,
        direction: data.direction,
        includeTransfers: data.includeTransfers,
        customStartDate: data.timeframeType === TimeframeType.CUSTOM ? data.customStartDate : undefined,
        customEndDate: data.timeframeType === TimeframeType.CUSTOM ? data.customEndDate : undefined,
        tableColumns: data.viewType === ReportViewType.TABLE ? data.tableColumns : undefined,
        sortBy: data.sortBy || undefined,
        sortDirection: data.sortBy ? data.sortDirection : undefined,
      },
      isFavourite: data.isFavourite,
    };

    await onSubmit(submitData);
  };

  const viewTypeOptions = Object.entries(VIEW_TYPE_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  const timeframeOptions = Object.entries(TIMEFRAME_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  const groupByOptions = Object.entries(GROUP_BY_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  const metricOptions = Object.entries(METRIC_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  const directionOptions = Object.entries(DIRECTION_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  const tableColumnOptions = Object.entries(TABLE_COLUMN_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  const sortByOptions = [
    { value: '', label: 'Default' },
    ...Object.entries(TABLE_COLUMN_LABELS).map(([value, label]) => ({
      value,
      label,
    })),
  ];

  const sortDirectionOptions = Object.entries(SORT_DIRECTION_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  if (isLoadingData) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      {/* Basic Info Section */}
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
              placeholder="e.g., Monthly Food Spending"
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
              <IconPicker
                label="Icon"
                value={field.value || null}
                onChange={field.onChange}
              />
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

      {/* Visualization Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Visualization
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label="View Type"
            options={viewTypeOptions}
            {...register('viewType')}
            error={errors.viewType?.message}
          />
          <Select
            label="Group By"
            options={groupByOptions}
            {...register('groupBy')}
            error={errors.groupBy?.message}
          />
        </div>
      </div>

      {/* Table Configuration Section - only shown when view type is TABLE */}
      {watchViewType === ReportViewType.TABLE && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            Table Configuration
          </h3>
          <div className="grid grid-cols-1 gap-4">
            <Controller
              name="tableColumns"
              control={control}
              render={({ field }) => (
                <MultiSelect
                  label="Columns to Display"
                  options={tableColumnOptions}
                  value={field.value || []}
                  onChange={field.onChange}
                  placeholder="Select columns..."
                />
              )}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select
                label="Sort By"
                options={sortByOptions}
                {...register('sortBy')}
              />
              <Select
                label="Sort Direction"
                options={sortDirectionOptions}
                {...register('sortDirection')}
              />
            </div>
          </div>
        </div>
      )}

      {/* Time Period Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Time Period
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label="Timeframe"
            options={timeframeOptions}
            {...register('timeframeType')}
            error={errors.timeframeType?.message}
          />
          {watchTimeframeType === TimeframeType.CUSTOM && (
            <>
              <Input
                label="Start Date"
                type="date"
                {...register('customStartDate')}
                error={errors.customStartDate?.message}
              />
              <Input
                label="End Date"
                type="date"
                {...register('customEndDate')}
                error={errors.customEndDate?.message}
              />
            </>
          )}
        </div>
      </div>

      {/* Filters Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Filters (Optional)
        </h3>
        <FilterBuilder
          value={filterGroups}
          onChange={setFilterGroups}
          accounts={accounts}
          categories={categories}
          payees={payees}
        />
      </div>

      {/* Aggregation Options Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          Aggregation Options
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label="Metric"
            options={metricOptions}
            {...register('metric')}
            error={errors.metric?.message}
          />
          <Select
            label="Direction"
            options={directionOptions}
            {...register('direction')}
            error={errors.direction?.message}
          />
          <div className="md:col-span-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                {...register('includeTransfers')}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                Include transfers
              </span>
            </label>
          </div>
          <div className="md:col-span-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                {...register('isFavourite')}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                Add to favourites
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving...' : report ? 'Update Report' : 'Create Report'}
        </Button>
      </div>
    </form>
  );
}
