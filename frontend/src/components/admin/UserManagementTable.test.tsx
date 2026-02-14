import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    {
      id: 'u3', email: 'jane@example.com', firstName: 'Jane', lastName: 'Smith',
      role: 'user', authProvider: 'local', isActive: false, hasPassword: true,
      createdAt: '2025-01-20T00:00:00Z', lastLogin: '2025-01-25T08:00:00Z',
    },
  ] as any[];

  const defaultProps = {
    users,
    currentUserId: 'u1',
    onChangeRole,
    onToggleStatus,
    onResetPassword,
    onDeleteUser,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders table with user data', () => {
    render(<UserManagementTable {...defaultProps} />);
    expect(screen.getByText('Admin User')).toBeInTheDocument();
    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
  });

  it('renders table headers', () => {
    render(<UserManagementTable {...defaultProps} />);
    // "User" also appears in role dropdown options, so check within thead
    const headerRow = screen.getAllByRole('columnheader');
    const headerTexts = headerRow.map(h => h.textContent);
    expect(headerTexts).toContain('User');
    expect(headerTexts).toContain('Role');
    expect(headerTexts).toContain('Provider');
    expect(headerTexts).toContain('Status');
    expect(headerTexts).toContain('Last Login');
    expect(headerTexts).toContain('Actions');
  });

  it('shows (you) label for current user', () => {
    render(<UserManagementTable {...defaultProps} />);
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  it('shows SSO badge for OIDC users and Local for local users', () => {
    render(<UserManagementTable {...defaultProps} />);
    expect(screen.getByText('SSO')).toBeInTheDocument();
    expect(screen.getAllByText('Local')).toHaveLength(2);
  });

  it('shows Never for users without last login', () => {
    render(<UserManagementTable {...defaultProps} />);
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows Active and Disabled status badges', () => {
    render(<UserManagementTable {...defaultProps} />);
    const activeBadges = screen.getAllByText('Active');
    expect(activeBadges.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows Delete button for non-self users and calls onDeleteUser', () => {
    render(<UserManagementTable {...defaultProps} />);
    const deleteButtons = screen.getAllByText('Delete');
    expect(deleteButtons).toHaveLength(2); // u2 and u3
    fireEvent.click(deleteButtons[0]);
    expect(onDeleteUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'u2' }));
  });

  it('shows Reset Password button only for users with password', () => {
    render(<UserManagementTable {...defaultProps} />);
    const resetButtons = screen.getAllByText('Reset Password');
    // u2 has no password (oidc), u3 has password - so only u3 should show Reset Password
    expect(resetButtons).toHaveLength(1);
    fireEvent.click(resetButtons[0]);
    expect(onResetPassword).toHaveBeenCalledWith(expect.objectContaining({ id: 'u3' }));
  });

  it('does not show actions for current user (self)', () => {
    render(<UserManagementTable {...defaultProps} />);
    // Admin User (u1) is self, should not have Delete or Reset Password
    // There should be 2 Delete buttons (for u2 and u3)
    const deleteButtons = screen.getAllByText('Delete');
    expect(deleteButtons).toHaveLength(2);
  });

  it('shows role dropdown for non-self users', () => {
    render(<UserManagementTable {...defaultProps} />);
    // Non-self users should have a select element for role
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBe(2); // u2 and u3
  });

  it('calls onChangeRole when role select is changed', () => {
    render(<UserManagementTable {...defaultProps} />);
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'admin' } });
    expect(onChangeRole).toHaveBeenCalledWith(expect.objectContaining({ id: 'u2' }), 'admin');
  });

  it('calls onToggleStatus when status badge is clicked', () => {
    render(<UserManagementTable {...defaultProps} />);
    // Click the Disabled badge to toggle status
    fireEvent.click(screen.getByText('Disabled'));
    expect(onToggleStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'u3' }));
  });

  it('shows role badge for current user instead of dropdown', () => {
    render(<UserManagementTable {...defaultProps} />);
    // Current user (admin) row should show a static badge, not a dropdown
    // "Admin" appears as badge text and also as dropdown option in other rows
    // Find the badge specifically (it should be in a span with badge styling)
    const adminBadges = screen.getAllByText('Admin');
    // At least one should be a static badge (not inside a select)
    const staticBadge = adminBadges.find(el => el.tagName === 'SPAN');
    expect(staticBadge).toBeTruthy();
  });

  it('shows empty state when no users', () => {
    render(<UserManagementTable {...defaultProps} users={[]} />);
    expect(screen.getByText('No users found.')).toBeInTheDocument();
  });

  it('falls back to email when first and last names are empty', () => {
    const usersNoName = [
      {
        id: 'u4', email: 'noname@example.com', firstName: '', lastName: '',
        role: 'user', authProvider: 'local', isActive: true, hasPassword: true,
        createdAt: '2025-02-01T00:00:00Z', lastLogin: null,
      },
    ] as any[];

    render(<UserManagementTable {...defaultProps} users={usersNoName} currentUserId="other" />);
    // Email appears as both display name and email sub-text
    const matches = screen.getAllByText('noname@example.com');
    expect(matches.length).toBe(2);
  });

  it('falls back to Unknown when no name and no email', () => {
    const usersNoInfo = [
      {
        id: 'u5', email: '', firstName: '', lastName: '',
        role: 'user', authProvider: 'local', isActive: true, hasPassword: true,
        createdAt: '2025-02-01T00:00:00Z', lastLogin: null,
      },
    ] as any[];

    render(<UserManagementTable {...defaultProps} users={usersNoInfo} currentUserId="other" />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('No email')).toBeInTheDocument();
  });

  it('sorts users by creation date ascending', () => {
    render(<UserManagementTable {...defaultProps} />);
    const rows = screen.getAllByRole('row');
    // First data row should be Admin User (earliest createdAt)
    expect(rows[1]).toHaveTextContent('Admin User');
  });
});
