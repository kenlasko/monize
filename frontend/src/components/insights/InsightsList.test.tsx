import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { InsightsList } from './InsightsList';

const mockGetInsights = vi.fn();
const mockGenerateInsights = vi.fn();
const mockDismissInsight = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    getStatus: vi.fn().mockResolvedValue({ configured: true }),
    getInsights: (...args: unknown[]) => mockGetInsights(...args),
    generateInsights: (...args: unknown[]) => mockGenerateInsights(...args),
    dismissInsight: (...args: unknown[]) => mockDismissInsight(...args),
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

// Render and flush all pending async state updates (e.g. useEffect API calls)
async function renderInsights() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<InsightsList />);
  });
  return result!;
}

describe('InsightsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockGetInsights.mockResolvedValue({
      insights: [],
      total: 0,
      lastGeneratedAt: null,
      isGenerating: false,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  });

  it('shows loading skeleton initially', async () => {
    mockGetInsights.mockReturnValue(new Promise(() => {})); // never resolves
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<InsightsList />));
    });
    expect(container!.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('shows empty state when no insights exist', async () => {
    await renderInsights();

    await waitFor(() => {
      expect(
        screen.getByText(/No insights generated yet/),
      ).toBeInTheDocument();
    });
  });

  it('shows generate button in empty state', async () => {
    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Generate Insights')).toBeInTheDocument();
    });
  });

  it('renders insights when they exist', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'High Dining Spending',
          description: 'Spending is above average',
          severity: 'warning',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('High Dining Spending')).toBeInTheDocument();
    });
  });

  it('shows alert and warning counts', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Alert 1',
          description: 'Desc',
          severity: 'alert',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
        {
          id: 'i2',
          type: 'trend',
          title: 'Warning 1',
          description: 'Desc',
          severity: 'warning',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 2,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('1 alert')).toBeInTheDocument();
      expect(screen.getByText('1 warning')).toBeInTheDocument();
    });
  });

  it('calls generateInsights and polls for results when refresh button clicked', async () => {
    vi.useFakeTimers();

    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Test',
          description: 'Desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });
    mockGenerateInsights.mockResolvedValue(undefined);

    render(<InsightsList />);

    // Flush initial async load (useEffect -> loadInsights)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('Refresh Insights')).toBeInTheDocument();

    // Set up poll response with updated lastGeneratedAt
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i2',
          type: 'trend',
          title: 'New Insight',
          description: 'New desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T12:00:00.000Z',
          expiresAt: '2026-02-25T12:00:00.000Z',
          createdAt: '2026-02-18T12:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T12:00:00.000Z',
      isGenerating: false,
    });

    // Click refresh and flush microtasks so generateInsights resolves and polling starts
    await act(async () => {
      fireEvent.click(screen.getByText('Refresh Insights'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockGenerateInsights).toHaveBeenCalled();

    // Advance past the poll interval (POLL_INTERVAL = 5000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });

    expect(screen.getByText('New Insight')).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('shows generating state when server reports isGenerating on load', async () => {
    // Server says generation is in progress — subsequent polls return completed
    mockGetInsights
      .mockResolvedValueOnce({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: true,
      })
      .mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: '2026-02-18T12:00:00.000Z',
        isGenerating: false,
      });

    await renderInsights();

    // Buttons should show "Generating..." after initial load detects isGenerating
    await waitFor(() => {
      const buttons = screen.getAllByText('Generating...');
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons[0]).toBeDisabled();
    });
  });

  it('calls dismiss when dismiss button clicked', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Test Insight',
          description: 'Desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });
    mockDismissInsight.mockResolvedValue(undefined);

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Test Insight')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Dismiss'));

    await waitFor(() => {
      expect(mockDismissInsight).toHaveBeenCalledWith('i1');
    });
  });

  it('shows error message on load failure', async () => {
    mockGetInsights.mockRejectedValue(new Error('Network error'));

    await renderInsights();

    await waitFor(() => {
      expect(
        screen.getByText('Failed to load insights. Please try again.'),
      ).toBeInTheDocument();
    });
  });

  it('shows error message on generate failure', async () => {
    mockGetInsights.mockResolvedValue({
      insights: [
        {
          id: 'i1',
          type: 'anomaly',
          title: 'Test',
          description: 'Desc',
          severity: 'info',
          data: {},
          isDismissed: false,
          generatedAt: '2026-02-18T00:00:00.000Z',
          expiresAt: '2026-02-25T00:00:00.000Z',
          createdAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      total: 1,
      lastGeneratedAt: '2026-02-18T00:00:00.000Z',
      isGenerating: false,
    });
    mockGenerateInsights.mockRejectedValue(new Error('Provider error'));

    await renderInsights();

    await waitFor(() => {
      expect(screen.getByText('Refresh Insights')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Refresh Insights'));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Failed to generate insights. Make sure you have an AI provider configured.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('passes filter parameters to API', async () => {
    await renderInsights();

    await waitFor(() => {
      expect(mockGetInsights).toHaveBeenCalledWith({
        type: undefined,
        severity: undefined,
        includeDismissed: false,
      });
    });
  });
});
