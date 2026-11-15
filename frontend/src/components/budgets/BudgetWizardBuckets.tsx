'use client';

import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { moneyDecimalsForCurrency, sumMoney } from '@/lib/format';
import type { ApplyBudgetCategoryData } from '@/types/budget';
import { BudgetBucketEditor } from './BudgetBucketEditor';
import type { BudgetBucketEditorRow } from './utils/budget-bucket-presets';
import type { WizardState } from './BudgetWizard';

type LineMap = Map<string, ApplyBudgetCategoryData>;

/**
 * The lines a bucket can hold: every selected expense line and every selected
 * transfer. Income lines cannot be assigned (design decision 7).
 */
export function budgetWizardBucketLines(
  categories: LineMap,
  transfers: LineMap,
): ApplyBudgetCategoryData[] {
  return [
    ...Array.from(categories.values()).filter((c) => !c.isIncome),
    ...Array.from(transfers.values()),
  ];
}

/** The line's bucket key while it names a bucket that still exists, else null. */
export function liveBucketKey(
  line: ApplyBudgetCategoryData | undefined,
  buckets: readonly BudgetBucketEditorRow[],
): string | null {
  if (!line || line.isIncome || line.bucketKey === undefined) return null;
  return buckets.some((b) => b.key === line.bucketKey) ? line.bucketKey : null;
}

/** The entry with `bucketKey` set to `key`, or removed when `key` is null. */
export function withBucketKey(
  entry: ApplyBudgetCategoryData,
  key: string | null,
): ApplyBudgetCategoryData {
  if (key !== null) return { ...entry, bucketKey: key };
  const rest = { ...entry };
  delete rest.bucketKey;
  return rest;
}

/**
 * The map with every `bucketKey` outside `keys` dropped; the same map when no
 * entry changes, so an unrelated bucket edit does not rewrite the lines.
 */
export function withoutStaleBucketKeys(map: LineMap, keys: ReadonlySet<string>): LineMap {
  let next: LineMap | null = null;
  for (const [id, entry] of map) {
    if (entry.bucketKey !== undefined && !keys.has(entry.bucketKey)) {
      next ??= new Map(map);
      next.set(id, withBucketKey(entry, null));
    }
  }
  return next ?? map;
}

export interface BudgetWizardBucketTally {
  buckets: Array<{ row: BudgetBucketEditorRow; count: number; planned: number }>;
  unassignedCount: number;
  unassignedPlanned: number;
}

/**
 * How many selected lines each bucket holds, and a plain sum of the amounts
 * the person typed for them. Not a bucket figure: allocations, income shares
 * and availability are the server's (INV-BUDGET-001).
 */
export function tallyBudgetWizardBuckets(
  buckets: readonly BudgetBucketEditorRow[],
  categories: LineMap,
  transfers: LineMap,
  currencyCode: string,
): BudgetWizardBucketTally {
  const decimals = moneyDecimalsForCurrency(currencyCode);
  const lines = budgetWizardBucketLines(categories, transfers);
  const byKey = new Map<string, number[]>(buckets.map((b) => [b.key, []]));
  const unassigned: number[] = [];
  for (const line of lines) {
    const amounts = byKey.get(liveBucketKey(line, buckets) ?? '');
    if (amounts) amounts.push(line.amount);
    else unassigned.push(line.amount);
  }
  return {
    buckets: buckets.map((row) => {
      const amounts = byKey.get(row.key) ?? [];
      return { row, count: amounts.length, planned: sumMoney(amounts, decimals) };
    }),
    unassignedCount: unassigned.length,
    unassignedPlanned: sumMoney(unassigned, decimals),
  };
}

/** The categories step's "Buckets" panel: the editor over the wizard's list. */
export function BudgetWizardBucketsPanel({
  state,
  updateState,
}: {
  state: WizardState;
  updateState: (updates: Partial<WizardState>) => void;
}) {
  const t = useTranslations('budgets');

  const handleChange = (rows: BudgetBucketEditorRow[]) => {
    // A removed bucket unassigns its lines; a renamed one keeps them (the key is stable).
    const keys = new Set(rows.map((row) => row.key));
    const categories = withoutStaleBucketKeys(state.selectedCategories, keys);
    const transfers = withoutStaleBucketKeys(state.selectedTransfers, keys);
    updateState({
      buckets: rows,
      ...(categories !== state.selectedCategories ? { selectedCategories: categories } : {}),
      ...(transfers !== state.selectedTransfers ? { selectedTransfers: transfers } : {}),
    });
  };

  return (
    <Card as="section" padding="sm" aria-labelledby="wizard-buckets-heading">
      <h4
        id="wizard-buckets-heading"
        className="text-base font-semibold text-gray-900 dark:text-gray-100"
      >
        {t('wizardBuckets.title')}
      </h4>
      <p className="mt-1 mb-4 text-sm text-gray-600 dark:text-gray-400">
        {t('wizardBuckets.description')}
      </p>
      <BudgetBucketEditor
        mode="memory"
        currencyCode={state.currencyCode}
        rows={state.buckets}
        onChange={handleChange}
      />
    </Card>
  );
}

/**
 * Wide enough for the longest option at the select's text size (the wrapper
 * is text-xs too, so `ch` measures at it), plus the arrow's padding, and never
 * narrower than 10rem.
 */
export function bucketSelectWidth(labels: readonly string[]): string {
  const longest = Math.max(0, ...labels.map((label) => label.length));
  return `max(10rem, calc(${longest + 1}ch + 2.25rem))`;
}

/** A selected expense or transfer row's bucket choice. */
export function BudgetWizardBucketSelect({
  id,
  lineName,
  value,
  buckets,
  onChange,
}: {
  id: string;
  lineName: string;
  value: string | null;
  buckets: readonly BudgetBucketEditorRow[];
  onChange: (key: string | null) => void;
}) {
  const t = useTranslations('budgets');
  const options = [
    { value: '', label: t('wizardBuckets.unassigned') },
    ...buckets.map((b) => ({ value: b.key, label: b.name })),
  ];
  return (
    <div
      className="w-full sm:w-[var(--bucket-select-width)] max-w-full flex-shrink-0 text-xs"
      style={{ '--bucket-select-width': bucketSelectWidth(options.map((o) => o.label)) } as CSSProperties}
    >
      {/* The global `select` rule is unlayered, so it outranks plain utilities:
          without `!` its padding and text-base push the text below the 28px box. */}
      <Select
        id={id}
        aria-label={t('wizardBuckets.selectLabel', { name: lineName })}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="h-7 py-0! pl-2! pr-7! text-xs!"
        options={options}
      />
    </div>
  );
}

/** Below the category list: lines per bucket and the unassigned remainder. */
export function BudgetWizardBucketTallyCard({
  tally,
  currencyCode,
}: {
  tally: BudgetWizardBucketTally;
  currencyCode: string;
}) {
  const t = useTranslations('budgets');
  const { formatCurrency } = useNumberFormat();
  const rows = [
    ...tally.buckets.map((b) => ({ key: b.row.key, name: b.row.name, count: b.count, planned: b.planned })),
    {
      key: '__unassigned',
      name: t('wizardBuckets.unassigned'),
      count: tally.unassignedCount,
      planned: tally.unassignedPlanned,
    },
  ];
  return (
    <Card as="section" padding="sm" aria-labelledby="wizard-bucket-tally-heading">
      <h4
        id="wizard-bucket-tally-heading"
        className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3"
      >
        {t('wizardBuckets.tallyTitle')}
      </h4>
      <ul className="space-y-1.5" data-testid="wizard-bucket-tally">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-wrap items-center justify-between gap-x-3 text-sm">
            <span className="min-w-0 break-words font-medium text-gray-700 dark:text-gray-300">{row.name}</span>
            <span className="text-gray-600 dark:text-gray-400">
              {t('wizardBuckets.tallyValue', {
                count: row.count,
                amount: formatCurrency(row.planned, currencyCode),
              })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The review step's bucket list and its non-blocking warning (open question B4). */
export function BudgetWizardBucketReview({ state }: { state: WizardState }) {
  const t = useTranslations('budgets');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const tally = tallyBudgetWizardBuckets(
    state.buckets,
    state.selectedCategories,
    state.selectedTransfers,
    state.currencyCode,
  );

  const targetCaption = (row: BudgetBucketEditorRow) =>
    row.targetType === 'PERCENT'
      ? t('bucketEditor.row.percentTarget', { percent: formatPercentTrimmed(row.targetValue) })
      : t('bucketEditor.row.amountTarget', { amount: formatCurrency(row.targetValue, state.currencyCode) });

  const carryCaption = (row: BudgetBucketEditorRow) => {
    if (!row.carryOver) return t('bucketEditor.row.noCarry');
    return row.carryCap === null
      ? t('bucketEditor.row.carries')
      : t('bucketEditor.row.carriesUpTo', { cap: formatCurrency(row.carryCap, state.currencyCode) });
  };

  const warning =
    tally.buckets.length === 0
      ? t('wizardBuckets.review.noBuckets')
      : tally.unassignedCount > 0
        ? t('wizardBuckets.review.unassigned', { count: tally.unassignedCount })
        : null;

  return (
    <Card as="section" padding="md" aria-labelledby="wizard-review-buckets-heading">
      <h4
        id="wizard-review-buckets-heading"
        className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3"
      >
        {t('wizardBuckets.title')}
      </h4>
      {warning && (
        <p
          role="note"
          className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200"
        >
          {warning}
        </p>
      )}
      {tally.buckets.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700" aria-label={t('wizardBuckets.title')}>
          {tally.buckets.map(({ row, count }) => (
            <li key={row.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">{row.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('bucketEditor.row.caption', { target: targetCaption(row), carry: carryCaption(row) })}
                </p>
              </div>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {t('wizardBuckets.review.lineCount', { count })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
