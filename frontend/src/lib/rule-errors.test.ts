import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';
import { createAction, createSplitPart, type EditorAction } from './rule-actions';
import { emptyDraft, type RuleDraft } from './rule-draft';
import {
  draftGaps,
  isKnownRuleErrorCode,
  isRevisionConflict,
  keyForPath,
  placeErrors,
  readRuleApiError,
  structuralFieldErrors,
} from './rule-errors';
import { RULE_VALIDATION_CODES } from './rule-fields';
import { createGroup, createLeaf, type EditorLeaf } from './rule-tree';

function axiosError(status: number, data: unknown): AxiosError {
  const response = { status, data, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } } as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, response);
}

describe('keyForPath', () => {
  it.each([
    ['condition', 'c:'],
    ['condition.field', 'c:'],
    ['condition.stray', 'c:'],
    ['condition.all[1].stray', 'c:1'],
    ['condition.all[0]', 'c:0'],
    ['condition.all[0].value', 'c:0'],
    ['condition.all[0].value[1]', 'c:0'],
    ['condition.all[2].any[1]', 'c:2.1'],
    ['condition.any[0].all[3].any[4].op', 'c:0.3.4'],
    ['actions[2]', 'a:2'],
    ['actions[10].tagIds[3]', 'a:10'],
    ['actions', 'actions'],
    ['name', 'name'],
  ])('%s belongs to %s', (path, key) => {
    expect(keyForPath(path)).toBe(key);
  });

  it.each(['', 'triggers', 'condition2', 'actions[x]'])('%s belongs to no card', (path) => {
    expect(keyForPath(path)).toBeNull();
  });
});

describe('placeErrors', () => {
  it('groups codes by card, once each, and keeps the rest as unplaced', () => {
    const placed = placeErrors([
      { path: 'condition.all[0].value', code: 'VALUE_REQUIRED' },
      { path: 'condition.all[0]', code: 'VALUE_REQUIRED' },
      { path: 'condition.all[0].op', code: 'OPERATOR_NOT_ALLOWED' },
      { path: 'actions[1].categoryId', code: 'INVALID_UUID' },
      { path: 'actions', code: 'TOO_MANY_ACTIONS' },
      { path: 'somewhere.else', code: 'INVALID_SHAPE' },
    ]);
    expect(placed.byKey).toEqual({
      'c:0': ['VALUE_REQUIRED', 'OPERATOR_NOT_ALLOWED'],
      'a:1': ['INVALID_UUID'],
      actions: ['TOO_MANY_ACTIONS'],
    });
    expect(placed.unplaced).toEqual([{ path: 'somewhere.else', code: 'INVALID_SHAPE' }]);
  });
});

describe('readRuleApiError', () => {
  it('reads the status, the machine code and the entries of a 400', () => {
    const error = readRuleApiError(
      axiosError(400, {
        message: 'The rule definition is not valid',
        errorCode: 'INVALID_RULE',
        errors: [{ path: 'actions[0]', code: 'DUPLICATE_ACTION' }, { nope: 1 }, null],
      }),
    );
    expect(error).toEqual({
      status: 400,
      errorCode: 'INVALID_RULE',
      message: 'The rule definition is not valid',
      entries: [{ path: 'actions[0]', code: 'DUPLICATE_ACTION' }],
    });
    expect(isRevisionConflict(error)).toBe(false);
  });

  it('recognises a revision conflict only as a 409 with its code', () => {
    expect(isRevisionConflict(readRuleApiError(axiosError(409, { errorCode: 'REVISION_CONFLICT' })))).toBe(true);
    expect(isRevisionConflict(readRuleApiError(axiosError(409, { errorCode: 'RULE_LIST_CHANGED' })))).toBe(false);
    expect(isRevisionConflict(readRuleApiError(axiosError(400, { errorCode: 'REVISION_CONFLICT' })))).toBe(false);
  });

  it('joins a validation pipe message list and tolerates anything else', () => {
    expect(readRuleApiError(axiosError(400, { message: ['a', 'b'] })).message).toBe('a. b');
    expect(readRuleApiError(axiosError(500, 'oops'))).toEqual({
      status: 500,
      errorCode: undefined,
      message: undefined,
      entries: [],
    });
    expect(readRuleApiError(new Error('network'))).toMatchObject({ status: undefined, entries: [] });
  });
});

describe('isKnownRuleErrorCode', () => {
  it('knows every validation code, the reference check and the local one', () => {
    for (const code of [...RULE_VALIDATION_CODES, 'REFERENCE_NOT_FOUND', 'NAME_REQUIRED']) {
      expect(isKnownRuleErrorCode(code)).toBe(true);
    }
    expect(isKnownRuleErrorCode('SOMETHING_NEW')).toBe(false);
  });
});

describe('draftGaps', () => {
  const draft = (over: Partial<RuleDraft>): RuleDraft => ({ ...emptyDraft(), name: 'Rule', ...over });
  const leaf = (over: Partial<EditorLeaf>): EditorLeaf => ({ ...createLeaf('referenceNumber'), ...over });
  const tags = { ...createAction('add_tags'), tagIds: ['t'] };

  it('is empty for a complete draft', () => {
    expect(draftGaps(draft({ actions: [tags] }))).toEqual([]);
  });

  it('accepts a complete date range and asks for an end that is still empty', () => {
    const condition = createGroup('all', [
      leaf({ field: 'date', op: 'between', value: ['2026-10-01', '2026-10-31'] }),
      leaf({ field: 'date', op: 'between', value: ['2026-10-01', ''] }),
      leaf({ field: 'date', op: 'gte', value: '2026-10-01' }),
    ]);
    expect(draftGaps(draft({ condition, actions: [tags] }))).toEqual([
      { path: 'condition.all[1]', code: 'VALUE_REQUIRED' },
    ]);
  });

  it('asks for a name and an action', () => {
    expect(draftGaps(draft({ name: '  ' }))).toEqual([
      { path: 'name', code: 'NAME_REQUIRED' },
      { path: 'actions', code: 'NO_ACTIONS' },
    ]);
  });

  it('points at the conditions that lack a value, at the path the server would use', () => {
    const condition = createGroup('all', [
      leaf({ value: 'x' }),
      createGroup('any', [
        leaf({ value: '' }),
        leaf({ field: 'tagIds', op: 'hasAny', value: [] }),
        leaf({ field: 'amount', op: 'between', value: [1, undefined] }),
        leaf({ field: 'referenceNumber', op: 'isEmpty', value: undefined }),
        leaf({ field: 'payeeId', op: 'in', value: Array.from({ length: 51 }, () => 'p') }),
      ]),
    ]);
    expect(draftGaps(draft({ condition, actions: [tags] }))).toEqual([
      { path: 'condition.all[1].any[0]', code: 'VALUE_REQUIRED' },
      { path: 'condition.all[1].any[1]', code: 'ARRAY_EMPTY' },
      { path: 'condition.all[1].any[2]', code: 'VALUE_REQUIRED' },
      { path: 'condition.all[1].any[4]', code: 'ARRAY_TOO_LARGE' },
    ]);
  });

  it('points at the actions that lack their parameters', () => {
    const actions = [
      createAction('add_tags'),
      { ...createAction('remove_tags'), tagIds: Array.from({ length: 21 }, () => 't') },
      createAction('set_category'),
      createAction('set_payee'),
      { ...createAction('request_ai_review'), instruction: '   ' },
    ] as RuleDraft['actions'];
    expect(draftGaps(draft({ actions }))).toEqual([
      { path: 'actions[0]', code: 'ARRAY_EMPTY' },
      { path: 'actions[1]', code: 'ARRAY_TOO_LARGE' },
      { path: 'actions[2]', code: 'VALUE_REQUIRED' },
      { path: 'actions[3]', code: 'VALUE_REQUIRED' },
      { path: 'actions[4]', code: 'VALUE_EMPTY' },
    ]);
  });

  it('asks for the text of a text action, and bounds it like the server', () => {
    const actions = [
      createAction('set_payee_from_text'),
      { ...createAction('set_description'), template: '   ' },
      { ...createAction('set_payee_from_text'), template: 'x'.repeat(201) },
      { ...createAction('set_description'), template: 'x'.repeat(201) },
    ] as RuleDraft['actions'];
    expect(draftGaps(draft({ actions }))).toEqual([
      { path: 'actions[0]', code: 'VALUE_EMPTY' },
      { path: 'actions[1]', code: 'VALUE_EMPTY' },
      { path: 'actions[2]', code: 'VALUE_TOO_LONG' },
    ]);
  });

  describe('the glob-trap advice on an existing rule', () => {
    const matchesLeaf = (value: string): EditorLeaf => ({
      ...createLeaf('description'),
      op: 'matches',
      value,
    });
    const withPattern = (value: string): RuleDraft =>
      draft({ condition: createGroup('all', [matchesLeaf(value)]), actions: [tags] });
    const bareWord = [{ path: 'condition.all[0]', code: 'PATTERN_WITHOUT_WILDCARD' }];

    it('blocks a new rule whose pattern has no wildcard', () => {
      expect(draftGaps(withPattern('NETFLIX.COM'))).toEqual(bareWord);
      expect(draftGaps(withPattern('NETFLIX.COM'), null)).toEqual(bareWord);
    });

    it('lets an existing rule with such a pattern be renamed', () => {
      const loaded = withPattern('NETFLIX.COM');
      // The editor rebuilds nodes with new uids; only the saved shape counts.
      const reloaded = { ...withPattern('NETFLIX.COM'), name: 'Renamed' };
      expect(draftGaps(reloaded, loaded)).toEqual([]);
      expect(draftGaps({ ...loaded, triggers: ['create'], actions: [tags] }, loaded)).toEqual([]);
    });

    it('blocks the same rule once its condition is edited', () => {
      const loaded = withPattern('NETFLIX.COM');
      expect(draftGaps(withPattern('HBO.COM'), loaded)).toEqual(bareWord);
      expect(draftGaps(withPattern('a|b'), loaded)).toEqual([
        { path: 'condition.all[0]', code: 'LOOKS_LIKE_REGEX' },
      ]);
    });

    it('still reports the gaps the server refuses whatever the condition', () => {
      const loaded = withPattern('NETFLIX.COM');
      expect(draftGaps({ ...loaded, name: '' }, loaded)).toEqual([{ path: 'name', code: 'NAME_REQUIRED' }]);
    });

    it('reports an empty pattern as a missing value only', () => {
      expect(draftGaps(withPattern(''))).toEqual([{ path: 'condition.all[0]', code: 'VALUE_REQUIRED' }]);
    });
  });

  it('refuses a placeholder no pattern of the rule defines, and a malformed one', () => {
    const condition = createGroup('all', [leaf({ field: 'description', op: 'matches', value: '*{payee}*' })]);
    const actions = [
      { ...createAction('set_payee_from_text'), template: '{payee} {payeeText} {description}' },
      { ...createAction('set_description'), template: '{nope}' },
      { ...createAction('set_description'), template: '{Payee}' },
    ] as RuleDraft['actions'];
    expect(draftGaps(draft({ condition, actions }))).toEqual([
      { path: 'actions[1]', code: 'UNKNOWN_CAPTURE' },
      { path: 'actions[2]', code: 'INVALID_CAPTURE' },
    ]);
  });

  it('refuses the patterns the server refuses, at the leaf', () => {
    const condition = createGroup('all', [
      leaf({ field: 'description', op: 'matches', value: '*{a}*' }),
      leaf({ field: 'referenceNumber', op: 'matches', value: '*{a}*' }),
      leaf({ field: 'referenceNumber', op: 'matches', value: '{Bad}' }),
      leaf({ field: 'payeeText', op: 'matches', value: '{a1}{a2}{a3}{a4}{a5}{a6}' }),
    ]);
    expect(draftGaps(draft({ condition, actions: [tags] }))).toEqual([
      { path: 'condition.all[1]', code: 'DUPLICATE_CAPTURE' },
      { path: 'condition.all[2]', code: 'INVALID_CAPTURE' },
      { path: 'condition.all[3]', code: 'TOO_MANY_CAPTURES' },
    ]);
  });
});

describe('the structural actions', () => {
  const draft = (actions: RuleDraft['actions'], condition = emptyDraft().condition): RuleDraft => ({
    ...emptyDraft(),
    name: 'Rule',
    condition,
    actions,
  });
  const principal = createGroup('all', [
    { ...createLeaf('description'), op: 'matches', value: 'PRINCIPAL: {principal} INTEREST: {interest}PENALTY*' } as EditorLeaf,
  ]);
  const ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const part = (over: Partial<ReturnType<typeof createSplitPart>>) => ({ ...createSplitPart('{principal}'), ...over });
  const split = (parts: ReturnType<typeof createSplitPart>[]): EditorAction => ({ ...createAction('split'), parts }) as EditorAction;

  it('asks for the other account of a transfer, on the side the direction names', () => {
    expect(draftGaps(draft([createAction('convert_to_transfer')]))).toEqual([
      { path: 'actions[0].toAccountId', code: 'VALUE_REQUIRED' },
    ]);
    expect(
      draftGaps(draft([{ ...createAction('convert_to_transfer'), direction: 'from' } as EditorAction])),
    ).toEqual([{ path: 'actions[0].fromAccountId', code: 'VALUE_REQUIRED' }]);
    expect(
      draftGaps(draft([{ ...createAction('convert_to_transfer'), accountId: ACCOUNT } as EditorAction])),
    ).toEqual([]);
  });

  it('asks for each part its amount, a capture the patterns define, and an account for a transfer part', () => {
    const actions = [
      split([
        part({ amount: '' }),
        part({ amount: '{nothing}' }),
        part({ amount: 'principal' }),
        part({ amount: '{interest}', kind: 'transfer' }),
        part({ amount: '{principal}', categoryId: ACCOUNT }),
      ]),
    ];
    expect(draftGaps(draft(actions, principal))).toEqual([
      { path: 'actions[0].parts[0].amount', code: 'VALUE_REQUIRED' },
      { path: 'actions[0].parts[1].amount', code: 'UNKNOWN_CAPTURE' },
      { path: 'actions[0].parts[2].amount', code: 'INVALID_SHAPE' },
      { path: 'actions[0].parts[3].transferAccountId', code: 'VALUE_REQUIRED' },
    ]);
  });

  it('refuses a second rest and a whitespace-only or overlong memo', () => {
    const actions = [
      split([part({ amount: 'rest' }), part({ amount: 'rest', description: '   ' }), part({ description: 'x'.repeat(201) })]),
    ];
    expect(draftGaps(draft(actions, principal))).toEqual([
      { path: 'actions[0].parts[1].amount', code: 'DUPLICATE_ACTION' },
      { path: 'actions[0].parts[1].description', code: 'VALUE_EMPTY' },
      { path: 'actions[0].parts[2].description', code: 'VALUE_TOO_LONG' },
    ]);
  });

  it('reports a structural action next to set_category as CONFLICTING_ACTIONS on the structural card', () => {
    const category = { ...createAction('set_category'), categoryId: ACCOUNT } as EditorAction;
    const convert = { ...createAction('convert_to_transfer'), accountId: ACCOUNT } as EditorAction;
    expect(draftGaps(draft([category, convert]))).toEqual([{ path: 'actions[1]', code: 'CONFLICTING_ACTIONS' }]);
    expect(draftGaps(draft([convert, category]))).toEqual([{ path: 'actions[0]', code: 'CONFLICTING_ACTIONS' }]);
  });

  it('refuses a second structural action as DUPLICATE_ACTION', () => {
    const convert = { ...createAction('convert_to_transfer'), accountId: ACCOUNT } as EditorAction;
    expect(draftGaps(draft([convert, convert]))).toEqual([{ path: 'actions[1]', code: 'DUPLICATE_ACTION' }]);
  });
});

describe('structuralFieldErrors', () => {
  it('puts each entry at the field its path names and the rest on the card', () => {
    const placed = placeErrors([
      { path: 'actions[0]', code: 'CONFLICTING_ACTIONS' },
      { path: 'actions[0].toAccountId', code: 'REFERENCE_NOT_FOUND' },
      { path: 'actions[0].parts', code: 'ARRAY_TOO_LARGE' },
      { path: 'actions[0].parts[1]', code: 'CONFLICTING_ACTIONS' },
      { path: 'actions[0].parts[1].amount', code: 'UNKNOWN_CAPTURE' },
      { path: 'actions[0].parts[1].amount', code: 'UNKNOWN_CAPTURE' },
      { path: 'actions[0].parts[2].payeeId', code: 'CONFLICTING_ACTIONS' },
      { path: 'actions[0].stray', code: 'UNKNOWN_KEY' },
      { path: 'actions[1].parts[0].amount', code: 'VALUE_TYPE' },
    ]);
    expect(placed.byPath['actions[0].parts[1].amount']).toEqual(['UNKNOWN_CAPTURE']);
    const result = structuralFieldErrors(placed, 0);
    expect(result.shell).toEqual(['CONFLICTING_ACTIONS', 'UNKNOWN_KEY']);
    expect(result.fields).toEqual({
      toAccountId: ['REFERENCE_NOT_FOUND'],
      parts: ['ARRAY_TOO_LARGE'],
      'parts[1]': ['CONFLICTING_ACTIONS'],
      'parts[1].amount': ['UNKNOWN_CAPTURE'],
      'parts[2].payeeId': ['CONFLICTING_ACTIONS'],
    });
    expect(structuralFieldErrors(placed, 1).fields).toEqual({ 'parts[0].amount': ['VALUE_TYPE'] });
  });

  it('still lands every entry on its card in byKey', () => {
    const placed = placeErrors([{ path: 'actions[0].parts[1].amount', code: 'UNKNOWN_CAPTURE' }]);
    expect(placed.byKey).toEqual({ 'a:0': ['UNKNOWN_CAPTURE'] });
  });
});
