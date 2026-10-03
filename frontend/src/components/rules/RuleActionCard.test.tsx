import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import { RuleActionCard } from './RuleActionCard';
import { testOptions } from './rule-test-harness';
import { COFFEE_ID, PAYEE_ID, TAG_ID } from './rules-test-fixtures';
import { EDITOR_ACTION_TYPES, createAction, createSplitPart, type EditableActionType, type EditorAction } from '@/lib/rule-actions';
import { actionToApi } from '@/lib/rule-draft';
import { placeErrors, structuralFieldErrors } from '@/lib/rule-errors';
import {
  MAX_RULE_AI_INSTRUCTION_LENGTH,
  MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH,
  MAX_RULE_PAYEE_TEMPLATE_LENGTH,
} from '@/lib/rule-fields';

Element.prototype.scrollIntoView = vi.fn();

function Card({
  initial,
  types = EDITOR_ACTION_TYPES,
  onAction,
  errors = [],
  captures,
  fieldErrors,
}: {
  initial: EditorAction;
  types?: readonly EditableActionType[];
  onAction?: (action: EditorAction) => void;
  errors?: readonly string[];
  captures?: readonly string[];
  fieldErrors?: ReturnType<typeof structuralFieldErrors>;
}) {
  const [action, setAction] = useState(initial);
  return (
    <RuleActionCard
      action={action}
      types={types}
      options={testOptions}
      actions={[]}
      errors={errors}
      captures={captures}
      fieldErrors={fieldErrors}
      onChange={(next) => {
        setAction(next);
        onAction?.(next);
      }}
    />
  );
}

const optionLabels = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

describe('RuleActionCard', () => {
  describe('usage guide', () => {
    it('shows the split guide under the type select, with the example braces rendered literally', () => {
      render(<Card initial={createAction('split')} />);
      const guide = screen.getByTestId('rule-action-guide');
      expect(guide.parentElement).toContainElement(screen.getByLabelText('Action type'));
      expect(within(guide).getByText(/matches the pattern/)).toBeInTheDocument();
      expect(within(guide).getByText(/^Bank text: PRINCIPAL: 1200,50 INTEREST: 300,25 PENALTY: 0,00$/)).toBeInTheDocument();
      expect(within(guide).getByText('Pattern: *PRINCIPAL: {principal} INTEREST: {interest} PENALTY*')).toBeInTheDocument();
      expect(within(guide).getByText(/^Part 1: \{principal\} as a transfer/)).toBeInTheDocument();
      expect(within(guide).getByText(/^Part 2: \{interest\} as the category/)).toBeInTheDocument();
      expect(within(guide).getByText(/Active between/)).toBeInTheDocument();
    });

    it('shows the short guide for a conversion to a transfer', () => {
      render(<Card initial={createAction('convert_to_transfer')} />);
      const guide = screen.getByTestId('rule-action-guide');
      expect(within(guide).getByText(/Only the balance of the other account changes/)).toBeInTheDocument();
      expect(within(guide).queryByText(/Bank text/)).not.toBeInTheDocument();
    });

    it('shows no guide for the other action types and follows a change of type', () => {
      render(<Card initial={createAction('add_tags')} />);
      expect(screen.queryByTestId('rule-action-guide')).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'split' } });
      expect(screen.getByTestId('rule-action-guide')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'set_payee' } });
      expect(screen.queryByTestId('rule-action-guide')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Action type')).toBeInTheDocument();
    });
  });

  it('lists the action types it is given, translated', () => {
    render(<Card initial={createAction('add_tags')} types={['add_tags', 'set_payee']} />);
    expect(optionLabels(screen.getByLabelText('Action type'))).toEqual(['Add tags', 'Set the payee']);
  });

  it('lists all nine types when none is held back', () => {
    render(<Card initial={createAction('add_tags')} />);
    expect(optionLabels(screen.getByLabelText('Action type'))).toEqual([
      'Add tags',
      'Remove tags',
      'Set the category',
      'Set the payee',
      'Set the payee from text',
      'Set the description',
      'Convert to transfer',
      'Split transaction',
      'Ask for an AI review',
    ]);
  });

  it('starts "Only if empty" on when the type is changed to set_category or set_payee', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('add_tags')} onAction={onAction} />);
    expect(screen.queryByRole('switch', { name: 'Only if empty' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'set_category' } });
    expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'true');
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'set_category', onlyIfEmpty: true }));

    fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'set_payee' } });
    expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'true');
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'set_payee', onlyIfEmpty: true }));
  });

  it('explains what "Only if empty" does not replace', () => {
    render(<Card initial={createAction('set_category')} />);
    const help = screen.getByRole('button', { name: /does not replace one set by hand or by the payee's default category/ });
    expect(help).toBeInTheDocument();
  });

  it('turns "Only if empty" off and keeps the choice', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('set_payee')} onAction={onAction} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Only if empty' }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'set_payee', onlyIfEmpty: false }));
    expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'false');
  });

  it('picks a category and a payee by name', () => {
    const onAction = vi.fn();
    const { unmount } = render(<Card initial={createAction('set_category')} onAction={onAction} />);
    fireEvent.focus(screen.getByPlaceholderText('Choose a category'));
    fireEvent.click(screen.getByText('Food: Coffee'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: COFFEE_ID, onlyIfEmpty: true }));
    unmount();

    render(<Card initial={createAction('set_payee')} onAction={onAction} />);
    fireEvent.focus(screen.getByPlaceholderText('Choose a payee'));
    fireEvent.click(screen.getByText('Corner Cafe'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ payeeId: PAYEE_ID }));
  });

  it('picks tags for add_tags and remove_tags', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('remove_tags')} onAction={onAction} />);
    fireEvent.click(screen.getByText('Choose tags'));
    fireEvent.click(screen.getByLabelText('Coffee run'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'remove_tags', tagIds: [TAG_ID] }));
  });

  it('takes the instruction of an AI review, bounded to what the server accepts', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('request_ai_review')} onAction={onAction} />);
    const box = screen.getByLabelText('What should be checked');
    expect(box).toHaveAttribute('maxlength', String(MAX_RULE_AI_INSTRUCTION_LENGTH));
    fireEvent.change(box, { target: { value: 'Split by the receipt' } });
    expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'request_ai_review', instruction: 'Split by the receipt' }),
    );
    expect(screen.getByText(/A person approves any change/)).toBeInTheDocument();
  });

  it('shows its errors on the card', () => {
    render(<Card initial={createAction('set_payee')} errors={['REFERENCE_NOT_FOUND']} />);
    expect(screen.getByRole('alert')).toHaveTextContent('An item chosen here no longer exists. Choose another.');
  });

  it('stacks its controls on a phone', () => {
    render(<Card initial={createAction('add_tags')} />);
    const grid = screen.getByLabelText('Action type').closest('.grid');
    expect(grid).toHaveClass('grid-cols-1');
  });

  it('links the AI review action to the review inbox', () => {
    render(<Card initial={createAction('request_ai_review')} />);
    expect(screen.getByRole('link', { name: 'See the review inbox' })).toHaveAttribute('href', '/ai-reviews');
  });

  it('shows no inbox link on the other action types', () => {
    render(<Card initial={createAction('add_tags')} />);
    expect(screen.queryByRole('link', { name: 'See the review inbox' })).not.toBeInTheDocument();
  });

  describe('set_payee_from_text', () => {
    it('starts with the server defaults: fill only, never create', () => {
      const onAction = vi.fn();
      render(<Card initial={createAction('add_tags')} onAction={onAction} />);
      fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'set_payee_from_text' } });
      expect(onAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'set_payee_from_text', template: '', createIfMissing: false, onlyIfEmpty: true }),
      );
      expect(screen.getByLabelText('Payee name')).toHaveValue('');
      expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('switch', { name: 'Create the payee if it does not exist' })).toHaveAttribute('aria-checked', 'false');
    });

    it('explains in a tooltip that a payee may be created, and turns the choice on', () => {
      const onAction = vi.fn();
      render(<Card initial={createAction('set_payee_from_text')} onAction={onAction} />);
      expect(screen.getByRole('button', { name: /a new payee is created with it/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('switch', { name: 'Create the payee if it does not exist' }));
      expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ createIfMissing: true, onlyIfEmpty: true }));
    });

    it('bounds the name like the server does', () => {
      render(<Card initial={createAction('set_payee_from_text')} />);
      expect(screen.getByLabelText('Payee name')).toHaveAttribute('maxlength', String(MAX_RULE_PAYEE_TEMPLATE_LENGTH));
    });
  });

  describe('set_description', () => {
    it('starts with the server defaults: replace, and write even when there is a description', () => {
      const onAction = vi.fn();
      render(<Card initial={createAction('add_tags')} onAction={onAction} />);
      fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'set_description' } });
      expect(onAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'set_description', template: '', mode: 'replace', onlyIfEmpty: false }),
      );
      expect(optionLabels(screen.getByLabelText('How to write it'))).toEqual([
        'Replace the description',
        'Add after the description',
        'Add before the description',
      ]);
      expect(screen.getByRole('switch', { name: 'Only if empty' })).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByLabelText('Description text')).toHaveAttribute('maxlength', String(MAX_RULE_DESCRIPTION_TEMPLATE_LENGTH));
    });

    it('changes the mode, and says the text is joined as written only for the modes that join', () => {
      const onAction = vi.fn();
      render(<Card initial={createAction('set_description')} onAction={onAction} />);
      expect(screen.queryByText(/joined to the current description exactly as written/)).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('How to write it'), { target: { value: 'prepend' } });
      expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'prepend' }));
      expect(screen.getByText(/joined to the current description exactly as written/)).toBeInTheDocument();
    });

    it('has its own explanation of "Only if empty"', () => {
      render(<Card initial={createAction('set_description')} />);
      expect(screen.getByRole('button', { name: /writes the description only if the transaction has none/ })).toBeInTheDocument();
    });
  });

  describe('the placeholders of a text action', () => {
    it('lists the two built-ins and the captures of the rule, and inserts one where the cursor is', () => {
      const onAction = vi.fn();
      render(
        <RuleActionCard
          action={{ ...createAction('set_description'), template: 'AB' } as EditorAction}
          types={EDITOR_ACTION_TYPES}
          options={testOptions}
          actions={[]}
          errors={[]}
          captures={['payee', 'ref']}
          onChange={onAction}
        />,
      );
      const names = screen.getAllByRole('button', { name: /^Insert / }).map((b) => b.textContent);
      expect(names).toEqual(['{payeeText}', '{description}', '{payee}', '{ref}']);

      const input = screen.getByLabelText('Description text') as HTMLInputElement;
      input.setSelectionRange(1, 1);
      fireEvent.click(screen.getByRole('button', { name: 'Insert {payee}' }));
      expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ template: 'A{payee}B' }));
    });

    it('offers only the built-ins when no pattern captures anything', () => {
      render(<Card initial={createAction('set_payee_from_text')} />);
      expect(screen.getAllByRole('button', { name: /^Insert / }).map((b) => b.textContent)).toEqual([
        '{payeeText}',
        '{description}',
      ]);
    });

    it('flags an unknown placeholder inline, and a malformed one, without repeating them in the card list', () => {
      render(
        <RuleActionCard
          action={{ ...createAction('set_payee_from_text'), template: '{payee} {nope} {Bad}' } as EditorAction}
          types={EDITOR_ACTION_TYPES}
          options={testOptions}
          actions={[]}
          errors={['UNKNOWN_CAPTURE', 'INVALID_CAPTURE', 'VALUE_TOO_LONG']}
          captures={['payee']}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByText(/Not defined by this rule: \{nope\}/)).toBeInTheDocument();
      expect(screen.getByText(/Not a valid placeholder: \{Bad\}/)).toBeInTheDocument();
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(screen.getByRole('alert')).toHaveTextContent('The text is too long.');
    });

    it('does not flag the built-ins or a capture of the rule', () => {
      render(
        <RuleActionCard
          action={{ ...createAction('set_description'), template: '{payee} {payeeText} {description}' } as EditorAction}
          types={EDITOR_ACTION_TYPES}
          options={testOptions}
          actions={[]}
          errors={[]}
          captures={['payee']}
          onChange={vi.fn()}
        />,
      );
      expect(screen.queryByText(/Not defined by this rule/)).not.toBeInTheDocument();
    });

    it('cannot insert a placeholder that would not fit', () => {
      render(
        <Card
          initial={{ ...createAction('set_payee_from_text'), template: 'x'.repeat(MAX_RULE_PAYEE_TEMPLATE_LENGTH - 3) } as EditorAction}
        />,
      );
      expect(screen.getByRole('button', { name: 'Insert {payeeText}' })).toBeDisabled();
    });
  });
});

const ACCOUNT = testOptions.accounts[0].value;

describe('RuleActionCard: convert to transfer', () => {
  it('is picked from the type list and starts as an expense with the category cleared', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('add_tags')} onAction={onAction} />);
    fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'convert_to_transfer' } });
    expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'convert_to_transfer', direction: 'to', accountId: '', clearCategory: true, payeeId: '' }),
    );
    expect(screen.getByLabelText('To Account')).toHaveValue('');
    expect(screen.getByRole('switch', { name: 'Clear the category' })).toHaveAttribute('aria-checked', 'true');
  });

  it('stores an expense as toAccountId and an income as fromAccountId', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('convert_to_transfer')} onAction={onAction} />);
    fireEvent.change(screen.getByLabelText('To Account'), { target: { value: ACCOUNT } });
    const expense = onAction.mock.lastCall?.[0] as EditorAction;
    expect(actionToApi(expense)).toEqual({ type: 'convert_to_transfer', toAccountId: ACCOUNT, clearCategory: true });

    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'from' } });
    expect(screen.getByLabelText('From Account')).toHaveValue(ACCOUNT);
    const income = onAction.mock.lastCall?.[0] as EditorAction;
    expect(actionToApi(income)).toEqual({ type: 'convert_to_transfer', fromAccountId: ACCOUNT, clearCategory: true });
  });

  it('offers the transfer form accounts only: no brokerage or closed account', () => {
    render(<Card initial={createAction('convert_to_transfer')} />);
    expect(optionLabels(screen.getByLabelText('To Account'))).toEqual(['Select destination account...', 'Chequing (CAD)']);
  });

  it('keeps an account the rule already names although the transfer list leaves it out', () => {
    const options = { ...testOptions, transferAccounts: [], accounts: [{ value: ACCOUNT, label: 'Old account (CAD) (Closed)' }] };
    render(
      <RuleActionCard
        action={{ ...createAction('convert_to_transfer'), accountId: ACCOUNT } as EditorAction}
        types={EDITOR_ACTION_TYPES}
        options={options}
        actions={[]}
        errors={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('To Account')).toHaveValue(ACCOUNT);
  });

  it('turns the category clearing off and picks a payee for both legs', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('convert_to_transfer')} onAction={onAction} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Clear the category' }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ clearCategory: false }));
    fireEvent.focus(screen.getByPlaceholderText('Select or type payee name...'));
    fireEvent.click(screen.getByText('Corner Cafe'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ payeeId: PAYEE_ID, clearCategory: false }));
  });

  it('shows each server error at its field and keeps the rest on the card', () => {
    const placed = placeErrors([
      { path: 'actions[0]', code: 'CONFLICTING_ACTIONS' },
      { path: 'actions[0].toAccountId', code: 'REFERENCE_NOT_FOUND' },
    ]);
    render(
      <Card
        initial={createAction('convert_to_transfer')}
        errors={placed.byKey['a:0']}
        fieldErrors={structuralFieldErrors(placed, 0)}
      />,
    );
    const select = screen.getByLabelText('To Account');
    expect(select.parentElement).toHaveTextContent('An item chosen here no longer exists. Choose another.');
    // The card's own list holds only the code with no field; the field's code is not said twice.
    expect(screen.getAllByText(/An item chosen here no longer exists/)).toHaveLength(1);
    expect(screen.getByText(/cannot be combined with/)).toBeInTheDocument();
  });
});

describe('RuleActionCard: split', () => {
  const captures = ['principal', 'interest'];
  const part = (n: number) => screen.getByRole('group', { name: `Split ${n}` });
  const blank = createAction('split');

  const loan: EditorAction = {
    ...blank,
    parts: [
      { ...createSplitPart('{principal}'), kind: 'transfer', transferAccountId: ACCOUNT },
      { ...createSplitPart('{interest}'), categoryId: COFFEE_ID, description: 'Loans: Interest' },
    ],
  } as EditorAction;

  it('is picked from the type list and starts with two parts to fill in', () => {
    const onAction = vi.fn();
    render(<Card initial={createAction('add_tags')} onAction={onAction} captures={captures} />);
    fireEvent.change(screen.getByLabelText('Action type'), { target: { value: 'split' } });
    const action = onAction.mock.lastCall?.[0] as Extract<EditorAction, { type: 'split' }>;
    expect(action.type).toBe('split');
    expect(action.parts).toHaveLength(2);
    expect(screen.getAllByRole('group', { name: /^Split \d$/ })).toHaveLength(2);
  });

  it('lists the captures of the patterns and the rest as the amounts of a part', () => {
    render(<Card initial={blank} captures={captures} />);
    expect(optionLabels(within(part(1)).getByLabelText('Amount'))).toEqual([
      'Choose the amount...',
      '{principal}',
      '{interest}',
      'The rest',
    ]);
  });

  it('says that the parts must add up, instead of a remaining amount', () => {
    render(<Card initial={blank} captures={captures} />);
    expect(screen.getByText(/The parts must add up to the amount of the transaction/)).toBeInTheDocument();
    expect(screen.queryByText(/Remaining/)).not.toBeInTheDocument();
  });

  it('points at the pattern when it defines no capture yet', () => {
    render(<Card initial={blank} captures={[]} />);
    expect(screen.getByText(/No capture is defined yet\..*PRINCIPAL: \{principal\}/)).toBeInTheDocument();
    expect(optionLabels(within(part(1)).getByLabelText('Amount'))).toEqual(['Choose the amount...', 'The rest']);
  });

  it('offers the rest to one part only', () => {
    const onAction = vi.fn();
    render(<Card initial={blank} captures={captures} onAction={onAction} />);
    fireEvent.change(within(part(2)).getByLabelText('Amount'), { target: { value: 'rest' } });
    expect(optionLabels(within(part(1)).getByLabelText('Amount'))).not.toContain('The rest');
    expect(optionLabels(within(part(2)).getByLabelText('Amount'))).toContain('The rest');
  });

  it('keeps a capture the patterns no longer define in the list, so the field is not blank', () => {
    const stale = { ...blank, parts: [createSplitPart('{gone}'), createSplitPart('rest')] } as EditorAction;
    render(<Card initial={stale} captures={captures} />);
    expect(within(part(1)).getByLabelText('Amount')).toHaveValue('{gone}');
  });

  it('builds the loan split a person wrote: a transfer part with its payee and a category part with a memo', () => {
    const onAction = vi.fn();
    render(<Card initial={blank} captures={captures} onAction={onAction} />);

    fireEvent.change(within(part(1)).getByLabelText('Amount'), { target: { value: '{principal}' } });
    fireEvent.change(within(part(1)).getByLabelText('Type'), { target: { value: 'transfer' } });
    fireEvent.change(within(part(1)).getByLabelText('Account'), { target: { value: ACCOUNT } });
    fireEvent.focus(within(part(1)).getByPlaceholderText('Select or type payee name...'));
    fireEvent.click(screen.getByText('Corner Cafe'));

    fireEvent.change(within(part(2)).getByLabelText('Amount'), { target: { value: '{interest}' } });
    fireEvent.focus(within(part(2)).getByPlaceholderText('Select category...'));
    fireEvent.click(screen.getByText('Food: Coffee'));
    fireEvent.change(within(part(2)).getByLabelText('Memo'), { target: { value: 'Loans: Interest' } });

    const stored = actionToApi(onAction.mock.lastCall?.[0] as EditorAction);
    expect(stored).toEqual({
      type: 'split',
      parts: [
        { amount: '{principal}', transferAccountId: ACCOUNT, payeeId: PAYEE_ID },
        { amount: '{interest}', categoryId: COFFEE_ID, description: 'Loans: Interest' },
      ],
    });
  });

  it('picks the payee of the parent transaction', () => {
    const onAction = vi.fn();
    render(<Card initial={blank} captures={captures} onAction={onAction} />);
    fireEvent.focus(screen.getAllByPlaceholderText('Select or type payee name...')[0]);
    fireEvent.click(screen.getByText('Corner Cafe'));
    expect(actionToApi(onAction.mock.lastCall?.[0] as EditorAction)).toMatchObject({ type: 'split', payeeId: PAYEE_ID });
  });

  it('shows the payee field for a transfer part only, and clears the other kind when the kind changes', () => {
    render(<Card initial={loan} captures={captures} />);
    expect(within(part(1)).getByLabelText('Account')).toHaveValue(ACCOUNT);
    expect(within(part(1)).getByText('Payee of the other leg (optional)')).toBeInTheDocument();
    expect(within(part(2)).queryByText('Payee of the other leg (optional)')).not.toBeInTheDocument();

    fireEvent.change(within(part(1)).getByLabelText('Type'), { target: { value: 'category' } });
    expect(within(part(1)).queryByLabelText('Account')).not.toBeInTheDocument();
    expect(within(part(1)).getByPlaceholderText('Select category...')).toBeInTheDocument();
  });

  it('adds parts up to ten and removes them down to two', () => {
    render(<Card initial={blank} captures={captures} />);
    const add = () => screen.getByRole('button', { name: 'Add Split' });
    const removeButtons = () => screen.getAllByRole('button', { name: /^(Remove split|Minimum 2 splits required)$/ });

    expect(removeButtons()).toHaveLength(2);
    removeButtons().forEach((button) => expect(button).toBeDisabled());

    for (let n = 3; n <= 10; n++) fireEvent.click(add());
    expect(screen.getAllByRole('group', { name: /^Split \d+$/ })).toHaveLength(10);
    expect(add()).toBeDisabled();
    expect(screen.getByText('A split can have at most 10 parts.')).toBeInTheDocument();

    fireEvent.click(removeButtons()[4]);
    expect(screen.getAllByRole('group', { name: /^Split \d+$/ })).toHaveLength(9);
    expect(add()).toBeEnabled();
    expect(screen.queryByText('A split can have at most 10 parts.')).not.toBeInTheDocument();
  });

  it('removes the part that was asked, and keeps the others as they were', () => {
    const onAction = vi.fn();
    const three = { ...blank, parts: [createSplitPart('{principal}'), createSplitPart('{interest}'), createSplitPart('rest')] } as EditorAction;
    render(<Card initial={three} captures={captures} onAction={onAction} />);
    fireEvent.click(within(part(2)).getByRole('button', { name: 'Remove split' }));
    const action = onAction.mock.lastCall?.[0] as Extract<EditorAction, { type: 'split' }>;
    expect(action.parts.map((p) => p.amount)).toEqual(['{principal}', 'rest']);
  });

  it('shows each server error at the field its path names', () => {
    const placed = placeErrors([
      { path: 'actions[0].parts[1].amount', code: 'UNKNOWN_CAPTURE' },
      { path: 'actions[0].parts[0].transferAccountId', code: 'VALUE_REQUIRED' },
      { path: 'actions[0].parts[1].description', code: 'VALUE_TOO_LONG' },
      { path: 'actions[0].parts', code: 'ARRAY_TOO_LARGE' },
      { path: 'actions[0]', code: 'CONFLICTING_ACTIONS' },
    ]);
    const transferFirst = {
      ...blank,
      parts: [{ ...createSplitPart('{principal}'), kind: 'transfer' }, createSplitPart('{gone}')],
    } as EditorAction;
    render(
      <Card
        initial={transferFirst}
        captures={captures}
        errors={placed.byKey['a:0']}
        fieldErrors={structuralFieldErrors(placed, 0)}
      />,
    );
    expect(within(part(2)).getByLabelText('Amount').parentElement).toHaveTextContent(
      'This uses a capture that no condition of this rule defines.',
    );
    expect(within(part(1)).getByLabelText('Account').parentElement).toHaveTextContent('Enter or choose a value.');
    expect(within(part(2)).getByText('The text is too long.')).toBeInTheDocument();
    expect(screen.getByText('Too many items are chosen.')).toBeInTheDocument();
    expect(screen.getByText(/cannot be combined with/)).toBeInTheDocument();
  });
});
