import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { InstitutionList } from './InstitutionList';
import { Institution } from '@/types/institution';
import { institutionsApi } from '@/lib/institutions';

vi.mock('@/lib/institutions', () => ({
  institutionsApi: { delete: vi.fn() },
  institutionLogoUrl: (id: string) => `/api/v1/institutions/${id}/logo`,
}));

const makeInstitution = (overrides: Partial<Institution> = {}): Institution => ({
  id: 'i-1',
  userId: 'u-1',
  name: 'TD Canada Trust',
  website: 'https://td.com',
  country: 'CA',
  hasLogo: true,
  logoFetchedAt: null,
  createdAt: '',
  updatedAt: '',
  accountCount: 2,
  ...overrides,
});

describe('InstitutionList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders institution details', () => {
    render(
      <InstitutionList
        institutions={[makeInstitution()]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onManageAccounts={vi.fn()}
      />,
    );
    expect(screen.getByText('TD Canada Trust')).toBeInTheDocument();
    expect(screen.getByText('https://td.com')).toBeInTheDocument();
    // Accounts column shows just the number (with an accessible label).
    expect(
      screen.getByRole('button', { name: '2 accounts' }),
    ).toHaveTextContent('2');
  });

  it('applies dense row padding when density is dense', () => {
    render(
      <InstitutionList
        institutions={[makeInstitution()]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onManageAccounts={vi.fn()}
        density="dense"
      />,
    );
    // The name cell uses the dense padding (py-1) rather than the default.
    const nameCell = screen.getByText('TD Canada Trust').closest('td');
    expect(nameCell?.className).toContain('py-1');
  });

  it('shows the empty state', () => {
    render(
      <InstitutionList
        institutions={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onManageAccounts={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'No institutions yet. Create one to start grouping your accounts.',
      ),
    ).toBeInTheDocument();
  });

  it('invokes onEdit and onManageAccounts', () => {
    const onEdit = vi.fn();
    const onManageAccounts = vi.fn();
    render(
      <InstitutionList
        institutions={[makeInstitution()]}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onManageAccounts={onManageAccounts}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '2 accounts' }));
    expect(onManageAccounts).toHaveBeenCalled();
  });

  it('renders edit/delete as icon buttons in dense view', () => {
    render(
      <InstitutionList
        institutions={[makeInstitution()]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onManageAccounts={vi.fn()}
        density="dense"
      />,
    );
    // Icon buttons expose their action via aria-label, with no text content.
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit).toHaveTextContent('');
    expect(edit.querySelector('svg')).toBeInTheDocument();
  });

  it('deletes after confirmation', async () => {
    vi.mocked(institutionsApi.delete).mockResolvedValue(undefined);
    const onDelete = vi.fn();
    render(
      <InstitutionList
        institutions={[makeInstitution()]}
        onEdit={vi.fn()}
        onDelete={onDelete}
        onManageAccounts={vi.fn()}
      />,
    );

    // Row delete button opens the confirmation dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(
        screen.getByText(/Accounts assigned to it will be unassigned/),
      ).toBeInTheDocument(),
    );

    // Confirm in the dialog (two "Delete" buttons now exist; click the last).
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    });

    await waitFor(() => expect(institutionsApi.delete).toHaveBeenCalledWith('i-1'));
    expect(onDelete).toHaveBeenCalledWith('i-1');
  });
});
