import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@/test/render';
import { UpdateAvailableBanner } from './UpdateAvailableBanner';
import { useAuthStore } from '@/store/authStore';
import { updatesApi, UpdateStatus } from '@/lib/updatesApi';
import type { User } from '@/types/auth';

vi.mock('@/lib/updatesApi', () => ({
  updatesApi: {
    getStatus: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const adminUser: User = {
  id: 'admin-1',
  email: 'admin@example.com',
  authProvider: 'local',
  hasPassword: true,
  role: 'admin',
  isActive: true,
  mustChangePassword: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const regularUser: User = { ...adminUser, id: 'user-1', role: 'user' };

const baseStatus: UpdateStatus = {
  currentVersion: '1.8.40',
  latestVersion: '1.9.0',
  updateAvailable: true,
  releaseUrl: 'https://github.com/kenlasko/monize/releases/tag/v1.9.0',
  releaseName: 'Monize 1.9.0',
  publishedAt: '2026-02-01T00:00:00Z',
  checkedAt: '2026-02-02T00:00:00Z',
  dismissed: false,
  disabled: false,
  error: null,
};

async function renderBanner() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<UpdateAvailableBanner />);
  });
  return result!;
}

describe('UpdateAvailableBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
    });
  });

  it('renders nothing for non-admin users even if an update is available', async () => {
    useAuthStore.setState({ user: regularUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockResolvedValue(baseStatus);

    const { container } = await renderBanner();

    expect(container.firstChild).toBeNull();
    expect(updatesApi.getStatus).not.toHaveBeenCalled();
  });

  it('renders nothing when not authenticated', async () => {
    vi.mocked(updatesApi.getStatus).mockResolvedValue(baseStatus);

    const { container } = await renderBanner();

    expect(container.firstChild).toBeNull();
    expect(updatesApi.getStatus).not.toHaveBeenCalled();
  });

  it('renders banner with latest version and release notes link for admin with available update', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockResolvedValue(baseStatus);

    await renderBanner();

    await waitFor(() => {
      expect(
        screen.getByText(/Monize v1\.9\.0 is available/),
      ).toBeInTheDocument();
    });

    const link = screen.getByRole('link', { name: /release notes/i });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/kenlasko/monize/releases/tag/v1.9.0',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders nothing when updateAvailable is false', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockResolvedValue({
      ...baseStatus,
      updateAvailable: false,
    });

    const { container } = await renderBanner();

    await waitFor(() => {
      expect(updatesApi.getStatus).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the user has already dismissed this version', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockResolvedValue({
      ...baseStatus,
      dismissed: true,
    });

    const { container } = await renderBanner();

    await waitFor(() => {
      expect(updatesApi.getStatus).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('silently swallows a failed getStatus call and renders nothing', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockRejectedValueOnce(new Error('boom'));

    const { container } = await renderBanner();

    await waitFor(() => {
      expect(updatesApi.getStatus).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('falls back to a generic message when latestVersion is missing', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockResolvedValue({
      ...baseStatus,
      latestVersion: null,
    });

    await renderBanner();

    await waitFor(() => {
      expect(
        screen.getByText(/A new version of Monize is available/),
      ).toBeInTheDocument();
    });
  });

  it('un-hides the banner if dismiss fails so the user can retry', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockResolvedValue(baseStatus);
    vi.mocked(updatesApi.dismiss).mockRejectedValueOnce(new Error('boom'));

    await renderBanner();

    const dismissButton = await screen.findByRole('button', {
      name: /dismiss update notification/i,
    });

    await act(async () => {
      fireEvent.click(dismissButton);
    });

    await waitFor(() => {
      expect(updatesApi.dismiss).toHaveBeenCalledTimes(1);
    });

    // After the failed dismiss, the banner should be visible again.
    expect(
      screen.getByText(/Monize v1\.9\.0 is available/),
    ).toBeInTheDocument();
  });

  it('hides the banner and calls dismiss when the user clicks Dismiss', async () => {
    useAuthStore.setState({ user: adminUser, isAuthenticated: true });
    vi.mocked(updatesApi.getStatus).mockResolvedValue(baseStatus);
    vi.mocked(updatesApi.dismiss).mockResolvedValue({
      dismissed: true,
      version: '1.9.0',
    });

    await renderBanner();

    const dismissButton = await screen.findByRole('button', {
      name: /dismiss update notification/i,
    });

    await act(async () => {
      fireEvent.click(dismissButton);
    });

    await waitFor(() => {
      expect(updatesApi.dismiss).toHaveBeenCalledTimes(1);
    });

    expect(
      screen.queryByText(/Monize v1\.9\.0 is available/),
    ).not.toBeInTheDocument();
  });
});
