import { describe, it, expect, vi } from 'vitest';
import enBudgets from '@/i18n/messages/en/budgets.json';
import {
  BUDGET_BUCKET_PRESETS,
  findBudgetBucketPreset,
  materializeBudgetBucketPreset,
  type BudgetBucketPresetId,
} from './budget-bucket-presets';

/** Looks a dotted key up in the English `budgets` catalog. */
function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enBudgets);
}

function englishRows(id: BudgetBucketPresetId) {
  let n = 0;
  return materializeBudgetBucketPreset(
    findBudgetBucketPreset(id),
    (key) => lookup(key) as string,
    () => `key-${++n}`,
  ).map(({ key: _key, ...row }) => row);
}

describe('budget bucket presets', () => {
  it('offers Three buckets, Four buckets and Start from scratch, in that order', () => {
    expect(BUDGET_BUCKET_PRESETS.map((p) => p.id)).toEqual(['THREE', 'FOUR', 'SCRATCH']);
  });

  it('Three buckets is Fixed costs 50, Everyday spending 30, Savings 20 with carry-over', () => {
    expect(englishRows('THREE')).toEqual([
      { name: 'Fixed costs', targetType: 'PERCENT', targetValue: 50, carryOver: false, carryCap: null },
      { name: 'Everyday spending', targetType: 'PERCENT', targetValue: 30, carryOver: false, carryCap: null },
      { name: 'Savings', targetType: 'PERCENT', targetValue: 20, carryOver: true, carryCap: null },
    ]);
  });

  it('Four buckets is 60/10/10/20 with carry-over on the last two', () => {
    expect(englishRows('FOUR')).toEqual([
      { name: 'Daily expenses', targetType: 'PERCENT', targetValue: 60, carryOver: false, carryCap: null },
      { name: 'Splurge', targetType: 'PERCENT', targetValue: 10, carryOver: false, carryCap: null },
      { name: 'Long-term goals', targetType: 'PERCENT', targetValue: 10, carryOver: true, carryCap: null },
      { name: 'Safety and debt', targetType: 'PERCENT', targetValue: 20, carryOver: true, carryCap: null },
    ]);
  });

  it('Start from scratch has no buckets', () => {
    expect(englishRows('SCRATCH')).toEqual([]);
  });

  it('names every preset and every bucket with a key the English catalog has', () => {
    for (const preset of BUDGET_BUCKET_PRESETS) {
      expect(typeof lookup(preset.labelKey), preset.labelKey).toBe('string');
      for (const bucket of preset.buckets) {
        expect(typeof lookup(bucket.nameKey), bucket.nameKey).toBe('string');
      }
    }
  });

  it('translates each name once and gives each row its own key', () => {
    const translate = vi.fn((key: string) => `T(${key})`);
    let n = 0;
    const rows = materializeBudgetBucketPreset(findBudgetBucketPreset('FOUR'), translate, () => `k${++n}`);

    expect(translate).toHaveBeenCalledTimes(4);
    expect(rows.map((r) => r.key)).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect(rows[0].name).toBe('T(bucketEditor.presetBucketNames.dailyExpenses)');
  });

  it('refuses an unknown preset id', () => {
    expect(() => findBudgetBucketPreset('FIVE' as BudgetBucketPresetId)).toThrow(/Unknown bucket preset/);
  });
});
