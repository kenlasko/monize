import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import { ImportPreviewCheckbox } from './ImportPreviewCheckbox';
import { ImportPreviewChoice } from './ImportPreviewChoice';
import { ImportPreviewExpandButton } from './ImportPreviewExpandButton';
import { ImportPreviewPayeeCell } from './ImportPreviewPayeeCell';
import { ImportPreviewPayeeMapping } from './ImportPreviewPayeeMapping';
import { ImportPreviewRuleTrace } from './ImportPreviewRuleTrace';
import type { ImportPreviewPayee, ImportPreviewRule } from '@/types/import-preview';

const payee = (over: Partial<ImportPreviewPayee> = {}): ImportPreviewPayee => ({
  original: 'SHOP 12',
  name: 'Shop',
  via: 'alias',
  aliasPattern: 'SHOP*',
  payeeId: 'p-1',
  ...over,
});

describe('ImportPreviewCheckbox', () => {
  it.each([
    ['all', true, false],
    ['none', false, false],
    ['some', false, true],
  ] as const)('shows %s as checked=%s indeterminate=%s', (state, checked, indeterminate) => {
    render(<ImportPreviewCheckbox state={state} onChange={vi.fn()} label="Pick" />);
    const box = screen.getByRole('checkbox', { name: 'Pick' }) as HTMLInputElement;
    expect(box.checked).toBe(checked);
    expect(box.indeterminate).toBe(indeterminate);
  });

  it('checks everything when clicked while only some are checked, and unchecks when all are', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ImportPreviewCheckbox state="some" onChange={onChange} label="Pick" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<ImportPreviewCheckbox state="all" onChange={onChange} label="Pick" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<ImportPreviewCheckbox state="none" onChange={onChange} label="Pick" />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it('can be disabled', () => {
    render(<ImportPreviewCheckbox state="all" onChange={vi.fn()} label="Pick" disabled />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});

describe('ImportPreviewChoice', () => {
  it('offers skip now and add to exceptions as one group named for the row', () => {
    const onChange = vi.fn();
    render(<ImportPreviewChoice rowId="r1" rowLabel="Shop" choice="skip" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'What to do with Shop if it is not imported' });
    expect(within(group).getByRole('radio', { name: 'Skip now' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Add to exceptions' }));
    expect(onChange).toHaveBeenCalledWith('except');
  });

  it('keeps two rows\' groups apart', () => {
    render(
      <>
        <ImportPreviewChoice rowId="r1" rowLabel="A" choice="skip" onChange={vi.fn()} />
        <ImportPreviewChoice rowId="r2" rowLabel="B" choice="except" onChange={vi.fn()} />
      </>,
    );
    const [first, second] = screen.getAllByRole('radio', { name: 'Skip now' });
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
  });
});

describe('ImportPreviewPayeeCell', () => {
  it('shows the text with the whole of it in a title, and a tooltip saying how it was found', () => {
    render(<ImportPreviewPayeeCell text="Shop" payee={payee()} />);
    expect(screen.getByText('Shop')).toHaveAttribute('title', 'Shop');
    expect(
      screen.getByRole('button', { name: 'From the bank: SHOP 12. Maps to: Shop (alias "SHOP*")' }),
    ).toBeInTheDocument();
  });

  it('shows no tooltip when the text is the payee', () => {
    render(<ImportPreviewPayeeCell text="Shop" payee={payee({ via: 'name', original: 'Shop' })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows no tooltip without a payee', () => {
    render(<ImportPreviewPayeeCell text="No payee" payee={null} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ImportPreviewPayeeMapping', () => {
  it('says there is no information without a payee', () => {
    render(<ImportPreviewPayeeMapping payee={null} />);
    expect(screen.getByText('No payee information for this transaction.')).toBeInTheDocument();
  });

  it.each([
    [{ via: 'name' as const }, 'Matches your existing payee Shop.'],
    [{ via: 'alias' as const }, 'Maps to Shop through the alias "SHOP*".'],
    [{ via: 'alias' as const, aliasPattern: null }, 'Maps to Shop through an alias.'],
    [{ via: 'new' as const, payeeId: null }, 'No payee has this name yet, so Shop would be created.'],
    [{ via: 'rule' as const }, 'An import rule sets the payee: Shop.'],
    [{ via: 'rule' as const, name: null }, 'An import rule clears the payee.'],
    [{ via: 'none' as const, name: null, original: null, payeeId: null }, 'The bank gave no counterparty, so the transaction has no payee.'],
  ])('says how the payee resolved: %j', (over, sentence) => {
    render(<ImportPreviewPayeeMapping payee={payee(over)} />);
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('links to the aliases of an existing payee only', () => {
    const { rerender } = render(<ImportPreviewPayeeMapping payee={payee()} />);
    const link = screen.getByRole('link', { name: "Open the payee's aliases in a new tab" });
    expect(link).toHaveAttribute('href', '/payees/p-1?tab=aliases');
    // In-app navigation here would run the modal's history pop after it and
    // land back on the page behind the preview, so the link opens a new tab.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    rerender(<ImportPreviewPayeeMapping payee={payee({ payeeId: null })} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('ImportPreviewRuleTrace', () => {
  const labels = { categories: { c1: 'Food' }, payees: {}, tags: {} };
  const rule = (over: Partial<ImportPreviewRule> = {}): ImportPreviewRule => ({
    ruleId: 'r1',
    ruleName: 'Food rule',
    changes: { categoryId: { before: null, after: 'c1' } },
    applied: [{ type: 'set_category' }],
    skipped: [],
    stopped: false,
    ...over,
  });

  it('says no rule matched for an empty trace', () => {
    render(<ImportPreviewRuleTrace rules={[]} labels={labels} />);
    expect(screen.getByText('No import rule matched this transaction.')).toBeInTheDocument();
  });

  it('links each rule by name and writes its changes in words', () => {
    render(<ImportPreviewRuleTrace rules={[rule()]} labels={labels} />);
    const link = screen.getByRole('link', { name: 'Open the rule Food rule in a new tab' });
    expect(link).toHaveAttribute('href', '/rules/r1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Category: none → Food')).toBeInTheDocument();
  });

  it('reads a skipped action with the reason, and a stop', () => {
    render(
      <ImportPreviewRuleTrace
        rules={[rule({ skipped: [{ type: 'set_payee_from_text', reason: 'empty_render' }], stopped: true })]}
        labels={labels}
      />,
    );
    expect(
      screen.getByText('Set the payee from text: skipped (the text of an action came out empty for it)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Stops the rules after it.')).toBeInTheDocument();
  });

  it('says a reason it has no sentence for as the rule being unable to change the row', () => {
    render(
      <ImportPreviewRuleTrace
        rules={[rule({ skipped: [{ type: 'set_category', reason: 'already_set' }] })]}
        labels={labels}
      />,
    );
    expect(screen.getByText('Set the category: skipped (the rule cannot change it)')).toBeInTheDocument();
  });

  it('shows an action type this client does not know as the server named it', () => {
    render(
      <ImportPreviewRuleTrace
        rules={[rule({ changes: {}, applied: [{ type: 'brand_new_action' }] })]}
        labels={labels}
      />,
    );
    expect(screen.getByText('Applied: brand_new_action')).toBeInTheDocument();
  });

  it('names an unnamed rule generically', () => {
    render(<ImportPreviewRuleTrace rules={[rule({ ruleName: null })]} labels={labels} />);
    expect(screen.getByRole('link', { name: 'Open the rule Rule in a new tab' })).toBeInTheDocument();
  });
});

describe('ImportPreviewExpandButton', () => {
  it('says whether it is open, hides its label from sight and points at the details only when open', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ImportPreviewExpandButton expanded={false} detailsId="d1" rowLabel="Shop" onToggle={onToggle} />,
    );
    const closed = screen.getByRole('button', { name: 'Show details of Shop' });
    expect(closed).toHaveAttribute('aria-expanded', 'false');
    expect(closed).not.toHaveAttribute('aria-controls');
    fireEvent.click(closed);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<ImportPreviewExpandButton expanded detailsId="d1" rowLabel="Shop" onToggle={onToggle} />);
    const open = screen.getByRole('button', { name: 'Hide details of Shop' });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(open).toHaveAttribute('aria-controls', 'd1');
    expect(within(open).getByText('Hide details of Shop').className).toContain('sr-only');
  });
});
