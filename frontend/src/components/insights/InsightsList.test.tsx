import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { InsightsList } from './InsightsList';

const mockGetInsights = vi.fn();
const mockGenerateInsights = vi.fn();
const mockDismissInsight = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
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

describe('InsightsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetInsights.mockResolvedValue({
      insights: [],
      total: 0,
      lastGeneratedAt: null,
    });
  });

  it('shows loading skeleton initially', () => {
    mockGetInsights.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<InsightsList />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('shows empty state when no insights exist', async () => {
    render(<InsightsList />);

    await waitFor(() => {
      expect(
        screen.getByText(/No insights generated yet/),
      ).toBeInTheDocument();
    });
  });

  it('shows generate button in empty state', async () => {
    render(<InsightsList />);

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
    });

    render(<InsightsList />);

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
    });

    render(<InsightsList />);

    await waitFor(() => {
      expect(screen.getByText('1 alert')).toBeInTheDocument();
      expect(screen.getByText('1 warning')).toBeInTheDocument();
    });
  });

  it('calls generateInsights when refresh button clicked', async () => {
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
    });
    mockGenerateInsights.mockResolvedValue({
      insights: [],
      total: 0,
      lastGeneratedAt: '2026-02-18T12:00:00.000Z',
    });

    render(<InsightsList />);

    await waitFor(() => {
      expect(screen.getByText('Refresh Insights')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Refresh Insights'));

    await waitFor(() => {
      expect(mockGenerateInsights).toHaveBeenCalled();
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
    });
    mockDismissInsight.mockResolvedValue(undefined);

    render(<InsightsList />);

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

    render(<InsightsList />);

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
    });
    mockGenerateInsights.mockRejectedValue(new Error('Provider error'));

    render(<InsightsList />);

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
    render(<InsightsList />);

    await waitFor(() => {
      expect(mockGetInsights).toHaveBeenCalledWith({
        type: undefined,
        severity: undefined,
        includeDismissed: false,
      });
    });
  });
});
