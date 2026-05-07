import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@/test/render';
import { ActionHistoryPanel } from './ActionHistoryPanel';
import { actionHistoryApi } from '@/lib/action-history';
import { notifyUndoRedo } from '@/lib/undoRedoSignal';

vi.mock('@/lib/action-history', () => ({
  actionHistoryApi: {
    getHistory: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  },
}));

vi.mock('@/lib/apiCache', () => ({
  clearAllCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const makeItem = (overrides?: Record<string, any>) => ({
  id: '1',
  userId: 'u1',
  entityType: 'transaction',
  entityId: 'tx-1',
  action: 'create',
  isUndone: false,
  description: 'Created transaction: Grocery $50',
  createdAt: new Date().toISOString(),
  ...overrides,
});

const mockHistory = [
  makeItem(),
  makeItem({
    id: '2',
    entityType: 'tag',
    entityId: 'tag-1',
    action: 'delete',
    isUndone: true,
    description: 'Deleted tag "Old Tag"',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  }),
];

async function openPanel() {
  const utils = render(<ActionHistoryPanel />);
  await act(async () => {
    fireEvent.click(utils.getByTestId('action-history-button'));
  });
  await waitFor(() => {
    expect(utils.getByTestId('action-history-panel')).toBeInTheDocument();
  });
  return utils;
}

describe('ActionHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(mockHistory);
    (actionHistoryApi.undo as ReturnType<typeof vi.fn>).mockResolvedValue({
      action: mockHistory[0],
      description: 'Undone: Created transaction',
    });
    (actionHistoryApi.redo as ReturnType<typeof vi.fn>).mockResolvedValue({
      action: mockHistory[1],
      description: 'Redone: Deleted tag',
    });
  });

  it('should render the trigger button', () => {
    const { getByTestId } = render(<ActionHistoryPanel />);
    expect(getByTestId('action-history-button')).toBeInTheDocument();
  });

  it('should not show panel by default', () => {
    const { queryByTestId } = render(<ActionHistoryPanel />);
    expect(queryByTestId('action-history-panel')).not.toBeInTheDocument();
  });

  it('should open panel and fetch history on click', async () => {
    const { getByTestId } = await openPanel();
    await waitFor(() => {
      expect(actionHistoryApi.getHistory).toHaveBeenCalledWith(20);
    });
    expect(getByTestId('action-history-panel')).toBeInTheDocument();
  });

  it('should display history items', async () => {
    const { getAllByTestId } = await openPanel();
    await waitFor(() => {
      const items = getAllByTestId('history-item');
      expect(items).toHaveLength(2);
    });
  });

  it('should show undone items with reduced opacity', async () => {
    const { getAllByTestId } = await openPanel();
    await waitFor(() => {
      const items = getAllByTestId('history-item');
      expect(items[1]).toHaveClass('opacity-50');
    });
  });

  it('should call undo API when undo button clicked', async () => {
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('undo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('undo-button'));
    });
    expect(actionHistoryApi.undo).toHaveBeenCalled();
  });

  it('should call redo API when redo button clicked', async () => {
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('redo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('redo-button'));
    });
    expect(actionHistoryApi.redo).toHaveBeenCalled();
  });

  it('should close panel on outside click', async () => {
    const { getByTestId: _getByTestId, queryByTestId } = await openPanel();
    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(queryByTestId('action-history-panel')).not.toBeInTheDocument();
  });

  it('should show empty state when no history', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { getByTestId, getByText } = render(<ActionHistoryPanel />);
    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });
    await waitFor(() => {
      expect(getByText('No recent actions')).toBeInTheDocument();
    });
  });

  it('should close panel when close button inside panel is clicked', async () => {
    const { getByLabelText, queryByTestId } = await openPanel();
    await act(async () => {
      fireEvent.click(getByLabelText('Close'));
    });
    expect(queryByTestId('action-history-panel')).not.toBeInTheDocument();
  });

  it('shows loading spinner while fetching history before data arrives', async () => {
    let resolveHistory!: (v: any) => void;
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((res) => { resolveHistory = res; }),
    );
    const { getByTestId } = render(<ActionHistoryPanel />);
    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });
    // Still loading, no items yet
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    // Resolve so the component can settle
    await act(async () => { resolveHistory([]); });
  });

  it('displays entity labels for known entity types', async () => {
    const { getByText } = await openPanel();
    await waitFor(() => {
      expect(getByText('Transaction')).toBeInTheDocument();
      expect(getByText('Tag')).toBeInTheDocument();
    });
  });

  it('falls back to raw entityType for unknown entity types', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ entityType: 'unknown_entity' }),
    ]);
    const { getByText } = await openPanel();
    await waitFor(() => {
      expect(getByText('unknown_entity')).toBeInTheDocument();
    });
  });

  it('shows "Undone" label on undone items', async () => {
    const { getByText } = await openPanel();
    await waitFor(() => {
      expect(getByText('Undone')).toBeInTheDocument();
    });
  });

  it('applies line-through style to undone item descriptions', async () => {
    const { getAllByTestId } = await openPanel();
    await waitFor(() => {
      const items = getAllByTestId('history-item');
      const undoneDescription = items[1].querySelector('p');
      expect(undoneDescription?.className).toContain('line-through');
    });
  });

  it('shows toast success after successful undo', async () => {
    const toast = await import('react-hot-toast');
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('undo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('undo-button'));
    });
    await waitFor(() => {
      expect(toast.default.success).toHaveBeenCalledWith('Undone: Created transaction');
    });
  });

  it('shows toast success after successful redo', async () => {
    const toast = await import('react-hot-toast');
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('redo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('redo-button'));
    });
    await waitFor(() => {
      expect(toast.default.success).toHaveBeenCalledWith('Redone: Deleted tag');
    });
  });

  it('shows "Nothing to undo" on undo 404 error', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.undo as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 404, data: {} },
    });
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('undo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('undo-button'));
    });
    await waitFor(() => {
      expect(toast.default.success).toHaveBeenCalledWith('Nothing to undo');
    });
  });

  it('shows conflict message on undo 409 error with message', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.undo as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 409, data: { message: 'Cannot undo a deleted account' } },
    });
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('undo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('undo-button'));
    });
    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Cannot undo a deleted account');
    });
  });

  it('shows fallback message on undo 409 error without message', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.undo as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 409, data: {} },
    });
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('undo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('undo-button'));
    });
    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Cannot undo this action');
    });
  });

  it('shows generic "Undo failed" on unexpected undo error', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.undo as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('undo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('undo-button'));
    });
    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Undo failed');
    });
  });

  it('shows "Nothing to redo" on redo 404 error', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.redo as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 404, data: {} },
    });
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('redo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('redo-button'));
    });
    await waitFor(() => {
      expect(toast.default.success).toHaveBeenCalledWith('Nothing to redo');
    });
  });

  it('shows conflict message on redo 409 error with message', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.redo as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 409, data: { message: 'Cannot redo this' } },
    });
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('redo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('redo-button'));
    });
    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Cannot redo this');
    });
  });

  it('shows fallback message on redo 409 error without message', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.redo as ReturnType<typeof vi.fn>).mockRejectedValue({
      response: { status: 409, data: {} },
    });
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('redo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('redo-button'));
    });
    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Cannot redo this action');
    });
  });

  it('shows generic "Redo failed" on unexpected redo error', async () => {
    const toast = await import('react-hot-toast');
    (actionHistoryApi.redo as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('redo-button')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(getByTestId('redo-button'));
    });
    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalledWith('Redo failed');
    });
  });

  it('ignores duplicate undo clicks while a request is pending', async () => {
    let resolveUndo!: (v: any) => void;
    (actionHistoryApi.undo as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((res) => { resolveUndo = res; }),
    );
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getByTestId('undo-button')).toBeInTheDocument());
    // Click twice rapidly
    fireEvent.click(getByTestId('undo-button'));
    fireEvent.click(getByTestId('undo-button'));
    // Resolve so component can settle
    await act(async () => {
      resolveUndo({ action: mockHistory[0], description: 'Undone' });
    });
    // Only called once despite two clicks
    expect(actionHistoryApi.undo).toHaveBeenCalledTimes(1);
  });

  it('refreshes history after notifyUndoRedo signal when panel is open', async () => {
    const { getByTestId } = await openPanel();
    await waitFor(() => expect(getAllByTestIdSafe('history-item')).toBeTruthy());

    // Reset call count then trigger the signal
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockClear();
    await act(async () => {
      notifyUndoRedo();
    });
    await waitFor(() => {
      expect(actionHistoryApi.getHistory).toHaveBeenCalled();
    });

    function getAllByTestIdSafe(_id: string) {
      return getByTestId('action-history-panel');
    }
  });

  it('does not refresh history after notifyUndoRedo when panel is closed', async () => {
    render(<ActionHistoryPanel />);
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockClear();
    await act(async () => {
      notifyUndoRedo();
    });
    // Panel was never opened, no fetch should occur
    expect(actionHistoryApi.getHistory).not.toHaveBeenCalled();
  });

  it('timeAgo shows "just now" for very recent items', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ createdAt: new Date().toISOString() }),
    ]);
    const { getByText } = await openPanel();
    await waitFor(() => {
      expect(getByText('just now')).toBeInTheDocument();
    });
  });

  it('timeAgo shows minutes for items created minutes ago', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
    ]);
    const { getByText } = await openPanel();
    await waitFor(() => {
      expect(getByText('5m ago')).toBeInTheDocument();
    });
  });

  it('timeAgo shows hours for items created hours ago', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }),
    ]);
    const { getByText } = await openPanel();
    await waitFor(() => {
      expect(getByText('3h ago')).toBeInTheDocument();
    });
  });

  it('timeAgo shows days for items created days ago', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() }),
    ]);
    const { getByText } = await openPanel();
    await waitFor(() => {
      expect(getByText('2d ago')).toBeInTheDocument();
    });
  });

  it('undo button is enabled when there are non-undone items', async () => {
    const { getByTestId } = await openPanel();
    await waitFor(() => {
      // mockHistory has item with isUndone=false, so canUndo=true
      expect(getByTestId('undo-button')).not.toBeDisabled();
    });
  });

  it('redo button is enabled when there are undone items', async () => {
    const { getByTestId } = await openPanel();
    await waitFor(() => {
      // mockHistory has item with isUndone=true, so canRedo=true
      expect(getByTestId('redo-button')).not.toBeDisabled();
    });
  });

  it('undo button is disabled when all items are undone', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ isUndone: true }),
    ]);
    const { getByTestId } = await openPanel();
    await waitFor(() => {
      expect(getByTestId('undo-button')).toBeDisabled();
    });
  });

  it('redo button is disabled when no items are undone', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeItem({ isUndone: false }),
    ]);
    const { getByTestId } = await openPanel();
    await waitFor(() => {
      expect(getByTestId('redo-button')).toBeDisabled();
    });
  });

  it('toggles panel closed when button clicked again', async () => {
    const { getByTestId, queryByTestId } = render(<ActionHistoryPanel />);
    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });
    expect(getByTestId('action-history-panel')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });
    expect(queryByTestId('action-history-panel')).not.toBeInTheDocument();
  });

  it('handles silently when getHistory throws', async () => {
    (actionHistoryApi.getHistory as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );
    const { getByTestId } = render(<ActionHistoryPanel />);
    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });
    // Panel still renders, just no history items
    await waitFor(() => {
      expect(getByTestId('action-history-panel')).toBeInTheDocument();
    });
  });
});
