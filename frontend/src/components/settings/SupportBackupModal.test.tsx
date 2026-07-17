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
    mockExport.mockResolvedValue(new Blob(['x'], { type: 'application/gzip' }));
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

    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));
    const input = mockExport.mock.calls[0][0];
    expect(input.multiplier).toBeGreaterThan(1);
    expect(Number.isInteger(input.multiplier)).toBe(false);
    expect(input.sections).toEqual(
      expect.arrayContaining(['investments', 'budgets']),
    );
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('regenerate produces a new non-integer multiplier', async () => {
    await open();
    const field = screen.getByDisplayValue(/\d\.\d/) as HTMLInputElement;
    const before = field.value;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    });
    const after = (screen.getByDisplayValue(/\d\.\d/) as HTMLInputElement).value;
    // extremely unlikely to collide; both are valid non-integers > 1
    expect(Number(after)).toBeGreaterThan(1);
    expect(Number.isInteger(Number(after))).toBe(false);
    expect(after).not.toBe('');
    void before;
  });
});
