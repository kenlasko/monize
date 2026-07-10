import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '@/test/render';
import { OverpaymentCategoryControl } from './OverpaymentCategoryControl';
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
  props: Partial<React.ComponentProps<typeof OverpaymentCategoryControl>> = {},
) {
  const onChange = props.onChange ?? vi.fn();
  await act(async () => {
    render(
      <OverpaymentCategoryControl accountId="loan-1" value={null} onChange={onChange} {...props} />,
    );
  });
  return { onChange };
}

describe('OverpaymentCategoryControl', () => {
  it('reveals the category picker only after the gear is clicked', async () => {
    await renderControl();
    expect(screen.queryByPlaceholderText('Select a category')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Overpayment Category' }));
    });

    expect(screen.getByPlaceholderText('Select a category')).toBeInTheDocument();
  });

  it('offers only expense categories', async () => {
    await renderControl();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Overpayment Category' }));
    });
    fireEvent.click(screen.getByPlaceholderText('Select a category'));

    expect(await screen.findByText('Extra Principal')).toBeInTheDocument();
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
  });

  it('persists the selection and reports it upward', async () => {
    const { onChange } = await renderControl();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Overpayment Category' }));
    });
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
    expect(onChange).toHaveBeenCalledWith('cat-extra');
  });
});
