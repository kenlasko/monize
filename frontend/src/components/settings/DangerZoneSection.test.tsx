import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { DangerZoneSection } from './DangerZoneSection';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    deleteAccount: vi.fn(),
  },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    logout: vi.fn(),
  })),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { userSettingsApi } from '@/lib/user-settings';
import toast from 'react-hot-toast';

describe('DangerZoneSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the danger zone heading', () => {
    render(<DangerZoneSection />);

    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Account' })).toBeInTheDocument();
  });

  it('shows confirmation input when Delete Account is clicked', () => {
    render(<DangerZoneSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));

    expect(screen.getByText(/Type DELETE to confirm/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type DELETE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm Delete' })).toBeDisabled();
  });

  it('enables Confirm Delete only when DELETE is typed', () => {
    render(<DangerZoneSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));
    fireEvent.change(screen.getByPlaceholderText('Type DELETE'), { target: { value: 'DELETE' } });

    expect(screen.getByRole('button', { name: 'Confirm Delete' })).not.toBeDisabled();
  });

  it('hides confirmation when Cancel is clicked', () => {
    render(<DangerZoneSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));
    expect(screen.getByText(/Type DELETE to confirm/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Type DELETE to confirm/)).not.toBeInTheDocument();
  });

  it('calls deleteAccount API when confirmed', async () => {
    (userSettingsApi.deleteAccount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<DangerZoneSection />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));
    fireEvent.change(screen.getByPlaceholderText('Type DELETE'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));

    await waitFor(() => {
      expect(userSettingsApi.deleteAccount).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Account deleted');
    });
  });
});
