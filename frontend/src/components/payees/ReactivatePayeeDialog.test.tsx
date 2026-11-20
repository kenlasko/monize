import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@/test/render';
import { __resetModalStateForTesting } from '@/components/ui/Modal';
import { ReactivatePayeeDialog } from './ReactivatePayeeDialog';
import { Payee } from '@/types/payee';

describe('ReactivatePayeeDialog', () => {
  const onReactivate = vi.fn();
  const onCancel = vi.fn();

  const mockPayee: Payee = {
    id: 'payee-1',
    userId: 'user-1',
    name: 'Old Store',
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
    isActive: false,
    createdAt: '2024-01-01',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetModalStateForTesting();
  });

  /** Escape from inside the dialog, where the keyboard focus is once it opens. */
  async function pressEscape() {
    const button = screen.getByText('Reactivate');
    await act(async () => {
      button.focus();
    });
    await act(async () => {
      fireEvent.keyDown(button, { key: 'Escape' });
    });
  }

  it('reads closing it unanswered as Keep Inactive by default', async () => {
    render(<ReactivatePayeeDialog isOpen={true} payee={mockPayee} onReactivate={onReactivate} onCancel={onCancel} />);
    await pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('tells closing it unanswered apart from Keep Inactive when asked to', async () => {
    const onDismiss = vi.fn();
    render(
      <ReactivatePayeeDialog
        isOpen={true}
        payee={mockPayee}
        onReactivate={onReactivate}
        onCancel={onCancel}
        onDismiss={onDismiss}
      />,
    );
    await pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('No, Keep Inactive'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the payee name in the dialog', () => {
    const { getByText } = render(
      <ReactivatePayeeDialog
        isOpen={true}
        payee={mockPayee}
        onReactivate={onReactivate}
        onCancel={onCancel}
      />,
    );

    expect(getByText(/"Old Store"/)).toBeInTheDocument();
    // Titled through Modal, so the dialog is named by its title.
    expect(screen.getByRole('dialog', { name: 'Reactivate Payee' })).toBeInTheDocument();
  });

  it('does not render when payee is null', () => {
    const { container } = render(
      <ReactivatePayeeDialog
        isOpen={true}
        payee={null}
        onReactivate={onReactivate}
        onCancel={onCancel}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('does not render when not open', () => {
    const { queryByText } = render(
      <ReactivatePayeeDialog
        isOpen={false}
        payee={mockPayee}
        onReactivate={onReactivate}
        onCancel={onCancel}
      />,
    );

    expect(queryByText('Reactivate Payee')).not.toBeInTheDocument();
  });

  it('calls onReactivate when Reactivate button is clicked', () => {
    const { getByText } = render(
      <ReactivatePayeeDialog
        isOpen={true}
        payee={mockPayee}
        onReactivate={onReactivate}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(getByText('Reactivate'));

    expect(onReactivate).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when No Keep Inactive button is clicked', () => {
    const { getByText } = render(
      <ReactivatePayeeDialog
        isOpen={true}
        payee={mockPayee}
        onReactivate={onReactivate}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(getByText('No, Keep Inactive'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows Reactivating text when isReactivating is true', () => {
    const { getByText } = render(
      <ReactivatePayeeDialog
        isOpen={true}
        payee={mockPayee}
        onReactivate={onReactivate}
        onCancel={onCancel}
        isReactivating={true}
      />,
    );

    expect(getByText('Reactivating...')).toBeInTheDocument();
  });

  it('disables buttons when isReactivating is true', () => {
    const { getByText } = render(
      <ReactivatePayeeDialog
        isOpen={true}
        payee={mockPayee}
        onReactivate={onReactivate}
        onCancel={onCancel}
        isReactivating={true}
      />,
    );

    expect(getByText('Reactivating...')).toBeDisabled();
    expect(getByText('No, Keep Inactive')).toBeDisabled();
  });
});
