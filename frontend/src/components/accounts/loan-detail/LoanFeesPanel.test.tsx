import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { LoanFeesPanel } from './LoanFeesPanel';
import type { Account } from '@/types/account';
import type { LoanFee } from '@/types/loan-fee';

const mockList = vi.fn();
const mockReplace = vi.fn();
vi.mock('@/lib/loan-fees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-fees')>()),
  loanFeesApi: {
    list: (...args: unknown[]) => mockList(...args),
    replace: (...args: unknown[]) => mockReplace(...args),
  },
}));

const mockCategories = vi.fn();
const mockCreateCategory = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: () => mockCategories(),
    create: (...args: unknown[]) => mockCreateCategory(...args),
  },
}));

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const MORTGAGE = {
  id: 'mtg-1',
  accountType: 'MORTGAGE',
  name: 'Home',
  currencyCode: 'CAD',
  interestCategoryId: 'cat-interest',
  scheduledTransactionId: 'st-1',
  paymentMatchingRuleId: null,
} as unknown as Account;

const TAX: LoanFee = {
  id: 'fee-1',
  categoryId: 'cat-tax',
  name: 'Property tax',
  calculation: 'FIXED',
  basis: 'ANNUAL',
  amount: 3600,
  rate: null,
  sortOrder: 0,
};

describe('LoanFeesPanel', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockReplace.mockReset();
    mockCategories.mockReset();
    mockCreateCategory.mockReset();
    mockCategories.mockResolvedValue([
      { id: 'cat-tax', name: 'Taxes', parentId: null },
      { id: 'cat-interest', name: 'Interest', parentId: null },
    ]);
  });

  it('lists the fees with their category and terms', async () => {
    mockList.mockResolvedValue([TAX]);
    await act(async () => {
      render(<LoanFeesPanel account={MORTGAGE} />);
    });
    expect(mockList).toHaveBeenCalledWith('mtg-1');
    expect(screen.getByText('Property tax')).toBeInTheDocument();
    expect(screen.getByText(/Taxes/)).toBeInTheDocument();
    expect(screen.getByText(/per year/)).toBeInTheDocument();
  });

  it('says so when the mortgage has no fees', async () => {
    mockList.mockResolvedValue([]);
    await act(async () => {
      render(<LoanFeesPanel account={MORTGAGE} />);
    });
    expect(screen.getByText("No fees are collected with this mortgage's payment.")).toBeInTheDocument();
  });

  it('reports a failed read rather than an empty list, and retries', async () => {
    mockList.mockRejectedValueOnce(new Error('down')).mockResolvedValue([]);
    await act(async () => {
      render(<LoanFeesPanel account={MORTGAGE} />);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('saves an edited set and reloads the loan', async () => {
    mockList.mockResolvedValue([TAX]);
    mockReplace.mockResolvedValue([]);
    const onChanged = vi.fn();
    await act(async () => {
      render(<LoanFeesPanel account={MORTGAGE} onChanged={onChanged} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit fees' }));
    });
    fireEvent.change(screen.getByLabelText('Fee name'), { target: { value: 'School tax' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save fees' }));
    });
    expect(mockReplace).toHaveBeenCalledWith('mtg-1', [
      {
        categoryId: 'cat-tax',
        name: 'School tax',
        calculation: 'FIXED',
        basis: 'ANNUAL',
        amount: 3600,
        rate: null,
      },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('does not send an incomplete fee', async () => {
    mockList.mockResolvedValue([]);
    await act(async () => {
      render(<LoanFeesPanel account={MORTGAGE} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit fees' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add a fee' }));
    expect(screen.getAllByTestId('loan-fee-row')).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save fees' }));
    });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getAllByText('Required').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove fee' }));
    expect(screen.queryAllByTestId('loan-fee-row')).toHaveLength(0);
  });

  it('creates a category typed into a fee picker and saves the fee with it', async () => {
    mockList.mockResolvedValue([]);
    mockReplace.mockResolvedValue([]);
    mockCreateCategory.mockResolvedValue({ id: 'cat-new', name: 'Mortgage Insurance', parentId: null });
    await act(async () => {
      render(<LoanFeesPanel account={MORTGAGE} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit fees' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add a fee' }));
    fireEvent.change(screen.getByLabelText('Fee name'), { target: { value: 'Insurance' } });
    const category = screen.getByLabelText('Category');
    fireEvent.focus(category);
    // The picker opens on focus after a short delay, as its own tests wait.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    fireEvent.change(category, { target: { value: 'mortgage insurance' } });
    const create = await screen.findByText('Create "mortgage insurance"');
    await act(async () => {
      fireEvent.click(create);
    });
    expect(mockCreateCategory).toHaveBeenCalledWith({ name: 'Mortgage Insurance', isIncome: false });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '25' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save fees' }));
    });
    expect(mockReplace).toHaveBeenCalledWith('mtg-1', [
      expect.objectContaining({ categoryId: 'cat-new', name: 'Insurance', amount: 25 }),
    ]);
  });

  it('shows the server refusal in the dialog', async () => {
    mockList.mockResolvedValue([TAX]);
    mockReplace.mockRejectedValue(new Error('refused'));
    await act(async () => {
      render(<LoanFeesPanel account={MORTGAGE} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit fees' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save fees' }));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
