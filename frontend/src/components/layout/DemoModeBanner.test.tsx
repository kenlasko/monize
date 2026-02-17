import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { DemoModeBanner } from './DemoModeBanner';
import { useDemoStore } from '@/store/demoStore';

describe('DemoModeBanner', () => {
  beforeEach(() => {
    useDemoStore.setState({ isDemoMode: false });
  });

  it('renders nothing when demo mode is inactive', () => {
    const { container } = render(<DemoModeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders banner when demo mode is active', () => {
    useDemoStore.setState({ isDemoMode: true });
    render(<DemoModeBanner />);
    expect(screen.getByText('Demo Mode')).toBeInTheDocument();
  });

  it('displays the reset schedule message', () => {
    useDemoStore.setState({ isDemoMode: true });
    render(<DemoModeBanner />);
    expect(
      screen.getByText(/All data resets daily at 4:00 AM UTC/),
    ).toBeInTheDocument();
  });

  it('displays explore freely message', () => {
    useDemoStore.setState({ isDemoMode: true });
    render(<DemoModeBanner />);
    expect(screen.getByText(/Explore freely!/)).toBeInTheDocument();
  });

  it('renders Demo Mode label in bold', () => {
    useDemoStore.setState({ isDemoMode: true });
    render(<DemoModeBanner />);
    const label = screen.getByText('Demo Mode');
    expect(label.tagName).toBe('SPAN');
    expect(label.className).toContain('font-semibold');
  });

  it('uses amber color scheme', () => {
    useDemoStore.setState({ isDemoMode: true });
    const { container } = render(<DemoModeBanner />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain('bg-amber-50');
    expect(banner.className).toContain('text-amber-800');
  });
});
