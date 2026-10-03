import { describe, expect, it } from 'vitest';
import { makeRule } from '@/components/rules/rules-test-fixtures';
import { createAction, createSplitPart, type EditorAction } from './rule-actions';
import {
  actionToApi,
  conditionToApi,
  draftFromRule,
  draftSignature,
  draftToPayload,
  emptyDraft,
} from './rule-draft';
import { createGroup, createLeaf, type EditorGroup, type EditorLeaf } from './rule-tree';
import type { TransactionRule } from '@/types/transaction-rule';

const UUID = '11111111-1111-4111-8111-111111111111';

const read = (over: Partial<TransactionRule>) => draftFromRule(makeRule(over));

describe('emptyDraft', () => {
  it('is an enabled rule for both triggers that matches everything and does nothing yet', () => {
    const draft = emptyDraft();
    expect(draft).toMatchObject({ name: '', enabled: true, triggers: ['create', 'import'], stopProcessing: false });
    expect(draft.condition.children).toEqual([]);
    expect(draft.actions).toEqual([]);
  });
});

describe('the text actions', () => {
  const actions = [
    { type: 'set_payee_from_text', template: ' {payee}  ', createIfMissing: true, onlyIfEmpty: false },
    { type: 'set_description', template: '{description} | {ref}', mode: 'prepend', onlyIfEmpty: true },
  ];

  it('opens and saves as stored: the text untrimmed, every flag and mode kept', () => {
    const { draft, repaired } = read({ actions: actions as never });
    expect(repaired).toBe(0);
    expect(draft.actions.map((a) => a.type)).toEqual(['set_payee_from_text', 'set_description']);
    expect(draft.actions.map(actionToApi)).toEqual(actions);
  });

  it('reads a missing flag or mode as the default the server applies', () => {
    const { draft, repaired } = read({
      actions: [
        { type: 'set_payee_from_text', template: '{payee}' },
        { type: 'set_description', template: 'x' },
      ] as never,
    });
    expect(repaired).toBe(0);
    expect(draft.actions.map(actionToApi)).toEqual([
      { type: 'set_payee_from_text', template: '{payee}', createIfMissing: false, onlyIfEmpty: true },
      { type: 'set_description', template: 'x', mode: 'replace', onlyIfEmpty: false },
    ]);
  });

  it('counts a mode or a template it cannot read as repaired', () => {
    const { draft, repaired } = read({
      actions: [
        { type: 'set_description', template: 'x', mode: 'swap', onlyIfEmpty: false },
        { type: 'set_payee_from_text', template: 5, createIfMissing: false, onlyIfEmpty: true },
      ] as never,
    });
    expect(repaired).toBe(2);
    expect(draft.actions.map(actionToApi)).toEqual([
      { type: 'set_description', template: 'x', mode: 'replace', onlyIfEmpty: false },
      { type: 'set_payee_from_text', template: '', createIfMissing: false, onlyIfEmpty: true },
    ]);
  });

  it('writes exactly the keys the DTO takes', () => {
    expect(Object.keys(actionToApi(createAction('set_payee_from_text'))).sort()).toEqual(
      ['createIfMissing', 'onlyIfEmpty', 'template', 'type'],
    );
    expect(Object.keys(actionToApi(createAction('set_description'))).sort()).toEqual(
      ['mode', 'onlyIfEmpty', 'template', 'type'],
    );
  });
});

describe('draftFromRule: the X3 fields', () => {
  it('keeps a condition on each of the fields, values and operators intact', () => {
    const condition = {
      all: [
        { field: 'dayOfMonth', op: 'in', value: [1, 15] },
        { field: 'dayOfMonth', op: 'between', value: [10, 20] },
        { field: 'dayOfMonth', op: 'gte', value: 28 },
        { field: 'weekday', op: 'in', value: ['SAT', 'SUN'] },
        { field: 'status', op: 'neq', value: 'VOID' },
        { field: 'hasAttachment', op: 'eq', value: false },
        { field: 'referenceNumber', op: 'isEmpty' },
        { field: 'referenceNumber', op: 'matches', value: 'CHK-{n}' },
      ],
    };
    const { draft, repaired } = read({ condition: condition as never });
    expect(repaired).toBe(0);
    expect(conditionToApi(draft.condition)).toEqual(condition);
  });
});

describe('draftFromRule', () => {
  it('reads a valid rule without repairing anything', () => {
    const { draft, repaired } = draftFromRule(makeRule());
    expect(repaired).toBe(0);
    expect(draft.name).toBe('Coffee shops');
    expect(draft.condition).toMatchObject({ kind: 'group', match: 'all', not: false });
    expect(draft.condition.children[0]).toMatchObject({
      kind: 'leaf',
      field: 'referenceNumber',
      op: 'contains',
      value: 'coffee',
    });
    expect(draft.actions.map((a) => a.type)).toEqual(['add_tags', 'set_payee']);
  });

  it('round-trips a nested rule through the editor and back to the same JSON', () => {
    const condition = {
      all: [
        { field: 'type', op: 'eq', value: 'TRANSFER' },
        { any: [{ field: 'amount', op: 'between', value: [-500, -100] }, { field: 'referenceNumber', op: 'isEmpty' }], not: true },
      ],
    };
    const actions = [
      { type: 'set_category', categoryId: UUID, onlyIfEmpty: false },
      { type: 'remove_tags', tagIds: [UUID] },
      { type: 'request_ai_review', instruction: 'Check the split' },
    ];
    const { draft, repaired } = read({ condition, actions } as Partial<TransactionRule>);
    expect(repaired).toBe(0);
    expect(conditionToApi(draft.condition)).toEqual(condition);
    expect(draft.actions.map(actionToApi)).toEqual(actions);
  });

  it('wraps a bare leaf in a group', () => {
    const { draft, repaired } = read({ condition: { field: 'referenceNumber', op: 'eq', value: 'x' } });
    expect(repaired).toBe(0);
    expect(draft.condition.children).toHaveLength(1);
  });

  it('opens an unreadable definition as an empty one and counts the repairs', () => {
    const { draft, repaired } = read({ condition: {} as never, actions: [] });
    expect(draft.condition.children).toEqual([]);
    expect(draft.actions).toEqual([]);
    expect(repaired).toBeGreaterThan(0);
  });

  it('drops parts it cannot read and resets a leaf whose operator the field does not allow', () => {
    const condition = {
      all: [
        { field: 'nope', op: 'eq', value: 'x' },
        'text',
        { field: 'type', op: 'contains', value: 'x' },
        { field: 'referenceNumber', op: 'eq', value: 5 },
        { field: 'amount', op: 'between', value: [1] },
        { field: 'referenceNumber', op: 'isEmpty', value: 'stray' },
        { all: 'not a list' },
        { all: [], any: [] },
      ],
    };
    const { draft, repaired } = read({ condition } as never);
    expect(repaired).toBe(8);
    const kinds = draft.condition.children.map((c) => (c.kind === 'leaf' ? `${c.field}:${c.op}` : `group:${c.match}`));
    expect(kinds).toEqual(['type:eq', 'referenceNumber:eq', 'amount:between', 'referenceNumber:isEmpty', 'group:all']);
    expect((draft.condition.children[1] as EditorLeaf).value).toBe('');
    expect((draft.condition.children[3] as EditorLeaf).value).toBeUndefined();
  });

  it('repairs actions: unknown types dropped, missing parameters blank, missing flag on', () => {
    const actions = [
      { type: 'delete_everything' },
      null,
      { type: 'add_tags', tagIds: 'x' },
      { type: 'set_category' },
      { type: 'set_payee', payeeId: UUID },
      { type: 'request_ai_review' },
    ];
    const { draft, repaired } = read({ actions } as never);
    expect(repaired).toBe(5);
    expect(draft.actions).toMatchObject([
      { type: 'add_tags', tagIds: [] },
      { type: 'set_category', categoryId: '', onlyIfEmpty: true },
      { type: 'set_payee', payeeId: UUID, onlyIfEmpty: true },
      { type: 'request_ai_review', instruction: '' },
    ]);
  });

  it('counts actions that are not a list', () => {
    const { draft, repaired } = read({ actions: 'x' as never });
    expect(draft.actions).toEqual([]);
    expect(repaired).toBe(1);
  });

  it('keeps only known triggers, in the server order', () => {
    expect(read({ triggers: ['import', 'create', 'manual'] as never }).draft.triggers).toEqual(['create', 'import']);
    expect(read({ triggers: undefined as never }).draft.triggers).toEqual([]);
  });

  it('reads flags strictly and tolerates a missing name', () => {
    const { draft } = read({ name: undefined as never, enabled: undefined as never, stopProcessing: true });
    expect(draft).toMatchObject({ name: '', enabled: false, stopProcessing: true });
  });
});

describe('the active window', () => {
  it('opens an unlimited rule with both sides empty and sends neither key', () => {
    const { draft, repaired } = read({});
    expect(repaired).toBe(0);
    expect(draft).toMatchObject({ activeFrom: '', activeTo: '' });
    // Absent, not null: a backend that predates the window refuses an unknown key.
    const payload = draftToPayload(draft, draft);
    expect(payload).not.toHaveProperty('activeFrom');
    expect(payload).not.toHaveProperty('activeTo');
    expect(draftToPayload(draft)).not.toHaveProperty('activeFrom');
  });

  it('opens and saves a stored window as it is', () => {
    const { draft } = read({ activeFrom: '2026-10-01', activeTo: '2026-12-31' });
    expect(draft).toMatchObject({ activeFrom: '2026-10-01', activeTo: '2026-12-31' });
    expect(draftToPayload(draft)).toMatchObject({ activeFrom: '2026-10-01', activeTo: '2026-12-31' });
  });

  it('reads a stored rule from an older server, with no window at all, as open', () => {
    const { draft } = read({ activeFrom: undefined as never, activeTo: undefined as never });
    expect(draft).toMatchObject({ activeFrom: '', activeTo: '' });
  });

  it('keeps one open side out of the payload: a date is itself, an untouched open side is absent', () => {
    const draft = { ...emptyDraft(), activeFrom: '2026-10-01' };
    const payload = draftToPayload(draft, emptyDraft());
    expect(payload).toMatchObject({ activeFrom: '2026-10-01' });
    expect(payload).not.toHaveProperty('activeTo');
  });

  it('sends null for a side the stored rule had and the draft cleared, and only for that side', () => {
    const { draft: loaded } = read({ activeFrom: '2026-10-01', activeTo: '2026-12-31' });
    const cleared = { ...loaded, activeFrom: '' };
    const payload = draftToPayload(cleared, loaded);
    expect(payload).toMatchObject({ activeFrom: null, activeTo: '2026-12-31' });
    const { draft: halfOpen } = read({ activeFrom: '2026-10-01' });
    expect(draftToPayload({ ...halfOpen, activeFrom: '' }, halfOpen)).toMatchObject({ activeFrom: null });
    expect(draftToPayload({ ...halfOpen, activeFrom: '' }, halfOpen)).not.toHaveProperty('activeTo');
  });

  it('is part of the signature, so moving the window is an unsaved change', () => {
    const base = emptyDraft();
    expect(draftSignature({ ...base, activeTo: '2026-12-31' })).not.toBe(draftSignature(base));
  });

  it('reads and writes a date condition with its text value and a range of two texts', () => {
    const condition = {
      all: [
        { field: 'date', op: 'gte', value: '2026-10-01' },
        { field: 'date', op: 'between', value: ['2026-10-01', '2026-10-31'] },
      ],
    };
    const { draft, repaired } = read({ condition: condition as never });
    expect(repaired).toBe(0);
    expect(conditionToApi(draft.condition)).toEqual(condition);
  });

  it('repairs a date range stored as numbers', () => {
    const { repaired } = read({ condition: { all: [{ field: 'date', op: 'between', value: [1, 2] }] } as never });
    expect(repaired).toBe(1);
  });
});

describe('draftToPayload', () => {
  it('sends exactly the fields the DTO accepts, with the name trimmed', () => {
    const draft = { ...emptyDraft(), name: '  Rent  ', actions: [{ ...createAction('add_tags'), tagIds: [UUID] } as never] };
    expect(draftToPayload(draft)).toEqual({
      name: 'Rent',
      enabled: true,
      triggers: ['create', 'import'],
      condition: { all: [] },
      actions: [{ type: 'add_tags', tagIds: [UUID] }],
      stopProcessing: false,
    });
  });

  it('writes not only when it is on, any groups as any, and omits the value of isEmpty', () => {
    const empty: EditorLeaf = { ...createLeaf('referenceNumber'), op: 'isEmpty', value: undefined };
    const group: EditorGroup = { ...createGroup('any', [empty]), not: true };
    expect(conditionToApi(group)).toEqual({ any: [{ field: 'referenceNumber', op: 'isEmpty' }], not: true });
    expect(conditionToApi(createGroup('all'))).toEqual({ all: [] });
  });

  it('writes every action type in its DTO shape, onlyIfEmpty included', () => {
    expect(actionToApi({ uid: 'u', type: 'set_category', categoryId: UUID, onlyIfEmpty: false })).toEqual({
      type: 'set_category',
      categoryId: UUID,
      onlyIfEmpty: false,
    });
    expect(actionToApi({ uid: 'u', type: 'set_payee', payeeId: UUID, onlyIfEmpty: true })).toEqual({
      type: 'set_payee',
      payeeId: UUID,
      onlyIfEmpty: true,
    });
    expect(actionToApi({ uid: 'u', type: 'request_ai_review', instruction: 'x' })).toEqual({
      type: 'request_ai_review',
      instruction: 'x',
    });
    expect(actionToApi({ uid: 'u', type: 'remove_tags', tagIds: [UUID] })).toEqual({ type: 'remove_tags', tagIds: [UUID] });
  });

  it('gives two drafts that would save the same rule the same signature, whatever their identities', () => {
    const a = draftFromRule(makeRule()).draft;
    const b = draftFromRule(makeRule()).draft;
    expect(a.condition.uid).not.toBe(b.condition.uid);
    expect(draftSignature(a)).toBe(draftSignature(b));
    expect(draftSignature({ ...a, name: 'Other' })).not.toBe(draftSignature(a));
    expect(draftSignature({ ...a, name: ' Coffee shops ' })).toBe(draftSignature(a));
  });
});

describe('the structural actions', () => {
  const ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const actions = [
    { type: 'convert_to_transfer', toAccountId: ACCOUNT, clearCategory: true, payeeId: UUID },
    {
      type: 'split',
      payeeId: UUID,
      parts: [
        { amount: '{principal}', transferAccountId: ACCOUNT, payeeId: UUID },
        { amount: '{interest}', categoryId: UUID, description: 'interest' },
        { amount: 'rest' },
      ],
    },
  ];

  it('opens and saves exactly as stored, with nothing repaired', () => {
    const { draft, repaired } = read({ actions: actions as never });
    expect(repaired).toBe(0);
    expect(draft.actions.map((a) => a.type)).toEqual(['convert_to_transfer', 'split']);
    expect(draft.actions.map(actionToApi)).toEqual(actions);
    expect(draftToPayload(draft).actions).toEqual(actions);
  });

  it('reads a transfer part and a category part as the kind they are', () => {
    const { draft } = read({ actions: [actions[1]] as never });
    const split = draft.actions[0];
    if (split.type !== 'split') throw new Error('not a split');
    expect(split.parts.map((p) => p.kind)).toEqual(['transfer', 'category', 'category']);
    expect(split.parts[0]).toMatchObject({ amount: '{principal}', transferAccountId: ACCOUNT, payeeId: UUID, categoryId: '' });
    expect(split.parts[1]).toMatchObject({ categoryId: UUID, description: 'interest', transferAccountId: '' });
    expect(split.parts[2]).toMatchObject({ amount: 'rest', categoryId: '', transferAccountId: '', description: '' });
  });

  it('writes the income side as fromAccountId and a card with no payee without one', () => {
    const stored = { type: 'convert_to_transfer', fromAccountId: ACCOUNT, clearCategory: false };
    const { draft, repaired } = read({ actions: [stored] as never });
    expect(repaired).toBe(0);
    expect(draft.actions[0]).toMatchObject({ direction: 'from', accountId: ACCOUNT, clearCategory: false, payeeId: '' });
    expect(actionToApi(draft.actions[0])).toEqual(stored);
  });

  it('writes what the editor holds: a category line has no payee, a transfer line no category', () => {
    const split = {
      ...createAction('split'),
      payeeId: UUID,
      parts: [
        { ...createSplitPart('{principal}'), kind: 'transfer' as const, transferAccountId: ACCOUNT, payeeId: UUID, categoryId: 'stale' },
        { ...createSplitPart('rest'), kind: 'category' as const, categoryId: UUID, payeeId: 'stale', description: 'interest' },
      ],
    } as EditorAction;
    expect(actionToApi(split)).toEqual({
      type: 'split',
      payeeId: UUID,
      parts: [
        { amount: '{principal}', transferAccountId: ACCOUNT, payeeId: UUID },
        { amount: 'rest', categoryId: UUID, description: 'interest' },
      ],
    });
  });

  it('leaves out a transfer account that is not chosen yet, so the server names the field', () => {
    expect(actionToApi(createAction('convert_to_transfer'))).toEqual({ type: 'convert_to_transfer', clearCategory: true });
  });

  it('gives each a card of its own that survives a signature round trip', () => {
    const { draft } = read({ actions: actions as never });
    const again = draftFromRule(makeRule({ actions: draftToPayload(draft).actions as never })).draft;
    expect(draftSignature(again)).toBe(draftSignature(draft));
  });

  it('repairs what the server would refuse and counts it', () => {
    const { draft, repaired } = read({
      actions: [
        { type: 'convert_to_transfer', toAccountId: ACCOUNT, fromAccountId: ACCOUNT, clearCategory: true },
        {
          type: 'split',
          parts: [
            { amount: '{a}', categoryId: UUID, transferAccountId: ACCOUNT },
            { amount: '{b}', categoryId: UUID, payeeId: UUID },
          ],
        },
      ] as never,
    });
    expect(repaired).toBe(3);
    expect(draft.actions[0]).toMatchObject({ direction: 'to', accountId: ACCOUNT });
    const split = draft.actions[1];
    if (split.type !== 'split') throw new Error('not a split');
    expect(split.parts[0]).toMatchObject({ kind: 'transfer', transferAccountId: ACCOUNT, categoryId: '' });
    expect(split.parts[1]).toMatchObject({ kind: 'category', categoryId: UUID, payeeId: '' });
  });

  it('opens a split with no parts as two blank ones', () => {
    const { draft, repaired } = read({ actions: [{ type: 'split' }] as never });
    expect(repaired).toBeGreaterThan(0);
    const split = draft.actions[0];
    if (split.type !== 'split') throw new Error('not a split');
    expect(split.parts).toHaveLength(2);
  });
});
