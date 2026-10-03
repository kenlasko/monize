import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { act, fireEvent, render, screen, within } from '@/test/render';
import { RuleEditor } from './RuleEditor';
import { lookupFixtures, makeRule } from './rules-test-fixtures';

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

const CHECKING = '11111111-1111-4111-8111-000000000001';
const LOAN = '11111111-1111-4111-8111-000000000002';
const BROKERAGE = '11111111-1111-4111-8111-000000000003';
const CLOSED = '11111111-1111-4111-8111-000000000004';
const REPAYMENT = '22222222-2222-4222-8222-000000000001';
const OVERPAYMENT = '22222222-2222-4222-8222-000000000002';
const LOANS = '33333333-3333-4333-8333-000000000001';
const INTEREST = '33333333-3333-4333-8333-000000000002';

const account = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  currencyCode: 'PLN',
  isClosed: false,
  isJoint: false,
  accountType: 'CHEQUING',
  accountSubType: null,
  ...extra,
});

const PATTERN = 'PRINCIPAL: {principal} INTEREST: {interest}PENALTY*';

async function renderEditor(ruleId?: string) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RuleEditor ruleId={ruleId} />);
  });
  return result;
}

const card = (label: 'Condition' | 'Action', index = 0) => screen.getAllByRole('group', { name: label })[index];
const part = (action: HTMLElement, n: number) => within(action).getByRole('group', { name: `Split ${n}` });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const optionLabels = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
  });
}

function startRule() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Loan instalment' } });
  click('+ Add condition');
  fireEvent.change(screen.getByLabelText('Field'), { target: { value: 'description' } });
  fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'matches' } });
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: PATTERN } });
}

function addAction(type: string, index: number): HTMLElement {
  click('+ Add action');
  fireEvent.change(within(card('Action', index)).getByLabelText('Action type'), { target: { value: type } });
  return card('Action', index);
}

function pickCombobox(scope: HTMLElement, placeholder: string, name: string) {
  fireEvent.focus(within(scope).getByPlaceholderText(placeholder));
  fireEvent.click(screen.getByText(name));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts.mockResolvedValue([
    account(CHECKING, 'Checking account'),
    account(LOAN, 'Loan account', { accountType: 'LOAN' }),
    account(BROKERAGE, 'Brokerage cash', { accountSubType: 'INVESTMENT_BROKERAGE' }),
    account(CLOSED, 'Old account', { isClosed: true }),
  ]);
  mocks.payees.mockResolvedValue([
    { id: REPAYMENT, name: 'Loan repayment' },
    { id: OVERPAYMENT, name: 'Loan overpayment' },
  ]);
  mocks.categories.mockResolvedValue([
    { id: LOANS, name: 'Loans', parentId: null },
    { id: INTEREST, name: 'Interest', parentId: LOANS },
  ]);
  mocks.tags.mockResolvedValue(lookupFixtures.tags);
  mocks.currencies.mockResolvedValue(lookupFixtures.currencies);
  mocks.rules.getApplications.mockResolvedValue([]);
});

describe('RuleEditor: a split action', () => {
  it('builds the loan split from the captures of the pattern and sends what the API takes', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'new-id' }));
    await renderEditor();
    startRule();

    const action = addAction('split', 0);
    pickCombobox(action, 'Select or type payee name...', 'Loan repayment');

    // The amounts offered are the two captures of the pattern above, then the rest.
    expect(optionLabels(within(part(action, 1)).getByLabelText('Amount'))).toEqual([
      'Choose the amount...',
      '{principal}',
      '{interest}',
      'The rest',
    ]);

    fireEvent.change(within(part(action, 1)).getByLabelText('Amount'), { target: { value: '{principal}' } });
    fireEvent.change(within(part(action, 1)).getByLabelText('Type'), { target: { value: 'transfer' } });
    // The transfer form's accounts: no brokerage account and no closed one.
    expect(optionLabels(within(part(action, 1)).getByLabelText('Account'))).toEqual([
      'Select account...',
      'Checking account (PLN)',
      'Loan account (PLN)',
    ]);
    fireEvent.change(within(part(action, 1)).getByLabelText('Account'), { target: { value: LOAN } });
    pickCombobox(part(action, 1), 'Select or type payee name...', 'Loan overpayment');

    fireEvent.change(within(part(action, 2)).getByLabelText('Amount'), { target: { value: '{interest}' } });
    pickCombobox(part(action, 2), 'Select category...', 'Loans: Interest');
    fireEvent.change(within(part(action, 2)).getByLabelText('Memo'), { target: { value: 'Interest' } });

    await save();

    expect(mocks.rules.create).toHaveBeenCalledWith({
      name: 'Loan instalment',
      enabled: true,
      triggers: ['create', 'import'],
      condition: { all: [{ field: 'description', op: 'matches', value: PATTERN }] },
      actions: [
        {
          type: 'split',
          payeeId: REPAYMENT,
          parts: [
            { amount: '{principal}', transferAccountId: LOAN, payeeId: OVERPAYMENT },
            { amount: '{interest}', categoryId: INTEREST, description: 'Interest' },
          ],
        },
      ],
      stopProcessing: false,
    });
  });

  it('does not save a part whose amount is not chosen, and names the part and the field', async () => {
    await renderEditor();
    startRule();
    const action = addAction('split', 0);
    fireEvent.change(within(part(action, 1)).getByLabelText('Amount'), { target: { value: '{principal}' } });
    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(within(part(action, 2)).getByText('Enter or choose a value.')).toBeInTheDocument();
    expect(within(part(action, 1)).queryByText('Enter or choose a value.')).not.toBeInTheDocument();
  });

  it('flags a capture that the pattern no longer defines, as the server would', async () => {
    await renderEditor();
    startRule();
    const action = addAction('split', 0);
    fireEvent.change(within(part(action, 1)).getByLabelText('Amount'), { target: { value: '{principal}' } });
    fireEvent.change(within(part(action, 2)).getByLabelText('Amount'), { target: { value: 'rest' } });
    // Removing {interest} from the pattern leaves {principal} in place; this one stays valid.
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'PRINCIPAL: {principal}*' } });
    await save();
    expect(mocks.rules.create).toHaveBeenCalledTimes(1);

    mocks.rules.create.mockClear();
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'PRINCIPAL: *' } });
    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(
      within(part(card('Action', 0), 1)).getByText('This uses a capture that no condition of this rule defines.'),
    ).toBeInTheDocument();
  });

  it("shows the server's error at the part and the field its path names", async () => {
    mocks.rules.create.mockRejectedValue(
      new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        data: { errorCode: 'INVALID_RULE', errors: [{ path: 'actions[0].parts[1].amount', code: 'DUPLICATE_ACTION' }] },
        statusText: '',
        headers: {},
        config: { headers: new AxiosHeaders() },
      } as AxiosResponse),
    );
    await renderEditor();
    startRule();
    const action = addAction('split', 0);
    fireEvent.change(within(part(action, 1)).getByLabelText('Amount'), { target: { value: '{principal}' } });
    fireEvent.change(within(part(action, 2)).getByLabelText('Amount'), { target: { value: '{interest}' } });
    await save();
    expect(mocks.rules.create).toHaveBeenCalledTimes(1);
    const message = 'A rule can have only one AI review, one transfer or split, and one split part that takes the rest.';
    expect(within(part(card('Action', 0), 2)).getByText(message)).toBeInTheDocument();
    expect(within(part(card('Action', 0), 1)).queryByText(message)).not.toBeInTheDocument();
    // The next edit clears it, like every other error.
    fireEvent.change(within(part(card('Action', 0), 2)).getByLabelText('Memo'), { target: { value: 'x' } });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });
});

describe('RuleEditor: a transfer action', () => {
  it('stores an expense toward an account, with the category cleared and a payee', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'new-id' }));
    await renderEditor();
    startRule();
    const action = addAction('convert_to_transfer', 0);
    fireEvent.change(within(action).getByLabelText('To Account'), { target: { value: LOAN } });
    pickCombobox(action, 'Select or type payee name...', 'Loan repayment');
    await save();
    expect(mocks.rules.create.mock.calls[0][0].actions).toEqual([
      { type: 'convert_to_transfer', toAccountId: LOAN, clearCategory: true, payeeId: REPAYMENT },
    ]);
  });

  it('stores an income from an account, and the category kept when the switch is turned off', async () => {
    mocks.rules.create.mockResolvedValue(makeRule({ id: 'new-id' }));
    await renderEditor();
    startRule();
    const action = addAction('convert_to_transfer', 0);
    fireEvent.change(within(action).getByLabelText('Direction'), { target: { value: 'from' } });
    fireEvent.change(within(action).getByLabelText('From Account'), { target: { value: CHECKING } });
    fireEvent.click(within(action).getByRole('switch', { name: 'Clear the category' }));
    await save();
    expect(mocks.rules.create.mock.calls[0][0].actions).toEqual([
      { type: 'convert_to_transfer', fromAccountId: CHECKING, clearCategory: false },
    ]);
  });

  it('asks for the account before saving, at the field', async () => {
    await renderEditor();
    startRule();
    const action = addAction('convert_to_transfer', 0);
    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(within(action).getByLabelText('To Account').parentElement).toHaveTextContent('Enter or choose a value.');
  });
});

describe('RuleEditor: combining the structural actions', () => {
  it('offers one structural action per rule: the second card does not list either', async () => {
    await renderEditor();
    startRule();
    addAction('split', 0);
    click('+ Add action');
    const second = within(card('Action', 1)).getByLabelText('Action type');
    expect(optionLabels(second)).not.toContain('Split transaction');
    expect(optionLabels(second)).not.toContain('Convert to transfer');
    // The card that holds one still lists both, so it can be switched.
    expect(optionLabels(within(card('Action', 0)).getByLabelText('Action type'))).toEqual(
      expect.arrayContaining(['Split transaction', 'Convert to transfer']),
    );
  });

  it('refuses a transfer next to "Set the category", on the transfer card, before anything is sent', async () => {
    await renderEditor();
    startRule();
    const category = addAction('set_category', 0);
    pickCombobox(category, 'Choose a category', 'Loans: Interest');
    const transfer = addAction('convert_to_transfer', 1);
    fireEvent.change(within(transfer).getByLabelText('To Account'), { target: { value: LOAN } });
    await save();
    expect(mocks.rules.create).not.toHaveBeenCalled();
    expect(within(card('Action', 1)).getByText(/cannot be combined with “Set the category”/)).toBeInTheDocument();
    expect(within(card('Action', 0)).queryByText(/cannot be combined with/)).not.toBeInTheDocument();
  });
});

describe('RuleEditor: a stored transfer or split', () => {
  const stored = makeRule({
    id: 'rule-split',
    revision: 5,
    condition: { all: [{ field: 'description', op: 'matches', value: PATTERN }] },
    actions: [
      {
        type: 'split',
        payeeId: REPAYMENT,
        parts: [
          { amount: '{principal}', transferAccountId: LOAN, payeeId: OVERPAYMENT },
          { amount: '{interest}', categoryId: INTEREST, description: 'Interest' },
          { amount: 'rest' },
        ],
      },
    ],
  });

  beforeEach(() => {
    mocks.rules.getById.mockResolvedValue(stored);
  });

  it('opens with every part as stored and nothing to save until something changes', async () => {
    await renderEditor('rule-split');
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
    const action = card('Action', 0);
    expect(within(part(action, 1)).getByLabelText('Amount')).toHaveValue('{principal}');
    expect(within(part(action, 1)).getByLabelText('Type')).toHaveValue('transfer');
    expect(within(part(action, 1)).getByLabelText('Account')).toHaveValue(LOAN);
    expect(within(part(action, 2)).getByLabelText('Memo')).toHaveValue('Interest');
    expect(within(part(action, 3)).getByLabelText('Amount')).toHaveValue('rest');
    expect(screen.getByRole('button', { name: 'Save rule' })).toBeDisabled();
  });

  it('saves an edit to one part with the rest of the definition as stored', async () => {
    mocks.rules.update.mockResolvedValue({ ...stored, revision: 6 });
    await renderEditor('rule-split');
    fireEvent.change(within(part(card('Action', 0), 2)).getByLabelText('Memo'), { target: { value: 'Loan interest' } });
    await save();
    expect(mocks.rules.update).toHaveBeenCalledWith('rule-split', {
      name: stored.name,
      enabled: true,
      triggers: ['create'],
      condition: stored.condition,
      actions: [
        {
          type: 'split',
          payeeId: REPAYMENT,
          parts: [
            { amount: '{principal}', transferAccountId: LOAN, payeeId: OVERPAYMENT },
            { amount: '{interest}', categoryId: INTEREST, description: 'Loan interest' },
            { amount: 'rest' },
          ],
        },
      ],
      stopProcessing: false,
      revision: 5,
    });
  });

  it('opens a stored transfer on the income side with its account', async () => {
    mocks.rules.getById.mockResolvedValue(
      makeRule({
        id: 'rule-transfer',
        actions: [{ type: 'convert_to_transfer', fromAccountId: LOAN, clearCategory: false }],
      }),
    );
    await renderEditor('rule-transfer');
    const action = card('Action', 0);
    expect(within(action).getByLabelText('Direction')).toHaveValue('from');
    expect(within(action).getByLabelText('From Account')).toHaveValue(LOAN);
    expect(within(action).getByRole('switch', { name: 'Clear the category' })).toHaveAttribute('aria-checked', 'false');
  });
});
