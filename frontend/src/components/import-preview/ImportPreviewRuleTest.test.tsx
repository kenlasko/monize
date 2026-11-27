import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@/test/render';
import { ImportPreviewRuleTest } from './ImportPreviewRuleTest';
import { ImportPreviewRuleTestProvider } from './ImportPreviewRuleTestProvider';
import { transactionRulesApi } from '@/lib/transaction-rules-api';
import type { ImportPreviewRuleInput } from '@/types/import-preview';
import type {
  ExplainedRule,
  RuleConditionExplanation,
  RuleRowExplanation,
} from '@/types/transaction-rule-explain';

vi.mock('@/lib/transaction-rules-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/transaction-rules-api')>();
  return {
    ...original,
    transactionRulesApi: { ...original.transactionRulesApi, explainRow: vi.fn() },
  };
});

const explainRow = vi.mocked(transactionRulesApi.explainRow);

const ACCOUNT = 'a0000000-0000-4000-8000-000000000001';
const CATEGORY = 'c0000000-0000-4000-8000-000000000002';
const TAG = 't0000000-0000-4000-8000-000000000003';

const input = (over: Partial<ImportPreviewRuleInput> = {}): ImportPreviewRuleInput => ({
  accountId: ACCOUNT,
  currencyCode: 'PLN',
  amount: '-50.0000',
  isTransfer: false,
  payeeId: null,
  payeeText: 'Sklep Alfa nr 7',
  categoryId: null,
  description: 'Zakupy',
  tagIds: [],
  hasSplits: false,
  ...over,
});

const labels = {
  accounts: { [ACCOUNT]: 'Checking' },
  payees: {},
  categories: { [CATEGORY]: 'Food: Groceries' },
  tags: { [TAG]: 'Weekly' },
};

const leaf = (over: Partial<Extract<RuleConditionExplanation, { kind: 'leaf' }>> = {}): RuleConditionExplanation => ({
  kind: 'leaf',
  field: 'payeeText',
  operator: 'matches',
  expected: 'sklep {shop} nr *',
  actual: 'Sklep Alfa nr 7',
  result: true,
  captures: { shop: 'Alfa' },
  ...over,
});

function rule(over: Partial<ExplainedRule> = {}): ExplainedRule {
  return {
    ruleId: 'r1',
    ruleName: 'Food rule',
    enabled: true,
    position: 1,
    evaluated: true,
    matched: true,
    condition: {
      kind: 'all',
      result: true,
      children: [leaf(), leaf({ field: 'amount', operator: 'lt', expected: 0, actual: '-50.0000', captures: undefined })],
    },
    effects: {
      ruleId: 'r1',
      matched: true,
      applied: [{ type: 'set_category' }],
      skipped: [],
      changes: { categoryId: { before: null, after: CATEGORY } },
      stopped: false,
    },
    stopped: false,
    ...over,
  };
}

const notMatched = (over: Partial<ExplainedRule> = {}): ExplainedRule =>
  rule({
    ruleId: 'r2',
    ruleName: 'Fuel rule',
    position: 2,
    matched: false,
    condition: {
      kind: 'all',
      result: false,
      children: [
        leaf({ field: 'description', operator: 'contains', expected: 'diesel', actual: 'Zakupy', result: false, captures: undefined }),
        leaf({ field: 'type', operator: 'eq', expected: 'EXPENSE', actual: 'EXPENSE', result: true, captures: undefined }),
      ],
    },
    effects: { ruleId: 'r2', matched: false, applied: [], skipped: [], changes: {}, stopped: false },
    ...over,
  });

const explanation = (...rules: ExplainedRule[]): RuleRowExplanation => ({ rules, labels });

async function show(result: RuleRowExplanation, ruleInput: ImportPreviewRuleInput | null = input()) {
  explainRow.mockResolvedValue(result);
  await act(async () => {
    render(<ImportPreviewRuleTest rowKey="ref:1" ruleInput={ruleInput} />);
  });
}

beforeEach(() => {
  explainRow.mockReset();
});

describe('ImportPreviewRuleTest', () => {
  it('asks for the row as soon as it is shown, with the import trigger and the row input as it came', async () => {
    const ruleInput = input({ tagIds: [TAG] });
    await show(explanation(rule()), ruleInput);
    expect(explainRow).toHaveBeenCalledTimes(1);
    expect(explainRow).toHaveBeenCalledWith({ trigger: 'import', input: ruleInput });
  });

  it('is titled Import rules, in a region of that name', async () => {
    await show(explanation(rule()));
    expect(screen.getByRole('region', { name: 'Import rules' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Import rules' })).toBeInTheDocument();
  });

  it('shows a loading state in place until the answer arrives, never "no rules"', async () => {
    let resolve: (value: RuleRowExplanation) => void = () => {};
    explainRow.mockReturnValue(new Promise((done) => (resolve = done)));
    await act(async () => {
      render(<ImportPreviewRuleTest rowKey="ref:1" ruleInput={input()} />);
    });
    const loading = screen.getByRole('status');
    expect(loading).toHaveTextContent('Loading the rule test result');
    expect(screen.queryByText(/no import rules/i)).not.toBeInTheDocument();

    await act(async () => resolve(explanation(rule())));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the rule Food rule in a new tab' })).toBeInTheDocument();
  });

  it('renders nothing for a row that has no rule input and asks for nothing', async () => {
    await show(explanation(rule()), null);
    expect(explainRow).not.toHaveBeenCalled();
    expect(screen.queryByText('Import rules')).not.toBeInTheDocument();
  });

  describe('a rule that matched', () => {
    it('names the rule with a link to it in a new tab and a Matched badge', async () => {
      await show(explanation(rule()));
      const link = screen.getByRole('link', { name: 'Open the rule Food rule in a new tab' });
      expect(link).toHaveAttribute('href', '/rules/r1');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByText('Matched')).toBeInTheDocument();
    });

    it('reads the condition tree in the words of the rule editor, one mark per node, with the value this transaction had', async () => {
      await show(explanation(rule()));
      expect(screen.getByText('All of these:')).toBeInTheDocument();
      expect(screen.getByText('Payee text as received matches the pattern "sklep {shop} nr *"')).toBeInTheDocument();
      expect(screen.getByText('Amount (with sign) is less than 0.00')).toBeInTheDocument();
      expect(screen.getByText('Value in this transaction: "Sklep Alfa nr 7"')).toBeInTheDocument();
      expect(screen.getByText('Value in this transaction: -50.00')).toBeInTheDocument();
      // The group and its two leaves each say that the condition was met, in words for a screen reader.
      expect(screen.getAllByText('Condition met')).toHaveLength(3);
      expect(screen.queryByText('Condition not met')).not.toBeInTheDocument();
    });

    it('shows what a matches leaf captured as name = value', async () => {
      await show(explanation(rule()));
      expect(screen.getByText('shop = Alfa')).toBeInTheDocument();
    });

    it('writes what the rule changes, with names and not ids', async () => {
      await show(explanation(rule()));
      expect(screen.getByText('Category: none → Food: Groceries')).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(CATEGORY))).not.toBeInTheDocument();
    });

    it('writes the tags, the payee and the description it would set', async () => {
      await show(
        explanation(
          rule({
            effects: {
              ruleId: 'r1',
              matched: true,
              applied: [{ type: 'set_payee_from_text' }, { type: 'set_description' }, { type: 'add_tags' }],
              skipped: [],
              changes: {
                payeeName: { before: 'Sklep Alfa nr 7', after: 'Alfa' },
                payeeCreated: true,
                description: { before: 'Zakupy', after: 'Alfa: Zakupy' },
                tagIds: { before: [], after: [TAG] },
              },
              stopped: false,
            },
          }),
        ),
      );
      expect(screen.getByText('Tags added: Weekly')).toBeInTheDocument();
      expect(screen.getByText('Description: "Zakupy" → "Alfa: Zakupy"')).toBeInTheDocument();
      expect(screen.getByText('A new payee will be created: Alfa')).toBeInTheDocument();
    });

    it('says a matched rule that changes nothing changes nothing', async () => {
      await show(
        explanation(
          rule({ effects: { ruleId: 'r1', matched: true, applied: [], skipped: [], changes: {}, stopped: false } }),
        ),
      );
      expect(screen.getByText('It matched, but it changes nothing in this transaction.')).toBeInTheDocument();
    });

    it('reads a skipped action with its reason, and says a rule that stops the others stops them', async () => {
      await show(
        explanation(
          rule({
            stopped: true,
            effects: {
              ruleId: 'r1',
              matched: true,
              applied: [],
              skipped: [
                { type: 'set_category', reason: 'row_has_splits' },
                { type: 'set_category', reason: 'already_set' },
                { type: 'set_payee', reason: 'cross_owner_transfer_leg' },
                { type: 'set_payee_from_text', reason: 'no_change' },
                { type: 'set_description', reason: 'empty_render' },
                { type: 'set_payee_from_text', reason: 'payee_not_found' },
                { type: 'add_tags', reason: 'something_newer' },
                { type: 'convert_to_transfer', reason: 'row_is_transfer_leg' },
              ],
              changes: {},
              stopped: true,
            },
          }),
        ),
      );
      const text = (line: string) => screen.getByText(line);
      text('Set the category: skipped (it is split, so the category belongs to the splits)');
      text('Set the category: skipped (it already has a value and the rule only fills in an empty one)');
      text('Set the payee: skipped (it is a transfer to another owner, whose payee this rule may not change)');
      text('Set the payee from text: skipped (it already has what the rule would set)');
      text('Set the description: skipped (the text of an action came out empty for it)');
      text('Set the payee from text: skipped (no payee has the name the rule built, and it does not create one)');
      text('Add tags: skipped (the rule cannot change it)');
      // Only a structural action refuses a transfer now: a transfer takes a
      // category (INV-CATEGORY-002).
      text('Convert to transfer: skipped (it is already a transfer)');
      expect(screen.getByText('Stops the rules after it.')).toBeInTheDocument();
    });

    it('shows an action type this client does not know as the server named it', async () => {
      await show(
        explanation(
          rule({
            effects: {
              ruleId: 'r1',
              matched: true,
              applied: [{ type: 'brand_new_action' }],
              skipped: [],
              changes: {},
              stopped: false,
            },
          }),
        ),
      );
      expect(screen.getByText('Applied: brand_new_action')).toBeInTheDocument();
    });

    it('names the actions it applied when it has nothing else to say, such as a review request', async () => {
      await show(
        explanation(
          rule({
            effects: {
              ruleId: 'r1',
              matched: true,
              applied: [{ type: 'request_ai_review', outcome: 'queued' }],
              skipped: [],
              changes: {},
              stopped: false,
            },
          }),
        ),
      );
      expect(screen.getByText('Applied: Ask for an AI review')).toBeInTheDocument();
    });
  });

  describe('rules that did not match', () => {
    it('collapses them behind a button that says how many, and shows nothing of them until it is pressed', async () => {
      await show(explanation(rule(), notMatched()));
      const toggle = screen.getByRole('button', { name: 'Show rules that did not match (1)' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Fuel rule')).not.toBeInTheDocument();
      expect(screen.getByText('Food rule')).toBeInTheDocument();

      fireEvent.click(toggle);

      const open = screen.getByRole('button', { name: 'Hide rules that did not match (1)' });
      expect(open).toHaveAttribute('aria-expanded', 'true');
      expect(document.getElementById(open.getAttribute('aria-controls')!)).toHaveTextContent('Fuel rule');
      expect(screen.getByText('Not matched')).toBeInTheDocument();

      fireEvent.click(open);
      expect(screen.queryByText('Fuel rule')).not.toBeInTheDocument();
    });

    it('marks the failing leaf as not met and the one that held as met, each with what the transaction had', async () => {
      await show(explanation(notMatched()));
      fireEvent.click(screen.getByRole('button', { name: 'Show rules that did not match (1)' }));

      const failing = screen.getByText('Description contains "diesel"').closest('li')!;
      expect(within(failing).getByText('Condition not met')).toBeInTheDocument();
      expect(within(failing).getByText('Value in this transaction: "Zakupy"')).toBeInTheDocument();

      const holding = screen.getByText('Type is Expense').closest('li')!;
      expect(within(holding).getByText('Condition met')).toBeInTheDocument();
      expect(within(holding).getByText('Value in this transaction: Expense')).toBeInTheDocument();
      // The group failed as a whole.
      const group = screen.getByText('All of these:').closest('li')!;
      expect(within(group).getAllByText('Condition not met').length).toBeGreaterThan(0);
    });

    it('shows no changes for a rule that did not match', async () => {
      await show(explanation(notMatched()));
      fireEvent.click(screen.getByRole('button', { name: 'Show rules that did not match (1)' }));
      expect(screen.queryByText(/Category:/)).not.toBeInTheDocument();
    });

    it('says no rule matched when none did, and still offers the rules that did not', async () => {
      await show(explanation(notMatched()));
      expect(screen.getByText('No import rule matched this transaction.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show rules that did not match (1)' })).toBeInTheDocument();
    });

    it('has no button when every rule matched', async () => {
      await show(explanation(rule()));
      expect(screen.queryByRole('button', { name: /did not match/ })).not.toBeInTheDocument();
    });

    it('lists a rule after a stop as not evaluated, with the reason and no condition', async () => {
      await show(
        explanation(
          rule({ stopped: true }),
          notMatched({ evaluated: false, condition: null, effects: null }),
        ),
      );
      expect(screen.getByText('Stops the rules after it.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show rules that did not match (1)' }));
      expect(screen.getByText('Not evaluated')).toBeInTheDocument();
      expect(screen.getByText('Not evaluated: a previous rule stopped the rules.')).toBeInTheDocument();
      expect(screen.queryByText('Description contains "diesel"')).not.toBeInTheDocument();
    });

    it.each([
      ['disabled', 'Not evaluated: the rule is switched off.'],
      ['invalid', 'Not evaluated: the rule is not valid. Open it to repair it.'],
    ] as const)('says why a %s rule was not evaluated', async (skippedRule, sentence) => {
      await show(
        explanation(
          notMatched({ evaluated: false, condition: null, effects: null, skippedRule, enabled: skippedRule !== 'disabled' }),
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Show rules that did not match (1)' }));
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText('Not evaluated: a previous rule stopped the rules.')).not.toBeInTheDocument();
    });
  });

  describe('the condition tree', () => {
    const matchedWith = (condition: RuleConditionExplanation) => show(explanation(rule({ condition })));

    it('reads not over a group as one line, with the group beneath it', async () => {
      await matchedWith({
        kind: 'not',
        result: true,
        children: [
          {
            kind: 'any',
            result: false,
            children: [leaf({ field: 'description', operator: 'contains', expected: 'diesel', result: false, captures: undefined })],
          },
        ],
      });
      expect(screen.getByText('None of these:')).toBeInTheDocument();
      expect(screen.getByText('Description contains "diesel"')).toBeInTheDocument();
      expect(screen.queryByText('Any of these:')).not.toBeInTheDocument();
    });

    it('reads a rule with no conditions as matching every transaction', async () => {
      await matchedWith({ kind: 'all', result: true, children: [] });
      expect(screen.getByText('Every transaction')).toBeInTheDocument();
    });

    it('reads an empty nested group as empty', async () => {
      await matchedWith({ kind: 'all', result: true, children: [{ kind: 'any', result: false, children: [] }] });
      expect(screen.getByText('This group is empty.')).toBeInTheDocument();
    });

    it('names ids by their labels, an id with no name as a deleted item, and no fact as none', async () => {
      await matchedWith({
        kind: 'all',
        result: true,
        children: [
          leaf({ field: 'accountId', operator: 'eq', expected: ACCOUNT, actual: ACCOUNT, captures: undefined }),
          leaf({ field: 'categoryId', operator: 'eq', expected: CATEGORY, actual: 'c0000000-0000-4000-8000-0000000000ff', captures: undefined, result: false }),
          leaf({ field: 'payeeId', operator: 'isEmpty', expected: null, actual: null, captures: undefined }),
          leaf({ field: 'tagIds', operator: 'hasAny', expected: [TAG], actual: [TAG, 't-gone'], captures: undefined }),
          leaf({ field: 'tagIds', operator: 'hasAny', expected: [TAG], actual: [], captures: undefined, result: false }),
        ],
      });
      expect(screen.getByText('Account is Checking')).toBeInTheDocument();
      expect(screen.getByText('Value in this transaction: Checking')).toBeInTheDocument();
      expect(screen.getByText('Value in this transaction: a deleted item')).toBeInTheDocument();
      expect(screen.getByText('Value in this transaction: none')).toBeInTheDocument();
      expect(screen.getByText('Value in this transaction: Weekly and a deleted item')).toBeInTheDocument();
      expect(screen.getByText('Value in this transaction: no tags')).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(ACCOUNT))).not.toBeInTheDocument();
    });

    it('reads booleans, days, weekdays and statuses in words', async () => {
      await matchedWith({
        kind: 'all',
        result: true,
        children: [
          leaf({ field: 'hasSplits', operator: 'eq', expected: false, actual: false, captures: undefined }),
          leaf({ field: 'dayOfMonth', operator: 'eq', expected: 1, actual: 1, captures: undefined }),
          leaf({ field: 'weekday', operator: 'eq', expected: 'SUN', actual: 'SUN', captures: undefined }),
          leaf({ field: 'status', operator: 'eq', expected: 'CLEARED', actual: 'CLEARED', captures: undefined }),
        ],
      });
      expect(screen.getAllByText(/^Value in this transaction:/).map((el) => el.textContent)).toEqual([
        'Value in this transaction: No',
        'Value in this transaction: 1',
        'Value in this transaction: Sun',
        'Value in this transaction: Cleared',
      ]);
    });

    it('says a part left out by the server is not shown, and a condition this version cannot show says so', async () => {
      await matchedWith({
        kind: 'all',
        result: true,
        children: [
          { kind: 'omitted', result: true },
          leaf({ field: 'newfield' as never, operator: 'eq', expected: 'x', actual: 'y', captures: undefined }),
        ],
      });
      expect(screen.getByText('The details of this part of the condition are not shown.')).toBeInTheDocument();
      expect(screen.getByText('A condition this version cannot show')).toBeInTheDocument();
    });

    it('shows every capture of a leaf', async () => {
      await matchedWith({
        kind: 'all',
        result: true,
        children: [leaf({ captures: { shop: 'Alfa', num: '7' } })],
      });
      expect(screen.getByText('shop = Alfa')).toBeInTheDocument();
      expect(screen.getByText('num = 7')).toBeInTheDocument();
    });
  });

  describe('when there are no rules, or loading failed', () => {
    it('says the user has no import rules when the server answers an empty list', async () => {
      await show(explanation());
      expect(screen.getByText('You have no import rules, so there was nothing to test.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows a failed load as an error with a retry, never as "no rules"', async () => {
      explainRow.mockRejectedValue(new Error('network'));
      await act(async () => {
        render(<ImportPreviewRuleTest rowKey="ref:1" ruleInput={input()} />);
      });
      expect(screen.getByRole('alert')).toHaveTextContent('The rule test result could not be loaded.');
      expect(screen.queryByText(/no import rules/i)).not.toBeInTheDocument();
      expect(screen.queryByText('No import rule matched this transaction.')).not.toBeInTheDocument();

      explainRow.mockResolvedValue(explanation(rule()));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      });
      expect(explainRow).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('Food rule')).toBeInTheDocument();
    });

    it('goes back to loading while it retries', async () => {
      explainRow.mockRejectedValueOnce(new Error('network'));
      await act(async () => {
        render(<ImportPreviewRuleTest rowKey="ref:1" ruleInput={input()} />);
      });
      let resolve: (value: RuleRowExplanation) => void = () => {};
      explainRow.mockReturnValue(new Promise((done) => (resolve = done)));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      });
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await act(async () => resolve(explanation()));
      expect(screen.getByText('You have no import rules, so there was nothing to test.')).toBeInTheDocument();
    });
  });

  describe('once per row while the preview is open', () => {
    function Rows({ scope }: { scope: object }) {
      const [open, setOpen] = useState<Record<string, boolean>>({});
      const toggle = (key: string) => setOpen((now) => ({ ...now, [key]: !now[key] }));
      return (
        <ImportPreviewRuleTestProvider scope={scope}>
          {['a', 'b'].map((key) => (
            <div key={key}>
              <button onClick={() => toggle(key)}>toggle {key}</button>
              {open[key] && <ImportPreviewRuleTest rowKey={key} ruleInput={input({ payeeText: `Row ${key}` })} />}
            </div>
          ))}
        </ImportPreviewRuleTestProvider>
      );
    }

    it('does not ask again when a row is collapsed and expanded, and asks once for each row', async () => {
      explainRow.mockResolvedValue(explanation(rule()));
      await act(async () => {
        render(<Rows scope={{}} />);
      });
      const click = async (name: string) => {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name }));
        });
      };

      await click('toggle a');
      expect(explainRow).toHaveBeenCalledTimes(1);
      await click('toggle a');
      expect(screen.queryByText('Food rule')).not.toBeInTheDocument();
      await click('toggle a');
      expect(explainRow).toHaveBeenCalledTimes(1);
      // Shown straight from the answer already held, not through a second loading state.
      expect(screen.getByText('Food rule')).toBeInTheDocument();

      await click('toggle b');
      expect(explainRow).toHaveBeenCalledTimes(2);
      expect(explainRow).toHaveBeenLastCalledWith({ trigger: 'import', input: input({ payeeText: 'Row b' }) });
    });

    it('asks again for a row whose first load failed, when it is expanded again', async () => {
      explainRow.mockRejectedValueOnce(new Error('network')).mockResolvedValue(explanation(rule()));
      await act(async () => {
        render(<Rows scope={{}} />);
      });
      const click = async (name: string) => {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name }));
        });
      };
      await click('toggle a');
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await click('toggle a');
      await click('toggle a');
      expect(explainRow).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Food rule')).toBeInTheDocument();
    });

    it('starts again with a new preview, because the rules may have changed since', async () => {
      explainRow.mockResolvedValue(explanation(rule()));
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<Rows scope={{}} />);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'toggle a' }));
      });
      expect(explainRow).toHaveBeenCalledTimes(1);

      await act(async () => {
        view.rerender(<Rows scope={{}} />);
      });
      expect(explainRow).toHaveBeenCalledTimes(2);
    });
  });
});
