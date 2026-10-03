import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { RuleConfirmationCard } from './RuleConfirmationCard';
import { makeRule, makeRuleAction, makeTest } from './rule-card-fixtures';
import type { PendingAction, PendingActionRule } from '@/types/ai';

function renderCard(action: PendingAction, handlers = { onConfirm: vi.fn(), onCancel: vi.fn() }) {
  render(<RuleConfirmationCard action={action} {...handlers} />);
  return handlers;
}

/** No raw id may reach the screen: the fixtures' ids all contain a dash and a digit. */
function expectNoIds() {
  expect(document.body.textContent).not.toMatch(/\b(acc|pay|cat|tag|tx)-\d\b/);
}

describe('RuleConfirmationCard: create', () => {
  const action = makeRuleAction('create_transaction_rule', makeRule({ test: makeTest() }));

  it('titles the card and reads the rule in words with names', () => {
    renderCard(action);
    expect(screen.getByText('Create this rule?')).toBeInTheDocument();
    expect(screen.getByText('Tag coffee shops')).toBeInTheDocument();
    // Triggers.
    expect(screen.getByText('A transaction is created')).toBeInTheDocument();
    expect(screen.getByText('A transaction is imported')).toBeInTheDocument();
    // Actions, with names and the only-if-empty marker.
    expect(screen.getByText('Set the category to Food: Coffee (only if empty)')).toBeInTheDocument();
    expect(screen.getByText('Set the payee to Starbucks')).toBeInTheDocument();
    expect(screen.getByText('Add tags: coffee and treat')).toBeInTheDocument();
    expect(screen.getByText('Ask for an AI review: Check the receipt')).toBeInTheDocument();
    expect(screen.getByText('Stop processing other rules')).toBeInTheDocument();
    expectNoIds();
  });

  it('shows the conditions as a nested list with all/any groups', () => {
    renderCard(action);
    const root = screen.getByText('All of these:').closest('li') as HTMLElement;
    expect(within(root).getByText('Payee text as received contains "starbucks"')).toBeInTheDocument();
    const nested = within(root).getByText('Any of these:').closest('li') as HTMLElement;
    expect(within(nested).getByText('Account is Checking')).toBeInTheDocument();
    expect(within(nested).getByText('Amount (ignoring sign) is between 2.00 and 15.50')).toBeInTheDocument();
    expect(within(nested).getByText('Type is Expense')).toBeInTheDocument();
    expect(within(root).getByText('Tags has none of treat')).toBeInTheDocument();
    // The nested group is inside the root group's list, not beside it.
    expect(root.contains(nested)).toBe(true);
  });

  it('says a rule without conditions applies to every transaction', () => {
    renderCard(makeRuleAction('create_transaction_rule', makeRule({ condition: { all: [] } })));
    expect(screen.getByText('Every transaction')).toBeInTheDocument();
  });

  it('names a negated group, a missing name and a value-less operator', () => {
    renderCard(
      makeRuleAction(
        'create_transaction_rule',
        makeRule({
          condition: {
            all: [
              { any: [{ field: 'payeeId', op: 'eq', value: 'deleted-payee' }, { field: 'referenceNumber', op: 'isEmpty' }], not: true },
              { field: 'hasSplits', op: 'eq', value: true },
            ],
          },
          stopProcessing: false,
        }),
      ),
    );
    expect(screen.getByText('None of these:')).toBeInTheDocument();
    expect(screen.getByText('Payee is a deleted item')).toBeInTheDocument();
    expect(screen.getByText('Reference number is empty')).toBeInTheDocument();
    expect(screen.getByText('Has splits is Yes')).toBeInTheDocument();
    expect(screen.queryByText('Stop processing other rules')).not.toBeInTheDocument();
  });

  it('shows the test result with the first rows, formatted money and the change in words', () => {
    renderCard(action);
    const test = screen.getByTestId('rule-test-result');
    expect(within(test).getByText('Test on your existing transactions')).toBeInTheDocument();
    expect(within(test).getByText(/14 transactions would change/)).toBeInTheDocument();
    expect(within(test).getByText(/out of 200 transactions scanned/)).toBeInTheDocument();
    expect(within(test).getByText(/Starbucks 123/)).toBeInTheDocument();
    expect(within(test).getByText('-$4.50')).toBeInTheDocument();
    expect(within(test).getByText('Category: none → Food: Coffee')).toBeInTheDocument();
    expect(within(test).getByText('Tags added: coffee')).toBeInTheDocument();
    // A row in another currency uses its own; a missing payee and a deleted payee read as such.
    expect(within(test).getByText('-€7.00')).toBeInTheDocument();
    expect(within(test).getByText(/No payee/)).toBeInTheDocument();
    expect(within(test).getByText('Payee: a deleted item → Starbucks')).toBeInTheDocument();
    expect(within(test).getByText('Showing the first 2 of 14.')).toBeInTheDocument();
    expectNoIds();
  });

  it('shows skipped counts with translated reasons and the AI review count', () => {
    renderCard(action);
    const skipped = screen.getByTestId('rule-test-skipped');
    expect(within(skipped).getByText('5 transactions are left alone')).toBeInTheDocument();
    expect(within(skipped).getByText('1 transaction: it is reconciled and locked')).toBeInTheDocument();
    expect(
      within(skipped).getByText('1 transaction: it is split, so the category belongs to the splits'),
    ).toBeInTheDocument();
    expect(within(skipped).getByText('Reasons are shown for the first 2 only.')).toBeInTheDocument();
    expect(screen.getByText('3 AI review requests would be queued.')).toBeInTheDocument();
  });

  it('notes a truncated scan and says nothing extra when everything is shown', () => {
    renderCard(
      makeRuleAction(
        'create_transaction_rule',
        makeRule({
          test: makeTest({
            truncated: true,
            matchedCount: 2,
            skippedCount: 0,
            skipped: [],
            aiReviewRequests: 0,
          }),
        }),
      ),
    );
    expect(screen.getByText(/More transactions matched than the limit allows/)).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('rule-test-skipped')).not.toBeInTheDocument();
    expect(screen.queryByText(/AI review requests? would be queued/)).not.toBeInTheDocument();
  });

  it('says so when a test changes nothing', () => {
    renderCard(
      makeRuleAction(
        'create_transaction_rule',
        makeRule({
          test: makeTest({
            matchedCount: 0,
            conditionMatchedCount: 0,
            rows: [],
            skipped: [],
            skippedCount: 0,
            aiReviewRequests: 0,
          }),
        }),
      ),
    );
    expect(screen.getByText(/0 transactions would change/)).toBeInTheDocument();
    // ... and a rule that matches nothing is usually wrong, so the card says that plainly.
    expect(screen.getByRole('status')).toHaveTextContent(
      'This rule matches none of the transactions examined (200). Check the conditions before saving. A pattern without * matches only the whole text.',
    );
  });

  it('says the condition matches but nothing would change, without the wrong-rule warning', () => {
    renderCard(
      makeRuleAction(
        'create_transaction_rule',
        makeRule({
          test: makeTest({
            matchedCount: 0,
            conditionMatchedCount: 9,
            rows: [],
            skipped: [],
            skippedCount: 0,
            aiReviewRequests: 0,
          }),
        }),
      ),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      "9 of the 200 transactions examined match the rule's conditions, but nothing would change",
    );
    expect(screen.getByRole('status')).toHaveTextContent('This is not an error.');
    expect(screen.queryByText(/matches none of the transactions examined/)).not.toBeInTheDocument();
  });

  it('does not warn when the rule matches something or nothing was examined', () => {
    renderCard(action);
    expect(screen.queryByText(/matches none of the transactions examined/)).not.toBeInTheDocument();
    renderCard(
      makeRuleAction(
        'create_transaction_rule',
        makeRule({
          test: makeTest({
            matchedCount: 0,
            conditionMatchedCount: 0,
            scanned: 0,
            rows: [],
            skipped: [],
            skippedCount: 0,
            aiReviewRequests: 0,
          }),
        }),
      ),
    );
    expect(screen.queryByText(/matches none of the transactions examined/)).not.toBeInTheDocument();
  });

  it('approves and cancels', () => {
    const { onConfirm, onCancel } = renderCard(action);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the created state with a link to the rules', () => {
    renderCard({ ...action, status: 'confirmed' });
    expect(screen.getByText('Rule created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View rules' })).toHaveAttribute('href', '/rules');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('says the details are missing instead of rendering an empty card', () => {
    renderCard(makeRuleAction('create_transaction_rule', undefined));
    expect(screen.getByText(/The details of this rule are not available/)).toBeInTheDocument();
  });
});

describe('RuleConfirmationCard: update', () => {
  const current = makeRule();
  const proposed: PendingActionRule = makeRule({
    name: 'Tag coffee and tea',
    enabled: false,
    triggers: ['create'],
    actions: [{ type: 'add_tags', tagIds: ['tag-1'] }],
    current: {
      name: current.name,
      enabled: current.enabled,
      triggers: current.triggers,
      condition: current.condition,
      actions: current.actions,
      stopProcessing: current.stopProcessing,
    },
    test: makeTest(),
  });

  it('shows what was and what is now, only for the parts that change', () => {
    renderCard(makeRuleAction('update_transaction_rule', proposed));
    expect(screen.getByText('Apply this rule edit?')).toBeInTheDocument();
    const diff = screen.getByTestId('rule-diff');

    const name = within(within(diff).getByTestId('rule-diff-name'));
    expect(name.getByText('Tag coffee shops')).toBeInTheDocument();
    expect(name.getByText('Tag coffee and tea')).toBeInTheDocument();

    const enabled = within(within(diff).getByTestId('rule-diff-enabled'));
    expect(enabled.getByText('Yes')).toBeInTheDocument();
    expect(enabled.getByText('No')).toBeInTheDocument();

    const triggers = within(within(diff).getByTestId('rule-diff-triggers'));
    expect(triggers.getAllByText('A transaction is created')).toHaveLength(2);
    expect(triggers.getAllByText('A transaction is imported')).toHaveLength(1);

    const actions = within(within(diff).getByTestId('rule-diff-actions'));
    expect(actions.getByText('Set the category to Food: Coffee (only if empty)')).toBeInTheDocument();
    expect(actions.getAllByText('Add tags: coffee')).toHaveLength(1);

    // The condition and stop-processing are unchanged and not repeated.
    expect(within(diff).queryByTestId('rule-diff-condition')).not.toBeInTheDocument();
    expect(within(diff).queryByTestId('rule-diff-stopProcessing')).not.toBeInTheDocument();
    expectNoIds();
  });

  it('shows a moved active window as its own changed part, and the window of a new rule', () => {
    const windowed: PendingActionRule = makeRule({
      activeFrom: '2026-10-01',
      activeTo: null,
      current: { ...proposed.current!, activeFrom: null, activeTo: null },
    });
    renderCard(makeRuleAction('update_transaction_rule', windowed));
    const diff = within(screen.getByTestId('rule-diff'));
    const part = within(diff.getByTestId('rule-diff-activeWindow'));
    expect(part.getByText('Active between')).toBeInTheDocument();
    expect(part.getByText(/Only for transactions dated from .*2026.* to no limit/)).toBeInTheDocument();
    expect(diff.queryByTestId('rule-diff-name')).not.toBeInTheDocument();
  });

  it('shows the window on a card that reads the whole rule', () => {
    renderCard(makeRuleAction('create_transaction_rule', makeRule({ activeFrom: '2026-10-01', activeTo: '2026-12-31' })));
    expect(screen.getByText(/Only for transactions dated from .*2026.* to .*2026/)).toBeInTheDocument();
  });

  it('shows the test result of the edited rule', () => {
    renderCard(makeRuleAction('update_transaction_rule', proposed));
    expect(screen.getByTestId('rule-test-result')).toBeInTheDocument();
  });

  it('says so when nothing differs', () => {
    renderCard(makeRuleAction('update_transaction_rule', makeRule({ current: makeRule() })));
    expect(screen.getByText('The rule stays as it is.')).toBeInTheDocument();
  });

  it('falls back to the whole rule when the stored one is missing', () => {
    renderCard(makeRuleAction('update_transaction_rule', makeRule()));
    expect(screen.getByTestId('rule-in-words')).toBeInTheDocument();
  });

  it('shows the updated state', () => {
    renderCard(
      makeRuleAction('update_transaction_rule', proposed, {
        status: 'confirmed',
      }),
    );
    expect(screen.getByText('Rule updated')).toBeInTheDocument();
  });
});

describe('RuleConfirmationCard: delete', () => {
  it('titles the card, names the rule and reads it in words', () => {
    renderCard(makeRuleAction('delete_transaction_rule', makeRule()));
    expect(screen.getByText('Delete this rule?')).toBeInTheDocument();
    expect(screen.getByText('Tag coffee shops')).toBeInTheDocument();
    expect(screen.getByText('Set the payee to Starbucks')).toBeInTheDocument();
    expect(screen.queryByTestId('rule-test-result')).not.toBeInTheDocument();
  });

  it('shows the deleted state', () => {
    renderCard(
      makeRuleAction('delete_transaction_rule', makeRule(), {
        status: 'confirmed',
      }),
    );
    expect(screen.getByText('Rule deleted')).toBeInTheDocument();
  });
});

describe('RuleConfirmationCard: run', () => {
  const run = makeRule({
    filters: {
      accountIds: ['acc-1', 'acc-2'],
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      limit: 500,
    },
    test: makeTest(),
  });

  it('shows the filters with account names, the test result and the undo note', () => {
    renderCard(makeRuleAction('run_transaction_rule', run));
    expect(screen.getByText('Run this rule on existing transactions?')).toBeInTheDocument();
    const filters = screen.getByTestId('rule-run-filters');
    expect(within(filters).getByText('Checking, Savings')).toBeInTheDocument();
    expect(within(filters).getByText('From')).toBeInTheDocument();
    expect(within(filters).getByText('To')).toBeInTheDocument();
    expect(within(filters).getByText('500')).toBeInTheDocument();
    expect(screen.getByText('What this run changes')).toBeInTheDocument();
    expect(screen.getByText(/14 transactions would change/)).toBeInTheDocument();
    expect(screen.getByText('You can undo the run from the action history.')).toBeInTheDocument();
    expectNoIds();
  });

  it('reads no account filter as all accounts', () => {
    renderCard(makeRuleAction('run_transaction_rule', makeRule({ filters: {}, test: makeTest() })));
    const filters = screen.getByTestId('rule-run-filters');
    expect(within(filters).getByText('All accounts')).toBeInTheDocument();
    expect(within(filters).queryByText('From')).not.toBeInTheDocument();
  });

  it('names an account that is gone as a deleted item', () => {
    renderCard(makeRuleAction('run_transaction_rule', makeRule({ filters: { accountIds: ['acc-9'] } })));
    expect(within(screen.getByTestId('rule-run-filters')).getByText('a deleted item')).toBeInTheDocument();
  });

  it('shows what the confirmed run changed and skipped, and that it can be undone', () => {
    renderCard(
      makeRuleAction('run_transaction_rule', run, {
        status: 'confirmed',
        resultRuleRun: {
          changed: 12,
          skipped: [
            { transactionId: 'tx-9', reason: 'reconciled_locked' },
            { transactionId: 'tx-8', reason: 'reconciled_locked' },
          ],
          historyId: 'h1',
        },
      }),
    );
    expect(screen.getByText('12 transactions were changed.')).toBeInTheDocument();
    expect(screen.getByText('2 transactions are left alone')).toBeInTheDocument();
    expect(screen.getByText('2 transactions: it is reconciled and locked')).toBeInTheDocument();
    // Said once, in the confirmed state: the pre-approval note is gone with the footer swap.
    expect(screen.getAllByText('You can undo the run from the action history.').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'View rules' })).toBeInTheDocument();
  });

  it('shows a run that changed nothing as a known zero', () => {
    renderCard(
      makeRuleAction('run_transaction_rule', run, {
        status: 'confirmed',
        resultRuleRun: { changed: 0, skipped: [], historyId: null },
      }),
    );
    expect(screen.getByText('No transactions were changed.')).toBeInTheDocument();
  });

  it('still confirms a run whose result did not come back', () => {
    renderCard(makeRuleAction('run_transaction_rule', run, { status: 'confirmed' }));
    expect(screen.getByText('Rule run completed')).toBeInTheDocument();
  });
});

describe('RuleConfirmationCard: states and unknown values', () => {
  it('shows the error and retries', () => {
    const { onConfirm } = renderCard(
      makeRuleAction('create_transaction_rule', makeRule(), {
        status: 'error',
        errorMessage: 'Rule changed',
      }),
    );
    expect(screen.getByText('Rule changed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows saving, cancelled and expired', () => {
    const { unmount } = render(
      <RuleConfirmationCard
        action={makeRuleAction('create_transaction_rule', makeRule(), {
          status: 'confirming',
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    unmount();
    const cancelled = render(
      <RuleConfirmationCard
        action={makeRuleAction('create_transaction_rule', makeRule(), {
          status: 'cancelled',
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    cancelled.unmount();
    renderCard(
      makeRuleAction('create_transaction_rule', makeRule(), {
        status: 'expired',
      }),
    );
    expect(screen.getByText(/This confirmation expired/)).toBeInTheDocument();
  });

  it('says a field, operator or action it does not know cannot be shown', () => {
    renderCard(
      makeRuleAction(
        'create_transaction_rule',
        makeRule({
          condition: {
            all: [{ field: 'merchantCity', op: 'eq', value: 'x' } as never],
          },
          actions: [{ type: 'send_email' } as never],
        }),
      ),
    );
    expect(screen.getByText('A condition this version cannot show')).toBeInTheDocument();
    expect(screen.getByText('An action this version cannot show')).toBeInTheDocument();
  });
});
