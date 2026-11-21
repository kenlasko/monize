import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AdminStorageState, UserManagementTable } from './UserManagementTable';
import { AdminUserStorage } from '@/lib/admin';

const mobileState = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mobileState.isMobile,
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD', formatDate: (d: Date) => d.toISOString().slice(0, 10) }),
}));

describe('UserManagementTable', () => {
  const onChangeRole = vi.fn();
  const onToggleStatus = vi.fn();
  const onResetPassword = vi.fn();
  const onResetTwoFactor = vi.fn();
  const onUnlinkSso = vi.fn();
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

  /** A loaded reading, with each user's row overridable per test. */
  const readingOf = (...rows: AdminUserStorage[]): AdminStorageState => ({
    status: 'ready',
    byUser: new Map(rows.map((row) => [row.userId, row])),
  });

  const storedFor = (
    userId: string,
    overrides: Partial<AdminUserStorage> = {},
  ): AdminUserStorage => ({
    userId,
    backups: { enabled: true, artifacts: 2, bytes: 3_145_728 },
    attachments: { files: 4, bytes: 1_048_576 },
    ...overrides,
  });

  const defaultProps = {
    users,
    storage: readingOf(storedFor('u1'), storedFor('u2'), storedFor('u3')),
    currentUserId: 'u1',
    onChangeRole,
    onToggleStatus,
    onResetPassword,
    onUnlinkSso,
    onResetTwoFactor,
    onDeleteUser,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mobileState.isMobile = false;
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
    // Drop the sort glyphs the sortable headers carry.
    const headerTexts = headerRow.map(h => h.textContent?.replace(/[\u2191\u2193\u2195]/g, ''));
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
    expect(deleteButtons).toHaveLength(2); // u3 and u2, in name order
    fireEvent.click(deleteButtons[1]);
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

  it('offers Reset 2FA for every other user and never for the admin themself', () => {
    render(<UserManagementTable {...defaultProps} />);
    // The list carries no 2FA state, so the action is offered for both other
    // users; the server refuses one with none, and the page reports it.
    const resetTwoFactorButtons = screen.getAllByText('Reset 2FA');
    expect(resetTwoFactorButtons).toHaveLength(2);
    fireEvent.click(resetTwoFactorButtons[0]);
    expect(onResetTwoFactor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u3' }));
  });

  it('offers Reset Password for an SSO row with a password only while SSO password login is on', () => {
    const ssoWithPassword = users.map((u) => (u.id === 'u2' ? { ...u, hasPassword: true } : u));
    const { rerender } = render(<UserManagementTable {...defaultProps} users={ssoWithPassword} />);
    expect(screen.getAllByText('Reset Password')).toHaveLength(1); // u3 only
    rerender(<UserManagementTable {...defaultProps} users={ssoWithPassword} oidcPasswordLogin />);
    expect(screen.getAllByText('Reset Password')).toHaveLength(2);
  });

  it('offers Unlink SSO only for SSO users other than the admin themself', () => {
    const { rerender } = render(<UserManagementTable {...defaultProps} />);
    const buttons = screen.getAllByText('Unlink SSO');
    expect(buttons).toHaveLength(1); // u2 is the only oidc row
    fireEvent.click(buttons[0]);
    expect(onUnlinkSso).toHaveBeenCalledWith(expect.objectContaining({ id: 'u2' }));

    // An SSO admin looking at their own row gets no action.
    rerender(<UserManagementTable {...defaultProps} currentUserId="u2" />);
    expect(screen.queryByText('Unlink SSO')).not.toBeInTheDocument();
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
    fireEvent.change(selects[1], { target: { value: 'admin' } });
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

  describe('storage columns', () => {
    const soloUser = [users[1]] as any[];

    it('shows a size and what it covers for each figure', () => {
      render(
        <UserManagementTable
          {...defaultProps}
          users={soloUser}
          storage={readingOf(storedFor('u2'))}
        />,
      );

      expect(screen.getByText('3.0 MB')).toBeInTheDocument();
      expect(screen.getByText('2 backups')).toBeInTheDocument();
      expect(screen.getByText('1.0 MB')).toBeInTheDocument();
      expect(screen.getByText('4 files')).toBeInTheDocument();
    });

    it('renders a store it could not read as unknown, never as zero', () => {
      render(
        <UserManagementTable
          {...defaultProps}
          users={soloUser}
          storage={readingOf(
            storedFor('u2', {
              backups: { enabled: true, artifacts: null, bytes: null },
            }),
          )}
        />,
      );

      const unknown = screen.getByText('Unknown');
      expect(unknown).toBeInTheDocument();
      // The reason travels with the refusal: a bare "Unknown" is a dead end.
      expect(unknown).toHaveAttribute(
        'title',
        expect.stringContaining('backup store could not be read'),
      );
      expect(screen.queryByText('0 byte')).not.toBeInTheDocument();
    });

    it('distinguishes a user with no backups from one whose store is unreadable', () => {
      render(
        <UserManagementTable
          {...defaultProps}
          users={soloUser}
          storage={readingOf(
            storedFor('u2', {
              backups: { enabled: false, artifacts: 0, bytes: 0 },
              attachments: { files: 0, bytes: 0 },
            }),
          )}
        />,
      );

      expect(screen.getByText('Off')).toBeInTheDocument();
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
      // An account that stores no attachments genuinely stores zero.
      expect(screen.getByText('0 byte')).toBeInTheDocument();
      expect(screen.getByText('No files')).toBeInTheDocument();
    });

    it('still reports the bytes of a user whose schedule is switched off', () => {
      render(
        <UserManagementTable
          {...defaultProps}
          users={soloUser}
          storage={readingOf(
            storedFor('u2', {
              backups: { enabled: false, artifacts: 2, bytes: 3_145_728 },
            }),
          )}
        />,
      );

      expect(screen.getByText('3.0 MB')).toBeInTheDocument();
      expect(screen.getByText('Schedule off')).toBeInTheDocument();
    });

    it('says the figures are still loading rather than showing a blank cell', () => {
      render(
        <UserManagementTable
          {...defaultProps}
          users={soloUser}
          storage={{ status: 'loading' }}
        />,
      );

      expect(screen.getAllByText('Loading\u2026')).toHaveLength(2);
    });

    it('says the reading failed, and what to do, when the request did', () => {
      render(
        <UserManagementTable
          {...defaultProps}
          users={soloUser}
          storage={{ status: 'error' }}
        />,
      );

      const cells = screen.getAllByText('Unavailable');
      expect(cells).toHaveLength(2);
      expect(cells[0]).toHaveAttribute(
        'title',
        expect.stringContaining('Reload the page'),
      );
    });

    it('marks a user the reading did not cover instead of billing them zero', () => {
      render(
        <UserManagementTable
          {...defaultProps}
          users={soloUser}
          storage={readingOf()}
        />,
      );

      const unknown = screen.getAllByText('Not reported');
      expect(unknown).toHaveLength(2);
      expect(unknown[0]).toHaveAttribute(
        'title',
        expect.stringContaining('last storage reading'),
      );
    });
  });

  it('sorts users by name by default and says so on the header', () => {
    render(<UserManagementTable {...defaultProps} />);
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Admin User');
    expect(rows[2]).toHaveTextContent('Jane Smith');
    expect(rows[3]).toHaveTextContent('John Doe');
    expect(screen.getByRole('columnheader', { name: /^User/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('sorts by a column from its header button, and reverses on a second press', () => {
    render(<UserManagementTable {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^Last Login/ }));

    let rows = screen.getAllByRole('row');
    // Never signed in sorts as the oldest login.
    expect(rows[1]).toHaveTextContent('John Doe');
    expect(rows[3]).toHaveTextContent('Admin User');
    expect(screen.getByRole('columnheader', { name: /^Last Login/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    fireEvent.click(screen.getByRole('button', { name: /^Last Login/ }));
    rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Admin User');
    expect(screen.getByRole('columnheader', { name: /^Last Login/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('shows each user as one card on a phone, with every column and a sort header', () => {
    mobileState.isMobile = true;
    render(<UserManagementTable {...defaultProps} />);

    // One header cell holding every sortable field, and one cell per user.
    expect(screen.getAllByRole('columnheader')).toHaveLength(1);
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(1)) {
      expect(row.querySelectorAll('td')).toHaveLength(1);
    }
    // The card keeps the figures and the actions the table would have shown.
    expect(screen.getAllByText('Backups').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.0 MB')).toHaveLength(3);
    expect(screen.getAllByText('Reset 2FA')).toHaveLength(2);
    expect(screen.getAllByRole('combobox', { name: 'Role' })).toHaveLength(2);
  });

  it('prints each person an initial puck that stays hidden until the Modern style shows it', () => {
    const { container } = render(<UserManagementTable {...defaultProps} />);
    const pucks = Array.from(container.querySelectorAll('.ui-user-avatar'));
    expect(pucks.map((p) => p.textContent)).toEqual(['A', 'J', 'J']);
    for (const puck of pucks) {
      expect(puck).toHaveAttribute('aria-hidden', 'true');
      expect(puck.className).toContain('hidden');
    }
  });
});
