import { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import EditInvestmentReportPage from './page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
    </div>
  ),
}));
vi.mock('@/components/ui/LoadingSpinner', () => ({ LoadingSpinner: () => <div>spinner</div> }));
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({
    isOpen,
    onClose,
    children,
  }: {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="modal">
        <button onClick={onClose}>modal-close</button>
        {children}
      </div>
    ) : null,
}));

const mockGetById = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: {
    getById: (...a: unknown[]) => mockGetById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

vi.mock('@/components/reports/InvestmentReportForm', () => ({
  InvestmentReportForm: ({
    onSubmit,
    onCancel,
  }: {
    onSubmit: (d: unknown) => Promise<void>;
    onCancel: () => void;
  }) => (
    <div>
      <button
        onClick={() => {
          void onSubmit({ name: 'Updated', config: { columns: ['symbol'] } }).catch(() => {});
        }}
      >
        do-submit
      </button>
      <button onClick={onCancel}>do-cancel</button>
    </div>
  ),
}));

async function renderEdit(id = 'r1') {
  await act(async () => {
    render(
      <Suspense fallback={<div>suspense</div>}>
        <EditInvestmentReportPage params={Promise.resolve({ id })} />
      </Suspense>,
    );
  });
}

const report = {
  id: 'r1',
  name: 'My Report',
  config: { columns: ['symbol'] },
};

describe('EditInvestmentReportPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the report and updates it', async () => {
    mockGetById.mockResolvedValue(report);
    mockUpdate.mockResolvedValue(report);
    await renderEdit();
    expect(await screen.findByText('Edit Investment Report')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('do-submit'));
    });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('r1', expect.any(Object)));
    expect(mockPush).toHaveBeenCalledWith('/reports/investment/r1');
  });

  it('deletes the report through the confirmation modal', async () => {
    mockGetById.mockResolvedValue(report);
    mockDelete.mockResolvedValue(undefined);
    await renderEdit();
    await screen.findByText('Edit Investment Report');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Report' }));
    });
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('r1'));
    expect(mockPush).toHaveBeenCalledWith('/reports');
  });

  it('redirects to reports when the report fails to load', async () => {
    mockGetById.mockRejectedValue(new Error('boom'));
    await renderEdit();
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/reports'));
  });

  it('surfaces an error and stays on the page when the update fails', async () => {
    mockGetById.mockResolvedValue(report);
    mockUpdate.mockRejectedValue(new Error('boom'));
    await renderEdit();
    await screen.findByText('Edit Investment Report');
    await act(async () => {
      fireEvent.click(screen.getByText('do-submit'));
    });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalledWith('/reports/investment/r1');
  });

  it('cancels editing and returns to the report view', async () => {
    mockGetById.mockResolvedValue(report);
    await renderEdit();
    await screen.findByText('Edit Investment Report');
    await act(async () => {
      fireEvent.click(screen.getByText('do-cancel'));
    });
    expect(mockPush).toHaveBeenCalledWith('/reports/investment/r1');
  });

  it('closes the delete modal via the modal onClose handler', async () => {
    mockGetById.mockResolvedValue(report);
    await renderEdit();
    await screen.findByText('Edit Investment Report');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Report' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'modal-close' }));
    });
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
  });

  it('shows a loading spinner while the report loads', async () => {
    mockGetById.mockReturnValue(new Promise(() => {})); // never resolves
    await renderEdit();
    expect(screen.getByText('spinner')).toBeInTheDocument();
  });

  it('closes the delete confirmation on cancel without deleting', async () => {
    mockGetById.mockResolvedValue(report);
    await renderEdit();
    await screen.findByText('Edit Investment Report');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Report' }));
    });
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('keeps the user on the page when deletion fails', async () => {
    mockGetById.mockResolvedValue(report);
    mockDelete.mockRejectedValue(new Error('boom'));
    await renderEdit();
    await screen.findByText('Edit Investment Report');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete Report' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('r1'));
    expect(mockPush).not.toHaveBeenCalledWith('/reports');
  });
});
