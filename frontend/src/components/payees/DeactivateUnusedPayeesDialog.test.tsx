import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { DeactivateUnusedPayeesDialog } from './DeactivateUnusedPayeesDialog';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getDeactivationPreview: vi.fn(),
    deactivatePayees: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

const mockCandidates = [
  {
    payeeId: 'p1',
    payeeName: 'Old Store',
    transactionCount: 1,
    lastUsedDate: '2023-01-15',
    defaultCategoryName: 'Shopping',
  },
  {
    payeeId: 'p2',
    payeeName: 'Never Used',
    transactionCount: 0,
    lastUsedDate: null,
    defaultCategoryName: null,
  },
];

describe('DeactivateUnusedPayeesDialog', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderDialog(isOpen = true) {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <DeactivateUnusedPayeesDialog
          isOpen={isOpen}
          onClose={onClose}
          onSuccess={onSuccess}
        />,
      );
    });
    return result!;
  }

  describe('initial state', () => {
    it('renders the dialog with title and description', async () => {
      const { getByText } = await renderDialog();

      expect(getByText('Deactivate Unused Payees')).toBeInTheDocument();
      expect(getByText('How it works')).toBeInTheDocument();
    });

    it('shows preview button', async () => {
      const { getByText } = await renderDialog();

      expect(getByText('Preview Unused Payees')).toBeInTheDocument();
    });

    it('does not render when not open', async () => {
      const { queryByText } = await renderDialog(false);

      expect(queryByText('Deactivate Unused Payees')).not.toBeInTheDocument();
    });
  });

  describe('preview functionality', () => {
    it('loads and displays candidates on preview click', async () => {
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue(mockCandidates);
      const { getByText } = await renderDialog();

      await act(async () => {
        fireEvent.click(getByText('Preview Unused Payees'));
      });

      expect(getByText('Old Store')).toBeInTheDocument();
      expect(getByText('Never Used')).toBeInTheDocument();
      expect(getByText('Candidates (2 found)')).toBeInTheDocument();
    });

    it('shows "Never used" for candidates with null lastUsedDate', async () => {
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue(mockCandidates);
      const { getByText } = await renderDialog();

      await act(async () => {
        fireEvent.click(getByText('Preview Unused Payees'));
      });

      expect(getByText('Never used')).toBeInTheDocument();
    });

    it('shows empty state when no candidates match', async () => {
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue([]);
      const { getByText } = await renderDialog();

      await act(async () => {
        fireEvent.click(getByText('Preview Unused Payees'));
      });

      expect(getByText('No payees match the current criteria.')).toBeInTheDocument();
    });

    it('shows error toast on preview failure', async () => {
      vi.mocked(payeesApi.getDeactivationPreview).mockRejectedValue(new Error('Network error'));
      const { getByText } = await renderDialog();

      await act(async () => {
        fireEvent.click(getByText('Preview Unused Payees'));
      });

      expect(toast.error).toHaveBeenCalled();
    });

    it('selects all candidates by default after preview', async () => {
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue(mockCandidates);
      const { getByText } = await renderDialog();

      await act(async () => {
        fireEvent.click(getByText('Preview Unused Payees'));
      });

      expect(getByText('2 payees selected')).toBeInTheDocument();
    });
  });

  describe('selection', () => {
    async function renderWithPreview() {
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue(mockCandidates);
      const result = await renderDialog();
      await act(async () => {
        fireEvent.click(result.getByText('Preview Unused Payees'));
      });
      return result;
    }

    it('allows deselecting individual candidates', async () => {
      const { getAllByRole, getByText } = await renderWithPreview();

      const checkboxes = getAllByRole('checkbox');
      await act(async () => {
        fireEvent.click(checkboxes[0]);
      });

      expect(getByText('1 payee selected')).toBeInTheDocument();
    });

    it('select none clears all selections', async () => {
      const { getByText, queryByText } = await renderWithPreview();

      await act(async () => {
        fireEvent.click(getByText('Select none'));
      });

      expect(queryByText(/payee.*selected/)).not.toBeInTheDocument();
    });

    it('select all re-selects all candidates', async () => {
      const { getByText } = await renderWithPreview();

      await act(async () => {
        fireEvent.click(getByText('Select none'));
      });
      await act(async () => {
        fireEvent.click(getByText('Select all'));
      });

      expect(getByText('2 payees selected')).toBeInTheDocument();
    });
  });

  describe('apply deactivation', () => {
    async function renderWithPreview() {
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue(mockCandidates);
      const result = await renderDialog();
      await act(async () => {
        fireEvent.click(result.getByText('Preview Unused Payees'));
      });
      return result;
    }

    it('calls deactivatePayees with selected payee IDs', async () => {
      vi.mocked(payeesApi.deactivatePayees).mockResolvedValue({ deactivated: 2 });
      const { getByText } = await renderWithPreview();

      await act(async () => {
        fireEvent.click(getByText('Deactivate 2 Payees'));
      });

      expect(payeesApi.deactivatePayees).toHaveBeenCalledWith(['p1', 'p2']);
    });

    it('shows success toast and calls callbacks after apply', async () => {
      vi.mocked(payeesApi.deactivatePayees).mockResolvedValue({ deactivated: 2 });
      const { getByText } = await renderWithPreview();

      await act(async () => {
        fireEvent.click(getByText('Deactivate 2 Payees'));
      });

      expect(toast.success).toHaveBeenCalledWith('Deactivated 2 payees');
      expect(onSuccess).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('shows error toast on apply failure', async () => {
      vi.mocked(payeesApi.deactivatePayees).mockRejectedValue(new Error('Server error'));
      const { getByText } = await renderWithPreview();

      await act(async () => {
        fireEvent.click(getByText('Deactivate 2 Payees'));
      });

      expect(toast.error).toHaveBeenCalled();
    });

    it('shows singular "payee" for single deactivation', async () => {
      vi.mocked(payeesApi.deactivatePayees).mockResolvedValue({ deactivated: 1 });
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue([mockCandidates[0]]);
      const result = await renderDialog();
      await act(async () => {
        fireEvent.click(result.getByText('Preview Unused Payees'));
      });

      expect(result.getByText('Deactivate 1 Payee')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(result.getByText('Deactivate 1 Payee'));
      });

      expect(toast.success).toHaveBeenCalledWith('Deactivated 1 payee');
    });

    it('shows error when applying with no selections', async () => {
      const { getByText } = await renderWithPreview();

      await act(async () => {
        fireEvent.click(getByText('Select none'));
      });

      // Button should show "Deactivate 0 Payees" and be disabled
      const button = getByText('Deactivate 0 Payees');
      expect(button).toBeDisabled();
    });
  });

  describe('cancel', () => {
    it('calls onClose when Cancel is clicked', async () => {
      const { getByText } = await renderDialog();

      fireEvent.click(getByText('Cancel'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('slider configuration', () => {
    it('renders months unused slider with 6-month step and 10-year max', async () => {
      await renderDialog();

      const sliders = document.querySelectorAll('input[type="range"]');
      const monthsSlider = sliders[1];

      expect(monthsSlider).toHaveAttribute('min', '6');
      expect(monthsSlider).toHaveAttribute('max', '120');
      expect(monthsSlider).toHaveAttribute('step', '6');
    });

    it('displays correct range labels for months slider', async () => {
      const { getByText } = await renderDialog();

      expect(getByText('6 months')).toBeInTheDocument();
      expect(getByText('5 years')).toBeInTheDocument();
      expect(getByText('10 years')).toBeInTheDocument();
    });

    it('formats year labels correctly for 12-month increments', async () => {
      const { getByText } = await renderDialog();

      const sliders = document.querySelectorAll('input[type="range"]');
      const monthsSlider = sliders[1];

      // Change to 24 months = 2 years
      await act(async () => {
        fireEvent.change(monthsSlider, { target: { value: '24' } });
      });

      expect(getByText('2 years')).toBeInTheDocument();
    });

    it('formats half-year labels correctly for 6-month offsets', async () => {
      const { getByText } = await renderDialog();

      const sliders = document.querySelectorAll('input[type="range"]');
      const monthsSlider = sliders[1];

      // Change to 18 months = 1.5 years
      await act(async () => {
        fireEvent.change(monthsSlider, { target: { value: '18' } });
      });

      expect(getByText('1.5 years')).toBeInTheDocument();
    });
  });

  describe('state reset on reopen', () => {
    it('clears candidates when dialog reopens', async () => {
      vi.mocked(payeesApi.getDeactivationPreview).mockResolvedValue(mockCandidates);
      const { rerender, getByText, queryByText } = await renderDialog();

      await act(async () => {
        fireEvent.click(getByText('Preview Unused Payees'));
      });

      expect(getByText('Old Store')).toBeInTheDocument();

      // Close and reopen
      await act(async () => {
        rerender(
          <DeactivateUnusedPayeesDialog
            isOpen={false}
            onClose={onClose}
            onSuccess={onSuccess}
          />,
        );
      });
      await act(async () => {
        rerender(
          <DeactivateUnusedPayeesDialog
            isOpen={true}
            onClose={onClose}
            onSuccess={onSuccess}
          />,
        );
      });

      expect(queryByText('Old Store')).not.toBeInTheDocument();
    });
  });
});
