import { describe, expect, it } from 'vitest';
import {
  EDITOR_ACTION_TYPES,
  addSplitPart,
  availableActionTypes,
  canAddSplitPart,
  canRemoveSplitPart,
  captureOfAmount,
  createSplitPart,
  removeSplitPart,
  restIsFree,
  updateSplitPart,
  canAddAction,
  canDuplicateAction,
  canMoveAction,
  changeActionType,
  createAction,
  duplicateAction,
  moveAction,
  removeAction,
  updateAction,
  type EditorAction,
} from './rule-actions';
import { MAX_RULE_ACTIONS, RULE_ACTION_TYPES } from './rule-fields';

const many = (n: number): EditorAction[] => Array.from({ length: n }, () => createAction('add_tags'));

describe('createAction', () => {
  it('starts set_category and set_payee with onlyIfEmpty on', () => {
    expect(createAction('set_category')).toMatchObject({ categoryId: '', onlyIfEmpty: true });
    expect(createAction('set_payee')).toMatchObject({ payeeId: '', onlyIfEmpty: true });
  });

  it('starts the text actions where the server defaults are: a payee is filled and not created, a description replaced', () => {
    expect(createAction('set_payee_from_text')).toMatchObject({ template: '', createIfMissing: false, onlyIfEmpty: true });
    expect(createAction('set_description')).toMatchObject({ template: '', mode: 'replace', onlyIfEmpty: false });
  });

  it('starts the other types blank', () => {
    expect(createAction()).toMatchObject({ type: 'add_tags', tagIds: [] });
    expect(createAction('remove_tags')).toMatchObject({ type: 'remove_tags', tagIds: [] });
    expect(createAction('request_ai_review')).toMatchObject({ instruction: '' });
  });

  it('keeps the card when its type changes, and its parameters start over', () => {
    const tags = { ...createAction('add_tags'), tagIds: ['t1'] } as EditorAction;
    const category = changeActionType(tags, 'set_category');
    expect(category).toMatchObject({ type: 'set_category', uid: tags.uid, onlyIfEmpty: true });
    expect(changeActionType(tags, 'add_tags')).toBe(tags);
  });
});

describe('limits', () => {
  it('allows at most MAX_RULE_ACTIONS actions and no duplicate past it', () => {
    expect(canAddAction(many(MAX_RULE_ACTIONS - 1))).toBe(true);
    expect(canAddAction(many(MAX_RULE_ACTIONS))).toBe(false);
    expect(canDuplicateAction(many(MAX_RULE_ACTIONS), 0)).toBe(false);
    expect(duplicateAction(many(MAX_RULE_ACTIONS), 0)).toHaveLength(MAX_RULE_ACTIONS);
  });

  it('offers request_ai_review only to the card that is one, or while none is', () => {
    const list = [createAction('add_tags'), createAction('request_ai_review')];
    expect(availableActionTypes(list, 0)).not.toContain('request_ai_review');
    expect(availableActionTypes(list, 1)).toContain('request_ai_review');
    expect(availableActionTypes([createAction('add_tags')], 0)).toContain('request_ai_review');
  });

  it('never duplicates an AI review', () => {
    const list = [createAction('request_ai_review')];
    expect(canDuplicateAction(list, 0)).toBe(false);
    expect(duplicateAction(list, 0)).toBe(list);
    expect(canDuplicateAction(list, 4)).toBe(false);
  });
});

describe('list edits', () => {
  it('updates and removes by index without mutating', () => {
    const list = many(3);
    const changed = updateAction(list, 1, { ...list[1], type: 'add_tags', tagIds: ['x'] });
    expect(changed[1]).toMatchObject({ tagIds: ['x'] });
    expect(list[1]).toMatchObject({ tagIds: [] });
    expect(removeAction(list, 0).map((a) => a.uid)).toEqual([list[1].uid, list[2].uid]);
  });

  it('moves a card and stops at the ends', () => {
    const list = many(3);
    expect(canMoveAction(list, 0, -1)).toBe(false);
    expect(canMoveAction(list, 2, 1)).toBe(false);
    expect(canMoveAction(list, 5, 1)).toBe(false);
    expect(moveAction(list, 0, -1)).toBe(list);
    expect(moveAction(list, 0, 1).map((a) => a.uid)).toEqual([list[1].uid, list[0].uid, list[2].uid]);
  });

  it('duplicates a card right after itself with a new identity', () => {
    const list = many(2);
    const next = duplicateAction(list, 0);
    expect(next).toHaveLength(3);
    expect(next[1].uid).not.toBe(list[0].uid);
    expect(next[1]).toMatchObject({ type: 'add_tags' });
    expect(next[2].uid).toBe(list[1].uid);
  });
});

describe('the action types the editor offers', () => {
  it('are all the types the server accepts, each once', () => {
    expect([...EDITOR_ACTION_TYPES].sort()).toEqual([...RULE_ACTION_TYPES].sort());
  });

  it('lists the text actions after set_payee, the two structural ones, and the review last', () => {
    expect(availableActionTypes([createAction('add_tags')], 0)).toEqual([
      'add_tags',
      'remove_tags',
      'set_category',
      'set_payee',
      'set_payee_from_text',
      'set_description',
      'convert_to_transfer',
      'split',
      'request_ai_review',
    ]);
  });

  it('duplicates a text action with a new uid', () => {
    const list = [{ ...createAction('set_description'), template: 'x' }] as EditorAction[];
    const next = duplicateAction(list, 0);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ type: 'set_description', template: 'x' });
    expect(next[1].uid).not.toBe(next[0].uid);
  });
});

describe('the structural actions', () => {
  const split = createAction('split');
  const convert = createAction('convert_to_transfer');

  it('start where the server defaults are: the category cleared, two blank parts', () => {
    expect(convert).toMatchObject({ direction: 'to', accountId: '', clearCategory: true, payeeId: '' });
    expect(split).toMatchObject({ payeeId: '' });
    if (split.type !== 'split') throw new Error('not a split');
    expect(split.parts).toHaveLength(2);
    expect(split.parts[0]).toMatchObject({ amount: '', kind: 'category', categoryId: '', transferAccountId: '', payeeId: '', description: '' });
    expect(split.parts[0].uid).not.toBe(split.parts[1].uid);
  });

  it('are offered once: a card that is not one sees neither while another holds one', () => {
    const list = [createAction('add_tags'), split];
    expect(availableActionTypes(list, 0)).not.toContain('split');
    expect(availableActionTypes(list, 0)).not.toContain('convert_to_transfer');
    // The card that holds it keeps both, so it can be switched between them.
    expect(availableActionTypes(list, 1)).toEqual(expect.arrayContaining(['split', 'convert_to_transfer']));
  });

  it('stay offered next to set_category: the conflict is reported on the card, not hidden', () => {
    expect(availableActionTypes([createAction('set_category'), createAction('add_tags')], 1)).toEqual(
      expect.arrayContaining(['split', 'convert_to_transfer']),
    );
  });

  it('cannot be duplicated: the server allows one per rule', () => {
    expect(canDuplicateAction([split], 0)).toBe(false);
    expect(duplicateAction([split], 0)).toEqual([split]);
  });

  it('can be moved and removed like any other card', () => {
    const rest = createAction('add_tags');
    expect(moveAction([split, rest], 0, 1)).toEqual([rest, split]);
    expect(removeAction([split, rest], 0)).toEqual([rest]);
  });

  it('start over on a type change and keep the card place', () => {
    const next = changeActionType(convert, 'split');
    expect(next).toMatchObject({ type: 'split', uid: convert.uid });
  });
});

describe('split parts', () => {
  const parts = [createSplitPart('{principal}'), createSplitPart('{interest}')];

  it('are bounded to 2..10', () => {
    expect(canRemoveSplitPart(parts)).toBe(false);
    expect(removeSplitPart(parts, 0)).toBe(parts);
    const ten = Array.from({ length: 10 }, () => createSplitPart());
    expect(canAddSplitPart(ten)).toBe(false);
    expect(addSplitPart(ten)).toBe(ten);
    expect(canRemoveSplitPart(ten)).toBe(true);
    expect(removeSplitPart(ten, 3)).toHaveLength(9);
    expect(addSplitPart(parts)).toHaveLength(3);
  });

  it('allow the rest once: the part holding it keeps it, the others lose it', () => {
    const withRest = [createSplitPart('{principal}'), createSplitPart('rest'), createSplitPart()];
    expect(restIsFree(withRest, 1)).toBe(true);
    expect(restIsFree(withRest, 0)).toBe(false);
    expect(restIsFree(parts, 0)).toBe(true);
  });

  it('are replaced one at a time', () => {
    const next = updateSplitPart(parts, 1, { ...parts[1], amount: 'rest' });
    expect(next[1].amount).toBe('rest');
    expect(next[0]).toBe(parts[0]);
  });

  it('name a capture by its braces', () => {
    expect(captureOfAmount('{principal}')).toBe('principal');
    expect(captureOfAmount('rest')).toBeNull();
    expect(captureOfAmount('{Principal}')).toBeNull();
    expect(captureOfAmount('')).toBeNull();
  });
});
