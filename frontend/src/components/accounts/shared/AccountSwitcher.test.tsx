import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, within, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { AccountSwitcher } from './AccountSwitcher';
import type { Account } from '@/types/account';

const { getAllInstitutions } = vi.hoisted(() => ({ getAllInstitutions: vi.fn() }));
vi.mock('@/lib/institutions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/institutions')>()),
  institutionsApi: { getAll: getAllInstitutions },
}));
getAllInstitutions.mockResolvedValue([]);

function account(id: string, name: string, accountType = 'CHEQUING'): Account {
  return {
    id,
    accountType,
    name,
    currencyCode: 'CAD',
    currentBalance: 0,
  } as Account;
}

const two = [account('acc-1', 'Everyday Chequing'), account('acc-2', 'Savings', 'SAVINGS')];

function open(accounts: Account[], currentId = 'acc-1') {
  const onSelect = vi.fn();
  render(
    <AccountSwitcher currentId={currentId} accounts={accounts} onSelect={onSelect} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
  return { onSelect };
}

describe('AccountSwitcher', () => {
  it('renders nothing when there is no other account to switch to', () => {
    render(
      <AccountSwitcher currentId="acc-1" accounts={[two[0]]} onSelect={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Switch to another account' })).toBeNull();
  });

  it('lists the other accounts, not the current one', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /Savings/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Everyday Chequing/ })).toBeNull();
  });

  it('names each account type, so alike-named accounts are told apart', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /Savings/ })).toHaveTextContent('Savings');
  });

  it("marks each account with its institution's logo, else its type icon", async () => {
    getAllInstitutions.mockResolvedValueOnce([
      { id: 'inst-1', name: 'Big Bank', hasLogo: true },
    ]);
    const banked = { ...account('acc-2', 'Savings', 'SAVINGS'), institutionId: 'inst-1' } as Account;
    const loose = account('acc-3', 'Wallet', 'CASH');
    render(
      <AccountSwitcher
        currentId="acc-1"
        accounts={[two[0], banked, loose]}
        onSelect={vi.fn()}
      />,
    );
    await waitFor(() => expect(getAllInstitutions).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('menuitem', { name: /Savings/ }))
          .getByRole('img', { hidden: true })
          .getAttribute('src'),
      ).toBe('/api/v1/institutions/inst-1/logo'),
    );
    const wallet = screen.getByRole('menuitem', { name: /Wallet/ });
    expect(wallet.querySelector('img')).toBeNull();
    expect(wallet.querySelector('svg')).not.toBeNull();
  });

  it('selects an account and closes', () => {
    const { onSelect } = open(two);
    fireEvent.click(screen.getByRole('menuitem', { name: /Savings/ }));
    expect(onSelect).toHaveBeenCalledWith('acc-2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('lists the accounts alphabetically', () => {
    // Previously in whatever order the API answered in.
    open(
      [
        account('acc-1', 'Everyday Chequing'),
        account('acc-4', 'Zephyr Savings', 'SAVINGS'),
        account('acc-2', 'Anchor Loan', 'LOAN'),
        account('acc-3', 'Mid Savings', 'SAVINGS'),
      ],
    );
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Anchor LoanLoan',
      'Mid SavingsSavings',
      'Zephyr SavingsSavings',
    ]);
  });

  describe('favourites', () => {
    const starred = (id: string, name: string, sortOrder: number, type = 'SAVINGS') =>
      ({
        ...account(id, name, type),
        isFavourite: true,
        favouriteSortOrder: sortOrder,
      }) as Account;

    it('lifts the starred accounts into their own section, above the rest', () => {
      open([
        account('acc-1', 'Everyday Chequing'),
        account('acc-2', 'Anchor Loan', 'LOAN'),
        starred('acc-3', 'Zephyr Savings', 1),
      ]);

      // Last alphabetically, first in the menu: the section decides.
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'Zephyr SavingsSavings',
        'Anchor LoanLoan',
      ]);
      expect(
        within(screen.getByRole('group', { name: 'Favourites' }))
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['Zephyr SavingsSavings']);
      expect(
        within(screen.getByRole('group', { name: 'Other accounts' })).getAllByRole(
          'menuitem',
        ),
      ).toHaveLength(1);
    });

    it('orders the starred accounts the way the user arranged them', () => {
      open([
        account('acc-1', 'Everyday Chequing'),
        starred('acc-2', 'Alpha', 2),
        starred('acc-3', 'Beta', 1),
      ]);
      expect(
        within(screen.getByRole('group', { name: 'Favourites' }))
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['BetaSavings', 'AlphaSavings']);
    });

    it('falls back to alphabetical where the arrangement does not separate them', () => {
      // `favourite_sort_order` defaults to 0, so a user who starred three
      // accounts and never dragged them has three ties -- and a stable sort
      // would leave those in whatever order the API answered in.
      open([
        account('acc-1', 'Everyday Chequing'),
        starred('acc-2', 'Zephyr', 0),
        starred('acc-3', 'Anchor', 0),
        starred('acc-4', 'Mid', 0),
      ]);
      expect(
        within(screen.getByRole('group', { name: 'Favourites' }))
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['AnchorSavings', 'MidSavings', 'ZephyrSavings']);
    });

    it('leaves the menu unsectioned when nothing is starred', () => {
      open(two);
      expect(screen.queryAllByRole('group')).toHaveLength(0);
    });

    it('leaves the menu unsectioned when the only starred account is this one', () => {
      // The switcher never offers the account on screen, so the Favourites
      // heading would have nothing under it.
      open([starred('acc-1', 'Everyday Chequing', 1, 'CHEQUING'), two[1]], 'acc-1');
      expect(screen.queryAllByRole('group')).toHaveLength(0);
      expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    });

    it('sorts a linked pair by the name it shows, not the stored one', () => {
      // `displayName` strips the " - Brokerage" suffix, so ordering on the
      // stored name would put this pair somewhere the reader cannot predict.
      open([
        account('acc-1', 'Everyday Chequing'),
        account('acc-2', 'Anchor Loan', 'LOAN'),
        {
          ...account('brok-1', 'Zephyr TFSA - Brokerage', 'INVESTMENT'),
          accountSubType: 'INVESTMENT_BROKERAGE',
          linkedAccountId: 'cash-1',
        } as Account,
        {
          ...account('cash-1', 'Zephyr TFSA - Cash', 'INVESTMENT'),
          accountSubType: 'INVESTMENT_CASH',
          linkedAccountId: 'brok-1',
        } as Account,
      ]);
      expect(
        screen.getAllByRole('menuitem').map((item) => item.textContent),
      ).toEqual(['Anchor LoanLoan', 'Zephyr TFSAInvestment']);
    });
  });

  it('filters a long list by name or type', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      account(`acc-${index}`, `Account number ${index}`),
    );
    open(many, 'acc-0');
    fireEvent.change(screen.getByPlaceholderText('Filter accounts...'), {
      target: { value: 'number 7' },
    });
    expect(screen.getByRole('menuitem', { name: /Account number 7/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Account number 3/ })).toBeNull();
  });
  describe('an investment pair', () => {
    const pair = (): Account[] => [
      {
        ...account('brok-1', 'TFSA - Brokerage', 'INVESTMENT'),
        accountSubType: 'INVESTMENT_BROKERAGE',
        linkedAccountId: 'cash-1',
      } as Account,
      {
        ...account('cash-1', 'TFSA - Cash', 'INVESTMENT'),
        accountSubType: 'INVESTMENT_CASH',
        linkedAccountId: 'brok-1',
      } as Account,
    ];

    // Listing both halves offers the same account twice, under two names the
    // user never chose.
    it('lists a linked pair once, under the name the user gave it', () => {
      open([account('acc-1', 'Everyday Chequing'), ...pair()]);

      expect(screen.getByText('TFSA')).toBeInTheDocument();
      expect(screen.queryByText('TFSA - Brokerage')).toBeNull();
      expect(screen.queryByText('TFSA - Cash')).toBeNull();
    });

    it('selects the pair by its canonical id', () => {
      const { onSelect } = open([account('acc-1', 'Everyday Chequing'), ...pair()]);

      fireEvent.click(screen.getByText('TFSA'));

      expect(onSelect).toHaveBeenCalledWith('brok-1');
    });

    it('still finds the account when searching either ledger stored name', () => {
      // The filter only appears past a threshold, so the list is padded to it.
      const filler = Array.from({ length: 9 }, (_, i) =>
        account(`filler-${i}`, `Filler ${i}`),
      );
      open([account('acc-1', 'Everyday Chequing'), ...filler, ...pair()]);

      fireEvent.change(screen.getByPlaceholderText('Filter accounts...'), {
        target: { value: 'Cash' },
      });

      expect(screen.getByText('TFSA')).toBeInTheDocument();
      expect(screen.queryByText('Everyday Chequing')).toBeNull();
    });
  });
});
