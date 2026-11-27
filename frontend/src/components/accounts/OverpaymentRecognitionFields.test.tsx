import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@/test/render';
import { OverpaymentRecognitionFields } from './OverpaymentRecognitionFields';
import type { Category } from '@/types/category';

vi.mock('@/lib/categoryUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categoryUtils')>()),
  buildCategoryTree: (cats: Category[]) => cats.map((category) => ({ category })),
}));

// Stub Combobox as a native select so we can assert options + fire change.
vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({
    label,
    options,
    value,
    onChange,
  }: {
    label: string;
    options: { value: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
  }) => (
    <label>
      {label}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">--</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Bank Overpayment' },
      { id: 'p2', name: 'Other Payee' },
    ]),
  },
}));

const categories: Category[] = [
  { id: 'c1', name: 'Loan Overpayment', parentId: null } as Category,
];

// Payees are fetched on mount, so the render has async work behind it -- act
// keeps that state update wrapped even in the tests that never await it.
async function renderFields(overrides = {}) {
  const props = {
    categories,
    selectedInterestCategoryId: '',
    onInterestCategoryChange: vi.fn(),
    interestBookingMode: 'AUTO',
    onInterestBookingModeChange: vi.fn(),
    selectedOverpaymentCategoryId: '',
    onOverpaymentCategoryChange: vi.fn(),
    selectedOverpaymentPayeeId: '',
    onOverpaymentPayeeChange: vi.fn(),
    register: vi.fn(() => ({ name: 'overpaymentMemo' })),
    errors: {},
    ...overrides,
  };
  await act(async () => {
    render(
      <OverpaymentRecognitionFields
        {...(props as unknown as Parameters<typeof OverpaymentRecognitionFields>[0])}
      />,
    );
  });
  return props;
}

describe('OverpaymentRecognitionFields', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the category and payee pickers and loads payees', async () => {
    await renderFields();
    expect(screen.getByText('Overpayment recognition')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Bank Overpayment' })).toBeInTheDocument();
    });
    // The category appears in both the interest and overpayment pickers.
    expect(screen.getAllByRole('option', { name: 'Loan Overpayment' }).length).toBeGreaterThanOrEqual(1);
  });

  it('offers the interest picker Income and Expense only, and the overpayment picker every type (INV-CATEGORY-001)', async () => {
    await renderFields({
      categories: [
        ...categories,
        { id: 'ct', name: 'Savings moves', parentId: null, categoryType: 'transfer' } as Category,
      ],
    });
    const optionsOf = (label: string) =>
      Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value);
    expect(optionsOf('Interest Category (optional)')).toEqual(['', 'c1']);
    expect(optionsOf('Overpayment category')).toEqual(expect.arrayContaining(['c1', 'ct']));
  });

  it('labels the interest category with no marker when it is required', async () => {
    await renderFields({ interestCategoryRequired: true });
    expect(screen.getByLabelText('Interest Category')).toBeInTheDocument();
    expect(screen.queryByLabelText('Interest Category (optional)')).not.toBeInTheDocument();
  });

  it('labels the interest category as optional by default (an edit keeps it)', async () => {
    await renderFields();
    expect(screen.getByLabelText('Interest Category (optional)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Interest Category')).not.toBeInTheDocument();
  });

  it('reports the chosen payee', async () => {
    const props = await renderFields();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Bank Overpayment' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('Overpayment payee'), {
      target: { value: 'p1' },
    });
    expect(props.onOverpaymentPayeeChange).toHaveBeenCalledWith('p1');
  });

  it('reports the chosen interest booking mode', async () => {
    const props = await renderFields();
    fireEvent.change(screen.getByLabelText('Interest Recording'), {
      target: { value: 'SEPARATE' },
    });
    expect(props.onInterestBookingModeChange).toHaveBeenCalledWith('SEPARATE');
  });
});
