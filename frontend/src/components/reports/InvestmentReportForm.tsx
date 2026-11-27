'use client';

import { useState, useEffect } from 'react';
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
import { useTranslations } from 'next-intl';
import { useAccountPickerIcon } from '@/components/accounts/shared/AccountPickerIcon';
import { CARD_CLASS } from '@/components/ui/Card';

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
  mergeAccounts: z.boolean().optional(),
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
  const t = useTranslations('reports');
  const tSecurity = useTranslations('securityDetail');
  const accountIcon = useAccountPickerIcon();
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
          mergeAccounts: report.config.mergeAccounts ?? false,
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
          mergeAccounts: false,
          isFavourite: false,
        },
  });

  useEffect(() => {
    const loadData = async () => {
      try {
        const all = await accountsApi.getAll();
        setAccounts(
          // Closed accounts are kept here; accountOptions lists one only while selected.
          all.filter(
            (a) => a.accountType === 'INVESTMENT' && a.accountSubType !== 'INVESTMENT_CASH',
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
        mergeAccounts: data.mergeAccounts ?? false,
      },
      isFavourite: data.isFavourite,
    };
    await onSubmit(submitData);
  };

  const groupByOptions = Object.keys(GROUP_BY_LABELS).map((value) => ({
    value,
    label: t(`investmentReportLabels.groupBy.${value}`),
  }));
  const sortDirectionOptions = Object.keys(SORT_DIRECTION_LABELS).map(
    (value) => ({ value, label: t(`investmentReportLabels.sortDirection.${value}`) }),
  );
  const sortByOptions = [
    { value: '', label: t('investmentReportForm.defaultSortBy') },
    ...columns.map((key) => ({
      value: key,
      label: INVESTMENT_COLUMN_MAP[key]?.label ?? key,
    })),
  ];
  const accountOptions = accounts
    .filter((a) => !a.isClosed || accountIds.includes(a.id))
    .map((a) => ({
      value: a.id,
      label: a.isClosed ? tSecurity('accounts.closedSuffix', { name: a.name }) : a.name,
      icon: accountIcon(a),
    }));
  const watchGroupBy = useWatch({ control, name: 'groupBy' });

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
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('investmentReportForm.basicInformation')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <Input
              label={t('investmentReportForm.labelReportName')}
              {...register('name')}
              error={errors.name?.message}
              placeholder={t('investmentReportForm.namePlaceholder')}
            />
          </div>
          <div className="md:col-span-2">
            <Input
              label={t('investmentReportForm.labelDescription')}
              {...register('description')}
              placeholder={t('investmentReportForm.descriptionPlaceholder')}
            />
          </div>
          <Controller
            name="icon"
            control={control}
            render={({ field }) => (
              <IconPicker label={t('investmentReportForm.labelIcon')} value={field.value || null} onChange={field.onChange} />
            )}
          />
          <Controller
            name="backgroundColor"
            control={control}
            render={({ field }) => (
              <ColorPicker
                label={t('investmentReportForm.labelBackgroundColor')}
                value={field.value || null}
                onChange={field.onChange}
              />
            )}
          />
        </div>
      </div>

      {/* Columns */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
          {t('investmentReportForm.columns')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {t('investmentReportForm.columnsDescription')}
        </p>
        <InvestmentReportColumnChooser value={columns} onChange={setColumns} />
      </div>

      {/* Accounts */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('investmentReportForm.accounts')}
        </h3>
        <MultiSelect
          label={t('investmentReportForm.labelInvestmentAccounts')}
          options={accountOptions}
          value={accountIds}
          onChange={setAccountIds}
          placeholder={t('investmentReportForm.accountsPlaceholder')}
        />
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('investmentReportForm.accountsNote')}
        </p>
      </div>

      {/* Grouping & Sorting */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('investmentReportForm.groupingAndSorting')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Select label={t('investmentReportForm.labelGroupBy')} options={groupByOptions} {...register('groupBy')} />
          <Select label={t('investmentReportForm.labelSortBy')} options={sortByOptions} {...register('sortColumn')} />
          <Select
            label={t('investmentReportForm.labelSortDirection')}
            options={sortDirectionOptions}
            {...register('sortDirection')}
          />
        </div>
        {watchGroupBy !== InvestmentGroupBy.NONE && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t('investmentReportForm.groupByNote', { groupByLabel: t(`investmentReportLabels.groupBy.${watchGroupBy}`).toLowerCase() })}
          </p>
        )}
        {watchGroupBy !== InvestmentGroupBy.ACCOUNT && (
          <div className="mt-4 flex items-start gap-3">
            <Controller
              name="mergeAccounts"
              control={control}
              render={({ field }) => (
                <ToggleSwitch
                  checked={!!field.value}
                  onChange={field.onChange}
                  label={t('investmentReportForm.mergeAccountsLabel')}
                />
              )}
            />
            <div>
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {t('investmentReportForm.mergeAccountsLabel')}
              </span>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('investmentReportForm.mergeAccountsNote')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Report Date */}
      <div className={`${CARD_CLASS} p-6`}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
          {t('investmentReportForm.reportDate')}
        </h3>
        <div className="max-w-xs">
          <DateInput
            label={t('investmentReportForm.labelAsOfDate')}
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            onDateChange={(date) => setAsOfDate(date)}
          />
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('investmentReportForm.asOfDateNote')}
        </p>
      </div>

      {/* Favourite */}
      <div className={`${CARD_CLASS} p-6`}>
        <div className="flex items-center gap-3">
          <Controller
            name="isFavourite"
            control={control}
            render={({ field }) => (
              <ToggleSwitch
                checked={!!field.value}
                onChange={field.onChange}
                label={t('investmentReportForm.labelFavourite')}
              />
            )}
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {t('investmentReportForm.labelFavourite')}
          </span>
        </div>
      </div>

      <FormActions
        onCancel={onCancel}
        submitLabel={report ? t('investmentReportForm.submitUpdate') : t('investmentReportForm.submitCreate')}
        isSubmitting={isSubmitting}
      />
    </form>
  );
}
