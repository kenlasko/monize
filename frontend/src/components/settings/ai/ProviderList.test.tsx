import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ProviderList } from './ProviderList';
import type { AiProviderConfig } from '@/types/ai';

const mockDeleteConfig = vi.fn();
const mockUpdateConfig = vi.fn();
const mockCreateConfig = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    deleteConfig: (...args: unknown[]) => mockDeleteConfig(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    createConfig: (...args: unknown[]) => mockCreateConfig(...args),
    testConnection: vi.fn().mockResolvedValue({ available: true }),
  },
}));

vi.mock('react-hot-toast', () => ({
  __esModule: true,
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
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
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('ProviderList', () => {
  const onConfigsChanged = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
});
