import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { OverpaymentSettingsControl } from './OverpaymentSettingsControl';
import { categoriesApi } from '@/lib/categories';
import { accountsApi } from '@/lib/accounts';
import type { Category } from '@/types/category';

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: vi.fn() },
}));
vi.mock('@/lib/accounts', () => ({
  accountsApi: { update: vi.fn() },
}));

const categories = [
  { id: 'cat-extra', name: 'Extra Principal', isIncome: false, parentId: null },
  { id: 'cat-salary', name: 'Salary', isIncome: true, parentId: null },
] as Category[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(categoriesApi.getAll).mockResolvedValue(categories);
  vi.mocked(accountsApi.update).mockResolvedValue({} as never);
});

async function renderControl(
  props: Partial<React.ComponentProps<typeof OverpaymentSettingsControl>> = {},
) {
  const onCategoryChange = props.onCategoryChange ?? vi.fn();
  const onMemoChange = props.onMemoChange ?? vi.fn();
  const onInterestCategoryChange = props.onInterestCategoryChange ?? vi.fn();
  await act(async () => {
    render(
      <OverpaymentSettingsControl
        accountId="loan-1"
        categoryValue={null}
        memoValue={null}
        interestCategoryValue={null}
        onCategoryChange={onCategoryChange}
        onMemoChange={onMemoChange}
        onInterestCategoryChange={onInterestCategoryChange}
        {...props}
      />,
    );
  });
  return { onCategoryChange, onMemoChange, onInterestCategoryChange };
}

async function openPanel() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Payment recognition' }));
  });
}

describe('OverpaymentSettingsControl', () => {
  it('reveals the interest and overpayment pickers and memo input only after the gear is clicked', async () => {
    await renderControl();
    expect(screen.queryByPlaceholderText('Select a category')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Select interest category')).not.toBeInTheDocument();

    await openPanel();

    expect(screen.getByPlaceholderText('Select interest category')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Select a category')).toBeInTheDocument();
    expect(screen.getByLabelText('Overpayment memo')).toBeInTheDocument();
  });

  it('persists the interest category selection and reports it upward', async () => {
    const { onInterestCategoryChange } = await renderControl();
    await openPanel();
    fireEvent.click(screen.getByPlaceholderText('Select interest category'));

    const option = await screen.findByText('Extra Principal');
    await act(async () => {
      fireEvent.click(option);
    });

    await waitFor(() =>
      expect(accountsApi.update).toHaveBeenCalledWith('loan-1', {
        interestCategoryId: 'cat-extra',
      }),
    );
    expect(onInterestCategoryChange).toHaveBeenCalledWith('cat-extra');
  });

  it('offers only expense categories', async () => {
    await renderControl();
    await openPanel();
    fireEvent.click(screen.getByPlaceholderText('Select a category'));

    expect(await screen.findByText('Extra Principal')).toBeInTheDocument();
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
  });

  it('persists the category selection and reports it upward', async () => {
    const { onCategoryChange } = await renderControl();
    await openPanel();
    fireEvent.click(screen.getByPlaceholderText('Select a category'));

    const option = await screen.findByText('Extra Principal');
    await act(async () => {
      fireEvent.click(option);
    });

    await waitFor(() =>
      expect(accountsApi.update).toHaveBeenCalledWith('loan-1', {
        overpaymentCategoryId: 'cat-extra',
      }),
    );
    expect(onCategoryChange).toHaveBeenCalledWith('cat-extra');
  });

  it('saves a trimmed memo on blur and reports it upward', async () => {
    const { onMemoChange } = await renderControl();
    await openPanel();

    const memoInput = screen.getByLabelText('Overpayment memo');
    fireEvent.change(memoInput, { target: { value: '  Extra principal  ' } });
    await act(async () => {
      fireEvent.blur(memoInput);
    });

    await waitFor(() =>
      expect(accountsApi.update).toHaveBeenCalledWith('loan-1', {
        overpaymentMemo: 'Extra principal',
        overpaymentPayeeId: null,
      }),
    );
    expect(onMemoChange).toHaveBeenCalledWith('Extra principal');
  });

  it('clears the memo (null) when emptied', async () => {
    const { onMemoChange } = await renderControl({ memoValue: 'Extra principal' });
    await openPanel();

    const memoInput = screen.getByLabelText('Overpayment memo');
    fireEvent.change(memoInput, { target: { value: '' } });
    await act(async () => {
      fireEvent.blur(memoInput);
    });

    await waitFor(() =>
      expect(accountsApi.update).toHaveBeenCalledWith('loan-1', {
        overpaymentMemo: null,
        overpaymentPayeeId: null,
      }),
    );
    expect(onMemoChange).toHaveBeenCalledWith(null);
  });

  it('does not save when the memo is unchanged', async () => {
    await renderControl({ memoValue: 'Extra principal' });
    await openPanel();

    const memoInput = screen.getByLabelText('Overpayment memo');
    await act(async () => {
      fireEvent.blur(memoInput);
    });

    expect(accountsApi.update).not.toHaveBeenCalled();
  });
});
