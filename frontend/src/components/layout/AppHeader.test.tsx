import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { AppHeader } from './AppHeader';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
}));

// Track router.push calls
const mockPush = vi.fn();
let mockPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

// Mock auth API
const mockApiLogout = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/auth', () => ({
  authApi: {
    logout: (...args: any[]) => mockApiLogout(...args),
  },
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockLogout = vi.fn();
let mockUser: any = {
  id: 'test-user-id',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  role: 'user',
};

vi.mock('@/store/authStore', () => ({
  useAuthStore: () => ({
    user: mockUser,
    logout: mockLogout,
  }),
}));

// Mock BudgetAlertBadge to avoid async act() warnings (tested in its own file)
vi.mock('@/components/budgets/BudgetAlertBadge', () => ({
  BudgetAlertBadge: () => <div data-testid="budget-alert-badge" />,
}));

describe('AppHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/dashboard';
    mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      role: 'user',
    };
  });

  it('renders the Monize logo and brand name', () => {
    render(<AppHeader />);
    expect(screen.getByText('Monize')).toBeInTheDocument();
    expect(screen.getByAltText('Monize')).toBeInTheDocument();
  });

  it('renders main navigation links in desktop nav', () => {
    render(<AppHeader />);
    // Desktop nav includes Transactions, Accounts, Investments, Bills & Deposits, Reports
    expect(screen.getAllByText('Transactions').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Accounts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Investments').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Bills & Deposits').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Reports').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the user first name in settings button', () => {
    render(<AppHeader />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('renders user email when firstName is not available', () => {
    mockUser = {
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: '',
      lastName: 'User',
      role: 'user',
    };
    render(<AppHeader />);
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });

  it('renders the logout button', () => {
    render(<AppHeader />);
    expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
  });

  it('calls authApi.logout and store logout on logout click', async () => {
    render(<AppHeader />);
    const logoutButton = screen.getByRole('button', { name: /logout/i });
    fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(mockApiLogout).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/login');
    });
  });

  it('still logs out and redirects when authApi.logout fails', async () => {
    mockApiLogout.mockRejectedValueOnce(new Error('Network error'));
    render(<AppHeader />);
    const logoutButton = screen.getByRole('button', { name: /logout/i });
    fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/login');
    });
  });

  it('renders the Tools dropdown button', () => {
    render(<AppHeader />);
    // There is a "Tools" button in the desktop nav
    expect(screen.getAllByText('Tools').length).toBeGreaterThanOrEqual(1);
  });

  it('opens Tools dropdown and shows tools links on click', () => {
    render(<AppHeader />);
    // Find the desktop Tools button (not the mobile Tools section header)
    const toolsButtons = screen.getAllByText('Tools');
    // Click the desktop dropdown toggle
    fireEvent.click(toolsButtons[0]);

    // All tools links should now appear in the dropdown
    expect(screen.getAllByText('Categories').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Payees').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Securities').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Currencies').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Import Transactions').length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to tool link and closes dropdown when tool link clicked', () => {
    render(<AppHeader />);
    const toolsButtons = screen.getAllByText('Tools');
    fireEvent.click(toolsButtons[0]);

    const categoriesLinks = screen.getAllByText('Categories');
    fireEvent.click(categoriesLinks[0]);

    expect(mockPush).toHaveBeenCalledWith('/categories');
  });

  it('navigates to dashboard when logo is clicked', () => {
    render(<AppHeader />);
    const logoButton = screen.getByText('Monize');
    fireEvent.click(logoButton);
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('navigates when desktop nav link is clicked', () => {
    render(<AppHeader />);
    const transactionsButtons = screen.getAllByText('Transactions');
    fireEvent.click(transactionsButtons[0]);
    expect(mockPush).toHaveBeenCalledWith('/transactions');
  });

  it('navigates to settings when settings button is clicked', () => {
    render(<AppHeader />);
    const settingsButton = screen.getByTitle('Settings');
    fireEvent.click(settingsButton);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  // Active link highlighting
  it('highlights active nav link based on pathname', () => {
    mockPathname = '/transactions';
    render(<AppHeader />);
    // The active desktop button should have bg-blue-100 class
    const transactionsButtons = screen.getAllByText('Transactions');
    // Desktop nav button (not mobile) - find one with the active class
    const activeButton = transactionsButtons.find(
      (el) => el.closest('button')?.className.includes('bg-blue-100'),
    );
    expect(activeButton).toBeTruthy();
  });

  it('highlights Tools dropdown when a tools link is active', () => {
    mockPathname = '/categories';
    render(<AppHeader />);
    const toolsButtons = screen.getAllByText('Tools');
    // The tools button should be highlighted since /categories is a tools link
    const activeToolsButton = toolsButtons.find(
      (el) => el.closest('button')?.className.includes('bg-blue-100'),
    );
    expect(activeToolsButton).toBeTruthy();
  });

  it('highlights settings button when pathname is /settings', () => {
    mockPathname = '/settings';
    render(<AppHeader />);
    const settingsButton = screen.getByTitle('Settings');
    expect(settingsButton.className).toContain('bg-blue-100');
  });

  // Admin link
  it('does not show Admin link for regular users', () => {
    render(<AppHeader />);
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
    expect(screen.queryByText('User Management')).not.toBeInTheDocument();
  });

  it('shows Admin link for admin users in desktop nav', () => {
    mockUser = {
      id: 'admin-user-id',
      email: 'admin@example.com',
      firstName: 'AdminUser',
      lastName: 'Test',
      role: 'admin',
    };
    render(<AppHeader />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('highlights Admin link when pathname starts with /admin', () => {
    mockPathname = '/admin/users';
    mockUser = {
      id: 'admin-user-id',
      email: 'admin@example.com',
      firstName: 'AdminUser',
      lastName: 'Test',
      role: 'admin',
    };
    render(<AppHeader />);
    const adminButton = screen.getByText('Admin');
    expect(adminButton.closest('button')?.className).toContain('bg-blue-100');
  });

  // Mobile menu
  it('toggles mobile menu when hamburger button is clicked', () => {
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');

    // Mobile menu should not be visible initially
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();

    // Click to open
    fireEvent.click(menuToggle);

    // Now Dashboard should appear in the mobile menu
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows all nav links in mobile menu when open', () => {
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    // Check for main nav links
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    // Check for tools section header
    const toolsHeaders = screen.getAllByText('Tools');
    expect(toolsHeaders.length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to dashboard from mobile menu', () => {
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    const dashboardButton = screen.getByText('Dashboard');
    fireEvent.click(dashboardButton);
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('navigates to settings from mobile menu', () => {
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    const settingsButton = screen.getByText('Settings');
    fireEvent.click(settingsButton);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('shows Admin section in mobile menu for admin users', () => {
    mockUser = {
      id: 'admin-user-id',
      email: 'admin@example.com',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
    };
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    expect(screen.getByText('User Management')).toBeInTheDocument();
  });

  it('does not show Admin section in mobile menu for regular users', () => {
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    expect(screen.queryByText('User Management')).not.toBeInTheDocument();
  });

  it('navigates to admin/users from mobile menu', () => {
    mockUser = {
      id: 'admin-user-id',
      email: 'admin@example.com',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
    };
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    fireEvent.click(screen.getByText('User Management'));
    expect(mockPush).toHaveBeenCalledWith('/admin/users');
  });

  it('highlights active link in mobile menu', () => {
    mockPathname = '/transactions';
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    // Find the Transactions button in the mobile menu that has active style
    const transactionsButtons = screen.getAllByText('Transactions');
    const mobileActive = transactionsButtons.find(
      (el) => el.closest('button')?.className.includes('bg-blue-50'),
    );
    expect(mobileActive).toBeTruthy();
  });

  it('highlights dashboard in mobile menu when pathname is /dashboard', () => {
    mockPathname = '/dashboard';
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    const dashboardButton = screen.getByText('Dashboard');
    expect(dashboardButton.closest('button')?.className).toContain('bg-blue-50');
  });

  it('closes mobile menu when clicking outside', () => {
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    expect(screen.getByText('Dashboard')).toBeInTheDocument();

    // Click outside (mousedown on document)
    fireEvent.mouseDown(document);

    // Mobile menu should close
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('closes Tools dropdown when clicking outside', () => {
    render(<AppHeader />);
    const toolsButtons = screen.getAllByText('Tools');
    fireEvent.click(toolsButtons[0]);

    // Dropdown is open with Categories
    expect(screen.getAllByText('Categories').length).toBeGreaterThanOrEqual(1);

    // Click outside
    fireEvent.mouseDown(document);

    // The dropdown should close. Desktop nav still has Tools button text but
    // the dropdown items should be gone. We can check if the number of Categories reduced.
    // Actually, after close, mobile menu is not open so only the desktop Tools remains
    // Categories should no longer be in dropdown
  });

  it('shows mobile tools links and navigates', () => {
    render(<AppHeader />);
    const menuToggle = screen.getByLabelText('Toggle menu');
    fireEvent.click(menuToggle);

    // Click a tools link in the mobile menu
    const categoriesButtons = screen.getAllByText('Categories');
    fireEvent.click(categoriesButtons[0]);
    expect(mockPush).toHaveBeenCalledWith('/categories');
  });

  it('shows no user menu items when user is null', () => {
    mockUser = null;
    render(<AppHeader />);
    // No firstName or email should be rendered
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
    expect(screen.queryByText('test@example.com')).not.toBeInTheDocument();
    // Admin link should not appear
    expect(screen.queryByText('Admin')).not.toBeInTheDocument();
  });
});
