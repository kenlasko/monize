import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import AiSettingsPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: any) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: any) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="spinner">Loading</div>,
}));

vi.mock('@/components/settings/ai/ProviderList', () => ({
  ProviderList: ({ configs, disabled, onConfigsChanged }: any) => (
    <div data-testid="provider-list">
      <span>configs:{configs.length}</span>
      <span>disabled:{String(disabled)}</span>
      <button onClick={() => onConfigsChanged && onConfigsChanged()}>reload</button>
    </div>
  ),
}));

vi.mock('@/components/settings/ai/UsageDashboard', () => ({
  UsageDashboard: ({ onPeriodChange }: any) => (
    <div data-testid="usage-dashboard">
      <button onClick={() => onPeriodChange(7)}>7d</button>
      <button onClick={() => onPeriodChange(undefined)}>all</button>
    </div>
  ),
}));

const mockGetConfigs = vi.fn();
const mockGetUsage = vi.fn();
const mockGetStatus = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    getConfigs: (...args: any[]) => mockGetConfigs(...args),
    getUsage: (...args: any[]) => mockGetUsage(...args),
    getStatus: (...args: any[]) => mockGetStatus(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (e: any, fallback: string) => (e instanceof Error ? e.message : fallback),
}));

const mockUseDemoMode = vi.fn(() => false);
vi.mock('@/hooks/useDemoMode', () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

describe('AiSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDemoMode.mockReturnValue(false);
  });

  it('shows loading spinner initially', () => {
    mockGetConfigs.mockReturnValue(new Promise(() => {}));
    mockGetUsage.mockReturnValue(new Promise(() => {}));
    mockGetStatus.mockReturnValue(new Promise(() => {}));
    render(<AiSettingsPage />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('renders settings with data', async () => {
    mockGetConfigs.mockResolvedValue([{ id: '1', provider: 'anthropic' }]);
    mockGetUsage.mockResolvedValue({ totalCost: 0, requests: 0 });
    mockGetStatus.mockResolvedValue({ encryptionAvailable: true, hasSystemDefault: false });
    render(<AiSettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('AI Settings')).toBeInTheDocument();
    });
    expect(screen.getByTestId('provider-list')).toBeInTheDocument();
    expect(screen.getByTestId('usage-dashboard')).toBeInTheDocument();
    expect(screen.getByText('configs:1')).toBeInTheDocument();
    expect(screen.getByText('disabled:false')).toBeInTheDocument();
  });

  it('handles period change', async () => {
    mockGetConfigs.mockResolvedValue([]);
    mockGetUsage.mockResolvedValue({ totalCost: 0, requests: 0 });
    mockGetStatus.mockResolvedValue({ encryptionAvailable: true });
    render(<AiSettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('usage-dashboard')).toBeInTheDocument();
    });
    mockGetUsage.mockResolvedValueOnce({ totalCost: 100, requests: 5 });
    await act(async () => {
      fireEvent.click(screen.getByText('7d'));
    });
    expect(mockGetUsage).toHaveBeenCalledWith(7);
  });

  it('handles period change error', async () => {
    mockGetConfigs.mockResolvedValue([]);
    mockGetUsage.mockResolvedValue({ totalCost: 0, requests: 0 });
    mockGetStatus.mockResolvedValue({ encryptionAvailable: true });
    render(<AiSettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('usage-dashboard')).toBeInTheDocument();
    });
    mockGetUsage.mockRejectedValueOnce(new Error('failed'));
    await act(async () => {
      fireEvent.click(screen.getByText('all'));
    });
  });

  it('handles loadData error', async () => {
    mockGetConfigs.mockRejectedValue(new Error('boom'));
    mockGetUsage.mockRejectedValue(new Error('boom'));
    mockGetStatus.mockRejectedValue(new Error('boom'));
    render(<AiSettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('AI Settings')).toBeInTheDocument();
    });
  });

  it('shows demo mode notice when in demo mode', async () => {
    mockUseDemoMode.mockReturnValue(true);
    mockGetConfigs.mockResolvedValue([]);
    mockGetUsage.mockResolvedValue({ totalCost: 0, requests: 0 });
    mockGetStatus.mockResolvedValue({ encryptionAvailable: true });
    render(<AiSettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
    });
    expect(screen.getByText('disabled:true')).toBeInTheDocument();
  });

  it('reloads configs when ProviderList signals change', async () => {
    mockGetConfigs.mockResolvedValue([]);
    mockGetUsage.mockResolvedValue({ totalCost: 0, requests: 0 });
    mockGetStatus.mockResolvedValue({ encryptionAvailable: true });
    render(<AiSettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('provider-list')).toBeInTheDocument();
    });
    mockGetConfigs.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText('reload'));
    });
    expect(mockGetConfigs).toHaveBeenCalled();
  });

  it('does not render usage dashboard when usage is null', async () => {
    mockGetConfigs.mockResolvedValue([]);
    mockGetUsage.mockResolvedValue(null);
    mockGetStatus.mockResolvedValue({ encryptionAvailable: true });
    render(<AiSettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('provider-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('usage-dashboard')).not.toBeInTheDocument();
  });
});
