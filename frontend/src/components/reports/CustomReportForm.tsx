'use client';

import { useState, useEffect, MutableRefObject } from 'react';
import { useForm, useWatch, Controller } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
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
  ReportCategoryType,
  TransferMeasure,
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
import { isTransferCategory } from '@/lib/category-type';
import { Payee } from '@/types/payee';
import { Tag } from '@/types/tag';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { tagsApi } from '@/lib/tags';
import { createLogger } from '@/lib/logger';

import { useFormSubmitRef } from '@/hooks/useFormSubmitRef';
import { useFormDirtyNotify } from '@/hooks/useFormDirtyNotify';
import { FormActions } from '@/components/ui/FormActions';
import { useTranslations } from 'next-intl';
import { CARD_CLASS } from '@/components/ui/Card';

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

  const tagConditions = (filters.tagIds || []).map((id) => ({
    field: 'tag' as const,
    value: id,
  }));
  if (tagConditions.length > 0) groups.push({ conditions: tagConditions });

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
  categoryType: z.nativeEnum(ReportCategoryType),
  includeTransfers: z.boolean(),
  /** '' is no measure: the report reads as it always has. */
  transferMeasure: z.union([z.nativeEnum(TransferMeasure), z.literal('')]),
  customStartDate: z.string().optional(),
  customEndDate: z.string().optional(),
  isFavourite: z.boolean().optional(),
  tableColumns: z.array(z.nativeEnum(TableColumn)).optional(),
  sortBy: z.nativeEnum(TableColumn).optional().nullable(),
  sortDirection: z.nativeEnum(SortDirection).optional(),
}).superRefine((data, ctx) => {
  if (data.transferMeasure && data.metric === MetricType.BUDGET_VARIANCE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A transfer measure cannot be combined with a budget variance',
      path: ['transferMeasure'],
    });
  }
  if (data.timeframeType === TimeframeType.CUSTOM) {
    if (!data.customStartDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Start date is required for custom timeframe',
        path: ['customStartDate'],
      });
    }
    if (!data.customEndDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'End date is required for custom timeframe',
        path: ['customEndDate'],
      });
    }
  }
});

type FormData = z.infer<typeof customReportSchema>;

interface CustomReportFormProps {
  report?: CustomReport;
  onSubmit: (data: CreateCustomReportData) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  submitRef?: MutableRefObject<(() => void) | null>;
}

export function CustomReportForm({ report, onSubmit, onCancel, onDirtyChange, submitRef }: CustomReportFormProps) {
  const t = useTranslations('reports');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [filterGroups, setFilterGroups] = useState<FilterGroup[]>(
    report ? convertLegacyFilters(report.filters) : [],
  );

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting, isDirty },
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
          categoryType: report.config.categoryType ?? ReportCategoryType.ALL,
          includeTransfers: report.config.includeTransfers,
          transferMeasure: report.config.transferMeasure ?? '',
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
          direction: DirectionFilter.BOTH,
          categoryType: ReportCategoryType.EXPENSE,
          includeTransfers: false,
          transferMeasure: '',
          customStartDate: '',
          customEndDate: '',
          isFavourite: false,
          tableColumns: [TableColumn.LABEL, TableColumn.VALUE, TableColumn.COUNT, TableColumn.PERCENTAGE],
          sortBy: null,
          sortDirection: SortDirection.DESC,
        },
  });

  useFormDirtyNotify(isDirty, onDirtyChange);

  const watchTimeframeType = useWatch({ control, name: 'timeframeType' });
  const watchViewType = useWatch({ control, name: 'viewType' });
  const watchTransferMeasure = useWatch({ control, name: 'transferMeasure' });
  const watchMetric = useWatch({ control, name: 'metric' });

  // A Transfer category holds transfer legs only, so a filter naming one
  // matches nothing without them: choosing one turns Include transfers on
  // (docs/specs/transfer-categories.md section 8.1). The server does not infer
  // it; a saved report means what it says.
  const handleFilterGroupsChange = (groups: FilterGroup[]) => {
    const transferIds = new Set(categories.filter(isTransferCategory).map((c) => c.id));
    const before = new Set(
      filterGroups.flatMap((g) => g.conditions).filter((c) => c.field === 'category').flatMap((c) => [c.value].flat()),
    );
    const namesNewTransferCategory = groups
      .flatMap((g) => g.conditions)
      .filter((c) => c.field === 'category')
      .flatMap((c) => [c.value].flat())
      .some((id) => transferIds.has(id) && !before.has(id));
    if (namesNewTransferCategory) setValue('includeTransfers', true, { shouldDirty: true });
    setFilterGroups(groups);
  };

  useEffect(() => {
    const loadData = async () => {
      try {
        const [accountsData, categoriesData, payeesData, tagsData] = await Promise.all([
          accountsApi.getAll(),
          categoriesApi.getAll(),
          payeesApi.getAll(),
          tagsApi.getAll(),
        ]);
        setAccounts(accountsData.filter((a) => !a.isClosed));
        setCategories(categoriesData);
        setPayees(payeesData);
        setTags(tagsData);
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
        categoryType: data.categoryType,
        includeTransfers: data.includeTransfers,
        // null clears a measure the report held; a report without one never
        // sends it, so it saves as it always has.
        ...(data.transferMeasure
          ? { transferMeasure: data.transferMeasure }
          : report?.config.transferMeasure
            ? { transferMeasure: null }
            : {}),
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

  useFormSubmitRef(submitRef, handleSubmit, handleFormSubmit);

  const viewTypeOptions = Object.keys(VIEW_TYPE_LABELS).map((value) => ({
    value,
    label: t(`customReportLabels.viewType.${value}`),
  }));

  const timeframeOptions = Object.keys(TIMEFRAME_LABELS).map((value) => ({
    value,
    label: t(`customReportLabels.timeframe.${value}`),
  }));

  const groupByOptions = Object.keys(GROUP_BY_LABELS).map((value) => ({
    value,
    label: t(`customReportLabels.groupBy.${value}`),
  }));

  const metricOptions = Object.keys(METRIC_LABELS).map((value) => ({
    value,
    label: t(`customReportLabels.metric.${value}`),
  }));

  const directionOptions = Object.keys(DIRECTION_LABELS).map((value) => ({
    value,
    label: t(`customReportLabels.direction.${value}`),
  }));

  const tableColumnOptions = Object.keys(TABLE_COLUMN_LABELS).map((value) => ({
    value,
    label: t(`customReportLabels.tableColumn.${value}`),
  }));

  const sortByOptions = [
    { value: '', label: t('customReport.sortByPlaceholder') },
    ...Object.keys(TABLE_COLUMN_LABELS).map((value) => ({
      value,
      label: t(`customReportLabels.tableColumn.${value}`),
    })),
  ];

  const sortDirectionOptions = Object.keys(SORT_DIRECTION_LABELS).map((value) => ({
    value,
    label: t(`customReportLabels.sortDirection.${value}`),
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
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('customReport.basicInformation')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <Input
              label={t('customReport.labelReportName')}
              {...register('name')}
              error={errors.name?.message}
              placeholder={t('customReport.namePlaceholder')}
            />
          </div>
          <div className="md:col-span-2">
            <Input
              label={t('customReport.labelDescription')}
              {...register('description')}
              placeholder={t('customReport.descriptionPlaceholder')}
            />
          </div>
          <Controller
            name="icon"
            control={control}
            render={({ field }) => (
              <IconPicker
                label={t('customReport.labelIcon')}
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
                label={t('customReport.labelBackgroundColor')}
                value={field.value || null}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </div>

      {/* Visualization Section */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('customReport.visualization')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label={t('customReport.labelViewType')}
            options={viewTypeOptions}
            {...register('viewType')}
            error={errors.viewType?.message}
          />
          <Select
            label={t('customReport.labelGroupBy')}
            options={groupByOptions}
            {...register('groupBy')}
            error={errors.groupBy?.message}
          />
        </div>
      </div>

      {/* Table Configuration Section - only shown when view type is TABLE */}
      {watchViewType === ReportViewType.TABLE && (
        <div className={`${CARD_CLASS} p-6`}>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
            {t('customReport.tableConfiguration')}
          </h3>
          <div className="grid grid-cols-1 gap-4">
            <Controller
              name="tableColumns"
              control={control}
              render={({ field }) => (
                <MultiSelect
                  label={t('customReport.labelColumns')}
                  options={tableColumnOptions}
                  value={field.value || []}
                  onChange={field.onChange}
                  placeholder={t('customReport.columnsPlaceholder')}
                />
              )}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Select
                label={t('customReport.labelSortBy')}
                options={sortByOptions}
                {...register('sortBy')}
              />
              <Select
                label={t('customReport.labelSortDirection')}
                options={sortDirectionOptions}
                {...register('sortDirection')}
              />
            </div>
          </div>
        </div>
      )}

      {/* Time Period Section */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('customReport.timePeriod')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label={t('customReport.labelTimeframe')}
            options={timeframeOptions}
            {...register('timeframeType')}
            error={errors.timeframeType?.message}
          />
          {watchTimeframeType === TimeframeType.CUSTOM && (
            <>
              <DateInput
                label={t('customReport.labelStartDate')}
                error={errors.customStartDate?.message}
                onDateChange={(date) => setValue('customStartDate', date, { shouldDirty: true, shouldValidate: true })}
                {...register('customStartDate')}
              />
              <DateInput
                label={t('customReport.labelEndDate')}
                error={errors.customEndDate?.message}
                onDateChange={(date) => setValue('customEndDate', date, { shouldDirty: true, shouldValidate: true })}
                {...register('customEndDate')}
              />
            </>
          )}
        </div>
      </div>

      {/* Filters Section */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('customReport.filtersOptional')}
        </h3>
        <FilterBuilder
          value={filterGroups}
          onChange={handleFilterGroupsChange}
          accounts={accounts}
          categories={categories}
          payees={payees}
          tags={tags}
        />
      </div>

      {/* Aggregation Options Section */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('customReport.aggregationOptions')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Select
            label={t('customReport.labelMetric')}
            options={metricOptions}
            {...register('metric')}
            error={errors.metric?.message}
          />
          <Select
            label={t('customReport.labelTransferMeasure')}
            options={[
              { value: '', label: t('customReportLabels.transferMeasure.NONE') },
              ...Object.values(TransferMeasure).map((value) => ({
                value,
                label: t(`customReportLabels.transferMeasure.${value}`),
              })),
            ]}
            {...register('transferMeasure')}
            error={
              watchTransferMeasure && watchMetric === MetricType.BUDGET_VARIANCE
                ? t('customReport.transferMeasureBudgetVariance')
                : errors.transferMeasure?.message
            }
          />
          {/* A transfer measure reads transfer legs only, by its own sign, so
              the direction, the category type and Include transfers do not
              apply to it (docs/specs/transfer-categories.md section 8.2). */}
          {!watchTransferMeasure && (
            <>
              <Select
                label={t('customReport.labelDirection')}
                options={directionOptions}
                {...register('direction')}
                error={errors.direction?.message}
              />
              <Select
                label={t('customReport.labelCategoryType')}
                options={Object.values(ReportCategoryType).map((value) => ({
                  value,
                  label: t(`customReportLabels.categoryType.${value}`),
                }))}
                {...register('categoryType')}
                error={errors.categoryType?.message}
              />
              <div className="md:col-span-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    {...register('includeTransfers')}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    {t('customReport.checkboxTransfers')}
                  </span>
                </label>
              </div>
            </>
          )}
          <div className="md:col-span-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                {...register('isFavourite')}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('customReport.checkboxFavourites')}
              </span>
            </label>
          </div>
        </div>
      </div>
      {/* Actions */}
      <FormActions onCancel={onCancel} submitLabel={report ? t('customReport.submitUpdate') : t('customReport.submitCreate')} isSubmitting={isSubmitting} />
    </form>
  );
}
