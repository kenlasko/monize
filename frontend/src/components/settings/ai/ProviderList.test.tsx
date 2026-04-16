import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ProviderList } from './ProviderList';
import type { AiProviderConfig } from '@/types/ai';

const mockDeleteConfig = vi.fn();
const mockUpdateConfig = vi.fn();
const mockCreateConfig = vi.fn();
const mockTestConnection = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    deleteConfig: (...args: unknown[]) => mockDeleteConfig(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    createConfig: (...args: unknown[]) => mockCreateConfig(...args),
    testConnection: (...args: unknown[]) => mockTestConnection(...args),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('react-hot-toast', () => ({
  __esModule: true,
  default: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

const mockConfig: AiProviderConfig = {
  id: 'config-1',
  provider: 'anthropic',
  displayName: 'My Claude',
  isActive: true,
  priority: 0,
  model: 'claude-sonnet-4-20250514',
  apiKeyMasked: '****abcd',
  baseUrl: null,
  config: {},
  inputCostPer1M: null,
  outputCostPer1M: null,
  costCurrency: 'USD',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('ProviderList', () => {
  const onConfigsChanged = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ available: true });
  });

  it('renders empty state when no configs', () => {
    render(<ProviderList configs={[]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByText(/no ai providers configured/i)).toBeInTheDocument();
  });

  it('renders provider cards with details', () => {
    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByText('My Claude')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/claude-sonnet/)).toBeInTheDocument();
    expect(screen.getByText(/\*\*\*\*abcd/)).toBeInTheDocument();
  });

  it('shows encryption warning when not available', () => {
    render(<ProviderList configs={[]} encryptionAvailable={false} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByText(/AI_ENCRYPTION_KEY is not configured/)).toBeInTheDocument();
  });

  it('renders Add Provider button', () => {
    render(<ProviderList configs={[]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    expect(screen.getByRole('button', { name: /add provider/i })).toBeInTheDocument();
  });

  it('calls delete and refreshes on Delete click', async () => {
    mockDeleteConfig.mockResolvedValueOnce(undefined);

    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    await waitFor(() => {
      expect(mockDeleteConfig).toHaveBeenCalledWith('config-1');
      expect(onConfigsChanged).toHaveBeenCalled();
    });
  });

  it('toggles active state on Disable click', async () => {
    mockUpdateConfig.mockResolvedValueOnce(undefined);

    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /disable/i }));

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledWith('config-1', { isActive: false });
      expect(onConfigsChanged).toHaveBeenCalled();
    });
  });

  it('shows Edit form when Edit is clicked', async () => {
    render(<ProviderList configs={[mockConfig]} encryptionAvailable={true} onConfigsChanged={onConfigsChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    await waitFor(() => {
      expect(screen.getByText('Edit Provider')).toBeInTheDocument();
    });
  });

  describe('auto-test after save', () => {
    it('runs testConnection against the newly-created provider id', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      mockTestConnection.mockResolvedValueOnce({
        available: true,
        modelAvailable: true,
        model: 'claude-sonnet-4-20250514',
      });

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      // Invoke the create handler directly via an internal form submission
      // is fiddly; reach into the component by clicking "Add Provider"
      // then trigger the form's submit path via the hidden Modal.
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockTestConnection).toHaveBeenCalledWith('new-id');
      });
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith(
          'Model "claude-sonnet-4-20250514" is ready.',
        );
      });
    });

    it('surfaces a warning toast when the saved config reaches the provider but the model is missing', async () => {
      mockUpdateConfig.mockResolvedValueOnce({ ...mockConfig });
      mockTestConnection.mockResolvedValueOnce({
        available: true,
        modelAvailable: false,
        model: 'typo-4o',
        modelError: 'Model "typo-4o" was not found.',
      });

      const { container } = render(
        <ProviderList
          configs={[mockConfig]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          'Model "typo-4o" was not found.',
          expect.objectContaining({ duration: 7000 }),
        );
      });
    });

    it('surfaces a warning toast when the saved provider is unreachable', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      mockTestConnection.mockResolvedValueOnce({
        available: false,
        error: 'Connection test failed. Check your provider settings.',
      });

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          'Connection test failed. Check your provider settings.',
          expect.objectContaining({ duration: 7000 }),
        );
      });
    });

    it('stays silent when the post-save test itself throws (non-fatal)', async () => {
      mockCreateConfig.mockResolvedValueOnce({ ...mockConfig, id: 'new-id' });
      mockTestConnection.mockRejectedValueOnce(new Error('network down'));

      const { container } = render(
        <ProviderList
          configs={[]}
          encryptionAvailable={true}
          onConfigsChanged={onConfigsChanged}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /add provider/i }));
      const form = container.querySelector('form');
      fireEvent.submit(form!);

      await waitFor(() => {
        expect(mockTestConnection).toHaveBeenCalled();
      });
      // Save already succeeded; we swallow post-save test errors so the
      // user isn't spammed with a scary-looking toast for a non-fatal probe.
      const errorToasts = mockToastError.mock.calls as unknown[][];
      expect(
        errorToasts.some(
          (args) => typeof args[0] === 'string' && args[0].includes('network down'),
        ),
      ).toBe(false);
    });
  });
});
