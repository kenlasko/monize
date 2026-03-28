import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { ActionHistoryPanel } from './ActionHistoryPanel';
import { actionHistoryApi } from '@/lib/action-history';

vi.mock('@/lib/action-history', () => ({
  actionHistoryApi: {
    getHistory: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockHistory = [
  {
    id: '1',
    userId: 'u1',
    entityType: 'transaction',
    entityId: 'tx-1',
    action: 'create',
    isUndone: false,
    description: 'Created transaction: Grocery $50',
    createdAt: new Date().toISOString(),
  },
  {
    id: '2',
    userId: 'u1',
    entityType: 'tag',
    entityId: 'tag-1',
    action: 'delete',
    isUndone: true,
    description: 'Deleted tag "Old Tag"',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
];

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
    const { getByTestId } = render(<ActionHistoryPanel />);

    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });

    await waitFor(() => {
      expect(actionHistoryApi.getHistory).toHaveBeenCalledWith(20);
    });

    expect(getByTestId('action-history-panel')).toBeInTheDocument();
  });

  it('should display history items', async () => {
    const { getByTestId, getAllByTestId } = render(<ActionHistoryPanel />);

    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });

    await waitFor(() => {
      const items = getAllByTestId('history-item');
      expect(items).toHaveLength(2);
    });
  });

  it('should show undone items with reduced opacity', async () => {
    const { getByTestId, getAllByTestId } = render(<ActionHistoryPanel />);

    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });

    await waitFor(() => {
      const items = getAllByTestId('history-item');
      expect(items[1]).toHaveClass('opacity-50');
    });
  });

  it('should call undo API when undo button clicked', async () => {
    const { getByTestId } = render(<ActionHistoryPanel />);

    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });

    await waitFor(() => {
      expect(getByTestId('undo-button')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(getByTestId('undo-button'));
    });

    expect(actionHistoryApi.undo).toHaveBeenCalled();
  });

  it('should call redo API when redo button clicked', async () => {
    const { getByTestId } = render(<ActionHistoryPanel />);

    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });

    await waitFor(() => {
      expect(getByTestId('redo-button')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(getByTestId('redo-button'));
    });

    expect(actionHistoryApi.redo).toHaveBeenCalled();
  });

  it('should close panel on outside click', async () => {
    const { getByTestId, queryByTestId } = render(<ActionHistoryPanel />);

    await act(async () => {
      fireEvent.click(getByTestId('action-history-button'));
    });

    expect(getByTestId('action-history-panel')).toBeInTheDocument();

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
});
