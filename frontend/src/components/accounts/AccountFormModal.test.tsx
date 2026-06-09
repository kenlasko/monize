import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@/test/render';
import { AccountFormModal } from './AccountFormModal';
import { Account } from '@/types/account';

let capturedOnSubmit: ((data: any) => Promise<void>) | null = null;

// Stand-in for the dynamically loaded AccountForm: captures the onSubmit so the
// test can drive the modal's submit logic directly.
vi.mock('next/dynamic', () => ({
  default: () => (props: any) => {
    capturedOnSubmit = props.onSubmit ?? null;
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

  it('clears a previously set institution by sending null when removed on edit', async () => {
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
      await capturedOnSubmit!({ name: 'Renamed', accountType: 'CHEQUING', institutionId: undefined });
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({ institutionId: null }),
    );
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
});
