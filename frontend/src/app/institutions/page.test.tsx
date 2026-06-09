import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import InstitutionsPage from './page';
import toast from 'react-hot-toast';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'u-1', email: 't@e.com', role: 'user' },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    { getState: vi.fn(() => ({ user: { id: 'u-1' }, isAuthenticated: true, _hasHydrated: true })) },
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

vi.mock('@/lib/constants', () => ({ PAGE_SIZE: 25 }));

const mockGetAll = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock('@/lib/institutions', () => ({
  institutionsApi: {
    getAll: (...a: any[]) => mockGetAll(...a),
    create: (...a: any[]) => mockCreate(...a),
    update: (...a: any[]) => mockUpdate(...a),
  },
  institutionLogoUrl: (id: string) => `/api/v1/institutions/${id}/logo`,
}));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => {
    const [showForm, setShowForm] = useState(false);
    const [editingItem, setEditingItem] = useState<any>(null);
    return {
      showForm,
      editingItem,
      openCreate: () => { setEditingItem(null); setShowForm(true); },
      openEdit: (item: any) => { setEditingItem(item); setShowForm(true); },
      close: () => { setEditingItem(null); setShowForm(false); },
      isEditing: !!editingItem,
      modalProps: {},
      setFormDirty: vi.fn(),
      unsavedChangesDialog: { isOpen: false, onConfirm: vi.fn(), onCancel: vi.fn() },
      formSubmitRef: { current: null },
    };
  },
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: any) => <div data-testid="page-layout">{children}</div>,
}));
vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: any) => (
    <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}{actions}</div>
  ),
}));
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...rest }: any) => <button onClick={onClick} {...rest}>{children}</button>,
}));
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => (isOpen ? <div data-testid="modal">{children}</div> : null),
}));
vi.mock('@/components/ui/UnsavedChangesDialog', () => ({ UnsavedChangesDialog: () => null }));
vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: any) => <div data-testid="loading-spinner">{text}</div>,
}));
vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { accounts: null, checkCircle: null, money: null },
}));
vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages }: any) => (
    <div data-testid="pagination">Page {currentPage} of {totalPages}</div>
  ),
}));

vi.mock('@/components/institutions/InstitutionForm', () => ({
  InstitutionForm: ({ onSubmit, institution }: any) => (
    <div data-testid="institution-form">
      {institution && <span data-testid="editing">{institution.name}</span>}
      <button
        data-testid="submit-form"
        onClick={() =>
          Promise.resolve(
            onSubmit({ name: 'New Bank', website: 'newbank.com' }),
          ).catch(() => {})
        }
      >
        Submit
      </button>
    </div>
  ),
}));

vi.mock('@/components/institutions/InstitutionList', () => ({
  InstitutionList: ({ institutions, onEdit, onDelete, onManageAccounts }: any) => (
    <div data-testid="institution-list">
      {institutions.map((i: any) => (
        <div key={i.id} data-testid={`institution-${i.id}`}>
          {i.name}
          <button data-testid={`edit-${i.id}`} onClick={() => onEdit(i)}>Edit</button>
          <button data-testid={`delete-${i.id}`} onClick={() => onDelete(i.id)}>Delete</button>
          <button data-testid={`manage-${i.id}`} onClick={() => onManageAccounts(i)}>Manage</button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/institutions/InstitutionAccountsManager', () => ({
  InstitutionAccountsManager: ({ isOpen }: any) =>
    isOpen ? <div data-testid="accounts-manager">Manager</div> : null,
}));

const mockInstitutions = [
  { id: 'i-1', name: 'TD', website: 'https://td.com', country: 'CA', hasLogo: true, accountCount: 2 },
  { id: 'i-2', name: 'RBC', website: 'https://rbc.com', country: 'CA', hasLogo: false, accountCount: 0 },
];

describe('InstitutionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue(mockInstitutions);
  });

  it('renders the header, subtitle and summary cards', async () => {
    render(<InstitutionsPage />);
    await waitFor(() => expect(screen.getByText('Financial Institutions')).toBeInTheDocument());
    expect(screen.getByText('Banks and brokerages your accounts belong to')).toBeInTheDocument();
    expect(screen.getByTestId('summary-Total Institutions')).toHaveTextContent('2');
    expect(screen.getByTestId('summary-With Logo')).toHaveTextContent('1');
    expect(screen.getByTestId('summary-Linked Accounts')).toHaveTextContent('2');
  });

  it('filters by search query', async () => {
    render(<InstitutionsPage />);
    await waitFor(() => expect(screen.getByText('TD')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Search institutions...'), {
      target: { value: 'rbc' },
    });
    expect(screen.getByText('RBC')).toBeInTheDocument();
    expect(screen.queryByText('TD')).not.toBeInTheDocument();
  });

  it('shows a loading spinner while loading', async () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<InstitutionsPage />);
    await waitFor(() => expect(screen.getByTestId('loading-spinner')).toBeInTheDocument());
  });

  it('shows an error toast when loading fails', async () => {
    mockGetAll.mockRejectedValue(new Error('boom'));
    render(<InstitutionsPage />);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to load institutions'),
    );
  });

  it('creates an institution on submit', async () => {
    mockCreate.mockResolvedValue({ id: 'i-new', name: 'New Bank', accountCount: 0 });
    render(<InstitutionsPage />);
    await waitFor(() => expect(screen.getByText('New Institution')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('New Institution')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ name: 'New Bank', website: 'newbank.com' });
      expect(toast.success).toHaveBeenCalledWith('Institution created');
    });
  });

  it('opens the edit modal with the institution name', async () => {
    render(<InstitutionsPage />);
    await waitFor(() => expect(screen.getByTestId('institution-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('edit-i-1')); });
    await waitFor(() => {
      expect(screen.getByText('Edit Institution')).toBeInTheDocument();
      expect(screen.getByTestId('editing')).toHaveTextContent('TD');
    });
  });

  it('removes a deleted institution from the list', async () => {
    render(<InstitutionsPage />);
    await waitFor(() => expect(screen.getByTestId('institution-i-1')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('delete-i-1')); });
    await waitFor(() =>
      expect(screen.queryByTestId('institution-i-1')).not.toBeInTheDocument(),
    );
  });

  it('opens the accounts manager', async () => {
    render(<InstitutionsPage />);
    await waitFor(() => expect(screen.getByTestId('institution-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('manage-i-1')); });
    await waitFor(() => expect(screen.getByTestId('accounts-manager')).toBeInTheDocument());
  });
});
