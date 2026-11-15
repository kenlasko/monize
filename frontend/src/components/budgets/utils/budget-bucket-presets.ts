import type { BudgetBucketTargetType } from '@/types/budget';

/**
 * One bucket as the editor holds it before (or without) a server id: the
 * fields of `CreateBudgetBucketData`, with the cap's absence spelled `null`.
 */
export interface BudgetBucketDraft {
  name: string;
  targetType: BudgetBucketTargetType;
  targetValue: number;
  carryOver: boolean;
  /** `null` is no cap; only meaningful while `carryOver` is on. */
  carryCap: number | null;
}

/**
 * A row of `BudgetBucketEditor`. `key` is unique in the list: the bucket's id
 * once it is persisted, a `newClientId()` while it lives only in memory (the
 * wizard sends it as the apply request's bucket `key`).
 */
export interface BudgetBucketEditorRow extends BudgetBucketDraft {
  key: string;
}

export interface BudgetBucketPresetBucket {
  /** A `budgets` catalog key, resolved once when the preset is applied. */
  nameKey: string;
  targetType: BudgetBucketTargetType;
  targetValue: number;
  carryOver: boolean;
}

export type BudgetBucketPresetId = 'THREE' | 'FOUR' | 'SCRATCH';

export interface BudgetBucketPreset {
  id: BudgetBucketPresetId;
  /** A `budgets` catalog key naming the preset. */
  labelKey: string;
  buckets: readonly BudgetBucketPresetBucket[];
}

const NAMES = 'bucketEditor.presetBucketNames';

/** The presets the editor offers (design section 10). */
export const BUDGET_BUCKET_PRESETS: readonly BudgetBucketPreset[] = [
  {
    id: 'THREE',
    labelKey: 'bucketEditor.presets.THREE',
    buckets: [
      { nameKey: `${NAMES}.fixedCosts`, targetType: 'PERCENT', targetValue: 50, carryOver: false },
      { nameKey: `${NAMES}.everydaySpending`, targetType: 'PERCENT', targetValue: 30, carryOver: false },
      { nameKey: `${NAMES}.savings`, targetType: 'PERCENT', targetValue: 20, carryOver: true },
    ],
  },
  {
    id: 'FOUR',
    labelKey: 'bucketEditor.presets.FOUR',
    buckets: [
      { nameKey: `${NAMES}.dailyExpenses`, targetType: 'PERCENT', targetValue: 60, carryOver: false },
      { nameKey: `${NAMES}.splurge`, targetType: 'PERCENT', targetValue: 10, carryOver: false },
      { nameKey: `${NAMES}.longTermGoals`, targetType: 'PERCENT', targetValue: 10, carryOver: true },
      { nameKey: `${NAMES}.safetyAndDebt`, targetType: 'PERCENT', targetValue: 20, carryOver: true },
    ],
  },
  {
    id: 'SCRATCH',
    labelKey: 'bucketEditor.presets.SCRATCH',
    buckets: [],
  },
];

export function findBudgetBucketPreset(id: BudgetBucketPresetId): BudgetBucketPreset {
  const preset = BUDGET_BUCKET_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown bucket preset ${id}`);
  return preset;
}

/**
 * Turns a preset into editor rows. The names are translated here, once; from
 * then on a row's name is the person's own data and never re-translated.
 * `makeKey` supplies each row's client key (`newClientId` in the editor).
 */
export function materializeBudgetBucketPreset(
  preset: BudgetBucketPreset,
  translate: (key: string) => string,
  makeKey: () => string,
): BudgetBucketEditorRow[] {
  return preset.buckets.map((bucket) => ({
    key: makeKey(),
    name: translate(bucket.nameKey),
    targetType: bucket.targetType,
    targetValue: bucket.targetValue,
    carryOver: bucket.carryOver,
    carryCap: null,
  }));
}
