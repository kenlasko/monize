import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@/test/render';
import { RuleEffectsLines } from './RuleEffectsLines';
import type { PendingActionRuleEffects } from '@/types/ai';

const labels = { categories: {}, payees: { 'pay-1': 'Starbucks' }, tags: {}, rules: {} };

function effects(changes: Partial<PendingActionRuleEffects['changes']>): PendingActionRuleEffects {
  return { changes: { addTagIds: [], removeTagIds: [], ...changes }, aiReviewRequests: [], labels };
}

describe('RuleEffectsLines: the text actions', () => {
  it('says a payee named by text will be created when the row is saved', () => {
    render(<RuleEffectsLines effects={effects({ payeeName: 'Corner Cafe', createPayee: 'Corner Cafe' })} />);
    expect(within(screen.getByTestId('rule-effects')).getByText('A new payee will be created: Corner Cafe')).toBeInTheDocument();
  });

  it('names a payee chosen by text that no id stands for', () => {
    render(<RuleEffectsLines effects={effects({ payeeName: 'Corner Cafe' })} />);
    expect(screen.getByText('Set the payee to Corner Cafe')).toBeInTheDocument();
  });

  it('prefers the payee found by id, and says nothing twice', () => {
    render(<RuleEffectsLines effects={effects({ payeeId: 'pay-1', payeeName: 'Starbucks' })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Set the payee to Starbucks')).toBeInTheDocument();
  });

  it('says what the description will be', () => {
    render(<RuleEffectsLines effects={effects({ description: 'POS 1 / REF 9' })} />);
    expect(screen.getByText('Set the description to "POS 1 / REF 9"')).toBeInTheDocument();
  });

  it('renders nothing when the rules do nothing to the text', () => {
    const { container } = render(<RuleEffectsLines effects={effects({})} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RuleEffectsLines: a structural action', () => {
  const withAccounts = (changes: Partial<PendingActionRuleEffects['changes']>, accounts?: Record<string, string>) => ({
    ...effects(changes),
    labels: { ...labels, categories: { 'cat-1': 'Loans: Interest' }, ...(accounts ? { accounts } : {}) },
  });

  it('says the row becomes a transfer to the named account, with nothing else to say', () => {
    render(
      <RuleEffectsLines
        effects={withAccounts(
          { structure: { kind: 'transfer', accountId: 'a1', clearCategory: true } },
          { a1: 'Loan account' },
        )}
      />,
    );
    expect(within(screen.getByTestId('rule-effects')).getByText('Becomes a transfer with Loan account')).toBeInTheDocument();
    expect(screen.getByText('Your rules will also:')).toBeInTheDocument();
  });

  it('lists each part of a split with its signed amount and its target', () => {
    render(
      <RuleEffectsLines
        currencyCode="CAD"
        effects={withAccounts(
          {
            structure: {
              kind: 'split',
              parts: [
                { amount: -1200.5, transferAccountId: 'a1', categoryId: null, payeeId: null, memo: null },
                { amount: -300.25, transferAccountId: null, categoryId: 'cat-1', payeeId: null, memo: null },
              ],
            },
          },
          { a1: 'Loan account' },
        )}
      />,
    );
    const block = screen.getByTestId('rule-effects');
    expect(within(block).getByText('Will be split into 2 parts')).toBeInTheDocument();
    expect(within(block).getByText('Part 1: -$1,200.50 to Loan account')).toBeInTheDocument();
    expect(within(block).getByText('Part 2: -$300.25 as Loans: Interest')).toBeInTheDocument();
  });

  it('tolerates a card that carries no account names', () => {
    render(
      <RuleEffectsLines effects={withAccounts({ structure: { kind: 'transfer', accountId: 'a1', clearCategory: true } })} />,
    );
    expect(screen.getByText('Becomes a transfer with a deleted item')).toBeInTheDocument();
  });
});
