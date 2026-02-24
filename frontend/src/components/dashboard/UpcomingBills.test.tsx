import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { UpcomingBills } from './UpcomingBills';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (n: number) => n,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

function futureDateStr(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr(): string {
  return futureDateStr(0);
}

const defaultMaxItems = 20;

describe('UpcomingBills', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={true} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Upcoming Bills & Deposits')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no upcoming items', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('No upcoming bills, deposits, or transfers within their reminder windows.')).toBeInTheDocument();
  });

  it('renders upcoming bill with Tomorrow label', () => {
    const transactions = [
      {
        id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD',
        nextDueDate: futureDateStr(1), isActive: true, autoPost: false,
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeInTheDocument();
    expect(screen.getByText('Bill')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });

  it('renders Today label for bills due today', () => {
    const transactions = [
      {
        id: '1', name: 'Rent', amount: -1500, currencyCode: 'CAD',
        nextDueDate: todayStr(), isActive: true, autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
  });

  it('renders days-away label for upcoming bills', () => {
    const transactions = [
      {
        id: '1', name: 'Insurance', amount: -200, currencyCode: 'CAD',
        nextDueDate: futureDateStr(5), isActive: true, autoPost: true,
        reminderDaysBefore: 7,
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('5 days')).toBeInTheDocument();
  });

  it('shows total due amount for bills', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Spotify', amount: -9.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Total due')).toBeInTheDocument();
  });

  it('shows total incoming for deposits', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Salary', amount: 5000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: false },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Deposit')).toBeInTheDocument();
    expect(screen.getByText('Total incoming')).toBeInTheDocument();
  });

  it('shows Transfer badge for transfer transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Savings Transfer', amount: -500, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('filters out inactive scheduled transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Active Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Inactive Bill', amount: -30, currencyCode: 'CAD', nextDueDate: dateStr, isActive: false, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('Active Bill')).toBeInTheDocument();
    expect(screen.queryByText('Inactive Bill')).not.toBeInTheDocument();
  });

  it('filters out transactions beyond their reminder window', () => {
    const transactions = [
      { id: '1', name: 'Far Future Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(10), isActive: true, autoPost: true, reminderDaysBefore: 3 },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('No upcoming bills, deposits, or transfers within their reminder windows.')).toBeInTheDocument();
  });

  it('navigates to bills page on title click', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={false} maxItems={defaultMaxItems} />);
    fireEvent.click(screen.getByText('Upcoming Bills & Deposits'));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  it('navigates to bills page on View all bills link click', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    fireEvent.click(screen.getByText('View all bills & deposits'));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  it('shows payee name when available', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Phone Bill', amount: -80, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        payeeName: 'AT&T',
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getByText('AT&T')).toBeInTheDocument();
  });

  it('does not show Manual badge when autoPost is true', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Auto Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
  });

  it('shows bill amount with negative sign and red color', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // The amount appears in both the item row and the total section
    const amountEls = screen.getAllByText('-$15.99');
    expect(amountEls.length).toBeGreaterThanOrEqual(1);
    expect(amountEls[0].className).toContain('text-red');
  });

  it('shows deposit amount with plus sign and green color', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Salary', amount: 5000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // The amount appears in both the item row and the total section
    const amountEls = screen.getAllByText('+$5000.00');
    expect(amountEls.length).toBeGreaterThanOrEqual(1);
    expect(amountEls[0].className).toContain('text-green');
  });

  it('sorts items by due date ascending', () => {
    const transactions = [
      { id: '1', name: 'Later Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(3), isActive: true, autoPost: true },
      { id: '2', name: 'Sooner Bill', amount: -30, currencyCode: 'CAD', nextDueDate: futureDateStr(1), isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const items = screen.getAllByText(/Bill/);
    // The sooner bill should appear before the later one
    const soonerIdx = items.findIndex(el => el.textContent === 'Sooner Bill');
    const laterIdx = items.findIndex(el => el.textContent === 'Later Bill');
    expect(soonerIdx).toBeLessThan(laterIdx);
  });

  it('shows override amount instead of default when nextOverride exists', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Modified Bill', amount: -100, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: { amount: -75 },
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // Should show the override amount (-75), not the default (-100)
    expect(screen.getAllByText('-$75.00').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('-$100.00')).not.toBeInTheDocument();
  });

  it('uses override amount for type determination (bill vs deposit)', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Overridden to Deposit', amount: -100, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: { amount: 50 },
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    // Override amount is positive, so it should be classified as a deposit
    expect(screen.getByText('Deposit')).toBeInTheDocument();
  });

  it('uses default amount when nextOverride is null', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      {
        id: '1', name: 'Normal Bill', amount: -200, currencyCode: 'CAD',
        nextDueDate: dateStr, isActive: true, autoPost: true,
        nextOverride: null,
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    expect(screen.getAllByText('-$200.00').length).toBeGreaterThanOrEqual(1);
  });

  it('truncates list at maxItems and shows +N more link', () => {
    const dateStr = futureDateStr(1);
    const transactions = Array.from({ length: 6 }, (_, i) => ({
      id: String(i + 1), name: `Bill ${i + 1}`, amount: -10, currencyCode: 'CAD',
      nextDueDate: dateStr, isActive: true, autoPost: true,
    })) as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={4} />);
    // Only 4 of 6 items should be visible
    expect(screen.getByText('Bill 1')).toBeInTheDocument();
    expect(screen.getByText('Bill 4')).toBeInTheDocument();
    expect(screen.queryByText('Bill 5')).not.toBeInTheDocument();
    expect(screen.queryByText('Bill 6')).not.toBeInTheDocument();
    // "+2 more" link should appear
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('does not show +N more when items fit within maxItems', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Bill A', amount: -10, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Bill B', amount: -20, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={5} />);
    expect(screen.getByText('Bill A')).toBeInTheDocument();
    expect(screen.getByText('Bill B')).toBeInTheDocument();
    expect(screen.queryByText(/\+\d+ more/)).not.toBeInTheDocument();
  });

  it('prioritizes manual items over auto-post items on the same day', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Auto Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Manual Bill', amount: -30, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: false },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} maxItems={defaultMaxItems} />);
    const billElements = screen.getAllByText(/Bill/);
    const manualIdx = billElements.findIndex(el => el.textContent === 'Manual Bill');
    const autoIdx = billElements.findIndex(el => el.textContent === 'Auto Bill');
    expect(manualIdx).toBeLessThan(autoIdx);
  });
});
