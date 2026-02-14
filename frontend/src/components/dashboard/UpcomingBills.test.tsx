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

describe('UpcomingBills', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders loading state with title and pulse skeleton', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={true} />);
    expect(screen.getByText('Upcoming Bills & Deposits')).toBeInTheDocument();
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when no upcoming items', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={false} />);
    expect(screen.getByText('No bills, deposits, or transfers due in the next 7 days.')).toBeInTheDocument();
  });

  it('renders upcoming bill with Tomorrow label', () => {
    const transactions = [
      {
        id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD',
        nextDueDate: futureDateStr(1), isActive: true, autoPost: false,
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
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

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
  });

  it('renders days-away label for upcoming bills', () => {
    const transactions = [
      {
        id: '1', name: 'Insurance', amount: -200, currencyCode: 'CAD',
        nextDueDate: futureDateStr(5), isActive: true, autoPost: true,
      },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('5 days')).toBeInTheDocument();
  });

  it('shows total due amount for bills', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Spotify', amount: -9.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('Total due')).toBeInTheDocument();
  });

  it('shows total incoming for deposits', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Salary', amount: 5000, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: false },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('Deposit')).toBeInTheDocument();
    expect(screen.getByText('Total incoming')).toBeInTheDocument();
  });

  it('shows Transfer badge for transfer transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Savings Transfer', amount: -500, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true, isTransfer: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('filters out inactive scheduled transactions', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Active Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
      { id: '2', name: 'Inactive Bill', amount: -30, currencyCode: 'CAD', nextDueDate: dateStr, isActive: false, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('Active Bill')).toBeInTheDocument();
    expect(screen.queryByText('Inactive Bill')).not.toBeInTheDocument();
  });

  it('filters out transactions beyond 7 days', () => {
    const transactions = [
      { id: '1', name: 'Far Future Bill', amount: -50, currencyCode: 'CAD', nextDueDate: futureDateStr(10), isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('No bills, deposits, or transfers due in the next 7 days.')).toBeInTheDocument();
  });

  it('navigates to bills page on title click', () => {
    render(<UpcomingBills scheduledTransactions={[]} isLoading={false} />);
    fireEvent.click(screen.getByText('Upcoming Bills & Deposits'));
    expect(mockPush).toHaveBeenCalledWith('/bills');
  });

  it('navigates to bills page on View all bills link click', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
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

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.getByText('AT&T')).toBeInTheDocument();
  });

  it('does not show Manual badge when autoPost is true', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Auto Bill', amount: -50, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
  });

  it('shows bill amount with negative sign and red color', () => {
    const dateStr = futureDateStr(1);
    const transactions = [
      { id: '1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD', nextDueDate: dateStr, isActive: true, autoPost: true },
    ] as any[];

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
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

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
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

    render(<UpcomingBills scheduledTransactions={transactions} isLoading={false} />);
    const items = screen.getAllByText(/Bill/);
    // The sooner bill should appear before the later one
    const soonerIdx = items.findIndex(el => el.textContent === 'Sooner Bill');
    const laterIdx = items.findIndex(el => el.textContent === 'Later Bill');
    expect(soonerIdx).toBeLessThan(laterIdx);
  });
});
