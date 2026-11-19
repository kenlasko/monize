import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { MnyBillsPanel } from './MnyBillsPanel';
import { KMY_FORMAT } from '@/lib/binary-import-format';
import type { MnyPreviewBill } from '@/lib/import-mny';

function bill(overrides: Partial<MnyPreviewBill> = {}): MnyPreviewBill {
  return {
    handle: 7,
    name: 'Hydro One',
    accountName: 'Chequing',
    amount: -95.5,
    currencyCode: 'USD',
    frequency: 'MONTHLY',
    approximate: false,
    nextDueDate: '2026-08-02',
    isTransfer: false,
    isInvestment: false,
    splitCount: 0,
    status: 0,
    ...overrides,
  };
}

describe('MnyBillsPanel', () => {
  const defaultProps = {
    bills: [bill()],
    selectedHandles: new Set<number>([7]),
    unsupported: false,
    skipped: 0,
    onToggleBill: vi.fn(),
    onSetAllBills: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('lists each bill with its account, cadence, due date and amount', () => {
    render(<MnyBillsPanel {...defaultProps} />);

    expect(screen.getByText('Hydro One')).toBeInTheDocument();
    expect(screen.getByText('Chequing')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('-$95.50')).toBeInTheDocument();
  });

  it('pre-ticks the detected-active bills, so detection is a recommendation', () => {
    render(<MnyBillsPanel {...defaultProps} />);

    expect(screen.getByRole('checkbox', { name: 'Import Hydro One' })).toBeChecked();
  });

  it('reports an unticked bill to the wizard', () => {
    const onToggleBill = vi.fn();
    render(<MnyBillsPanel {...defaultProps} onToggleBill={onToggleBill} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Hydro One' }));

    expect(onToggleBill).toHaveBeenCalledWith(7);
  });

  it('shows an unticked bill as unchecked', () => {
    render(
      <MnyBillsPanel {...defaultProps} selectedHandles={new Set<number>()} />,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Import Hydro One' }),
    ).not.toBeChecked();
  });

  it('selects and clears every bill at once', () => {
    const onSetAllBills = vi.fn();
    render(<MnyBillsPanel {...defaultProps} onSetAllBills={onSetAllBills} />);

    fireEvent.click(screen.getByText('Select all'));
    expect(onSetAllBills).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByText('Select none'));
    expect(onSetAllBills).toHaveBeenCalledWith(false);
  });

  it('badges transfers, investments and splits', () => {
    render(
      <MnyBillsPanel
        {...defaultProps}
        bills={[
          bill({ handle: 1, name: 'Loan payment', splitCount: 2 }),
          bill({ handle: 2, name: 'To savings', isTransfer: true }),
          bill({ handle: 3, name: 'Monthly buy', isInvestment: true }),
        ]}
        selectedHandles={new Set([1, 2, 3])}
      />,
    );

    expect(screen.getByText('Transfer')).toBeInTheDocument();
    expect(screen.getByText('Investment')).toBeInTheDocument();
    expect(screen.getByText('2 splits')).toBeInTheDocument();
  });

  it('flags a bill whose Money interval Monize cannot express exactly', () => {
    render(
      <MnyBillsPanel
        {...defaultProps}
        bills={[bill({ frequency: 'WEEKLY', approximate: true })]}
      />,
    );

    expect(screen.getByText('Closest Monize frequency')).toBeInTheDocument();
  });

  it('explains that a Money 2001 file has no bills to import', () => {
    render(<MnyBillsPanel {...defaultProps} unsupported bills={[]} />);

    expect(
      screen.getByText(/predates scheduled bills/),
    ).toBeInTheDocument();
  });

  it('renders nothing when the file has no active bills', () => {
    const { container } = render(<MnyBillsPanel {...defaultProps} bills={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('reports bill series that could not be read', () => {
    render(<MnyBillsPanel {...defaultProps} skipped={2} />);

    expect(
      screen.getByText(/2 bill series were missing a template/),
    ).toBeInTheDocument();
  });
});

describe('MnyBillsPanel with a KMyMoney import', () => {
  const props = {
    bills: [bill()],
    selectedHandles: new Set<number>([7]),
    unsupported: false,
    skipped: 2,
    onToggleBill: vi.fn(),
    onSetAllBills: vi.fn(),
    format: KMY_FORMAT,
  };

  it('uses the scheduled-transactions heading and the KMyMoney explainer', () => {
    render(<MnyBillsPanel {...props} />);

    expect(screen.getByText('Scheduled transactions to create (1)')).toBeInTheDocument();
    expect(screen.getByText(/These are the scheduled transactions KMyMoney still has active/)).toBeInTheDocument();
  });

  it('counts skipped schedules, not bill series', () => {
    render(<MnyBillsPanel {...props} />);

    expect(screen.getByText('2 scheduled transactions could not be imported.')).toBeInTheDocument();
  });
});
