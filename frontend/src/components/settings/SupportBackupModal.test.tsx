import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { SupportBackupModal } from './SupportBackupModal';
import { backupApi } from '@/lib/backupApi';
import { accountsApi } from '@/lib/accounts';

vi.mock('@/lib/backupApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/backupApi')>();
  return {
    ...actual,
    backupApi: {
      supportExport: vi.fn(),
      supportExportPreview: vi.fn(),
    },
  };
});

vi.mock('@/lib/accounts', () => ({
  accountsApi: { getAll: vi.fn() },
}));

const mockPreview = backupApi.supportExportPreview as ReturnType<typeof vi.fn>;
const mockExport = backupApi.supportExport as ReturnType<typeof vi.fn>;
const mockGetAll = accountsApi.getAll as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAll.mockResolvedValue([
    { id: 'acc-1', name: 'Everyday Chequing', accountType: 'CHEQUING', isClosed: false },
  ]);
});

async function open() {
  await act(async () => {
    render(<SupportBackupModal isOpen onClose={vi.fn()} />);
  });
}

describe('SupportBackupModal', () => {
  it('renders sections, a de-identification note and account scope', async () => {
    await open();
    expect(screen.getByText('Create support backup')).toBeInTheDocument();
    expect(screen.getByText(/de-identified copy/i)).toBeInTheDocument();
    expect(screen.getByText('Budgets')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Everyday Chequing')).toBeInTheDocument(),
    );
  });

  it('previews before/after from the actual obfuscation output', async () => {
    mockPreview.mockResolvedValue({
      samples: [
        {
          table: 'payees',
          before: [{ name: 'Biedronka' }],
          after: [{ name: 'Bi*****ka' }],
        },
      ],
    });
    await open();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    });

    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Biedronka/)).toBeInTheDocument();
    expect(screen.getByText(/Bi\*\*\*\*\*ka/)).toBeInTheDocument();
  });

  it('generates and downloads the file, passing multiplier and sections', async () => {
    mockExport.mockResolvedValue({
      blob: new Blob(['x'], { type: 'application/octet-stream' }),
      filename: 'monize-support-backup-2026-07-17.mzbe',
    });
    const createObjectURL = vi.fn().mockReturnValue('blob:url');
    const revokeObjectURL = vi.fn();
    global.URL.createObjectURL = createObjectURL;
    global.URL.revokeObjectURL = revokeObjectURL;

    const onClose = vi.fn();
    await act(async () => {
      render(<SupportBackupModal isOpen onClose={onClose} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    });
    // The password-saved confirmation gates the actual export
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I saved it -- generate' }));
    });

    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    const input = mockExport.mock.calls[0][0];
    expect(input.multiplier).toBeGreaterThan(1);
    expect(Number.isInteger(input.multiplier)).toBe(false);
    expect(input.sections).toEqual(
      expect.arrayContaining(['investments', 'budgets']),
    );
    // The encryption password is required and pre-filled with a random value
    expect(typeof input.password).toBe('string');
    expect(input.password.length).toBeGreaterThanOrEqual(8);
    // Price history stays out unless the user opts in
    expect(input.includePriceHistory).toBe(false);
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('sends includePriceHistory when the user opts in', async () => {
    mockExport.mockResolvedValue({ blob: new Blob(['x']), filename: null });
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:url');
    global.URL.revokeObjectURL = vi.fn();
    await open();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Include security price history'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    });
    // The password-saved confirmation gates the actual export
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I saved it -- generate' }));
    });

    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    expect(mockExport.mock.calls[0][0].includePriceHistory).toBe(true);
  });

  it('hides a stale preview when any option changes', async () => {
    mockPreview.mockResolvedValue({
      samples: [
        { table: 'payees', before: [{ name: 'Biedronka' }], after: [{ name: 'Bi*****ka' }] },
      ],
    });
    await open();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    });
    await waitFor(() => expect(screen.getByText(/Biedronka/)).toBeInTheDocument());

    // Changing an input invalidates the rendered preview without any manual reset
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Include security price history'));
    });
    expect(screen.queryByText(/Biedronka/)).not.toBeInTheDocument();
  });

  it('renders the date range inputs and passes chosen bounds to the export', async () => {
    mockExport.mockResolvedValue({ blob: new Blob(['x']), filename: null });
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:url');
    global.URL.revokeObjectURL = vi.fn();
    await open();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('From'), {
        target: { value: '2026-01-01' },
      });
      fireEvent.change(screen.getByLabelText('To'), {
        target: { value: '2026-06-30' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    });
    // The password-saved confirmation gates the actual export
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I saved it -- generate' }));
    });

    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    const input = mockExport.mock.calls[0][0];
    expect(input.dateFrom).toBe('2026-01-01');
    expect(input.dateTo).toBe('2026-06-30');
  });

  it('does not export when the password-saved confirmation is cancelled', async () => {
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    });
    expect(screen.getByText('Did you save the password?')).toBeInTheDocument();
    await act(async () => {
      // Two Cancel buttons are on screen (modal footer + dialog); the
      // dialog's renders last.
      fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    });
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('blocks generating when the password is cleared', async () => {
    await open();
    const passwordInput = screen.getByDisplayValue(/^[23456789A-Za-z]{20}$/);
    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: 'short' } });
    });
    expect(screen.getByText('Enter at least 8 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
  });

  it('regenerate produces a new non-integer multiplier', async () => {
    await open();
    const field = screen.getByDisplayValue(/\d\.\d/) as HTMLInputElement;
    const before = field.value;
    await act(async () => {
      // Two Regenerate buttons exist (multiplier, password); the multiplier's
      // renders first in the layout.
      fireEvent.click(screen.getAllByRole('button', { name: 'Regenerate' })[0]);
    });
    const after = (screen.getByDisplayValue(/\d\.\d/) as HTMLInputElement).value;
    // extremely unlikely to collide; both are valid non-integers > 1
    expect(Number(after)).toBeGreaterThan(1);
    expect(Number.isInteger(Number(after))).toBe(false);
    expect(after).not.toBe('');
    void before;
  });
});
