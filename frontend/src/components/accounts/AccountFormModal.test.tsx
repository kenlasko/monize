import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { AccountFormModal } from './AccountFormModal';
import { Account } from '@/types/account';

let capturedOnSubmit: ((data: any) => Promise<void>) | null = null;
let capturedInitialValues: unknown;

// Stand-in for the dynamically loaded AccountForm: captures the onSubmit so the
// test can drive the modal's submit logic directly.
vi.mock('next/dynamic', () => ({
  default: () => (props: any) => {
    capturedOnSubmit = props.onSubmit ?? null;
    capturedInitialValues = props.initialValues;
    return <div data-testid="account-form" />;
  },
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    create: (...args: any[]) => mockCreate(...args),
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

vi.mock('@/lib/errors', () => ({ showErrorToast: vi.fn() }));

const buildFormModal = (overrides: Partial<any> = {}) => ({
  showForm: true,
  editingItem: undefined as Account | undefined,
  isEditing: false,
  close: vi.fn(),
  modalProps: { pushHistory: true, onBeforeClose: vi.fn() },
  setFormDirty: vi.fn(),
  unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
  formSubmitRef: { current: null },
  ...overrides,
});

describe('AccountFormModal', () => {
  beforeEach(() => {
    capturedOnSubmit = null;
    vi.clearAllMocks();
  });

  it('renders nothing when the form is closed', () => {
    render(<AccountFormModal formModal={buildFormModal({ showForm: false })} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
  });

  it('shows the New Account heading when creating', () => {
    render(<AccountFormModal formModal={buildFormModal()} onSaved={vi.fn()} />);
    expect(screen.getByText('New Account')).toBeInTheDocument();
  });

  it('shows the Edit Account heading when editing', () => {
    render(
      <AccountFormModal
        formModal={buildFormModal({ editingItem: { id: 'a-1' } as Account, isEditing: true })}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('Edit Account')).toBeInTheDocument();
  });

  it('creates an account and notifies the caller on submit', async () => {
    mockCreate.mockResolvedValue({ id: 'new' });
    const onSaved = vi.fn();
    const close = vi.fn();
    render(<AccountFormModal formModal={buildFormModal({ close })} onSaved={onSaved} />);

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'New', accountType: 'CHEQUING' });
    });

    expect(mockCreate).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalled();
  });

  it('hands the account it created to onCreated, after onSaved, and only on a create', async () => {
    const created = { id: 'new', name: 'New' } as Account;
    mockCreate.mockResolvedValue(created);
    const order: string[] = [];
    const onSaved = vi.fn(() => {
      order.push('saved');
    });
    const onCreated = vi.fn(() => {
      order.push('created');
    });
    render(
      <AccountFormModal formModal={buildFormModal()} onSaved={onSaved} onCreated={onCreated} />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'New', accountType: 'CHEQUING' });
    });

    expect(onCreated).toHaveBeenCalledWith(created);
    // onSaved takes no argument: a refresh function with parameters of its own
    // is never handed an account.
    expect(onSaved).toHaveBeenCalledWith();
    expect(order).toEqual(['saved', 'created']);
  });

  it('does not call onCreated for an update, or when the create fails', async () => {
    const onCreated = vi.fn();
    mockUpdate.mockResolvedValue({});
    const { unmount } = render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'a-1', accountType: 'CHEQUING' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
        onCreated={onCreated}
      />,
    );
    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'CHEQUING' });
    });
    expect(onCreated).not.toHaveBeenCalled();
    unmount();

    capturedOnSubmit = null;
    mockCreate.mockRejectedValue(new Error('nope'));
    render(
      <AccountFormModal formModal={buildFormModal()} onSaved={vi.fn()} onCreated={onCreated} />,
    );
    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'New', accountType: 'CHEQUING' }).catch(() => undefined);
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('passes the initial values to the form', async () => {
    const initialValues = { name: 'From the bank', accountType: 'SAVINGS' as const };
    render(
      <AccountFormModal
        formModal={buildFormModal()}
        onSaved={vi.fn()}
        initialValues={initialValues}
      />,
    );
    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    expect(capturedInitialValues).toBe(initialValues);
  });

  it('updates an existing account on submit', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({ editingItem: { id: 'a-1', accountType: 'CHEQUING' } as Account, isEditing: true })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'CHEQUING' });
    });

    expect(mockUpdate).toHaveBeenCalledWith('a-1', expect.any(Object));
  });

  it('clears a previously set description by sending null when blanked on edit', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'a-1', accountType: 'CHEQUING', description: 'Old note' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'CHEQUING', description: '' });
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({ description: null }),
    );
  });

  it('clears a previously set account number by sending null when blanked on edit', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'a-1', accountType: 'CHEQUING', accountNumber: '12345' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'CHEQUING', accountNumber: '' });
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({ accountNumber: null }),
    );
  });

  it('clears a previously set institution when the form reports an explicit null', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'a-1', accountType: 'CHEQUING', institutionId: 'inst-1' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'CHEQUING', institutionId: null });
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({ institutionId: null }),
    );
  });

  it('keeps the stored institution when institutionId is merely absent on edit (issue #806)', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'a-1', accountType: 'INVESTMENT', institutionId: 'inst-1' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'INVESTMENT', institutionId: undefined });
    });

    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload).not.toHaveProperty('institutionId');
  });

  it('omits an empty description when the account never had one', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'a-1', accountType: 'CHEQUING' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'CHEQUING', description: '' });
    });

    const [, payload] = mockUpdate.mock.calls[0];
    expect(payload).not.toHaveProperty('description');
  });
  // A pair is one account with two ledgers, so the form can carry edits to
  // both. The account's own update goes first, since a rename is what the
  // server propagates to the partner.
  it('saves the cash ledger edits as a second update, account first', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'brok-1', accountType: 'INVESTMENT' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({
        name: 'TFSA',
        accountType: 'INVESTMENT',
        cashAccountId: 'cash-1',
        cashOpeningBalance: 250,
        cashAccountNumber: '12345',
      });
    });

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls[0][0]).toBe('brok-1');
    expect(mockUpdate.mock.calls[1][0]).toBe('cash-1');
    expect(mockUpdate.mock.calls[1][1]).toMatchObject({
      openingBalance: 250,
      accountNumber: '12345',
    });
    // The cash fields describe the other ledger, not this one.
    expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty('cashAccountId');
    expect(mockUpdate.mock.calls[0][1]).not.toHaveProperty('cashOpeningBalance');
  });

  it('issues one update when the form carried no cash ledger edits', async () => {
    mockUpdate.mockResolvedValue({});
    render(
      <AccountFormModal
        formModal={buildFormModal({
          editingItem: { id: 'brok-1', accountType: 'INVESTMENT' } as Account,
          isEditing: true,
        })}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(capturedOnSubmit).not.toBeNull());
    await act(async () => {
      await capturedOnSubmit!({ name: 'TFSA', accountType: 'INVESTMENT' });
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
