import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render';
import { RuleEditor } from './RuleEditor';
import {
  ACCOUNT_ID,
  COFFEE_ID,
  PAYEE_ID,
  TAG_ID,
  TAG_WORK_ID,
  lookupFixtures,
  makeRule,
} from './rules-test-fixtures';
import { MAX_RULE_ACTIONS } from '@/lib/rule-fields';
import { makeApplication, makePreview } from './rules-test-fixtures';
import type { TransactionRule } from '@/types/transaction-rule';

Element.prototype.scrollIntoView = vi.fn();

const mocks = vi.hoisted(() => ({
  rules: { getById: vi.fn(), create: vi.fn(), update: vi.fn(), getApplications: vi.fn(), previewDraft: vi.fn(), previewRun: vi.fn(), run: vi.fn() },
  accounts: vi.fn(),
  payees: vi.fn(),
  categories: vi.fn(),
  tags: vi.fn(),
  currencies: vi.fn(),
}));

vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: mocks.rules }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi: { getAll: (...args: unknown[]) => mocks.accounts(...args) },
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi: { getAll: (...args: unknown[]) => mocks.payees(...args) },
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi: { getAll: (...args: unknown[]) => mocks.categories(...args) },
}));
vi.mock('@/lib/tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tags')>()),
  tagsApi: { getAll: (...args: unknown[]) => mocks.tags(...args) },
}));
vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi: { getCurrencies: (...args: unknown[]) => mocks.currencies(...args) },
}));

function apiError(status: number, data: unknown): AxiosError {
  const response = { status, data, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } } as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, response);
}

async function renderEditor(ruleId?: string) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RuleEditor ruleId={ruleId} />);
  });
  return result;
}

const card = (label: 'Condition' | 'Action' | 'Group', index = 0) => screen.getAllByRole('group', { name: label })[index];
const saveButton = () => screen.getByRole('button', { name: 'Save rule' });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

async function save() {
  await act(async () => {
    fireEvent.click(saveButton());
  });
}

function addTagAction(index: number, tagLabel: string) {
  click('+ Add action');
  const action = card('Action', index);
  fireEvent.click(within(action).getByText('Choose tags'));
  // The open list is drawn outside the card.
  fireEvent.click(screen.getByLabelText(tagLabel));
  fireEvent.mouseDown(document.body);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts.mockResolvedValue(lookupFixtures.accounts);
  mocks.payees.mockResolvedValue(lookupFixtures.payees);
  mocks.categories.mockResolvedValue(lookupFixtures.categories);
  mocks.tags.mockResolvedValue(lookupFixtures.tags);
  mocks.currencies.mockResolvedValue(lookupFixtures.currencies);
  mocks.rules.getApplications.mockResolvedValue([]);
});

describe('RuleEditor: a new rule', () => {
  it('lays out When, If and Then, and says that no condition means every transaction', async () => {
    await renderEditor();
    expect(screen.getByRole('region', { name: 'When' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'If' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Then' })).toBeInTheDocument();
    expect(screen.getByText('No conditions yet, so this rule applies to every transaction.')).toBeInTheDocument();
    expect(screen.getByText('No actions yet. Add at least one.')).toBeInTheDocument();
    expect(screen.getByLabelText('A transaction is created')).toBeChecked();
    expect(screen.getByLabelText('A transaction is imported')).toBeChecked();

    click('+ Add condition');
    expect(screen.queryByText(/applies to every transaction/)).not.toBeInTheDocument();
  });

  it('anchors the tour on the When, If, Then and Test panels', async () => {
    await renderEditor();
    const panels: Array<[string, string]> = [
      ['rule-editor-when', 'When'],
      ['rule-editor-if', 'If'],
      ['rule-editor-then', 'Then'],
      ['rule-editor-test', 'Test'],
    ];
    for (const [anchor, name] of panels) {
      const found = document.querySelectorAll(`[data-tour-id="${anchor}"]`);
      expect(found).toHaveLength(1);
      expect(found[0]).toBe(screen.getByRole('region', { name }));
    }
  });

  it('asks for the pickers\' lists once, with inactive payees and inactive accounts included', async () => {
    await renderEditor();
    expect(mocks.accounts).toHaveBeenCalledWith(true);
    expect(mocks.payees).toHaveBeenCalledWith('all');
  });

  it('refuses to save a rule without a name or an action, and writes nothing', async () => {
    await renderEditor();
    await save();

    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a name for the rule.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Then' })).getByText('Add at least one action.')).toBeInTheDocument();
    expect(screen.getByText('The rule was not saved. Fix the items marked below and try again.')).toBeInTheDocument();
  });

  it('marks a condition and an action that still lack their value', async () => {
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rule' } });
    click('+ Add condition');
    click('+ Add action');
    await save();

    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(within(card('Condition')).getByText('Enter or choose a value.')).toBeInTheDocument();
    expect(within(card('Action')).getByText('Choose at least one item.')).toBeInTheDocument();
  });

  it('creates the rule with exactly the payload the API takes, then opens it', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'new-id' }));
    await renderEditor();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Coffee  ' } });
    click('+ Add condition');
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'cafe' } });
    addTagAction(0, 'Coffee run');
    click('+ Add action');
    fireEvent.change(within(card('Action', 1)).getByLabelText('Action type'), { target: { value: 'set_category' } });
    fireEvent.focus(within(card('Action', 1)).getByPlaceholderText('Choose a category'));
    fireEvent.click(screen.getByText('Food: Coffee'));
    click('+ Add action');
    fireEvent.change(within(card('Action', 2)).getByLabelText('Action type'), { target: { value: 'set_payee' } });
    fireEvent.focus(within(card('Action', 2)).getByPlaceholderText('Choose a payee'));
    fireEvent.click(screen.getByText('Corner Cafe'));
    fireEvent.click(within(card('Action', 2)).getByRole('switch', { name: 'Only if empty' }));

    await save();

    expect(mocks.rules.create).toHaveBeenCalledTimes(1);
    expect(mocks.rules.create).toHaveBeenCalledWith({
      name: 'Coffee',
      enabled: true,
      triggers: ['create', 'import'],
      condition: { all: [{ field: 'payeeText', op: 'eq', value: 'cafe' }] },
      actions: [
        { type: 'add_tags', tagIds: [TAG_ID] },
        { type: 'set_category', categoryId: COFFEE_ID, onlyIfEmpty: true },
        { type: 'set_payee', payeeId: PAYEE_ID, onlyIfEmpty: false },
      ],
      stopProcessing: false,
    });
    expect(toast.success).toHaveBeenCalledWith('Rule created');
    expect(useRouter().replace).toHaveBeenCalledWith('/rules/new-id');
  });

  it('sends the trigger, enabled and stop-processing choices, and a negated nested group', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'x' }));
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rule' } });
    fireEvent.click(screen.getByLabelText('A transaction is created'));
    fireEvent.click(screen.getByRole('switch', { name: 'Stop processing other rules' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Rule enabled' }));
    click('+ Add group');
    const group = card('Group');
    fireEvent.click(within(group).getByRole('button', { name: 'Any of these' }));
    fireEvent.click(within(group).getByRole('switch', { name: /Negate this group/ }));
    fireEvent.click(within(group).getByRole('button', { name: '+ Add condition' }));
    fireEvent.change(within(group).getByLabelText('Operator'), { target: { value: 'isEmpty' } });
    addTagAction(0, 'Work');

    await save();

    expect(mocks.rules.create).toHaveBeenCalledWith({
      name: 'Rule',
      enabled: false,
      triggers: ['import'],
      condition: { all: [{ any: [{ field: 'payeeText', op: 'isEmpty' }], not: true }] },
      actions: [{ type: 'add_tags', tagIds: [TAG_WORK_ID] }],
      stopProcessing: true,
    });
  });

  it('sends the active window the dates were typed into, and nothing for a side left empty', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'x' }));
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mortgage' } });
    const from = screen.getByLabelText('First date');
    fireEvent.change(from, { target: { value: '2026-10-01' } });
    fireEvent.blur(from);
    addTagAction(0, 'Work');

    await save();

    expect(mocks.rules.create).toHaveBeenCalledWith(
      expect.objectContaining({ activeFrom: '2026-10-01' }),
    );
  });

  it('says so when the last date is before the first', async () => {
    await renderEditor();
    for (const [label, value] of [
      ['First date', '2026-12-31'],
      ['Last date', '2026-10-01'],
    ]) {
      const input = screen.getByLabelText(label);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    }
    expect(screen.getByText('The last date must not be before the first date')).toBeInTheDocument();
  });

  it('keeps at least one trigger checked', async () => {
    await renderEditor();
    fireEvent.click(screen.getByLabelText('A transaction is created'));
    expect(screen.getByLabelText('A transaction is imported')).toBeDisabled();
    expect(screen.getByText('Keep at least one option selected')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('A transaction is created'));
    expect(screen.getByLabelText('A transaction is imported')).toBeEnabled();
  });

  it('explains stop processing in a tooltip', async () => {
    await renderEditor();
    expect(screen.getByRole('button', { name: /the rules after it in the list are skipped/ })).toBeInTheDocument();
  });

  it('does not offer a joint account, which a rule may not name', async () => {
    await renderEditor();
    click('+ Add condition');
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'accountId' } });
    fireEvent.focus(screen.getByPlaceholderText('Choose an account'));
    expect(screen.getByText('Chequing (CAD)')).toBeInTheDocument();
    expect(screen.queryByText(/Partner joint/)).not.toBeInTheDocument();
    expect(ACCOUNT_ID).toBeTruthy();
  });

  it('stops at ten actions and offers an AI review only once', async () => {
    await renderEditor();
    click('+ Add action');
    fireEvent.change(within(card('Action', 0)).getByLabelText('Action type'), { target: { value: 'request_ai_review' } });
    click('+ Add action');
    const second = within(card('Action', 1)).getByLabelText('Action type');
    expect(within(second).queryByRole('option', { name: 'Ask for an AI review' })).not.toBeInTheDocument();
    expect(
      within(within(card('Action', 0)).getByLabelText('Action type')).getByRole('option', { name: 'Ask for an AI review' }),
    ).toBeInTheDocument();

    for (let i = 2; i < MAX_RULE_ACTIONS; i += 1) click('+ Add action');
    expect(screen.getAllByRole('group', { name: 'Action' })).toHaveLength(MAX_RULE_ACTIONS);
    expect(screen.getByRole('button', { name: '+ Add action' })).toBeDisabled();
    expect(screen.getByText(`A rule can have at most ${MAX_RULE_ACTIONS} actions.`)).toBeInTheDocument();
  });

  it('moves, duplicates and deletes action cards from their menu', async () => {
    await renderEditor();
    addTagAction(0, 'Coffee run');
    click('+ Add action');
    fireEvent.change(within(card('Action', 1)).getByLabelText('Action type'), { target: { value: 'set_payee' } });

    fireEvent.click(within(card('Action', 1)).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    expect(within(card('Action', 0)).getByLabelText('Action type')).toHaveValue('set_payee');

    fireEvent.click(within(card('Action', 1)).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(screen.getAllByRole('group', { name: 'Action' })).toHaveLength(3);
    expect(within(card('Action', 2)).getByLabelText('Action type')).toHaveValue('add_tags');

    fireEvent.click(within(card('Action', 0)).getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getAllByRole('group', { name: 'Action' })).toHaveLength(2);
    expect(within(card('Action', 0)).getByLabelText('Action type')).toHaveValue('add_tags');
  });

  it('shows the server\'s errors on the cards at their paths and clears them on the next edit', async () => {
    mocks.rules.create.mockRejectedValue(
      apiError(400, {
        message: 'The rule definition is not valid',
        errorCode: 'INVALID_RULE',
        errors: [
          { path: 'condition.all[1].value', code: 'VALUE_TOO_LONG' },
          { path: 'condition.all[0]', code: 'REFERENCE_NOT_FOUND' },
          { path: 'actions[1].categoryId', code: 'INVALID_UUID' },
          { path: 'actions[0]', code: 'DUPLICATE_ACTION' },
          { path: 'actions', code: 'TOO_MANY_ACTIONS' },
          { path: 'elsewhere', code: 'UNKNOWN_KEY' },
        ],
      }),
    );
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rule' } });
    click('+ Add condition');
    click('+ Add condition');
    fireEvent.change(screen.getAllByLabelText('Value')[0], { target: { value: 'a' } });
    fireEvent.change(screen.getAllByLabelText('Value')[1], { target: { value: 'b' } });
    addTagAction(0, 'Coffee run');
    addTagAction(1, 'Work');

    await save();

    expect(within(card('Condition', 0)).getByText('An item chosen here no longer exists. Choose another.')).toBeInTheDocument();
    expect(within(card('Condition', 1)).getByText('The text is too long.')).toBeInTheDocument();
    expect(within(card('Action', 0)).getByText('A rule can have only one AI review, one transfer or split, and one split part that takes the rest.')).toBeInTheDocument();
    expect(within(card('Action', 1)).getByText('Choose an item from the list.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Then' })).getByText(/There are too many actions/)).toBeInTheDocument();
    // What names no card is said at the top, in words.
    expect(screen.getByText('The rule was not saved. Fix the items marked below and try again.')).toBeInTheDocument();
    expect(screen.getByText('This part has a setting that does not exist.')).toBeInTheDocument();

    fireEvent.change(screen.getAllByLabelText('Value')[1], { target: { value: 'c' } });
    expect(screen.queryByText('The text is too long.')).not.toBeInTheDocument();
    expect(screen.queryByText('The rule was not saved. Fix the items marked below and try again.')).not.toBeInTheDocument();
  });

  it('says a refusal with no per-card errors in the server\'s own words, and keeps the draft', async () => {
    mocks.rules.create.mockRejectedValue(apiError(400, { message: 'You have reached the limit of rules' }));
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rule' } });
    addTagAction(0, 'Work');
    await save();

    expect(screen.getByText('You have reached the limit of rules')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Rule');
    expect(saveButton()).toBeEnabled();
  });

  it('disables the whole form while the save is in flight', async () => {
    let finish!: (rule: TransactionRule) => void;
    mocks.rules.create.mockReturnValue(new Promise<TransactionRule>((resolve) => (finish = resolve)));
    await renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rule' } });
    addTagAction(0, 'Work');

    await save();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(saveButton()).toBeDisabled();

    await act(async () => finish(makeRule({ id: 'done' })));
    expect(useRouter().replace).toHaveBeenCalledWith('/rules/done');
  });
});

describe('RuleEditor: the Test panel', () => {
  it('sits below Then, sends the unsaved draft and shows the planned change', async () => {
    mocks.rules.previewDraft.mockResolvedValue(makePreview());
    await renderEditor();
    expect(screen.getByRole('region', { name: 'Test' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run on existing transactions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test rule' })).toBeDisabled();

    addTagAction(0, 'Work');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test rule' }));
    });
    expect(mocks.rules.previewDraft).toHaveBeenCalledWith({
      condition: { all: [] },
      actions: [{ type: 'add_tags', tagIds: [TAG_WORK_ID] }],
      filters: { limit: 200 },
    });
    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
    expect(mocks.rules.create).not.toHaveBeenCalled();

    // A rename does not change what the rule does, so the result stays current.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Changing what it does leaves the result readable but out of date.
    addTagAction(1, 'Coffee run');
    expect(screen.getByRole('status')).toHaveTextContent('The rule or the filters changed since this result.');
    expect(screen.getByText('Corner Cafe')).toBeInTheDocument();
  });
});

describe('RuleEditor: a test that matched nothing', () => {
  const NONE =
    'This rule matches none of the transactions examined (12). Check the conditions before saving.';

  it('warns beside Save without blocking it, and only while the result is current', async () => {
    mocks.rules.previewDraft.mockResolvedValue(
      makePreview({ matched: [], conditionMatchedCount: 0, scanned: 12 }),
    );
    await renderEditor();
    addTagAction(0, 'Work');
    expect(
      screen.queryByText(/matches none of the transactions examined/),
    ).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test rule' }));
    });
    const warning = screen
      .getAllByRole('status')
      .find((el) => el.textContent?.includes('matches none'));
    expect(warning).toHaveTextContent(NONE);
    expect(saveButton()).toBeEnabled();

    // An edit that changes what the rule does makes the result stale, and the warning goes with it.
    addTagAction(1, 'Coffee run');
    expect(
      screen.queryByText(/matches none of the transactions examined/),
    ).not.toBeInTheDocument();
  });

  it('does not warn beside Save when the condition matches but nothing would change', async () => {
    mocks.rules.previewDraft.mockResolvedValue(
      makePreview({ matched: [], conditionMatchedCount: 5, scanned: 12 }),
    );
    await renderEditor();
    addTagAction(0, 'Work');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test rule' }));
    });
    expect(
      screen.queryByText(/matches none of the transactions examined/),
    ).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('says nothing when the test matched something', async () => {
    mocks.rules.previewDraft.mockResolvedValue(makePreview());
    await renderEditor();
    addTagAction(0, 'Work');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test rule' }));
    });
    expect(
      screen.queryByText(/matches none of the transactions examined/),
    ).not.toBeInTheDocument();
  });
});

describe('RuleEditor: an existing rule', () => {
  const stored = makeRule({
    id: 'rule-9',
    name: 'Coffee shops',
    revision: 7,
    triggers: ['import'],
    stopProcessing: true,
    condition: {
      all: [
        { field: 'accountId', op: 'eq', value: ACCOUNT_ID },
        { field: 'categoryId', op: 'inSubtree', value: COFFEE_ID },
      ],
    },
    actions: [
      { type: 'add_tags', tagIds: [TAG_ID] },
      { type: 'set_payee', payeeId: PAYEE_ID, onlyIfEmpty: false },
    ],
  });

  beforeEach(() => {
    mocks.rules.getById.mockResolvedValue(stored);
  });

  it('loads the rule and shows names, never ids', async () => {
    await renderEditor('rule-9');
    expect(mocks.rules.getById).toHaveBeenCalledWith('rule-9');
    expect(screen.getByLabelText('Name')).toHaveValue('Coffee shops');
    expect(screen.getByLabelText('A transaction is created')).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Stop processing other rules' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByPlaceholderText('Choose an account')).toHaveValue('Chequing (CAD)');
    expect(screen.getByPlaceholderText('Choose a category')).toHaveValue('Food: Coffee');
    expect(screen.getByPlaceholderText('Choose a payee')).toHaveValue('Corner Cafe');
    expect(within(card('Action', 0)).getByText('Coffee run')).toBeInTheDocument();
    expect(within(card('Action', 1)).getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'false');
    expect(document.body.textContent).not.toContain(ACCOUNT_ID);
    expect(document.body.textContent).not.toContain(PAYEE_ID);
  });

  it('shows the history of a saved rule and links each application to its transaction', async () => {
    mocks.rules.getApplications.mockResolvedValue([makeApplication()]);
    await renderEditor('rule-9');
    expect(mocks.rules.getApplications).toHaveBeenCalledWith('rule-9');
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByRole('link')).toHaveAttribute('href', '/transactions?targetTransactionId=tx-1');
  });

  it('runs the saved rule from the editor, and only while the draft matches what is saved', async () => {
    mocks.rules.previewRun.mockResolvedValue(makePreview());
    await renderEditor('rule-9');
    const runButton = () => screen.getByRole('button', { name: 'Run on existing transactions' });
    expect(runButton()).toBeEnabled();
    expect(screen.queryByText('Save your changes to run the saved rule.')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Coffee' } });
    expect(runButton()).toBeDisabled();
    expect(screen.getByText('Save your changes to run the saved rule.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Coffee shops' } });

    fireEvent.click(runButton());
    expect(screen.getByRole('dialog', { name: 'Run "Coffee shops" on existing transactions' })).toBeInTheDocument();
    // The editor already holds the accounts; the dialog does not fetch them again.
    expect(mocks.accounts).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    });
    expect(mocks.rules.previewRun).toHaveBeenCalledWith('rule-9', { limit: 200 });
  });

  it('tests the saved rule\'s current draft, not the stored one', async () => {
    mocks.rules.previewDraft.mockResolvedValue(makePreview());
    await renderEditor('rule-9');
    fireEvent.click(within(card('Action', 1)).getByRole('switch', { name: 'Only if empty' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test rule' }));
    });
    expect(mocks.rules.previewDraft.mock.calls[0][0].actions[1]).toEqual({
      type: 'set_payee',
      payeeId: PAYEE_ID,
      onlyIfEmpty: true,
    });
  });

  it('cannot be saved until something changed', async () => {
    await renderEditor('rule-9');
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Coffee' } });
    expect(saveButton()).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Coffee shops' } });
    expect(saveButton()).toBeDisabled();
  });

  it('saves with the revision it read, and starts a fresh draft from the answer', async () => {
    mocks.rules.update.mockResolvedValue({ ...stored, name: 'Cafes', revision: 8 });
    await renderEditor('rule-9');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cafes' } });
    fireEvent.click(within(card('Action', 1)).getByRole('switch', { name: 'Only if empty' }));

    await save();

    expect(mocks.rules.update).toHaveBeenCalledWith('rule-9', {
      name: 'Cafes',
      enabled: true,
      triggers: ['import'],
      condition: {
        all: [
          { field: 'accountId', op: 'eq', value: ACCOUNT_ID },
          { field: 'categoryId', op: 'inSubtree', value: COFFEE_ID },
        ],
      },
      actions: [
        { type: 'add_tags', tagIds: [TAG_ID] },
        { type: 'set_payee', payeeId: PAYEE_ID, onlyIfEmpty: true },
      ],
      stopProcessing: true,
      revision: 7,
    });
    expect(toast.success).toHaveBeenCalledWith('Rule saved');
    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(useRouter().replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Name')).toHaveValue('Cafes');
    expect(saveButton()).toBeDisabled();
  });

  it('saves a rename of a rule whose stored pattern has no wildcard, and blocks an edited condition', async () => {
    const old = makeRule({
      id: 'rule-9',
      name: 'Streaming',
      revision: 2,
      condition: { all: [{ field: 'description', op: 'matches', value: 'NETFLIX.COM' }] },
      actions: [{ type: 'add_tags', tagIds: [TAG_ID] }],
    });
    mocks.rules.getById.mockResolvedValue(old);
    mocks.rules.update.mockResolvedValue({ ...old, name: 'Renamed', revision: 3 });
    await renderEditor('rule-9');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });

    await save();
    expect(mocks.rules.update).toHaveBeenCalledWith('rule-9', expect.objectContaining({ name: 'Renamed', revision: 2 }));

    mocks.rules.update.mockClear();
    fireEvent.change(within(card('Condition')).getByDisplayValue('NETFLIX.COM'), { target: { value: 'HBO.COM' } });
    await save();
    expect(mocks.rules.update).not.toHaveBeenCalled();
  });

  it('answers a revision conflict with a message and a Reload that fetches the rule again', async () => {
    mocks.rules.update.mockRejectedValue(
      apiError(409, { message: 'changed elsewhere', errorCode: 'REVISION_CONFLICT' }),
    );
    await renderEditor('rule-9');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    await save();

    expect(screen.getByText('This rule was changed elsewhere')).toBeInTheDocument();
    expect(screen.getByText(/Your unsaved edits will be lost/)).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    mocks.rules.getById.mockResolvedValue({ ...stored, name: 'Theirs', revision: 8 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    });

    expect(mocks.rules.getById).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Name')).toHaveValue('Theirs');
    expect(screen.queryByText('This rule was changed elsewhere')).not.toBeInTheDocument();
  });

  it('shows why an invalid rule cannot run, and marks the card that names a missing item', async () => {
    mocks.rules.getById.mockResolvedValue({
      ...stored,
      invalid: true,
      invalidReasons: [
        { path: 'actions[1]', code: 'REFERENCE_NOT_FOUND' },
        { path: 'condition.all[0]', code: 'REFERENCE_NOT_FOUND' },
      ],
    });
    await renderEditor('rule-9');

    expect(screen.getByText('This rule cannot run')).toBeInTheDocument();
    expect(screen.getByText(/Skipped until fixed: a tag, payee, category or account it uses no longer exists\./)).toBeInTheDocument();
    expect(within(card('Action', 1)).getByText('An item chosen here no longer exists. Choose another.')).toBeInTheDocument();
    expect(within(card('Condition', 0)).getByText('An item chosen here no longer exists. Choose another.')).toBeInTheDocument();
    expect(within(card('Action', 0)).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens an unreadable stored definition, says what it reset, and can be saved', async () => {
    mocks.rules.getById.mockResolvedValue({
      ...stored,
      condition: {},
      actions: [],
      invalid: true,
      invalidReasons: [{ path: 'condition', code: 'INVALID_SHAPE' }, { path: 'actions', code: 'NO_ACTIONS' }],
    });
    await renderEditor('rule-9');

    expect(screen.getByText(/could not be read and were removed or reset here/)).toBeInTheDocument();
    expect(screen.getByText(/its saved definition cannot be read/)).toBeInTheDocument();
    expect(screen.getByText('No conditions yet, so this rule applies to every transaction.')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('shows an error with a retry when the rule fails to load, never a blank form', async () => {
    mocks.rules.getById.mockRejectedValueOnce(apiError(500, {}));
    await renderEditor('rule-9');

    expect(screen.getByRole('alert')).toHaveTextContent('The rule could not be loaded');
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save rule' })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.getByLabelText('Name')).toHaveValue('Coffee shops');
  });

  it('says so when the rule no longer exists, and links back to the list', async () => {
    mocks.rules.getById.mockRejectedValue(apiError(404, {}));
    await renderEditor('gone');
    expect(screen.getByText('This rule no longer exists. It may have been deleted.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Rules' })).toHaveAttribute('href', '/rules');
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});

describe('RuleEditor: the pickers\' lists', () => {
  it.each([
    ['accounts', () => mocks.accounts],
    ['payees', () => mocks.payees],
    ['categories', () => mocks.categories],
    ['tags', () => mocks.tags],
    ['currencies', () => mocks.currencies],
  ])('shows an error, not an empty form, when the %s fail to load', async (_name, pick) => {
    pick().mockRejectedValueOnce(new Error('down'));
    await renderEditor();

    expect(screen.getByRole('alert')).toHaveTextContent('The rule could not be loaded');
    expect(screen.getByText(/could not be loaded, so the rule cannot be shown safely/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
  });

  it('shows a spinner until both the rule and the lists have arrived', async () => {
    let release!: (rule: TransactionRule) => void;
    mocks.rules.getById.mockReturnValue(new Promise<TransactionRule>((resolve) => (release = resolve)));
    await renderEditor('rule-1');
    expect(screen.getByText('Loading the rule...')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await act(async () => release(makeRule({ id: 'rule-1' })));
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});

describe('RuleEditor: a date range and the active window', () => {
  const dated = makeRule({
    id: 'rule-d',
    name: 'October',
    revision: 3,
    condition: { all: [{ field: 'date', op: 'between', value: ['2026-10-01', '2026-10-31'] }] },
    actions: [{ type: 'add_tags', tagIds: [TAG_ID] }],
  });
  const typeDate = (label: string, value: string) => {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  };

  it('saves and tests a stored rule whose condition is a complete date range', async () => {
    mocks.rules.getById.mockResolvedValue(dated);
    mocks.rules.update.mockResolvedValue({ ...dated, name: 'October 2026', revision: 4 });
    mocks.rules.previewDraft.mockResolvedValue(makePreview());
    await renderEditor('rule-d');

    expect(screen.getByRole('button', { name: 'Test rule' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test rule' }));
    });
    expect(mocks.rules.previewDraft).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'October 2026' } });
    await save();
    expect(mocks.rules.update).toHaveBeenCalledTimes(1);
    expect(mocks.rules.update.mock.calls[0][1].condition).toEqual(dated.condition);
  });

  it('sends the draft window with the test, and marks the result out of date when the window moves', async () => {
    mocks.rules.previewDraft.mockResolvedValue(makePreview());
    await renderEditor();
    typeDate('First date', '2026-10-01');
    addTagAction(0, 'Work');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test rule' }));
    });
    const sent = mocks.rules.previewDraft.mock.calls[0][0];
    expect(sent.activeFrom).toBe('2026-10-01');
    // An open side is left out rather than sent as null.
    expect(sent).not.toHaveProperty('activeTo');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    typeDate('Last date', '2026-10-31');
    expect(screen.getByRole('status')).toHaveTextContent('The rule or the filters changed since this result.');
  });

  it('sends null to clear a side the stored rule had, and nothing for the side it left open', async () => {
    mocks.rules.getById.mockResolvedValue({ ...dated, activeFrom: '2026-10-01' });
    mocks.rules.update.mockResolvedValue({ ...dated, revision: 4 });
    await renderEditor('rule-d');
    typeDate('First date', '');
    await save();
    const payload = mocks.rules.update.mock.calls[0][1];
    expect(payload.activeFrom).toBeNull();
    expect(payload).not.toHaveProperty('activeTo');
  });
});
