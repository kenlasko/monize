import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { PayeeAliasManager } from './PayeeAliasManager';

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAliases: vi.fn(),
    createAlias: vi.fn(),
    deleteAlias: vi.fn(),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_: unknown, fallback: string) => fallback,
}));

import { payeesApi } from '@/lib/payees';

const mockGetAliases = payeesApi.getAliases as ReturnType<typeof vi.fn>;
const mockCreateAlias = payeesApi.createAlias as ReturnType<typeof vi.fn>;
const mockDeleteAlias = payeesApi.deleteAlias as ReturnType<typeof vi.fn>;

describe('PayeeAliasManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderComponent() {
    mockGetAliases.mockResolvedValue([
      { id: 'a1', payeeId: 'p1', alias: 'STARBUCKS*', createdAt: '2025-01-01' },
      { id: 'a2', payeeId: 'p1', alias: 'SBUX #*', createdAt: '2025-01-02' },
    ]);

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<PayeeAliasManager payeeId="p1" />);
    });
    return result!;
  }

  it('loads and displays existing aliases', async () => {
    await renderComponent();

    expect(screen.getByText('STARBUCKS*')).toBeInTheDocument();
    expect(screen.getByText('SBUX #*')).toBeInTheDocument();
    expect(mockGetAliases).toHaveBeenCalledWith('p1');
  });

  it('shows empty state when no aliases exist', async () => {
    mockGetAliases.mockResolvedValue([]);

    await act(async () => {
      render(<PayeeAliasManager payeeId="p1" />);
    });

    expect(screen.getByText('No aliases configured')).toBeInTheDocument();
  });

  it('adds a new alias', async () => {
    await renderComponent();

    const newAlias = { id: 'a3', payeeId: 'p1', alias: 'COFFEE*', createdAt: '2025-01-03' };
    mockCreateAlias.mockResolvedValue(newAlias);

    const input = screen.getByPlaceholderText('e.g., STARBUCKS #*');
    fireEvent.change(input, { target: { value: 'COFFEE*' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Add'));
    });

    expect(mockCreateAlias).toHaveBeenCalledWith({
      payeeId: 'p1',
      alias: 'COFFEE*',
    });
  });

  it('adds alias on Enter key', async () => {
    await renderComponent();

    const newAlias = { id: 'a3', payeeId: 'p1', alias: 'LATTE', createdAt: '2025-01-03' };
    mockCreateAlias.mockResolvedValue(newAlias);

    const input = screen.getByPlaceholderText('e.g., STARBUCKS #*');
    fireEvent.change(input, { target: { value: 'LATTE' } });

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(mockCreateAlias).toHaveBeenCalledWith({
      payeeId: 'p1',
      alias: 'LATTE',
    });
  });

  it('removes an alias', async () => {
    await renderComponent();

    mockDeleteAlias.mockResolvedValue(undefined);

    const removeButtons = screen.getAllByText('Remove');
    await act(async () => {
      fireEvent.click(removeButtons[0]);
    });

    expect(mockDeleteAlias).toHaveBeenCalledWith('a1');
  });

  it('disables Add button when input is empty', async () => {
    await renderComponent();

    const addButton = screen.getByText('Add');
    expect(addButton).toBeDisabled();
  });

  it('shows wildcard usage hint', async () => {
    await renderComponent();

    expect(screen.getByText(/Use \* as wildcard/)).toBeInTheDocument();
  });

  describe('local-only mode (no payeeId)', () => {
    it('renders without loading aliases from API', () => {
      const onChange = vi.fn();
      render(<PayeeAliasManager onPendingAliasesChange={onChange} />);

      expect(mockGetAliases).not.toHaveBeenCalled();
      expect(screen.getByText('No aliases configured')).toBeInTheDocument();
    });

    it('adds aliases locally without API call', async () => {
      const onChange = vi.fn();
      render(<PayeeAliasManager onPendingAliasesChange={onChange} />);

      const input = screen.getByPlaceholderText('e.g., STARBUCKS #*');
      fireEvent.change(input, { target: { value: 'LOCAL*' } });

      await act(async () => {
        fireEvent.click(screen.getByText('Add'));
      });

      expect(mockCreateAlias).not.toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledWith(['LOCAL*']);
      expect(screen.getByText('LOCAL*')).toBeInTheDocument();
    });

    it('removes aliases locally without API call', async () => {
      const onChange = vi.fn();
      render(<PayeeAliasManager onPendingAliasesChange={onChange} />);

      const input = screen.getByPlaceholderText('e.g., STARBUCKS #*');
      fireEvent.change(input, { target: { value: 'ALIAS1' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Add'));
      });

      fireEvent.click(screen.getByText('Remove'));

      expect(mockDeleteAlias).not.toHaveBeenCalled();
      expect(onChange).toHaveBeenLastCalledWith([]);
      expect(screen.getByText('No aliases configured')).toBeInTheDocument();
    });

    it('prevents duplicate aliases (case-insensitive)', async () => {
      const onChange = vi.fn();
      render(<PayeeAliasManager onPendingAliasesChange={onChange} />);

      const input = screen.getByPlaceholderText('e.g., STARBUCKS #*');

      fireEvent.change(input, { target: { value: 'STARBUCKS*' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Add'));
      });

      fireEvent.change(input, { target: { value: 'starbucks*' } });
      await act(async () => {
        fireEvent.click(screen.getByText('Add'));
      });

      // Should only have been called with one alias
      expect(onChange).toHaveBeenLastCalledWith(['STARBUCKS*']);
    });
  });
});
