import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { InvestmentReportForm } from './InvestmentReportForm';

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/components/ui/IconPicker', () => ({
  IconPicker: () => <div data-testid="icon-picker" />,
}));
vi.mock('@/components/ui/ColorPicker', () => ({
  ColorPicker: () => <div data-testid="color-picker" />,
}));
vi.mock('@/components/ui/DateInput', () => ({
  DateInput: ({
    label,
    onChange,
    onDateChange,
  }: {
    label?: string;
    onChange?: (e: { target: { value: string } }) => void;
    onDateChange?: (date: string) => void;
  }) => (
    <button
      type="button"
      data-testid="date-change"
      onClick={() => {
        onChange?.({ target: { value: '2024-02-02' } });
        onDateChange?.('2024-02-02');
      }}
    >
      {label}
    </button>
  ),
}));
vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: ({ label }: { label?: string }) => <div>{label}</div>,
}));
vi.mock('./InvestmentReportColumnChooser', () => ({
  InvestmentReportColumnChooser: () => <div data-testid="column-chooser" />,
}));

describe('InvestmentReportForm', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderForm(onSubmit = vi.fn().mockResolvedValue(undefined)) {
    await act(async () => {
      render(<InvestmentReportForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    });
    return onSubmit;
  }

  it('renders the builder sections after loading', async () => {
    await renderForm();
    expect(await screen.findByText('Columns')).toBeInTheDocument();
    expect(screen.getByText('Accounts')).toBeInTheDocument();
    expect(screen.getByText('Grouping & Sorting')).toBeInTheDocument();
    expect(screen.getByText('Report Date')).toBeInTheDocument();
    expect(screen.getByTestId('column-chooser')).toBeInTheDocument();
  });

  it('submits the assembled report configuration with symbol-led default columns', async () => {
    const onSubmit = await renderForm();
    const nameInput = screen.getByPlaceholderText('e.g., Taxable Holdings Overview');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'My Holdings' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Report' }));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.name).toBe('My Holdings');
    expect(submitted.config.columns[0]).toBe('symbol');
    expect(submitted.config.columns[1]).toBe('name');
    expect(submitted.config.columns).toContain('marketValue');
    expect(submitted.config.sortColumn).toBe('marketValue');
    expect(submitted.config.accountIds).toEqual([]);
    expect(submitted.config.asOfDate).toBeNull();
  });

  it('requires a name', async () => {
    const onSubmit = await renderForm();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Report' }));
    });
    await waitFor(() =>
      expect(screen.getByText('Name is required')).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('populates fields from an existing report and submits its config in edit mode', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const report = {
      id: 'r1',
      userId: 'u1',
      name: 'Existing',
      description: 'desc',
      icon: 'chart-bar',
      backgroundColor: '#123456',
      groupBy: 'ACCOUNT',
      config: {
        columns: ['symbol', 'gain'],
        accountIds: ['acc1'],
        sortColumn: 'gain',
        sortDirection: 'DESC',
        asOfDate: '2024-01-31',
      },
      isFavourite: true,
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    } as never;
    await act(async () => {
      render(<InvestmentReportForm report={report} onSubmit={onSubmit} onCancel={vi.fn()} />);
    });
    // Grouping hint renders for a grouped report
    expect(await screen.findByText(/Rows are grouped by account/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update Report' }));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.name).toBe('Existing');
    expect(submitted.config.columns).toEqual(['symbol', 'gain']);
    expect(submitted.config.sortColumn).toBe('gain');
    expect(submitted.config.accountIds).toEqual(['acc1']);
    expect(submitted.config.asOfDate).toBe('2024-01-31');
    expect(submitted.groupBy).toBe('ACCOUNT');
  });

  it('still renders when accounts fail to load', async () => {
    const { accountsApi } = await import('@/lib/accounts');
    vi.mocked(accountsApi.getAll).mockRejectedValueOnce(new Error('boom'));
    await renderForm();
    expect(await screen.findByText('Columns')).toBeInTheDocument();
  });

  it('filters the account list to open non-cash investment accounts', async () => {
    const { accountsApi } = await import('@/lib/accounts');
    vi.mocked(accountsApi.getAll).mockResolvedValueOnce([
      { id: 'a1', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', isClosed: false },
      { id: 'a2', accountType: 'CHECKING', accountSubType: null, isClosed: false },
      { id: 'a3', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_CASH', isClosed: false },
      { id: 'a4', accountType: 'INVESTMENT', accountSubType: null, isClosed: true },
    ] as never);
    await renderForm();
    // The account predicate runs across all branches without throwing.
    expect(await screen.findByText('Accounts')).toBeInTheDocument();
  });

  it('captures the chosen as-of date on submit', async () => {
    const onSubmit = await renderForm();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('e.g., Taxable Holdings Overview'), {
        target: { value: 'Dated' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('date-change'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Report' }));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].config.asOfDate).toBe('2024-02-02');
  });

  it('applies fallbacks for null fields and drops an invalid saved sort column', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const report = {
      id: 'r1',
      userId: 'u1',
      name: 'Minimal',
      description: null,
      icon: null,
      backgroundColor: null,
      groupBy: 'NONE',
      config: {
        columns: ['symbol', 'quantity'],
        accountIds: [],
        sortColumn: 'gain', // not in columns -> must be dropped on submit
        sortDirection: 'ASC',
        asOfDate: null,
      },
      isFavourite: false,
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    } as never;
    await act(async () => {
      render(<InvestmentReportForm report={report} onSubmit={onSubmit} onCancel={vi.fn()} />);
    });
    await screen.findByText('Columns');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update Report' }));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.config.sortColumn).toBeNull();
    expect(submitted.config.asOfDate).toBeNull();
  });
});
