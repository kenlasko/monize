import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeDetailHeader } from './PayeeDetailHeader';
import type { Payee } from '@/types/payee';

function payee(overrides: Partial<Payee> = {}): Payee {
  return {
    id: 'payee-1',
    userId: 'user-1',
    name: 'Starbucks',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    website: null,
    hasLogo: false,
    logoFetchedAt: null,
    contactLookupAt: null,
    contactLookupSource: null,
    address: null,
    email: null,
    phone: null,
    isActive: true,
    createdAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function renderHeader(
  overrides: Partial<Payee> = {},
  firstTransactionDate: string | null = null,
) {
  const handlers = {
    onBack: vi.fn(),
    onViewTransactions: vi.fn(),
    onEdit: vi.fn(),
    onMerge: vi.fn(),
    onToggleActive: vi.fn(),
    onSelectPayee: vi.fn(),
  };
  render(
    <PayeeDetailHeader
      payee={payee(overrides)}
      firstTransactionDate={firstTransactionDate}
      isTogglePending={false}
      payees={[]}
      {...handlers}
    />,
  );
  return handlers;
}

describe('PayeeDetailHeader', () => {
  it('shows the payee name', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: 'Starbucks' })).toBeInTheDocument();
  });

  it('opens shared people linked to this payee', () => {
    renderHeader();
    expect(
      screen.getByRole('link', { name: 'People linked to this payee' }),
    ).toHaveAttribute(
      'href',
      '/shared-expenses/people/payee-1',
    );
  });

  it('fires the action callbacks', () => {
    const handlers = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Payees' }));
    fireEvent.click(screen.getByRole('button', { name: 'View Transactions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    expect(handlers.onBack).toHaveBeenCalled();
    expect(handlers.onViewTransactions).toHaveBeenCalled();
    expect(handlers.onEdit).toHaveBeenCalled();
    expect(handlers.onMerge).toHaveBeenCalled();
  });

  it('offers Deactivate for an active payee', () => {
    const handlers = renderHeader();
    expect(screen.queryByText('Inactive')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(handlers.onToggleActive).toHaveBeenCalled();
  });

  it('shows the creation date as "since" when there are no transactions', () => {
    renderHeader();
    expect(screen.getByText(/Payee since/).textContent).toContain('2024');
  });

  it('uses the first transaction date as "since" when it predates the record', () => {
    renderHeader({}, '2019-03-01');
    expect(screen.getByText(/Payee since/).textContent).toContain('2019');
  });

  it('keeps the creation date as "since" when the first transaction came later', () => {
    renderHeader({}, '2025-06-01');
    expect(screen.getByText(/Payee since/).textContent).toContain('2024');
  });

  describe('the website link', () => {
    it('opens the payee site in a new tab, safely', () => {
      renderHeader({ website: 'https://www.starbucks.com' });
      const link = screen.getByRole('link', {
        name: "Open Starbucks's website in a new tab",
      });
      expect(link).toHaveAttribute('href', 'https://www.starbucks.com');
      expect(link).toHaveAttribute('target', '_blank');
      // Without noopener the opened page gets a handle on this one.
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('shows no icon when the payee has no website', () => {
      renderHeader();
      expect(
        screen.queryByRole('link', { name: "Open Starbucks's website in a new tab" }),
      ).toBeNull();
    });

    it('refuses to link a stored address that is not http(s)', () => {
      // A javascript: href runs on click, so an unchecked stored string must
      // never reach one -- rows predate the normaliser and imports bypass it.
      renderHeader({ website: 'javascript:alert(1)' });
      expect(
        screen.queryByRole('link', { name: "Open Starbucks's website in a new tab" }),
      ).toBeNull();
      expect(
        screen.getAllByRole('link').map((link) => link.getAttribute('href')),
      ).toEqual(['/shared-expenses/people/payee-1']);
    });

    it('keeps an explicit http address rather than showing nothing', () => {
      renderHeader({ website: 'http://corner.example' });
      expect(
        screen.getByRole('link', { name: "Open Starbucks's website in a new tab" }),
      ).toHaveAttribute(
        'href',
        'http://corner.example',
      );
    });
  });

  it('offers Reactivate, hides Merge and badges an inactive payee', () => {
    const handlers = renderHeader({ isActive: false });
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(handlers.onToggleActive).toHaveBeenCalled();
  });
});
