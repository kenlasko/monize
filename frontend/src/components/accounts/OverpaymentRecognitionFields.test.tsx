import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { OverpaymentRecognitionFields } from './OverpaymentRecognitionFields';
import type { Category } from '@/types/category';

vi.mock('@/lib/categoryUtils', () => ({
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

function renderFields(overrides = {}) {
  const props = {
    categories,
    selectedInterestCategoryId: '',
    onInterestCategoryChange: vi.fn(),
    selectedOverpaymentCategoryId: '',
    onOverpaymentCategoryChange: vi.fn(),
    selectedOverpaymentPayeeId: '',
    onOverpaymentPayeeChange: vi.fn(),
    register: vi.fn(() => ({ name: 'overpaymentMemo' })),
    errors: {},
    ...overrides,
  };
  render(
    <OverpaymentRecognitionFields
      {...(props as unknown as Parameters<typeof OverpaymentRecognitionFields>[0])}
    />,
  );
  return props;
}

describe('OverpaymentRecognitionFields', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the category and payee pickers and loads payees', async () => {
    renderFields();
    expect(screen.getByText('Overpayment recognition')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Bank Overpayment' })).toBeInTheDocument();
    });
    // The category appears in both the interest and overpayment pickers.
    expect(screen.getAllByRole('option', { name: 'Loan Overpayment' }).length).toBeGreaterThanOrEqual(1);
  });

  it('reports the chosen payee', async () => {
    const props = renderFields();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Bank Overpayment' })).toBeInTheDocument(),
    );
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(screen.getByLabelText('Overpayment payee'), {
      target: { value: 'p1' },
    });
    expect(props.onOverpaymentPayeeChange).toHaveBeenCalledWith('p1');
  });
});
