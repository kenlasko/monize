import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { SwipeShell } from './SwipeShell';

// Mock next/navigation
let mockPathname = '/dashboard';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => mockPathname,
}));

// Mock AppHeader to isolate SwipeShell testing
vi.mock('./AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header">AppHeader</div>,
}));

// Mock SwipeIndicator
vi.mock('./SwipeIndicator', () => ({
  SwipeIndicator: (props: any) => (
    <div data-testid="swipe-indicator" data-current={props.currentIndex} data-total={props.totalPages} data-swipe={props.isSwipePage}>
      SwipeIndicator
    </div>
  ),
}));

describe('SwipeShell', () => {
  it('renders AppHeader and children on app pages', () => {
    mockPathname = '/dashboard';
    render(<SwipeShell><p>Dashboard content</p></SwipeShell>);
    expect(screen.getByTestId('app-header')).toBeInTheDocument();
    expect(screen.getByText('Dashboard content')).toBeInTheDocument();
  });

  it('renders SwipeIndicator on app pages', () => {
    mockPathname = '/transactions';
    render(<SwipeShell><p>Content</p></SwipeShell>);
    expect(screen.getByTestId('swipe-indicator')).toBeInTheDocument();
  });

  it('renders only children on auth routes (no header)', () => {
    mockPathname = '/login';
    render(<SwipeShell><p>Login form</p></SwipeShell>);
    expect(screen.getByText('Login form')).toBeInTheDocument();
    expect(screen.queryByTestId('app-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('swipe-indicator')).not.toBeInTheDocument();
  });

  it('treats /register as an auth route', () => {
    mockPathname = '/register';
    render(<SwipeShell><p>Register form</p></SwipeShell>);
    expect(screen.queryByTestId('app-header')).not.toBeInTheDocument();
  });

  it('treats /forgot-password as an auth route', () => {
    mockPathname = '/forgot-password';
    render(<SwipeShell><p>Forgot password</p></SwipeShell>);
    expect(screen.queryByTestId('app-header')).not.toBeInTheDocument();
  });

  it('wraps content in overflow-x-hidden container on app pages', () => {
    mockPathname = '/accounts';
    const { container } = render(<SwipeShell><p>Content</p></SwipeShell>);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('overflow-x-hidden');
  });
});
