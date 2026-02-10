import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { UserManagementTable } from './UserManagementTable';

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: Date) => d.toISOString().slice(0, 10) }),
}));

describe('UserManagementTable', () => {
  const onChangeRole = vi.fn();
  const onToggleStatus = vi.fn();
  const onResetPassword = vi.fn();
  const onDeleteUser = vi.fn();

  const users = [
    {
      id: 'u1', email: 'admin@example.com', firstName: 'Admin', lastName: 'User',
      role: 'admin', authProvider: 'local', isActive: true, hasPassword: true,
      createdAt: '2025-01-01T00:00:00Z', lastLogin: '2025-02-01T12:00:00Z',
    },
    {
      id: 'u2', email: 'john@example.com', firstName: 'John', lastName: 'Doe',
      role: 'user', authProvider: 'oidc', isActive: true, hasPassword: false,
      createdAt: '2025-01-15T00:00:00Z', lastLogin: null,
    },
  ] as any[];

  it('renders table with user data', () => {
    render(
      <UserManagementTable
        users={users} currentUserId="u1"
        onChangeRole={onChangeRole} onToggleStatus={onToggleStatus}
        onResetPassword={onResetPassword} onDeleteUser={onDeleteUser}
      />
    );
    expect(screen.getByText('Admin User')).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
  });

  it('shows (you) label for current user', () => {
    render(
      <UserManagementTable
        users={users} currentUserId="u1"
        onChangeRole={onChangeRole} onToggleStatus={onToggleStatus}
        onResetPassword={onResetPassword} onDeleteUser={onDeleteUser}
      />
    );
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  it('shows SSO badge for OIDC users and Local for local users', () => {
    render(
      <UserManagementTable
        users={users} currentUserId="u1"
        onChangeRole={onChangeRole} onToggleStatus={onToggleStatus}
        onResetPassword={onResetPassword} onDeleteUser={onDeleteUser}
      />
    );
    expect(screen.getByText('SSO')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
  });

  it('shows Never for users without last login', () => {
    render(
      <UserManagementTable
        users={users} currentUserId="u1"
        onChangeRole={onChangeRole} onToggleStatus={onToggleStatus}
        onResetPassword={onResetPassword} onDeleteUser={onDeleteUser}
      />
    );
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows Delete button for non-self users and calls onDeleteUser', () => {
    render(
      <UserManagementTable
        users={users} currentUserId="u1"
        onChangeRole={onChangeRole} onToggleStatus={onToggleStatus}
        onResetPassword={onResetPassword} onDeleteUser={onDeleteUser}
      />
    );
    const deleteButton = screen.getByText('Delete');
    fireEvent.click(deleteButton);
    expect(onDeleteUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'u2' }));
  });
});
