import { describe, expect, it } from 'vitest';
import { changedRuleParts, type RuleDiffInput } from './rule-diff';

const base: RuleDiffInput = {
  name: 'Coffee',
  enabled: true,
  triggers: ['create', 'import'],
  condition: { all: [{ field: 'payeeText', op: 'contains', value: 'coffee' }] },
  actions: [{ type: 'add_tags', tagIds: ['t1'] }],
  stopProcessing: false,
};

describe('changedRuleParts', () => {
  it('reports nothing for an identical rule', () => {
    expect(changedRuleParts(base, { ...base })).toEqual([]);
  });

  it('reports a moved window, and reads an absent side as an open one', () => {
    expect(changedRuleParts(base, { ...base, activeFrom: '2026-10-01' })).toEqual(['activeWindow']);
    expect(changedRuleParts({ ...base, activeTo: null }, { ...base })).toEqual([]);
    expect(
      changedRuleParts({ ...base, activeFrom: '2026-10-01' }, { ...base, activeFrom: '2026-10-01', activeTo: '2026-12-31' }),
    ).toEqual(['activeWindow']);
    expect(changedRuleParts({ ...base, activeFrom: '2026-10-01' }, { ...base, activeFrom: null })).toEqual(['activeWindow']);
  });

  it('does not read a different trigger order as a change', () => {
    expect(changedRuleParts(base, { ...base, triggers: ['import', 'create'] })).toEqual([]);
  });

  it('reports each changed part in the editor order', () => {
    const after: RuleDiffInput = {
      name: 'Coffee shops',
      enabled: false,
      triggers: ['create'],
      condition: { any: [] },
      actions: [{ type: 'add_tags', tagIds: ['t2'] }],
      stopProcessing: true,
    };
    expect(changedRuleParts(base, after)).toEqual([
      'name',
      'enabled',
      'triggers',
      'condition',
      'actions',
      'stopProcessing',
    ]);
  });

  it('reads a reordering of the actions as a change', () => {
    const two: RuleDiffInput = {
      ...base,
      actions: [
        { type: 'add_tags', tagIds: ['t1'] },
        { type: 'set_payee', payeeId: 'p1', onlyIfEmpty: false },
      ],
    };
    expect(changedRuleParts(two, { ...two, actions: [...two.actions].reverse() })).toEqual(['actions']);
  });
});
