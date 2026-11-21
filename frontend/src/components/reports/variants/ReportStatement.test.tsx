import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { ReportStatementClassic } from './ReportStatementClassic';
import { ReportStatementModern } from './ReportStatementModern';
import type { ReportStatementViewProps } from './report-statement-view';

function props(over: Partial<ReportStatementViewProps> = {}): ReportStatementViewProps {
  return {
    ariaLabel: 'Income vs Expenses',
    lines: [
      { key: 'i', label: 'Income', value: '$100', tone: 'gain', share: '60%', swatch: 'red', onSelect: vi.fn() },
      { key: 'e', label: 'Expenses', value: '$40', tone: 'loss', share: '40%' },
    ],
    total: { label: 'Savings', value: '-$60', tone: 'loss' },
    memo: [{ key: 'r', label: 'Savings rate', value: '-60%', tone: 'loss' }],
    showShare: true,
    ...over,
  };
}

describe.each([
  ['Classic', ReportStatementClassic],
  ['Modern', ReportStatementModern],
])('ReportStatement%s', (_n, Variant) => {
  it('shows every line, the total and the memo with their signs intact', () => {
    render(<Variant {...props()} />);
    expect(screen.getByRole('region', { name: 'Income vs Expenses' })).toBeInTheDocument();
    for (const text of ['Income', 'Expenses', 'Savings', 'Savings rate', '$100', '$40', '-$60', '-60%']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it('opens a line that can drill down', async () => {
    const p = props();
    render(<Variant {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /Income/ }));
    expect(p.lines[0].onSelect).toHaveBeenCalled();
  });

  it('draws only the total when there are no lines', () => {
    render(<Variant {...props({ lines: [], memo: undefined, showShare: false })} />);
    expect(screen.getByText('Savings')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
