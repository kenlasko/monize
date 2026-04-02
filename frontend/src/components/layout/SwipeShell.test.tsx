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

// Mock BackendDownBanner
vi.mock('./BackendDownBanner', () => ({
  BackendDownBanner: (props: any) => (
    <div data-testid="backend-down-banner" data-https-active={props.httpsHeadersActive}>BackendDownBanner</div>
  ),
}));

// Mock HttpWarningBanner
vi.mock('./HttpWarningBanner', () => ({
  HttpWarningBanner: (props: any) => (
    <div data-testid="http-warning-banner" data-https-active={props.httpsHeadersActive}>HttpWarningBanner</div>
  ),
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

  it('wraps content in overflow-x-clip container on app pages', () => {
    mockPathname = '/accounts';
    const { container } = render(<SwipeShell><p>Content</p></SwipeShell>);
    const wrapper = container.firstChild as HTMLElement;
    // Must use overflow-x-clip (not overflow-x-hidden) to preserve
    // position:sticky and IntersectionObserver viewport behavior
    expect(wrapper.className).toContain('overflow-x-clip');
    expect(wrapper.className).not.toContain('overflow-x-hidden');
  });

  it('renders BackendDownBanner on app pages', () => {
    mockPathname = '/dashboard';
    render(<SwipeShell><p>Content</p></SwipeShell>);
    expect(screen.getByTestId('backend-down-banner')).toBeInTheDocument();
  });

  it('renders BackendDownBanner on auth routes', () => {
    mockPathname = '/login';
    render(<SwipeShell><p>Login form</p></SwipeShell>);
    expect(screen.getByTestId('backend-down-banner')).toBeInTheDocument();
  });

  it('renders HttpWarningBanner on app pages', () => {
    mockPathname = '/dashboard';
    render(<SwipeShell><p>Content</p></SwipeShell>);
    expect(screen.getByTestId('http-warning-banner')).toBeInTheDocument();
  });

  it('renders HttpWarningBanner on auth routes', () => {
    mockPathname = '/login';
    render(<SwipeShell><p>Login form</p></SwipeShell>);
    expect(screen.getByTestId('http-warning-banner')).toBeInTheDocument();
  });

  it('passes httpsHeadersActive to banners', () => {
    mockPathname = '/dashboard';
    render(<SwipeShell httpsHeadersActive={true}><p>Content</p></SwipeShell>);
    expect(screen.getByTestId('backend-down-banner')).toHaveAttribute('data-https-active', 'true');
    expect(screen.getByTestId('http-warning-banner')).toHaveAttribute('data-https-active', 'true');
  });

  it('defaults httpsHeadersActive to false', () => {
    mockPathname = '/dashboard';
    render(<SwipeShell><p>Content</p></SwipeShell>);
    expect(screen.getByTestId('backend-down-banner')).toHaveAttribute('data-https-active', 'false');
    expect(screen.getByTestId('http-warning-banner')).toHaveAttribute('data-https-active', 'false');
  });
});
