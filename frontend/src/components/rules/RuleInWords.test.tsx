import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/render';
import { RuleActionsInWords, RuleActiveWindowInWords, RuleConditionInWords, RuleInWords, type RuleWordsLabels } from './RuleInWords';
import type { RuleAction, RuleConditionNode } from '@/types/transaction-rule';

const labels: RuleWordsLabels = { accounts: {}, payees: {}, categories: {}, tags: {} };

function words(condition: RuleConditionNode) {
  render(<RuleConditionInWords condition={condition} labels={labels} />);
}

describe('the conditions in words: the newer fields', () => {
  it.each([
    [{ field: 'referenceNumber', op: 'startsWith', value: 'CHK' }, 'Reference number starts with "CHK"'],
    [{ field: 'referenceNumber', op: 'matches', value: 'CHK-{n}' }, 'Reference number matches the pattern "CHK-{n}"'],
    [{ field: 'referenceNumber', op: 'isEmpty' }, 'Reference number is empty'],
    [{ field: 'dayOfMonth', op: 'gte', value: 28 }, 'Day of the month is at least 28'],
    [{ field: 'dayOfMonth', op: 'between', value: [10, 20] }, 'Day of the month is between 10 and 20'],
    [{ field: 'dayOfMonth', op: 'in', value: [1, 15, 31] }, 'Day of the month is any of 1, 15, and 31'],
    [{ field: 'weekday', op: 'eq', value: 'MON' }, 'Day of the week is Mon'],
    [{ field: 'weekday', op: 'in', value: ['SAT', 'SUN'] }, 'Day of the week is any of Sat and Sun'],
    [{ field: 'status', op: 'neq', value: 'VOID' }, 'Status is not Void'],
    [{ field: 'status', op: 'in', value: ['CLEARED', 'RECONCILED'] }, 'Status is any of Cleared and Reconciled'],
    [{ field: 'hasAttachment', op: 'eq', value: true }, 'Has an attachment is Yes'],
    [{ field: 'hasAttachment', op: 'eq', value: false }, 'Has an attachment is No'],
  ] as const)('reads %j', (leaf, text) => {
    words({ all: [leaf as never] });
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('A condition this version cannot show')).not.toBeInTheDocument();
  });

  it('still says only that a condition exists when the field or the operator is newer than this client', () => {
    words({ all: [{ field: 'futureField', op: 'eq', value: 'x' } as never] });
    expect(screen.getByText('A condition this version cannot show')).toBeInTheDocument();
  });

  it('shows a value newer than this client as it is stored', () => {
    words({ all: [{ field: 'status', op: 'eq', value: 'PENDING' }] });
    expect(screen.getByText('Status is PENDING')).toBeInTheDocument();
  });
});

describe('the date condition in words', () => {
  it('reads a date in the reader\'s format and a range with both ends', () => {
    words({ all: [{ field: 'date', op: 'gte', value: '2026-10-01' }] });
    expect(screen.getByText(/^Date is at least .*2026/)).toBeInTheDocument();
  });

  it('reads a range of two dates', () => {
    words({ all: [{ field: 'date', op: 'between', value: ['2026-10-01', '2026-10-31'] }] });
    expect(screen.getByText(/^Date is between .*2026.* and .*2026/)).toBeInTheDocument();
  });
});

describe('the active window in words', () => {
  it('names both ends', () => {
    render(<RuleActiveWindowInWords activeFrom="2026-10-01" activeTo="2026-12-31" />);
    expect(screen.getByText(/^Only for transactions dated from .*2026.* to .*2026/)).toBeInTheDocument();
  });

  it('says no limit for an open side', () => {
    render(<RuleActiveWindowInWords activeFrom="2026-10-01" activeTo={null} />);
    expect(screen.getByText(/to no limit$/)).toBeInTheDocument();
  });

  it('is shown on a whole rule only when it has a window', () => {
    const rule = { triggers: ['create'] as const, condition: { all: [] }, actions: [], stopProcessing: false };
    const { unmount } = render(<RuleInWords rule={{ ...rule, triggers: ['create'] }} labels={labels} />);
    expect(screen.queryByText(/Only for transactions dated/)).not.toBeInTheDocument();
    unmount();
    render(<RuleInWords rule={{ ...rule, triggers: ['create'], activeFrom: '2026-10-01' }} labels={labels} />);
    expect(screen.getByText(/Only for transactions dated from .*2026.* to no limit/)).toBeInTheDocument();
  });
});

describe('the actions in words: the text actions', () => {
  function actions(list: RuleAction[]) {
    render(<RuleActionsInWords actions={list} labels={labels} />);
  }

  it('says where the payee comes from, whether it is created and whether it is only filled in', () => {
    actions([
      { type: 'set_payee_from_text', template: '{payee}', createIfMissing: false, onlyIfEmpty: false },
      { type: 'set_payee_from_text', template: '{payee} Ltd', createIfMissing: true, onlyIfEmpty: true },
    ]);
    expect(screen.getByText('Set the payee from text: "{payee}"')).toBeInTheDocument();
    expect(screen.getByText('Set the payee from text: "{payee} Ltd" (created if missing) (only if empty)')).toBeInTheDocument();
  });

  it('names the way the description is written', () => {
    actions([
      { type: 'set_description', template: '{payee}', mode: 'replace', onlyIfEmpty: false },
      { type: 'set_description', template: ' / {ref}', mode: 'append', onlyIfEmpty: true },
      { type: 'set_description', template: '{ref}: ', mode: 'prepend', onlyIfEmpty: false },
    ]);
    expect(screen.getByText('Set the description (replace): "{payee}"')).toBeInTheDocument();
    expect(screen.getByText('Set the description (append): " / {ref}" (only if empty)')).toBeInTheDocument();
    expect(screen.getByText('Set the description (prepend): "{ref}: "')).toBeInTheDocument();
  });
});

describe('the actions in words: the structural actions', () => {
  const ACCOUNT = '22222222-2222-4222-8222-222222222222';
  const CATEGORY = '33333333-3333-4333-8333-333333333333';
  const named: RuleWordsLabels = {
    ...labels,
    accounts: { [ACCOUNT]: 'Loan account' },
    categories: { [CATEGORY]: 'Loans: Interest' },
  };

  function actions(list: RuleAction[], withLabels = named) {
    render(<RuleActionsInWords actions={list} labels={withLabels} />);
  }

  it('says which way a transfer goes and to or from which account', () => {
    actions([
      { type: 'convert_to_transfer', toAccountId: ACCOUNT, clearCategory: true },
      { type: 'convert_to_transfer', fromAccountId: ACCOUNT, clearCategory: false },
    ]);
    expect(screen.getByText('Turn into a transfer to Loan account')).toBeInTheDocument();
    expect(screen.getByText('Turn into a transfer from Loan account')).toBeInTheDocument();
  });

  it('lists the parts of a split with the account, the category and the rest', () => {
    actions([
      {
        type: 'split',
        parts: [
          { amount: '{principal}', transferAccountId: ACCOUNT },
          { amount: '{interest}', categoryId: CATEGORY },
          { amount: 'rest' },
        ],
      },
    ]);
    expect(
      screen.getByText('Split into: {principal} to Loan account, {interest} as Loans: Interest, and the rest'),
    ).toBeInTheDocument();
  });

  it('does not name an account that is gone', () => {
    actions([{ type: 'convert_to_transfer', toAccountId: ACCOUNT, clearCategory: true }], labels);
    expect(screen.getByText(/^Turn into a transfer to /)).toBeInTheDocument();
    expect(screen.queryByText(/Loan account/)).not.toBeInTheDocument();
  });
});
