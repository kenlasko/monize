import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ProviderTestButton } from './ProviderTestButton';

const mockTestConnection = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    testConnection: (...args: unknown[]) => mockTestConnection(...args),
  },
}));

vi.mock('react-hot-toast', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

describe('ProviderTestButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Test button', () => {
    render(<ProviderTestButton configId="config-1" />);
    expect(screen.getByRole('button', { name: /test/i })).toBeInTheDocument();
  });

  it('shows success state on successful test', async () => {
    mockTestConnection.mockResolvedValueOnce({ available: true });

    render(<ProviderTestButton configId="config-1" />);
    fireEvent.click(screen.getByRole('button', { name: /test/i }));

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('Connection successful');
    });
  });

  it('shows error state on failed test', async () => {
    mockTestConnection.mockResolvedValueOnce({ available: false, error: 'Bad key' });

    render(<ProviderTestButton configId="config-1" />);
    fireEvent.click(screen.getByRole('button', { name: /test/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Bad key');
    });
  });

  it('shows error state on network failure', async () => {
    mockTestConnection.mockRejectedValueOnce(new Error('Network error'));

    render(<ProviderTestButton configId="config-1" />);
    fireEvent.click(screen.getByRole('button', { name: /test/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Connection test failed');
    });
  });
});
