import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ProfileSection } from './ProfileSection';
import { User } from '@/types/auth';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updateProfile: vi.fn(),
  },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    setUser: vi.fn(),
  })),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { userSettingsApi } from '@/lib/user-settings';
import toast from 'react-hot-toast';

const mockUser: User = {
  id: '1',
  email: 'test@example.com',
  firstName: 'John',
  lastName: 'Doe',
  authProvider: 'local',
  hasPassword: true,
  role: 'user',
  isActive: true,
  mustChangePassword: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('ProfileSection', () => {
  const mockOnUserUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the profile heading and form fields', () => {
    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(screen.getByLabelText('First Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Profile' })).toBeInTheDocument();
  });

  it('populates inputs with user data', () => {
    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    expect(screen.getByLabelText('First Name')).toHaveValue('John');
    expect(screen.getByLabelText('Last Name')).toHaveValue('Doe');
    expect(screen.getByLabelText('Email')).toHaveValue('test@example.com');
  });

  it('shows error toast when submitting with no changes', async () => {
    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    fireEvent.submit(screen.getByRole('button', { name: 'Save Profile' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('No changes to save');
    });
    expect(userSettingsApi.updateProfile).not.toHaveBeenCalled();
  });

  it('calls updateProfile and shows success toast on valid update', async () => {
    const updatedUser = { ...mockUser, firstName: 'Jane' };
    (userSettingsApi.updateProfile as ReturnType<typeof vi.fn>).mockResolvedValue(updatedUser);

    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jane' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save Profile' }));

    await waitFor(() => {
      expect(userSettingsApi.updateProfile).toHaveBeenCalledWith({ firstName: 'Jane' });
      expect(toast.success).toHaveBeenCalledWith('Profile updated successfully');
      expect(mockOnUserUpdated).toHaveBeenCalledWith(updatedUser);
    });
  });

  it('shows error toast when updateProfile fails', async () => {
    (userSettingsApi.updateProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Server error')
    );

    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'MyPass123!' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save Profile' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update profile');
    });
  });

  it('shows password field when email is changed', () => {
    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    expect(screen.queryByLabelText('Current Password')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });

    expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
  });

  it('handles user with empty firstName and lastName', () => {
    const userWithoutName: User = { ...mockUser, firstName: undefined, lastName: undefined };
    render(<ProfileSection user={userWithoutName as any} onUserUpdated={mockOnUserUpdated} />);

    expect(screen.getByLabelText('First Name')).toHaveValue('');
    expect(screen.getByLabelText('Last Name')).toHaveValue('');
  });

  it('shows Saving... text while profile is being updated', async () => {
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    (userSettingsApi.updateProfile as ReturnType<typeof vi.fn>).mockReturnValue(pendingPromise);

    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jane' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save Profile' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    });

    resolvePromise!({ ...mockUser, firstName: 'Jane' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save Profile' })).toBeInTheDocument();
    });
  });

  it('sends only changed fields to the API with password for email change', async () => {
    const updatedUser = { ...mockUser, lastName: 'Smith', email: 'new@example.com' };
    (userSettingsApi.updateProfile as ReturnType<typeof vi.fn>).mockResolvedValue(updatedUser);

    render(<ProfileSection user={mockUser} onUserUpdated={mockOnUserUpdated} />);

    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Smith' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'MyPass123!' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save Profile' }));

    await waitFor(() => {
      expect(userSettingsApi.updateProfile).toHaveBeenCalledWith({
        lastName: 'Smith',
        email: 'new@example.com',
        currentPassword: 'MyPass123!',
      });
    });
  });
});
