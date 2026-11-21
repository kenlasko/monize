import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { AccountsSummaryClassic, AccountsSummaryModern, AccountsSummaryStandard } from './AccountsSummary';
import type { AccountsSummaryViewProps } from './accounts-summary-view';

const props = (over: Partial<AccountsSummaryViewProps> = {}): AccountsSummaryViewProps => ({
  accountCount: 15,
  netWorth: <span>NW-FIGURE</span>,
  assets: <span>ASSETS-FIGURE</span>,
  liabilities: <span>LIAB-FIGURE</span>,
  netWorthNegative: false,
  labels: { accounts: 'Accounts', netWorth: 'Net Worth', assets: 'Assets', liabilities: 'Liabilities' },
  children: <div>standard grid</div>,
  ...over,
});

describe('AccountsSummary variants', () => {
  it('Standard draws the card grid it is given', () => {
    render(<AccountsSummaryStandard {...props()} />);
    expect(screen.getByText('standard grid')).toBeInTheDocument();
    expect(screen.queryByText('NW-FIGURE')).not.toBeInTheDocument();
  });

  it('Classic sets a statement: net worth over ruled assets, liabilities and count', () => {
    render(<AccountsSummaryClassic {...props()} />);
    const block = screen.getByTestId('accounts-summary-statement');
    expect(block).toHaveTextContent('NW-FIGURE');
    expect(block).toHaveTextContent('Assets');
    expect(block).toHaveTextContent('ASSETS-FIGURE');
    expect(block).toHaveTextContent('LIAB-FIGURE');
    expect(block).toHaveTextContent('15');
    expect(screen.queryByText('standard grid')).not.toBeInTheDocument();
  });

  it('Modern sets net worth in the ink block and the sides as blocks', () => {
    render(<AccountsSummaryModern {...props()} />);
    const block = screen.getByTestId('accounts-summary-blocks');
    expect(block.querySelector('.ui-invert')).toHaveTextContent('NW-FIGURE');
    expect(block.querySelector('.ui-block-accent')).toHaveTextContent('ASSETS-FIGURE');
    expect(block).toHaveTextContent('LIAB-FIGURE');
    expect(block).toHaveTextContent('Accounts: 15');
  });
});
