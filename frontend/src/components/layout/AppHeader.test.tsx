import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AppHeader } from './AppHeader';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    logout: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@/store/authStore', () => ({
  useAuthStore: () => ({
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      role: 'user',
    },
    logout: mockLogout,
  }),
}));

describe('AppHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Monize logo and brand name', () => {
    render(<AppHeader />);
    expect(screen.getByText('Monize')).toBeInTheDocument();
    expect(screen.getByAltText('Monize')).toBeInTheDocument();
  });

  it('renders main navigation links', () => {
    render(<AppHeader />);
    expect(screen.getAllByText('Transactions').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Accounts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Reports').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the user first name', () => {
    render(<AppHeader />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('renders the logout button', () => {
    render(<AppHeader />);
    expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
  });

  it('renders the Tools dropdown button', () => {
    render(<AppHeader />);
    expect(screen.getAllByText('Tools').length).toBeGreaterThanOrEqual(1);
  });
});
