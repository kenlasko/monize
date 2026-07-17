import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AccountDetailShell } from './AccountDetailShell';
import type { Account } from '@/types/account';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    accountType: 'CHEQUING',
    name: 'Everyday Chequing',
    currencyCode: 'CAD',
    currentBalance: 100,
    ...overrides,
  } as Account;
}

describe('AccountDetailShell', () => {
  it('renders the account name and formatted type + currency', () => {
    render(
      <AccountDetailShell account={makeAccount()}>
        <div>body</div>
      </AccountDetailShell>,
    );

    expect(screen.getByText('Everyday Chequing')).toBeInTheDocument();
    expect(screen.getByText(/Chequing - CAD/)).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('shows only the actions whose handlers are provided', () => {
    render(
      <AccountDetailShell
        account={makeAccount()}
        onViewTransactions={vi.fn()}
        onBack={vi.fn()}
      >
        <div />
      </AccountDetailShell>,
    );

    expect(screen.getByText('View Transactions')).toBeInTheDocument();
    expect(screen.getByText('Back to Accounts')).toBeInTheDocument();
    expect(screen.queryByText('Reconcile')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit Account')).not.toBeInTheDocument();
    expect(screen.queryByText('Export')).not.toBeInTheDocument();
  });

  it('fires the standard action handlers', () => {
    const onViewTransactions = vi.fn();
    const onReconcile = vi.fn();
    const onEdit = vi.fn();
    const onExport = vi.fn();
    const onBack = vi.fn();
    render(
      <AccountDetailShell
        account={makeAccount()}
        onViewTransactions={onViewTransactions}
        onReconcile={onReconcile}
        onEdit={onEdit}
        onExport={onExport}
        onBack={onBack}
      >
        <div />
      </AccountDetailShell>,
    );

    fireEvent.click(screen.getByText('View Transactions'));
    fireEvent.click(screen.getByText('Reconcile'));
    fireEvent.click(screen.getByText('Edit Account'));
    fireEvent.click(screen.getByText('Export PDF'));
    fireEvent.click(screen.getByText('Back to Accounts'));

    expect(onViewTransactions).toHaveBeenCalledTimes(1);
    expect(onReconcile).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders type-specific header actions', () => {
    render(
      <AccountDetailShell
        account={makeAccount()}
        headerActions={<button type="button">Refresh Prices</button>}
      >
        <div />
      </AccountDetailShell>,
    );
    expect(screen.getByText('Refresh Prices')).toBeInTheDocument();
  });

  it('renders a loading placeholder instead of the body', () => {
    render(
      <AccountDetailShell account={makeAccount()} isLoading>
        <div>body</div>
      </AccountDetailShell>,
    );
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    expect(screen.getByText('Loading account details...')).toBeInTheDocument();
  });

  it('renders an error with a retry button instead of the body', () => {
    const onRetry = vi.fn();
    render(
      <AccountDetailShell account={makeAccount()} error="Something broke" onRetry={onRetry}>
        <div>body</div>
      </AccountDetailShell>,
    );
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the institution logo when an institution is supplied', () => {
    render(
      <AccountDetailShell
        account={makeAccount({ institutionId: 'i-1' })}
        institution={{ id: 'i-1', name: 'TD', hasLogo: true }}
      >
        <div />
      </AccountDetailShell>,
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/v1/institutions/i-1/logo');
  });
});
