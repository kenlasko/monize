import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { QuickAddChip } from './QuickAddChip';

describe('QuickAddChip style hooks', () => {
  it('carries the field key and a label span only the Folio and Pebble styles print', () => {
    render(
      <QuickAddChip
        fieldLabel="Amount"
        field="amount"
        valueText="$84.37"
        state={{ tier: 'typed', need: null }}
        expanded={false}
        editorId="editor"
        stale={false}
        onClick={() => {}}
      />,
    );
    const chip = screen.getByRole('button');
    expect(chip).toHaveAttribute('data-field', 'amount');
    expect(chip).toHaveAttribute('data-tier', 'typed');
    const label = chip.querySelector('.ui-qa-chip-label');
    expect(label).toHaveAttribute('aria-hidden', 'true');
    // Hidden in Standard by the `hidden` utility, so Standard is unchanged.
    expect(label).toHaveClass('hidden');
  });
});
